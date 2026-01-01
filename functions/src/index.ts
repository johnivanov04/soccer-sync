// functions/src/index.ts
import * as admin from "firebase-admin";
import {
  onDocumentCreated,
  onDocumentWritten,
} from "firebase-functions/v2/firestore";

admin.initializeApp();
const db = admin.firestore();
const { FieldValue } = admin.firestore;

function uniqStrings(xs: any[]): string[] {
  return Array.from(
    new Set(
      (xs ?? [])
        .filter((x) => typeof x === "string" && x.trim())
        .map((x) => x.trim())
    )
  );
}

function truncate(s: string, n: number) {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function getUserTokens(uid: string): Promise<string[]> {
  if (!uid) return [];
  const snap = await db.collection("users").doc(uid).get();
  if (!snap.exists) return [];

  const u = snap.data() as any;
  return uniqStrings([
    ...(Array.isArray(u?.expoPushTokens) ? u.expoPushTokens : []),
    ...(u?.expoPushToken ? [u.expoPushToken] : []),
  ]);
}

async function removeBadTokenFromUser(uid: string, token: string) {
  if (!uid || !token) return;
  try {
    const userRef = db.collection("users").doc(uid);
    await userRef.set(
      {
        expoPushTokens: FieldValue.arrayRemove(token),
        ...(token ? { expoPushToken: FieldValue.delete() } : {}),
        expoPushTokenUpdatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    const fresh = await userRef.get();
    const d = fresh.data() as any;
    if (d?.expoPushToken === token) {
      await userRef.set(
        {
          expoPushToken: FieldValue.delete(),
          expoPushTokenUpdatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
  } catch (e) {
    console.warn("Failed cleaning bad token:", { uid, token, e });
  }
}

type PushMessage = {
  to: string;
  title: string;
  body: string;
  sound?: "default";
  data?: Record<string, any>;
};

async function sendExpoPushMany(
  messages: PushMessage[],
  tokenToUid?: Map<string, string>
) {
  if (!messages || messages.length === 0) return;

  const batches = chunk(messages, 100);

  for (const batch of batches) {
    const res = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(batch),
    });

    const json = await res.json();
    const tickets = json?.data;
    if (!tickets) throw new Error(`No Expo tickets returned: ${JSON.stringify(json)}`);

    const arr = Array.isArray(tickets) ? tickets : [tickets];

    for (let i = 0; i < arr.length; i++) {
      const ticket = arr[i];
      const token = batch[i]?.to;

      if (ticket?.status === "ok") continue;

      console.warn("Expo ticket not ok:", ticket);

      const errCode = ticket?.details?.error ?? ticket?.message ?? "unknown";
      if (
        token &&
        tokenToUid &&
        (errCode === "DeviceNotRegistered" ||
          errCode === "InvalidCredentials" ||
          String(errCode).toLowerCase().includes("notregistered"))
      ) {
        const uid = tokenToUid.get(token);
        if (uid) await removeBadTokenFromUser(uid, token);
      }
    }
  }
}

/**
 * Always keep these fields correct so your matches list can render:
 * - matches/{matchId}.confirmedYesCount
 * - matches/{matchId}.waitlistCount
 */
async function recomputeCounts(matchId: string) {
  const rsvpsCol = db.collection("rsvps");

  const confirmedSnap = await rsvpsCol
    .where("matchId", "==", matchId)
    .where("status", "==", "yes")
    .where("isWaitlisted", "==", false)
    .get();

  const waitlistSnap = await rsvpsCol
    .where("matchId", "==", matchId)
    .where("status", "==", "yes")
    .where("isWaitlisted", "==", true)
    .get();

  await db.collection("matches").doc(matchId).set(
    {
      confirmedYesCount: confirmedSnap.size,
      waitlistCount: waitlistSnap.size,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return { confirmed: confirmedSnap.size, waitlist: waitlistSnap.size };
}

async function promoteIfNeeded(matchId: string) {
  const matchRef = db.collection("matches").doc(matchId);
  const matchSnap = await matchRef.get();
  if (!matchSnap.exists) return;

  const match = matchSnap.data() as any;
  const maxPlayers = Number(match?.maxPlayers ?? 0);
  const status = String(match?.status ?? "scheduled").toLowerCase();

  if (!Number.isFinite(maxPlayers) || maxPlayers <= 0) return;
  if (status === "played" || status === "cancelled" || status === "canceled") return;

  const rsvpsCol = db.collection("rsvps");

  const confirmedSnap = await rsvpsCol
    .where("matchId", "==", matchId)
    .where("status", "==", "yes")
    .where("isWaitlisted", "==", false)
    .get();

  const openSlots = maxPlayers - confirmedSnap.size;
  if (openSlots <= 0) return;

  const waitlistedSnap = await rsvpsCol
    .where("matchId", "==", matchId)
    .where("status", "==", "yes")
    .where("isWaitlisted", "==", true)
    .orderBy("updatedAt", "asc")
    .limit(openSlots)
    .get();

  if (waitlistedSnap.empty) return;

  const promotedUserIds: string[] = [];

  for (const docSnap of waitlistedSnap.docs) {
    const rsvpRef = docSnap.ref;

    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(rsvpRef);
      if (!fresh.exists) return;

      const data = fresh.data() as any;
      if (data?.isWaitlisted !== true) return;

      tx.update(rsvpRef, {
        isWaitlisted: false,
        updatedAt: FieldValue.serverTimestamp(),
      });

      if (data?.userId) promotedUserIds.push(String(data.userId));
    });
  }

  const pushes: PushMessage[] = [];
  const sentTokens = new Set<string>();
  const tokenToUid = new Map<string, string>();

  for (const uid of uniqStrings(promotedUserIds)) {
    const tokens = await getUserTokens(uid);
    for (const t of tokens) {
      if (sentTokens.has(t)) continue;
      sentTokens.add(t);
      tokenToUid.set(t, uid);

      pushes.push({
        to: t,
        title: "You’re in! ✅",
        body: "A spot opened up — you’re now confirmed for the match.",
        sound: "default",
        data: { kind: "promoted", matchId },
      });
    }
  }

  await sendExpoPushMany(pushes, tokenToUid);
}

/**
 * ✅ Chat notifications + ✅ Match preview fields (lastMessage*)
 *
 * Adds:
 * - matches/{matchId}.lastMessageAt
 * - matches/{matchId}.lastMessageText
 * - matches/{matchId}.lastMessageSenderId
 * - matches/{matchId}.lastMessageSenderName
 *
 * Keeps your push fixes (exclude sender by UID + TOKEN, global token de-dupe).
 */
export const onMatchMessageCreate = onDocumentCreated(
  "matchMessages/{msgId}",
  async (event) => {
    const snap = event.data;
    if (!snap) return;

    const msgId = snap.id;
    const data = snap.data() as any;

    const matchId = String(data?.matchId ?? "");
    const senderId = String(data?.userId ?? "");
    const senderName = String(data?.displayName ?? "Someone");
    const text = String(data?.text ?? "");

    if (!matchId || !senderId || !text.trim()) return;

    const msgRef = db.collection("matchMessages").doc(msgId);
    const matchRef = db.collection("matches").doc(matchId);

    // Ensure match exists (avoid creating accidental match doc via merge)
    const matchSnap = await matchRef.get();
    if (!matchSnap.exists) return;

    // ✅ Always update match preview fields (even if push is skipped later)
    const createdAt = data?.createdAt ?? FieldValue.serverTimestamp();
    await matchRef.set(
      {
        lastMessageAt: createdAt,
        lastMessageText: truncate(text.trim(), 220),
        lastMessageSenderId: senderId,
        lastMessageSenderName: senderName,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // ---- Claim idempotently to avoid double-sends ----
    const claimed = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(msgRef);
      const d = (fresh.data() as any) ?? {};
      if (d?.notifiedAt || d?.notifyClaimedAt) return false;

      tx.set(
        msgRef,
        { notifyClaimedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
      return true;
    });

    if (!claimed) return;

    const match = matchSnap.data() as any;
    const hostId = match?.createdBy ? String(match.createdBy) : null;

    const rsvpSnap = await db
      .collection("rsvps")
      .where("matchId", "==", matchId)
      .get();

    const recipientIds: string[] = [];
    for (const d of rsvpSnap.docs) {
      const r = d.data() as any;
      const uid = r?.userId ? String(r.userId) : "";
      const st = String(r?.status ?? "").toLowerCase();
      if (!uid) continue;
      if (st === "yes" || st === "maybe") recipientIds.push(uid);
    }
    if (hostId) recipientIds.push(hostId);

    const finalRecipientIds = uniqStrings(recipientIds).filter(
      (uid) => uid !== senderId
    );

    // ---- Token-level exclusion + global de-dupe ----
    const senderTokens = await getUserTokens(senderId);
    const senderTokenSet = new Set(senderTokens);

    const pushes: PushMessage[] = [];
    const sentTokens = new Set<string>();
    const tokenToUid = new Map<string, string>();

    const body = truncate(text.trim(), 180);
    const title = "Match Chat";

    for (const uid of finalRecipientIds) {
      const tokens = await getUserTokens(uid);

      for (const t of tokens) {
        if (senderTokenSet.has(t)) continue;
        if (sentTokens.has(t)) continue;

        sentTokens.add(t);
        tokenToUid.set(t, uid);

        pushes.push({
          to: t,
          title,
          body: `${senderName}: ${body}`,
          sound: "default",
          data: { matchId, type: "chat" },
        });
      }
    }

    if (pushes.length === 0) {
      await msgRef.set(
        {
          notifiedAt: FieldValue.serverTimestamp(),
          notifyTokenCount: 0,
        },
        { merge: true }
      );
      return;
    }

    await sendExpoPushMany(pushes, tokenToUid);

    await msgRef.set(
      {
        notifiedAt: FieldValue.serverTimestamp(),
        notifyTokenCount: pushes.length,
      },
      { merge: true }
    );
  }
);

/**
 * Trigger on ANY RSVP create/update/delete:
 * 1) Try promotion (best-effort)
 * 2) ALWAYS recompute counts so the Matches tab stays correct
 */
export const onRsvpWrite = onDocumentWritten("rsvps/{rsvpId}", async (event) => {
  const before = event.data?.before?.data() as any | undefined;
  const after = event.data?.after?.data() as any | undefined;

  const matchId = String(after?.matchId ?? before?.matchId ?? "");
  if (!matchId) return;

  try {
    await promoteIfNeeded(matchId);
  } catch (e) {
    console.error("promoteIfNeeded failed:", e);
  }

  try {
    await recomputeCounts(matchId);
  } catch (e) {
    console.error("recomputeCounts failed:", e);
  }
});
