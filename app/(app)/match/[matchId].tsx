// app/(app)/match/[matchId].tsx
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
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
  const [rsvps, setRsvps] = useState<Rsvp[]>([]);
  const [userStatus, setUserStatus] = useState<RsvpStatus | null>(null);

  // Load match + RSVPs
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

  // Recompute confirmedYesCount on the match doc
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
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      console.error("Error recomputing YES count", err);
    }
  };

  // Save RSVP + friendly playerName
  const handleRsvp = async (status: RsvpStatus) => {
    if (!user) return;

    try {
      const rsvpId = `${matchId}_${user.uid}`;
      const rsvpRef = doc(db, "rsvps", rsvpId);

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

  // Host-only: update match status
  const handleUpdateStatus = async (newStatus: "played" | "cancelled") => {
    if (!matchId) return;
    try {
      const matchRef = doc(db, "matches", String(matchId));
      await updateDoc(matchRef, {
        status: newStatus,
        updatedAt: serverTimestamp(),
      });
      setMatch((prev: any) => (prev ? { ...prev, status: newStatus } : prev));
    } catch (err) {
      console.error("Error updating match status", err);
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

  // Status + host info
  const status: string = match.status ?? "scheduled";
  const isHost = !!user?.uid && match.createdBy === user.uid;
  const isScheduled = status === "scheduled";

  const statusLabel =
    status === "cancelled"
      ? "Cancelled"
      : status === "played"
      ? "Played"
      : "Scheduled";

  // Capacity / min players logic
  const confirmedYesCount: number =
    typeof match.confirmedYesCount === "number"
      ? match.confirmedYesCount
      : going.length;

  const maxPlayers: number = match.maxPlayers ?? 0;
  const minPlayers: number = match.minPlayers ?? 0;

  const isFull =
    isScheduled && maxPlayers > 0 && confirmedYesCount >= maxPlayers;
  const playersNeededForMin = Math.max(0, minPlayers - confirmedYesCount);

  // Per-button enable/disable logic
  const isRsvpEnabledForStatus = (statusOption: RsvpStatus) => {
    if (!isScheduled) return false;

    // If match is full, only allow:
    // - host to adjust
    // - a user who is already YES to change (YES -> maybe/no is allowed)
    if (statusOption === "yes" && isFull) {
      if (isHost) return true;
      if (userStatus === "yes") return true; // lets them back out
      return false; // can't newly switch to YES when full
    }

    return true;
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>
        {date.toLocaleDateString()}{" "}
        {date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </Text>
      <Text style={styles.location}>{match.locationText}</Text>

      <View style={styles.statusRow}>
        <Text
          style={[
            styles.statusTag,
            status === "cancelled" && styles.statusCancelled,
            status === "played" && styles.statusPlayed,
          ]}
        >
          {statusLabel}
        </Text>
        <Text style={styles.goingText}>
          {confirmedYesCount}/{maxPlayers || "?"} going
        </Text>
      </View>

      {playersNeededForMin > 0 && isScheduled && (
        <Text style={styles.minPlayersText}>
          Need {playersNeededForMin} more player
          {playersNeededForMin > 1 ? "s" : ""} to hit the minimum of{" "}
          {minPlayers}.
        </Text>
      )}

      <Text style={styles.sectionTitle}>Your RSVP</Text>
      {isScheduled ? (
        <>
          <View style={styles.rsvpRow}>
            {RSVP_STATUSES.map((statusOption) => {
              const enabled = isRsvpEnabledForStatus(statusOption);
              return (
                <Button
                  key={statusOption}
                  title={statusOption.toUpperCase()}
                  color={userStatus === statusOption ? "#007AFF" : "#aaa"}
                  disabled={!enabled}
                  onPress={() => {
                    if (!enabled) return;
                    handleRsvp(statusOption);
                  }}
                />
              );
            })}
          </View>

          {isFull && userStatus !== "yes" && !isHost && (
            <Text style={styles.fullNote}>
              This match is currently full. You can still change your answer to
              NO if you’re not coming.
            </Text>
          )}
        </>
      ) : (
        <Text style={{ marginTop: 8 }}>
          RSVPs are closed for this match ({statusLabel.toLowerCase()}).
        </Text>
      )}

      <Text style={styles.sectionTitle}>Going</Text>
      {going.length === 0 && <Text>No confirmed players yet.</Text>}
      {going.map((r) => (
        <Text key={r.id}>{r.playerName || r.userId}</Text>
      ))}

      {isHost && (
        <>
          <Text style={styles.sectionTitle}>Host tools</Text>

          {/* NEW: Edit match button */}
          <View style={{ marginVertical: 4 }}>
            <Button
              title="Edit match details"
              onPress={() =>
                router.push({
                  pathname: "/(app)/match/edit",
                  params: { matchId: String(matchId) },
                })
              }
            />
          </View>

          {status !== "played" && (
            <View style={{ marginVertical: 4 }}>
              <Button
                title="Mark as played"
                onPress={() => handleUpdateStatus("played")}
              />
            </View>
          )}

          {status !== "cancelled" && (
            <View style={{ marginVertical: 4 }}>
              <Button
                title="Cancel match"
                color="#d11"
                onPress={() => handleUpdateStatus("cancelled")}
              />
            </View>
          )}
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
  statusRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 12,
  },
  statusTag: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: "#E5F0FF",
    fontSize: 12,
    fontWeight: "600",
  },
  statusCancelled: {
    backgroundColor: "#FDE8E8",
    color: "#B00020",
  },
  statusPlayed: {
    backgroundColor: "#E2F7E1",
    color: "#1B5E20",
  },
  goingText: {
    fontSize: 14,
    color: "#333",
  },
  minPlayersText: {
    marginTop: 8,
    fontSize: 13,
    color: "#555",
  },
  fullNote: {
    marginTop: 8,
    fontSize: 12,
    color: "#B00020",
  },
});
