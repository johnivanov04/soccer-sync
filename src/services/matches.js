// src/services/matches.js
import {
    addDoc,
    collection,
    doc,
    getDoc,
    getDocs,
    orderBy,
    query,
    serverTimestamp,
    updateDoc,
    where,
} from "firebase/firestore";
import { db } from "../firebaseConfig";

export const createMatch = async ({
  teamId,
  startDateTime,
  locationText,
  maxPlayers,
  rsvpDeadline,
  description,
}) => {
  const matchesCol = collection(db, "matches");

  const matchDoc = await addDoc(matchesCol, {
    teamId,
    startDateTime,
    locationText,
    maxPlayers,
    minPlayers: 8,
    rsvpDeadline,
    description: description || "",
    status: "published",
    confirmedYesCount: 0,
    maybeCount: 0,
    waitlistCount: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  return matchDoc.id;
};

export const fetchUpcomingMatchesForUser = async (teamIds) => {
  if (!teamIds || teamIds.length === 0) return [];
  const matchesCol = collection(db, "matches");

  // Simple version: query for first team; later you can use "in" or multi-query
  const q = query(
    matchesCol,
    where("teamId", "in", teamIds),
    orderBy("startDateTime", "asc")
  );

  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
};

export const fetchMatchById = async (matchId) => {
  const ref = doc(db, "matches", matchId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
};

export const updateMatchCounts = async (matchId, counts) => {
  const ref = doc(db, "matches", matchId);
  await updateDoc(ref, {
    ...counts,
    updatedAt: serverTimestamp(),
  });
};
