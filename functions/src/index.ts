import * as crypto from "crypto";
import * as admin from "firebase-admin";
import { onDocumentCreated, onDocumentWritten } from "firebase-functions/v2/firestore";
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
  // hex => [0-9a-f], valid under our regex
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

async function getUserIdentitySnapshot(uid: string) {
  let userEmail = "";
  let userDisplayName = "";
  try {
    const u = await admin.auth().getUser(uid);
    userEmail = u.email ?? "";
    userDisplayName = u.displayName ?? "";
  } catch {
    // fallback to Firestore user doc if needed
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
 * - creates teams/{code}
 * - creates memberships/{code}_{uid} as owner/active
 * - sets users/{uid}.teamId/teamName
 */
export const createTeam = onCall(async (req) => {
  const uid = await requireAuth(req);

  const name = String(req.data?.name ?? "").trim();
  const code = normalizeCode(req.data?.code);

  if (!name) throw new HttpsError("invalid-argument", "Team name required.");
  if (!code) throw new HttpsError("invalid-argument", "Team code required.");
  if (!isValidTeamCode(code)) throw new HttpsError("invalid-argument", "Invalid team code.");

  // Enforce single-team membership
  const currentTeamId = (await getUserTeamIdQuick(uid)) ?? (await getAnyActiveMembershipTeamId(uid));
  if (currentTeamId) throw new HttpsError("failed-precondition", "Leave your current team first.");

  const teamRef = db.collection("teams").doc(code);
  const existing = await teamRef.get();
  if (existing.exists) throw new HttpsError("already-exists", "That team code is taken.");

  const inviteCode = code; // start as same as teamId; rotate later
  const { userEmail, userDisplayName } = await getUserIdentitySnapshot(uid);

  const memRef = db.collection("memberships").doc(membershipDocId(code, uid));
  const userRef = db.collection("users").doc(uid);

  await db.runTransaction(async (tx) => {
    tx.set(teamRef, {
      name,
      code,
      inviteCode,
      createdBy: uid,
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
 * - resolves code to teams/{teamId} OR teams where inviteCode==code
 * - creates memberships/{teamId}_{uid} as member/pending
 */
export const joinTeamWithCode = onCall(async (req) => {
  const uid = await requireAuth(req);

  const code = normalizeCode(req.data?.code);
  if (!code) throw new HttpsError("invalid-argument", "Code required.");
  if (!isValidTeamCode(code)) throw new HttpsError("invalid-argument", "Invalid code.");

  // Enforce single-team membership
  const currentTeamId = (await getUserTeamIdQuick(uid)) ?? (await getAnyActiveMembershipTeamId(uid));
  if (currentTeamId) throw new HttpsError("failed-precondition", "You’re already in a team. Leave first.");

  // Resolve teamId
  let teamId: string | null = null;
  let teamName: string | null = null;

  const directRef = db.collection("teams").doc(code);
  const directSnap = await directRef.get();
  if (directSnap.exists) {
    teamId = directSnap.id;
    teamName = String((directSnap.data() as any)?.name ?? directSnap.id);
  } else {
    const q = await db.collection("teams").where("inviteCode", "==", code).limit(1).get();
    if (!q.empty) {
      const t = q.docs[0];
      teamId = t.id;
      teamName = String((t.data() as any)?.name ?? t.id);
    }
  }

  if (!teamId) throw new HttpsError("not-found", "Team not found.");

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

  // Prevent approving someone already in a team
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
    tx.set(
      targetUserRef,
      { teamId, teamName, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
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

  await requireAdminOrOwner(teamId, uid);

  const targetMemRef = db.collection("memberships").doc(membershipDocId(teamId, userId));
  const targetMemSnap = await targetMemRef.get();
  if (!targetMemSnap.exists) return { ok: true };

  const targetMem = targetMemSnap.data() as any;
  if (targetMem.role === "owner") throw new HttpsError("failed-precondition", "Can’t remove the owner.");

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

  // only act when status changes (or doc created/deleted)
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

// -------------------- CHAT NOTIFICATIONS + MATCH PREVIEW FIELDS + SEQ --------------------
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

  // ✅ Token-level mute suppression (handles Expo Go token shared across accounts)
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

// -------------------- RSVP WRITE TRIGGER --------------------
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
