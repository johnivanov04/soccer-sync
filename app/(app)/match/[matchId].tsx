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
import {
  Alert,
  Button,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useAuth } from "../../../src/context/AuthContext";
import { db } from "../../../src/firebaseConfig";

const RSVP_STATUSES = ["yes", "maybe", "no"] as const;
type RsvpStatus = (typeof RSVP_STATUSES)[number];
type MatchStatus = "scheduled" | "played" | "cancelled";

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
  const [rsvps, setRsvps] = useState<Rsvp[]>([]);
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

  const handleUpdateStatus = async (newStatus: MatchStatus) => {
    if (!matchId) return;
    try {
      const matchRef = doc(db, "matches", String(matchId));
      await updateDoc(matchRef, {
        status: newStatus,
        ...(newStatus === "played" ? { playedAt: new Date() } : {}),
      });

      setMatch((prev: any) =>
        prev ? { ...prev, status: newStatus } : prev
      );
    } catch (err) {
      console.error("Error updating match status", err);
      Alert.alert("Error", "Could not update match status.");
    }
  };

  const confirmCancel = () => {
    Alert.alert(
      "Cancel match?",
      "Players will see this match as cancelled.",
      [
        { text: "Never mind", style: "cancel" },
        {
          text: "Cancel match",
          style: "destructive",
          onPress: () => handleUpdateStatus("cancelled"),
        },
      ]
    );
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
  const status: MatchStatus = (match.status as MatchStatus) || "scheduled";
  const isHost = !!user && match.createdBy === user.uid;

  const statusLabel =
    status === "scheduled"
      ? "Scheduled"
      : status === "played"
      ? "Played"
      : "Cancelled";

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>
        {date.toLocaleDateString()}{" "}
        {date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </Text>
      <Text style={styles.location}>{match.locationText}</Text>

      <Text style={styles.statusLine}>Status: {statusLabel}</Text>

      <Text style={{ marginTop: 12 }}>
        {going.length}/{match.maxPlayers} going
      </Text>

      <Text style={styles.sectionTitle}>Your RSVP</Text>
      <View style={styles.rsvpRow}>
        {RSVP_STATUSES.map((statusOption) => (
          <Button
            key={statusOption}
            title={statusOption.toUpperCase()}
            color={userStatus === statusOption ? "#007AFF" : "#aaa"}
            onPress={() => handleRsvp(statusOption)}
          />
        ))}
      </View>

      <Text style={styles.sectionTitle}>Going</Text>
      {going.length === 0 && <Text>No confirmed players yet.</Text>}
      {going.map((r) => (
        <Text key={r.id}>{r.playerName || r.userId}</Text>
      ))}

      {isHost && (
        <>
          <Text style={styles.sectionTitle}>Host controls</Text>
          <View style={styles.hostButtons}>
            <Button
              title="Mark as played"
              onPress={() => handleUpdateStatus("played")}
            />
            <View style={{ width: 12 }} />
            <Button
              title="Cancel match"
              color="#d11"
              onPress={confirmCancel}
            />
          </View>
        </>
      )}

      <View style={{ height: 40 }} />
      <Button title="Back to matches" onPress={() => router.back()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16 },
  title: { fontSize: 20, fontWeight: "bold" },
  location: { marginTop: 4, color: "#666" },
  statusLine: { marginTop: 8, color: "#555", fontSize: 13 },
  sectionTitle: { marginTop: 16, fontWeight: "600" },
  rsvpRow: {
    flexDirection: "row",
    justifyContent: "space-around",
    marginTop: 8,
  },
  hostButtons: {
    flexDirection: "row",
    marginTop: 8,
    justifyContent: "flex-start",
    alignItems: "center",
  },
});
