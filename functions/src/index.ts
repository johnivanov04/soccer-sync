import * as crypto from "crypto";
import * as admin from "firebase-admin";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";

admin.initializeApp();
const db = admin.firestore();
const { FieldValue } = admin.firestore;

// -------------------- shared helpers --------------------
function uniqStrings(xs: any[]): string[] {
  return Array.from(
    new Set(
      (xs ?? [])
        .filter((x) => typeof x === "string" && x.trim())
        .map((x) => x.trim())
    )
  );
}

export function truncate(s: string, n: number) {
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
export async function getMutedUidsForMatch(uids: string[], matchId: string): Promise<Set<string>> {
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

// -------------------- OPTION 1 helper: ALL ACTIVE TEAM MEMBERS --------------------
export async function getActiveTeamMemberUids(teamId: string): Promise<string[]> {
  const tid = String(teamId ?? "").trim();
  if (!tid) return [];

  const snap = await db
    .collection("memberships")
    .where("teamId", "==", tid)
    .where("status", "==", "active")
    .get();

  const out: string[] = [];
  for (const d of snap.docs) {
    const m = d.data() as any;

    let uid = m?.userId ? String(m.userId) : "";

    if (!uid && typeof d.id === "string" && d.id.startsWith(`${tid}_`)) {
      uid = d.id.slice(`${tid}_`.length);
    }

    if (uid) out.push(uid);
  }

  return uniqStrings(out);
}

// -------------------- OPTION 5: TEAMS + MEMBERSHIPS --------------------
function normalizeCode(raw: any) {
  return String(raw ?? "").trim().toLowerCase();
}
function isValidTeamCode(code: string) {
  return /^[a-z0-9-]{3,24}$/.test(code);
}
function membershipDocId(teamId: string, uid: string) {
  return `${teamId}_${uid}`;
}
async function requireAuth(req: any) {
  const uid = req?.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");
  return String(uid);
}
function randomInviteCode() {
  return crypto.randomBytes(6).toString("hex"); // 12 chars
}

async function getUserTeamIdQuick(uid: string): Promise<string | null> {
  const u = await db.collection("users").doc(uid).get();
  if (!u.exists) return null;
  const d = u.data() as any;
  return d?.teamId ? String(d.teamId) : null;
}

async function getAnyActiveMembershipTeamId(uid: string): Promise<string | null> {
  const q = await db
    .collection("memberships")
    .where("userId", "==", uid)
    .where("status", "==", "active")
    .limit(1)
    .get();
  if (q.empty) return null;
  const m = q.docs[0].data() as any;
  return m?.teamId ? String(m.teamId) : null;
}

async function getMembership(teamId: string, uid: string) {
  const id = membershipDocId(teamId, uid);
  const ref = db.collection("memberships").doc(id);
  const snap = await ref.get();
  const data = snap.exists ? (snap.data() as any) : null;
  return { ref, snap, data };
}

async function requireAdminOrOwner(teamId: string, uid: string) {
  const { data } = await getMembership(teamId, uid);
  if (!data || data.status !== "active") {
    throw new HttpsError("permission-denied", "Not an active member.");
  }
  if (data.role !== "owner" && data.role !== "admin") {
    throw new HttpsError("permission-denied", "Admin/owner required.");
  }
  return data;
}

// ✅ NEW: owner-only helper
async function requireOwner(teamId: string, uid: string) {
  const { data } = await getMembership(teamId, uid);
  if (!data || data.status !== "active") {
    throw new HttpsError("permission-denied", "Not an active member.");
  }
  if (data.role !== "owner") {
    throw new HttpsError("permission-denied", "Owner required.");
  }
  return data;
}

async function getUserIdentitySnapshot(uid: string) {
  let userEmail = "";
  let userDisplayName = "";
  try {
    const u = await admin.auth().getUser(uid);
    userEmail = u.email ?? "";
    userDisplayName = u.displayName ?? "";
  } catch {
    try {
      const s = await db.collection("users").doc(uid).get();
      if (s.exists) {
        const d = s.data() as any;
        userEmail = String(d?.email ?? userEmail);
        userDisplayName = String(d?.displayName ?? userDisplayName);
      }
    } catch {}
  }
  return { userEmail, userDisplayName };
}

/**
 * createTeam({ name, code })
 */
export const createTeam = onCall(async (req) => {
  const uid = await requireAuth(req);

  const name = String(req.data?.name ?? "").trim();
  const code = normalizeCode(req.data?.code);

  if (!name) throw new HttpsError("invalid-argument", "Team name required.");
  if (!code) throw new HttpsError("invalid-argument", "Team code required.");
  if (!isValidTeamCode(code)) throw new HttpsError("invalid-argument", "Invalid team code.");

  const currentTeamId = (await getUserTeamIdQuick(uid)) ?? (await getAnyActiveMembershipTeamId(uid));
  if (currentTeamId) throw new HttpsError("failed-precondition", "Leave your current team first.");

  const teamRef = db.collection("teams").doc(code);
  const existing = await teamRef.get();
  if (existing.exists) throw new HttpsError("already-exists", "That team code is taken.");

  const inviteCode = code;
  const { userEmail, userDisplayName } = await getUserIdentitySnapshot(uid);

  const memRef = db.collection("memberships").doc(membershipDocId(code, uid));
  const userRef = db.collection("users").doc(uid);

  await db.runTransaction(async (tx) => {
    tx.set(teamRef, {
      name,
      code,
      inviteCode,
      createdBy: uid,
      ownerId: uid, // ✅ convenience
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    tx.set(memRef, {
      teamId: code,
      teamName: name,
      userId: uid,
      userEmail,
      userDisplayName,
      role: "owner",
      status: "active",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    tx.set(
      userRef,
      {
        teamId: code,
        teamName: name,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });

  return { teamId: code, teamName: name, inviteCode };
});

/**
 * joinTeamWithCode({ code })
 */
export const joinTeamWithCode = onCall(async (req) => {
  const uid = await requireAuth(req);

  const code = normalizeCode(req.data?.code);
  if (!code) throw new HttpsError("invalid-argument", "Code required.");
  if (!isValidTeamCode(code)) throw new HttpsError("invalid-argument", "Invalid code.");

  const currentTeamId = (await getUserTeamIdQuick(uid)) ?? (await getAnyActiveMembershipTeamId(uid));
  if (currentTeamId) throw new HttpsError("failed-precondition", "You’re already in a team. Leave first.");

  const q = await db.collection("teams").where("inviteCode", "==", code).limit(1).get();
  if (q.empty) throw new HttpsError("not-found", "Invite code is invalid.");

  const t = q.docs[0];
  const teamId = t.id;
  const teamName = String((t.data() as any)?.name ?? teamId);

  const memId = membershipDocId(teamId, uid);
  const memRef = db.collection("memberships").doc(memId);
  const memSnap = await memRef.get();

  if (memSnap.exists) {
    const m = memSnap.data() as any;
    return { teamId, teamName, status: m?.status ?? "pending" };
  }

  const { userEmail, userDisplayName } = await getUserIdentitySnapshot(uid);

  await memRef.set({
    teamId,
    teamName,
    userId: uid,
    userEmail,
    userDisplayName,
    role: "member",
    status: "pending",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return { teamId, teamName, status: "pending" };
});

export const cancelMyPendingMembership = onCall(async (req) => {
  const uid = await requireAuth(req);
  const teamId = normalizeCode(req.data?.teamId);
  if (!teamId) throw new HttpsError("invalid-argument", "teamId required.");

  const { ref, data } = await getMembership(teamId, uid);
  if (!data || data.status !== "pending") return { ok: true };

  await ref.set({ status: "left", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true };
});

export const approveMembership = onCall(async (req) => {
  const uid = await requireAuth(req);

  const teamId = normalizeCode(req.data?.teamId);
  const userId = String(req.data?.userId ?? "").trim();
  if (!teamId || !userId) throw new HttpsError("invalid-argument", "teamId and userId required.");

  await requireAdminOrOwner(teamId, uid);

  const targetCurrentTeam =
    (await getUserTeamIdQuick(userId)) ?? (await getAnyActiveMembershipTeamId(userId));
  if (targetCurrentTeam) {
    throw new HttpsError("failed-precondition", "That user is already in a team.");
  }

  const memRef = db.collection("memberships").doc(membershipDocId(teamId, userId));
  const memSnap = await memRef.get();
  if (!memSnap.exists) throw new HttpsError("not-found", "Membership request not found.");

  const m = memSnap.data() as any;
  if (m.status !== "pending") return { ok: true };

  const teamRef = db.collection("teams").doc(teamId);
  const teamSnap = await teamRef.get();
  const teamName = teamSnap.exists ? String((teamSnap.data() as any)?.name ?? teamId) : teamId;

  const targetUserRef = db.collection("users").doc(userId);

  await db.runTransaction(async (tx) => {
    tx.set(memRef, { status: "active", teamName, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.set(targetUserRef, { teamId, teamName, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });

  return { ok: true };
});

export const denyMembership = onCall(async (req) => {
  const uid = await requireAuth(req);

  const teamId = normalizeCode(req.data?.teamId);
  const userId = String(req.data?.userId ?? "").trim();
  if (!teamId || !userId) throw new HttpsError("invalid-argument", "teamId and userId required.");

  await requireAdminOrOwner(teamId, uid);

  const memRef = db.collection("memberships").doc(membershipDocId(teamId, userId));
  const memSnap = await memRef.get();
  if (!memSnap.exists) return { ok: true };

  await memRef.set({ status: "removed", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true };
});

export const leaveTeam = onCall(async (req) => {
  const uid = await requireAuth(req);

  let teamId = await getUserTeamIdQuick(uid);
  if (!teamId) teamId = await getAnyActiveMembershipTeamId(uid);
  if (!teamId) return { ok: true };

  const { ref: memRef, data } = await getMembership(teamId, uid);
  if (data?.role === "owner") {
    throw new HttpsError("failed-precondition", "Owners can’t leave their team (transfer ownership first).");
  }

  const userRef = db.collection("users").doc(uid);

  await db.runTransaction(async (tx) => {
    tx.set(memRef, { status: "left", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.set(
      userRef,
      {
        teamId: FieldValue.delete(),
        teamName: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });

  return { ok: true };
});

export const kickMember = onCall(async (req) => {
  const uid = await requireAuth(req);

  const teamId = normalizeCode(req.data?.teamId);
  const userId = String(req.data?.userId ?? "").trim();
  if (!teamId || !userId) throw new HttpsError("invalid-argument", "teamId and userId required.");
  if (userId === uid) throw new HttpsError("invalid-argument", "You can’t remove yourself.");

  const me = await requireAdminOrOwner(teamId, uid);

  const targetMemRef = db.collection("memberships").doc(membershipDocId(teamId, userId));
  const targetMemSnap = await targetMemRef.get();
  if (!targetMemSnap.exists) return { ok: true };

  const targetMem = targetMemSnap.data() as any;

  if (targetMem.role === "owner") throw new HttpsError("failed-precondition", "Can’t remove the owner.");

  // ✅ NEW: admins cannot remove admins (owner can)
  if (me.role === "admin" && targetMem.role === "admin") {
    throw new HttpsError("permission-denied", "Only the owner can remove an admin.");
  }

  const targetUserRef = db.collection("users").doc(userId);

  await db.runTransaction(async (tx) => {
    tx.set(targetMemRef, { status: "removed", updatedAt: FieldValue.serverTimestamp() }, { merge: true });

    const u = await tx.get(targetUserRef);
    const currentTeamId = u.exists ? String((u.data() as any)?.teamId ?? "") : "";
    if (currentTeamId === teamId) {
      tx.set(
        targetUserRef,
        {
          teamId: FieldValue.delete(),
          teamName: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
  });

  return { ok: true };
});

export const rotateInviteCode = onCall(async (req) => {
  const uid = await requireAuth(req);
  const teamId = normalizeCode(req.data?.teamId);
  if (!teamId) throw new HttpsError("invalid-argument", "teamId required.");

  await requireAdminOrOwner(teamId, uid);

  const inviteCode = randomInviteCode();
  await db.collection("teams").doc(teamId).set(
    {
      inviteCode,
      inviteCodeUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return { inviteCode };
});

// ✅ NEW: Promote to admin (owner-only)
export const promoteAdmin = onCall(async (req) => {
  const uid = await requireAuth(req);

  const teamId = normalizeCode(req.data?.teamId);
  const targetUid = String(req.data?.targetUid ?? "").trim();
  if (!teamId || !targetUid) throw new HttpsError("invalid-argument", "teamId and targetUid required.");

  await requireOwner(teamId, uid);

  const target = await getMembership(teamId, targetUid);
  if (!target.data || target.data.status !== "active") {
    throw new HttpsError("failed-precondition", "Target is not an active member.");
  }
  if (target.data.role === "owner") {
    throw new HttpsError("failed-precondition", "Target is already the owner.");
  }
  if (target.data.role === "admin") return { ok: true };

  await target.ref.set(
    { role: "admin", updatedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );

  return { ok: true };
});

// ✅ NEW: Demote admin to member (owner-only)
export const demoteAdmin = onCall(async (req) => {
  const uid = await requireAuth(req);

  const teamId = normalizeCode(req.data?.teamId);
  const targetUid = String(req.data?.targetUid ?? "").trim();
  if (!teamId || !targetUid) throw new HttpsError("invalid-argument", "teamId and targetUid required.");

  await requireOwner(teamId, uid);

  const target = await getMembership(teamId, targetUid);
  if (!target.data || target.data.status !== "active") {
    throw new HttpsError("failed-precondition", "Target is not an active member.");
  }
  if (target.data.role === "owner") {
    throw new HttpsError("failed-precondition", "Cannot demote the owner.");
  }
  if (target.data.role !== "admin") return { ok: true };

  await target.ref.set(
    { role: "member", updatedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );

  return { ok: true };
});

// ✅ NEW: Transfer ownership (owner-only, transactional)
export const transferOwnership = onCall(async (req) => {
  const uid = await requireAuth(req);

  const teamId = normalizeCode(req.data?.teamId);
  const newOwnerUid = String(req.data?.newOwnerUid ?? "").trim();
  if (!teamId || !newOwnerUid) throw new HttpsError("invalid-argument", "teamId and newOwnerUid required.");
  if (newOwnerUid === uid) return { ok: true };

  await requireOwner(teamId, uid);

  const oldOwnerRef = db.collection("memberships").doc(membershipDocId(teamId, uid));
  const newOwnerRef = db.collection("memberships").doc(membershipDocId(teamId, newOwnerUid));
  const teamRef = db.collection("teams").doc(teamId);

  await db.runTransaction(async (tx) => {
    const [oldSnap, newSnap] = await Promise.all([tx.get(oldOwnerRef), tx.get(newOwnerRef)]);
    if (!oldSnap.exists) throw new HttpsError("failed-precondition", "Owner membership missing.");
    if (!newSnap.exists) throw new HttpsError("failed-precondition", "New owner membership missing.");

    const oldData = oldSnap.data() as any;
    const newData = newSnap.data() as any;

    if (oldData.status !== "active" || oldData.role !== "owner") {
      throw new HttpsError("permission-denied", "Owner required.");
    }
    if (newData.status !== "active") {
      throw new HttpsError("failed-precondition", "New owner must be an active member.");
    }
    if (newData.role === "owner") return;

    tx.set(newOwnerRef, { role: "owner", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.set(oldOwnerRef, { role: "admin", updatedAt: FieldValue.serverTimestamp() }, { merge: true });

    tx.set(
      teamRef,
      {
        ownerId: newOwnerUid,
        ownerTransferredAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });

  return { ok: true };
});

/**
 * Sync users/{uid}.teamId/teamName from memberships (source of truth)
 */
export const onMembershipWriteSyncUser = onDocumentWritten("memberships/{id}", async (event) => {
  const before = event.data?.before?.data() as any | undefined;
  const after = event.data?.after?.data() as any | undefined;

  const m = after ?? before;
  if (!m?.teamId || !m?.userId) return;

  const teamId = String(m.teamId);
  const userId = String(m.userId);

  const beforeStatus = String(before?.status ?? "");
  const afterStatus = String(after?.status ?? "");

  if (beforeStatus === afterStatus && beforeStatus) return;

  const userRef = db.collection("users").doc(userId);

  if (afterStatus === "active") {
    const teamSnap = await db.collection("teams").doc(teamId).get();
    const teamName = teamSnap.exists ? String((teamSnap.data() as any)?.name ?? teamId) : teamId;

    await userRef.set(
      {
        teamId,
        teamName,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return;
  }

  if (afterStatus === "removed" || afterStatus === "left") {
    const u = await userRef.get();
    const currentTeamId = u.exists ? String((u.data() as any)?.teamId ?? "") : "";
    if (currentTeamId === teamId) {
      await userRef.set(
        {
          teamId: FieldValue.delete(),
          teamName: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
  }
});

// -------------------- MATCH COUNTS + WAITLIST PROMOTION --------------------
// (rest of your file unchanged)
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

// ... everything after this remains exactly as you had it ...
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
