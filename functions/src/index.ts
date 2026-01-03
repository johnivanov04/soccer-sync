import * as admin from "firebase-admin";
import { onDocumentCreated, onDocumentWritten } from "firebase-functions/v2/firestore";

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

// ✅ Robust: derive UID from snapshot ref (no reliance on getAll ordering)
function uidFromChatPrefSnap(s: FirebaseFirestore.DocumentSnapshot): string | null {
  // path: users/{uid}/chatPrefs/{matchId}
  const userDoc = s.ref.parent?.parent; // users/{uid}
  return userDoc?.id ? String(userDoc.id) : null;
}

// ✅ Per-match mute lookup (robust)
async function getMutedUidsForMatch(uids: string[], matchId: string): Promise<Set<string>> {
  const list = uniqStrings(uids);
  if (!matchId || list.length === 0) return new Set();

  const refs = list.map((uid) =>
    db.collection("users").doc(uid).collection("chatPrefs").doc(matchId)
  );

  const snaps = await (db as any).getAll(...refs);

  const muted = new Set<string>();
  for (const s of snaps as FirebaseFirestore.DocumentSnapshot[]) {
    if (!s?.exists) continue;
    const d = s.data() as any;
    if (d?.muted === true) {
      const uid = uidFromChatPrefSnap(s);
      if (uid) muted.add(uid);
    }
  }
  return muted;
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

    // Safety: if legacy single token still equals this token, delete it.
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

async function sendExpoPushMany(messages: PushMessage[], tokenToUid?: Map<string, string>) {
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
 * ✅ Chat notifications + ✅ Match preview fields (lastMessage*) + ✅ Seq counters
 */
export const onMatchMessageCreate = onDocumentCreated("matchMessages/{msgId}", async (event) => {
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

  const createdAt = data?.createdAt ?? FieldValue.serverTimestamp();
  const previewText220 = truncate(text.trim(), 220);

  // --- claim notifications + update match preview + seq ---
  const txRes = await db.runTransaction(async (tx) => {
    const [msgSnap, matchSnap] = await Promise.all([tx.get(msgRef), tx.get(matchRef)]);
    if (!matchSnap.exists) return { ok: false as const, claimed: false, seq: 0 };

    const match = matchSnap.data() as any;
    const currentLastSeq = Number(match?.lastMessageSeq ?? 0);

    const msg = msgSnap.exists ? ((msgSnap.data() as any) ?? {}) : {};
    let seq = typeof msg?.seq === "number" ? msg.seq : null;

    if (seq == null || !Number.isFinite(seq)) {
      seq = currentLastSeq + 1;
      tx.set(msgRef, { seq }, { merge: true });
      tx.set(matchRef, { lastMessageSeq: seq }, { merge: true });
    }

    if (currentLastSeq <= seq) {
      tx.set(
        matchRef,
        {
          lastMessageSeq: Math.max(currentLastSeq, seq),
          lastMessageAt: createdAt,
          lastMessageText: previewText220,
          lastMessageSenderId: senderId,
          lastMessageSenderName: senderName,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    if (msg?.notifiedAt || msg?.notifyClaimedAt) {
      return { ok: true as const, claimed: false, seq };
    }

    tx.set(msgRef, { notifyClaimedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { ok: true as const, claimed: true, seq };
  });

  if (!txRes.ok) return;
  if (!txRes.claimed) return;

  // ---- Recipients (yes/maybe + host) ----
  const matchSnap = await matchRef.get();
  if (!matchSnap.exists) return;

  const match = matchSnap.data() as any;
  const hostId = match?.createdBy ? String(match.createdBy) : null;

  const rsvpSnap = await db.collection("rsvps").where("matchId", "==", matchId).get();

  const recipientIds: string[] = [];
  for (const d of rsvpSnap.docs) {
    const r = d.data() as any;
    const uid = r?.userId ? String(r.userId) : "";
    const st = String(r?.status ?? "").toLowerCase();
    if (!uid) continue;
    if (st === "yes" || st === "maybe") recipientIds.push(uid);
  }
  if (hostId) recipientIds.push(hostId);

  const finalRecipientIds = uniqStrings(recipientIds).filter((uid) => uid !== senderId);

  // ✅ mute set (by UID)
  let mutedSet = new Set<string>();
  try {
    mutedSet = await getMutedUidsForMatch(finalRecipientIds, matchId);
  } catch (e) {
    console.warn("getMutedUidsForMatch failed:", e);
    mutedSet = new Set<string>();
  }

  const recipientsAfterMute = finalRecipientIds.filter((uid) => !mutedSet.has(uid));

  // ✅ IMPORTANT FIX:
  // Token-level mute suppression in case the same Expo Go token is stored under multiple users.
  // If ANY owner UID of a token is muted for this match, we skip that token entirely.
  const tokensByUid = new Map<string, string[]>();
  const tokenOwners = new Map<string, Set<string>>();

  for (const uid of finalRecipientIds) {
    const tokens = await getUserTokens(uid);
    tokensByUid.set(uid, tokens);

    for (const t of tokens) {
      if (!tokenOwners.has(t)) tokenOwners.set(t, new Set<string>());
      tokenOwners.get(t)!.add(uid);
    }
  }

  const mutedTokens = new Set<string>();
  for (const [t, owners] of tokenOwners.entries()) {
    for (const ownerUid of owners) {
      if (mutedSet.has(ownerUid)) {
        mutedTokens.add(t);
        break;
      }
    }
  }

  // ---- Token-level exclusion + de-dupe ----
  const senderTokens = await getUserTokens(senderId);
  const senderTokenSet = new Set(senderTokens);

  const pushes: PushMessage[] = [];
  const sentTokens = new Set<string>();
  const tokenToUid = new Map<string, string>();

  const body = truncate(text.trim(), 180);
  const title = "Match Chat";

  let mutedTokenSkipHits = 0;

  for (const uid of recipientsAfterMute) {
    const tokens = tokensByUid.get(uid) ?? [];

    for (const t of tokens) {
      if (senderTokenSet.has(t)) continue;

      // ✅ Skip tokens that belong to ANY muted UID (prevents cross-account token leakage)
      if (mutedTokens.has(t)) {
        mutedTokenSkipHits++;
        continue;
      }

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

  // write debug counters so you can verify what happened per message
  await msgRef.set(
    {
      notifyRecipientCountBeforeMute: finalRecipientIds.length,
      notifyRecipientCountAfterMute: recipientsAfterMute.length,
      notifyMutedSkippedCount: mutedSet.size,
      notifyMutedTokenCount: mutedTokens.size,
      notifyMutedTokenSkipHits: mutedTokenSkipHits,
    },
    { merge: true }
  );

  if (pushes.length === 0) {
    await msgRef.set(
      { notifiedAt: FieldValue.serverTimestamp(), notifyTokenCount: 0 },
      { merge: true }
    );
    return;
  }

  await sendExpoPushMany(pushes, tokenToUid);

  await msgRef.set(
    { notifiedAt: FieldValue.serverTimestamp(), notifyTokenCount: pushes.length },
    { merge: true }
  );
});

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
