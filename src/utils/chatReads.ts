// src/utils/chatReads.ts
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { auth, db } from "../firebaseConfig";

/**
 * Writes the user's "last read" state for a match chat.
 * - Uses serverTimestamp() so rules that validate timestamps pass on cold start.
 * - Writes only fields allowed by rules.
 * - Avoids increment(), Date.now(), and extra keys that often trigger permission errors.
 */
export async function markChatReadNow(matchId: string, lastSeq: number) {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  if (!matchId) return;

  const seq = Number.isFinite(lastSeq) ? Math.max(0, Math.floor(lastSeq)) : 0;

  const ref = doc(db, "users", uid, "chatReads", matchId);

  await setDoc(
    ref,
    {
      lastReadAt: serverTimestamp(),
      lastReadSeq: seq,
      updatedAt: serverTimestamp(),
      // Optional metadata is allowed by rules now, but not required:
      // matchId,
      // userId: uid,
    },
    { merge: true }
  );
}
