// src/services/rsvps.js
import {
    collection,
    doc,
    getDocs,
    query,
    setDoc,
    where,
} from "firebase/firestore";
import { db } from "../firebaseConfig";

export const setRsvp = async ({ matchId, userId, status }) => {
  const rsvpRef = doc(db, "rsvps", `${matchId}_${userId}`);

  await setDoc(
    rsvpRef,
    {
      matchId,
      userId,
      status,
      updatedAt: new Date(),
    },
    { merge: true }
  );
};

export const fetchRsvpsForMatch = async (matchId) => {
  const rsvpsCol = collection(db, "rsvps");
  const q = query(rsvpsCol, where("matchId", "==", matchId));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
};
