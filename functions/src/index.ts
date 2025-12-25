import * as admin from "firebase-admin";
import { onDocumentCreated, onDocumentWritten } from "firebase-functions/v2/firestore";

admin.initializeApp();
const db = admin.firestore();

function uniqStrings(xs: any[]): string[] {
  return Array.from(
    new Set(xs.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()))
  );
}

function truncate(s: string, n: number) {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

async function sendExpoPushMany(messages: any[]) {
  if (!messages || messages.length === 0) return;

  const res = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(messages),
  });

  const json = await res.json();
  const tickets = json?.data;
  if (!tickets) throw new Error(`No Expo tickets returned: ${JSON.stringify(json)}`);

  const arr = Array.isArray(tickets) ? tickets : [tickets];
  for (const t of arr) {
    if (t?.status !== "ok") {
      console.warn("Expo ticket not ok:", t);
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
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
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

  // Earliest waitlisted YES first (requires composite index because of orderBy)
  const waitlistedSnap = await rsvpsCol
    .where("matchId", "==", matchId)
    .where("status", "==", "yes")
    .where("isWaitlisted", "==", true)
    .orderBy("updatedAt", "asc")
    .limit(openSlots)
    .get();

  if (waitlistedSnap.empty) return;

  const promotedUserIds: string[] = [];

  // Transaction per RSVP prevents double-promote under concurrency
  for (const docSnap of waitlistedSnap.docs) {
    const rsvpRef = docSnap.ref;

    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(rsvpRef);
      if (!fresh.exists) return;

      const data = fresh.data() as any;
      if (data?.isWaitlisted !== true) return;

      tx.update(rsvpRef, {
        isWaitlisted: false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      if (data?.userId) promotedUserIds.push(String(data.userId));
    });
  }

  // Send push to promoted users (all their tokens)
  const messages: any[] = [];

  for (const uid of uniqStrings(promotedUserIds)) {
    const userSnap = await db.collection("users").doc(uid).get();
    if (!userSnap.exists) continue;

    const u = userSnap.data() as any;
    const tokens = uniqStrings([
      ...(Array.isArray(u?.expoPushTokens) ? u.expoPushTokens : []),
      ...(u?.expoPushToken ? [u.expoPushToken] : []),
    ]);

    for (const t of tokens) {
      messages.push({
        to: t,
        title: "You’re in! ✅",
        body: "A spot opened up — you’re now confirmed for the match.",
        sound: "default",
        data: { kind: "promoted", matchId },
      });
    }
  }

  await sendExpoPushMany(messages);
}

/**
 * ✅ NEW: Chat notifications
 * Trigger when a message is CREATED in matchMessages.
 * Sends a push to:
 *  - everyone with an RSVP (yes/maybe) for that match
 *  - plus the match host (createdBy)
 *  - excluding the sender
 *
 * Push "data" includes { matchId, type: "chat" } so your app/_layout.tsx routes to chat.
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

    // Idempotency: if retried, don't double-send
    const fresh = await msgRef.get();
    const freshData = fresh.data() as any;
    if (freshData?.notifiedAt) return;

    // Load match (for createdBy / host)
    const matchSnap = await db.collection("matches").doc(matchId).get();
    const match = (matchSnap.exists ? (matchSnap.data() as any) : null) ?? null;
    const hostId = match?.createdBy ? String(match.createdBy) : null;

    // Collect recipients from RSVPs (yes/maybe)
    const rsvpSnap = await db.collection("rsvps").where("matchId", "==", matchId).get();

    const recipientIds: string[] = [];

    for (const d of rsvpSnap.docs) {
      const r = d.data() as any;
      const uid = r?.userId ? String(r.userId) : "";
      const st = String(r?.status ?? "").toLowerCase();
      if (!uid) continue;

      // Only notify people who actually care about the match
      if (st === "yes" || st === "maybe") recipientIds.push(uid);
    }

    if (hostId) recipientIds.push(hostId);

    // remove sender + uniq
    const finalRecipientIds = uniqStrings(recipientIds).filter((uid) => uid !== senderId);
    if (finalRecipientIds.length === 0) {
      // still mark as handled
      await msgRef.set(
        { notifiedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
      return;
    }

    // Build Expo pushes
    const pushes: any[] = [];
    const body = truncate(text.trim(), 180);
    const title = "Match Chat";

    for (const uid of finalRecipientIds) {
      const userSnap = await db.collection("users").doc(uid).get();
      if (!userSnap.exists) continue;

      const u = userSnap.data() as any;
      const tokens = uniqStrings([
        ...(Array.isArray(u?.expoPushTokens) ? u.expoPushTokens : []),
        ...(u?.expoPushToken ? [u.expoPushToken] : []),
      ]);

      for (const t of tokens) {
        pushes.push({
          to: t,
          title,
          body: `${senderName}: ${body}`,
          sound: "default",
          data: {
            matchId,
            type: "chat", // ✅ your app/_layout.tsx will route to chat
          },
        });
      }
    }

    await sendExpoPushMany(pushes);

    // mark handled (won't retrigger because this is onCreate)
    await msgRef.set(
      { notifiedAt: admin.firestore.FieldValue.serverTimestamp() },
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
