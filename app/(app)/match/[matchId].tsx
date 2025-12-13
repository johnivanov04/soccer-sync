// app/(app)/match/[matchId].tsx
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";

import React, { useEffect, useState } from "react";
import { Button, ScrollView, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../../src/context/AuthContext";
import { db } from "../../../src/firebaseConfig";

const RSVP_STATUSES = ["yes", "maybe", "no"] as const;
type RsvpStatus = (typeof RSVP_STATUSES)[number];

type Rsvp = {
  id: string;
  userId?: string;
  status?: RsvpStatus;
  playerName?: string;
};

export default function MatchDetailScreen() {
  const { matchId } = useLocalSearchParams();
  const { user } = useAuth();
  const router = useRouter();

  const [match, setMatch] = useState<any | null>(null);
  const [rsvps, setRsvps] = useState<Rsvp[]>([]);   // 👈 typed
  const [userStatus, setUserStatus] = useState<RsvpStatus | null>(null);

  useEffect(() => {
    if (!matchId) return;

    const matchRef = doc(db, "matches", String(matchId));
    getDoc(matchRef).then((snap) => {
      if (snap.exists()) {
        setMatch({ id: snap.id, ...snap.data() });
      } else {
        setMatch(null);
      }
    });

    const rsvpsCol = collection(db, "rsvps");
    const q = query(rsvpsCol, where("matchId", "==", String(matchId)));

    const unsub = onSnapshot(q, (snapshot) => {
      const list: Rsvp[] = snapshot.docs.map((d) => ({
        id: d.id,
        ...(d.data() as any),
      }));
      setRsvps(list);
      const mine = list.find((r) => r.userId === user?.uid);
      setUserStatus((mine?.status as RsvpStatus | undefined) ?? null);
    });

    return () => unsub();
  }, [matchId, user?.uid]);

  const recomputeYesCount = async () => {
    try {
      const rsvpsCol = collection(db, "rsvps");
      const yesQuery = query(
        rsvpsCol,
        where("matchId", "==", String(matchId)),
        where("status", "==", "yes")
      );

      const yesSnap = await getDocs(yesQuery);
      const matchRef = doc(db, "matches", String(matchId));

      await updateDoc(matchRef, {
        confirmedYesCount: yesSnap.size,
      });
    } catch (err) {
      console.error("Error recomputing YES count", err);
    }
  };


  // 👇 type the status param
  const handleRsvp = async (status: RsvpStatus) => {
  if (!user) return;

  try {
    const rsvpId = `${matchId}_${user.uid}`;
    const rsvpRef = doc(db, "rsvps", rsvpId);

    // Try to pull a friendly name from /users/{uid}
    let playerName = user.email ?? user.uid;

    try {
      const userDocRef = doc(db, "users", user.uid);
      const snap = await getDoc(userDocRef);
      if (snap.exists()) {
        const data = snap.data() as any;
        if (data?.displayName) {
          playerName = data.displayName;
        }
      }
    } catch (innerErr) {
      console.warn("Could not load user profile for RSVP", innerErr);
    }

    await setDoc(
      rsvpRef,
      {
        matchId: String(matchId),
        userId: user.uid,
        playerName,
        status,
        updatedAt: new Date(),
      },
      { merge: true }
    );

    setUserStatus(status);
    await recomputeYesCount();
  } catch (e) {
    console.error(e);
  }
};


  if (!match) {
    return (
      <View style={styles.container}>
        <Text>Loading match...</Text>
      </View>
    );
  }

  const date =
    match.startDateTime?.toDate?.() || new Date(match.startDateTime);
  const going = rsvps.filter((r) => r.status === "yes");

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>
        {date.toLocaleDateString()}{" "}
        {date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </Text>
      <Text style={styles.location}>{match.locationText}</Text>

      <Text style={{ marginTop: 12 }}>
        {going.length}/{match.maxPlayers} going
      </Text>

      <Text style={styles.sectionTitle}>Your RSVP</Text>
      <View style={styles.rsvpRow}>
        {RSVP_STATUSES.map((status) => (
          <Button
            key={status}
            title={status.toUpperCase()}
            color={userStatus === status ? "#007AFF" : "#aaa"}
            onPress={() => handleRsvp(status)}
          />
        ))}
      </View>

      <Text style={styles.sectionTitle}>Going</Text>
      {going.length === 0 && <Text>No confirmed players yet.</Text>}
      {going.map((r) => (
        <Text key={r.id}>{r.playerName || r.userId}</Text>
      ))}

      <View style={{ height: 40 }} />
      <Button title="Back to matches" onPress={() => router.back()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16 },
  title: { fontSize: 20, fontWeight: "bold" },
  location: { marginTop: 4, color: "#666" },
  sectionTitle: { marginTop: 16, fontWeight: "600" },
  rsvpRow: {
    flexDirection: "row",
    justifyContent: "space-around",
    marginTop: 8,
  },
});
