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

type Rsvp = {
  id: string;
  userId?: string;
  playerName?: string;
  status?: RsvpStatus;
  isWaitlisted?: boolean;
};

export default function MatchDetailScreen() {
  const { matchId } = useLocalSearchParams();
  const { user } = useAuth();
  const router = useRouter();

  const [match, setMatch] = useState<any | null>(null);
  const [rsvps, setRsvps] = useState<Rsvp[]>([]);
  const [userStatus, setUserStatus] = useState<RsvpStatus | null>(null);
  const [loadingMatch, setLoadingMatch] = useState(true);

  // Load match + live RSVPs
  useEffect(() => {
    if (!matchId) return;

    const matchRef = doc(db, "matches", String(matchId));

    const loadMatch = async () => {
      try {
        const snap = await getDoc(matchRef);
        if (snap.exists()) {
          setMatch({ id: snap.id, ...snap.data() });
        } else {
          setMatch(null);
        }
      } catch (err) {
        console.error("Error loading match", err);
        setMatch(null);
      } finally {
        setLoadingMatch(false);
      }
    };

    loadMatch();

    const rsvpsCol = collection(db, "rsvps");
    const q = query(rsvpsCol, where("matchId", "==", String(matchId)));

    const unsub = onSnapshot(q, (snapshot) => {
      const list: Rsvp[] = snapshot.docs.map((d) => {
        const data = d.data() as any;
        return {
          id: d.id,
          userId: data.userId,
          playerName: data.playerName,
          status: data.status as RsvpStatus,
          isWaitlisted: data.isWaitlisted ?? false,
        };
      });

      setRsvps(list);

      if (user?.uid) {
        const mine = list.find((r) => r.userId === user.uid);
        setUserStatus((mine?.status as RsvpStatus | undefined) ?? null);
      }
    });

    return () => unsub();
  }, [matchId, user?.uid]);

  // Recompute confirmed / waitlist counts on the match doc
  const recomputeYesCount = async () => {
    try {
      const rsvpsCol = collection(db, "rsvps");

      const confirmedQuery = query(
        rsvpsCol,
        where("matchId", "==", String(matchId)),
        where("status", "==", "yes"),
        where("isWaitlisted", "==", false)
      );

      const waitlistQuery = query(
        rsvpsCol,
        where("matchId", "==", String(matchId)),
        where("status", "==", "yes"),
        where("isWaitlisted", "==", true)
      );

      const [confirmedSnap, waitlistSnap] = await Promise.all([
        getDocs(confirmedQuery),
        getDocs(waitlistQuery),
      ]);

      const matchRef = doc(db, "matches", String(matchId));
      await updateDoc(matchRef, {
        confirmedYesCount: confirmedSnap.size,
        waitlistCount: waitlistSnap.size,
      });
    } catch (err) {
      console.error("Error recomputing YES count", err);
    }
  };

  const handleRsvp = async (status: RsvpStatus) => {
    if (!user) return;

    try {
      const matchRef = doc(db, "matches", String(matchId));
      const matchSnap = await getDoc(matchRef);

      if (!matchSnap.exists()) {
        Alert.alert("Match not found");
        return;
      }

      const matchData = matchSnap.data() as any;
      const maxPlayers: number = matchData.maxPlayers ?? 0;

      // Status-based blocking (cancelled / played)
      const matchStatus = matchData.status ?? "scheduled";
      if (matchStatus === "cancelled") {
        Alert.alert("Match cancelled", "You can’t change RSVP for a cancelled match.");
        return;
      }
      if (matchStatus === "played") {
        Alert.alert("Match already played", "This match is finished.");
        return;
      }

      // Deadline-based blocking (UI guard; we also do logic inside stats)
      if (matchData.rsvpDeadline) {
        const deadline =
          typeof matchData.rsvpDeadline.toDate === "function"
            ? matchData.rsvpDeadline.toDate()
            : new Date(matchData.rsvpDeadline);

        if (new Date() > deadline) {
          Alert.alert(
            "RSVP closed",
            "The RSVP deadline has passed. Ask the organizer directly if you still want to join."
          );
          return;
        }
      }

      const rsvpId = `${matchId}_${user.uid}`;
      const rsvpRef = doc(db, "rsvps", rsvpId);

      // Decide if this RSVP should be waitlisted
      let isWaitlisted = false;

      if (status === "yes") {
        const rsvpsCol = collection(db, "rsvps");
        const confirmedQuery = query(
          rsvpsCol,
          where("matchId", "==", String(matchId)),
          where("status", "==", "yes"),
          where("isWaitlisted", "==", false)
        );
        const confirmedSnap = await getDocs(confirmedQuery);
        const confirmedCount = confirmedSnap.size;

        if (confirmedCount >= maxPlayers) {
          isWaitlisted = true;
        }
      }

      // Get player name from /users/{uid}
      let playerName = user.email ?? user.uid;
      try {
        const userDocRef = doc(db, "users", user.uid);
        const userSnap = await getDoc(userDocRef);
        if (userSnap.exists()) {
          const data = userSnap.data() as any;
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
          isWaitlisted,
          updatedAt: new Date(),
        },
        { merge: true }
      );

      setUserStatus(status);
      await recomputeYesCount();

      if (status === "yes" && isWaitlisted) {
        Alert.alert(
          "You’re on the waitlist",
          "This match is already full. If someone drops, you’ll move into a confirmed spot."
        );
      }
    } catch (e) {
      console.error(e);
      Alert.alert("Error", "Could not update RSVP right now.");
    }
  };

  if (loadingMatch || !match) {
    return (
      <View style={styles.container}>
        <Text>Loading match...</Text>
      </View>
    );
  }

  const date =
    match.startDateTime?.toDate?.() || new Date(match.startDateTime);

  const going = rsvps.filter((r) => r.status === "yes" && !r.isWaitlisted);
  const waitlist = rsvps.filter((r) => r.status === "yes" && r.isWaitlisted);

  const myRsvp = rsvps.find((r) => r.userId === user?.uid);
  const userWaitlisted = myRsvp?.isWaitlisted ?? false;

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

      <Text style={styles.userStatusNote}>
        {userStatus === "yes"
          ? userWaitlisted
            ? "You’re on the waitlist for this match."
            : "You’re confirmed for this match."
          : "Tap YES, MAYBE, or NO to update your status."}
      </Text>

      <Text style={styles.sectionTitle}>Going</Text>
      {going.length === 0 && <Text>No confirmed players yet.</Text>}
      {going.map((r) => (
        <Text key={r.id}>{r.playerName || r.userId}</Text>
      ))}

      {waitlist.length > 0 && (
        <>
          <Text style={styles.sectionTitle}>Waitlist</Text>
          {waitlist.map((r) => (
            <Text key={r.id}>{r.playerName || r.userId}</Text>
          ))}
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
  sectionTitle: { marginTop: 16, fontWeight: "600" },
  rsvpRow: {
    flexDirection: "row",
    justifyContent: "space-around",
    marginTop: 8,
  },
  userStatusNote: {
    marginTop: 8,
    textAlign: "center",
    color: "#555",
    fontSize: 13,
  },
});
