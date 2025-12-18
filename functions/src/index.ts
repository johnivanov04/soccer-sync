import * as admin from "firebase-admin";
import { onDocumentWritten } from "firebase-functions/v2/firestore";

admin.initializeApp();
const db = admin.firestore();

function uniqStrings(xs: any[]): string[] {
  return Array.from(
    new Set(xs.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()))
  );
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
