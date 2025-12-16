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
import React, { useEffect, useMemo, useRef, useState } from "react";
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

type MatchStatus = "scheduled" | "played" | "cancelled" | string;

type Match = {
  id: string;
  startDateTime?: any;
  locationText?: string;
  maxPlayers?: number;
  status?: MatchStatus;
  createdBy?: string;
  rsvpDeadline?: any;
};

type Rsvp = {
  id: string;
  userId?: string;
  playerName?: string;
  status?: RsvpStatus;
  isWaitlisted?: boolean;
  updatedAt?: any;
};

function toDate(raw: any): Date {
  if (!raw) return new Date();
  if (typeof raw?.toDate === "function") return raw.toDate();
  return new Date(raw);
}

function toMillis(raw: any): number {
  if (!raw) return 0;
  const d = toDate(raw);
  const t = d.getTime();
  return Number.isFinite(t) ? t : 0;
}

export default function MatchDetailScreen() {
  const { matchId } = useLocalSearchParams();
  const { user } = useAuth();
  const router = useRouter();

  const [match, setMatch] = useState<Match | null>(null);
  const [rsvps, setRsvps] = useState<Rsvp[]>([]);
  const [userStatus, setUserStatus] = useState<RsvpStatus | null>(null);
  const [loadingMatch, setLoadingMatch] = useState(true);

  const promotionInFlightRef = useRef(false);
  const prevWaitlistedRef = useRef<boolean | null>(null);

  // Live subscribe: match + RSVPs
  useEffect(() => {
    if (!matchId) return;

    const matchRef = doc(db, "matches", String(matchId));
    const unsubMatch = onSnapshot(
      matchRef,
      (snap) => {
        if (snap.exists()) {
          setMatch({ id: snap.id, ...(snap.data() as any) });
        } else {
          setMatch(null);
        }
        setLoadingMatch(false);
      },
      (err) => {
        console.error("Error listening to match", err);
        setMatch(null);
        setLoadingMatch(false);
      }
    );

    const rsvpsCol = collection(db, "rsvps");
    const q = query(rsvpsCol, where("matchId", "==", String(matchId)));

    const unsubRsvps = onSnapshot(
      q,
      (snapshot) => {
        const list: Rsvp[] = snapshot.docs.map((d) => {
          const data = d.data() as any;
          return {
            id: d.id,
            userId: data.userId,
            playerName: data.playerName,
            status: data.status as RsvpStatus,
            isWaitlisted: data.isWaitlisted ?? false,
            updatedAt: data.updatedAt,
          };
        });

        setRsvps(list);

        if (user?.uid) {
          const mine = list.find((r) => r.userId === user.uid);
          setUserStatus((mine?.status as RsvpStatus | undefined) ?? null);

          const nowWaitlisted =
            (mine?.status === "yes" && (mine?.isWaitlisted ?? false)) ?? false;

          // Promotion toast/alert (only after initial load)
          if (prevWaitlistedRef.current !== null) {
            if (prevWaitlistedRef.current === true && nowWaitlisted === false && mine?.status === "yes") {
              Alert.alert("You’re in!", "A spot opened up — you’re now confirmed.");
            }
          }
          prevWaitlistedRef.current = nowWaitlisted;
        }
      },
      (err) => console.error("RSVP listener error", err)
    );

    return () => {
      unsubMatch();
      unsubRsvps();
    };
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

  /**
   * Auto-promote earliest waitlisted YES into confirmed if a spot exists.
   * NOTE: This is a client-side best-effort implementation. For perfect behavior under
   * concurrency, move this logic to a Cloud Function later.
   */
  const autoPromoteWaitlistIfNeeded = async (maxPlayers: number) => {
    if (!matchId) return;
    if (promotionInFlightRef.current) return;

    const status = ((match?.status ?? "scheduled") as string).toLowerCase();
    if (status === "played" || status === "cancelled" || status === "canceled") return;

    // No capacity => no waitlist => nothing to promote
    if (!Number.isFinite(maxPlayers) || maxPlayers <= 0) return;

    try {
      promotionInFlightRef.current = true;

      const rsvpsCol = collection(db, "rsvps");

      // Current confirmed YES count (server-truth)
      const confirmedQuery = query(
        rsvpsCol,
        where("matchId", "==", String(matchId)),
        where("status", "==", "yes"),
        where("isWaitlisted", "==", false)
      );
      const confirmedSnap = await getDocs(confirmedQuery);
      const openSlots = maxPlayers - confirmedSnap.size;

      if (openSlots <= 0) return;

      // Get all waitlisted YES, then sort client-side by updatedAt (earliest first)
      const waitlistQuery = query(
        rsvpsCol,
        where("matchId", "==", String(matchId)),
        where("status", "==", "yes"),
        where("isWaitlisted", "==", true)
      );
      const waitlistSnap = await getDocs(waitlistQuery);

      if (waitlistSnap.empty) return;

      const waitlistedDocs = waitlistSnap.docs
        .map((d) => ({ id: d.id, ref: d.ref, data: d.data() as any }))
        .sort((a, b) => toMillis(a.data.updatedAt) - toMillis(b.data.updatedAt));

      const promoteCount = Math.min(openSlots, waitlistedDocs.length);

      for (let i = 0; i < promoteCount; i++) {
        const target = waitlistedDocs[i];
        await updateDoc(target.ref, {
          isWaitlisted: false,
          updatedAt: new Date(),
        });
      }
    } catch (e) {
      console.error("Auto-promotion error", e);
    } finally {
      promotionInFlightRef.current = false;
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
      const matchStatus = (matchData.status ?? "scheduled").toLowerCase();
      if (matchStatus === "cancelled" || matchStatus === "canceled") {
        Alert.alert(
          "Match cancelled",
          "You can’t change RSVP for a cancelled match."
        );
        return;
      }
      if (matchStatus === "played") {
        Alert.alert("Match already played", "This match is finished.");
        return;
      }

      // Deadline-based blocking
      if (matchData.rsvpDeadline) {
        const deadline =
          typeof matchData.rsvpDeadline?.toDate === "function"
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
        // Only waitlist if maxPlayers is a real capacity (> 0)
        if (maxPlayers > 0) {
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

      // NEW: after any RSVP update, try to promote from waitlist if a spot opened,
      // then recompute counts.
      await autoPromoteWaitlistIfNeeded(maxPlayers);
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

  // If host changes maxPlayers in Edit screen while this is open, we can also promote automatically.
  // This keeps things consistent without needing the host to do anything else.
  useEffect(() => {
    const maxPlayers = match?.maxPlayers ?? 0;
    if (!matchId) return;
    if (!Number.isFinite(maxPlayers) || maxPlayers <= 0) return;

    const going = rsvps.filter((r) => r.status === "yes" && !r.isWaitlisted);
    const waitlist = rsvps.filter((r) => r.status === "yes" && r.isWaitlisted);

    if (waitlist.length > 0 && going.length < maxPlayers) {
      autoPromoteWaitlistIfNeeded(maxPlayers).then(() => recomputeYesCount());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match?.maxPlayers, rsvps.length]);

  // Host controls (status updates)
  const isHost = useMemo(() => {
    return !!user?.uid && !!match?.createdBy && match.createdBy === user.uid;
  }, [user?.uid, match?.createdBy]);

  const setMatchStatus = async (
    nextStatus: "scheduled" | "played" | "cancelled"
  ) => {
    if (!matchId) return;

    try {
      const matchRef = doc(db, "matches", String(matchId));
      await updateDoc(matchRef, { status: nextStatus, updatedAt: new Date() });
    } catch (e) {
      console.error("Error updating match status", e);
      Alert.alert("Error", "Could not update match status.");
    }
  };

  const confirmStatusChange = (nextStatus: "played" | "cancelled") => {
    const label =
      nextStatus === "played" ? "mark this match as played" : "cancel this match";
    Alert.alert("Confirm", `Are you sure you want to ${label}?`, [
      { text: "No", style: "cancel" },
      { text: "Yes", style: "destructive", onPress: () => setMatchStatus(nextStatus) },
    ]);
  };

  if (loadingMatch || !match) {
    return (
      <View style={styles.container}>
        <Text>Loading match...</Text>
      </View>
    );
  }

  const date = toDate(match.startDateTime);

  const going = rsvps.filter((r) => r.status === "yes" && !r.isWaitlisted);
  const waitlist = rsvps.filter((r) => r.status === "yes" && r.isWaitlisted);

  const myRsvp = rsvps.find((r) => r.userId === user?.uid);
  const userWaitlisted = myRsvp?.isWaitlisted ?? false;

  const statusLabel = ((match.status ?? "scheduled") as string).toLowerCase();
  const statusText =
    statusLabel === "played"
      ? "Played"
      : statusLabel === "cancelled" || statusLabel === "canceled"
      ? "Cancelled"
      : "Scheduled";

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>
        {date.toLocaleDateString()}{" "}
        {date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </Text>

      {!!match.locationText && (
        <Text style={styles.location}>{match.locationText}</Text>
      )}

      <View style={{ marginTop: 10 }}>
        <Text style={styles.statusPill}>Status: {statusText}</Text>
      </View>

      <Text style={{ marginTop: 12 }}>
        {going.length}/{match.maxPlayers ?? "?"} going
        {waitlist.length > 0 ? ` • ${waitlist.length} waitlist` : ""}
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

      {isHost && (
        <>
          <Text style={styles.sectionTitle}>Host tools</Text>

          <View style={{ marginTop: 8 }}>
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

          <View style={{ marginTop: 8 }}>
            <Button
              title="Mark as played"
              onPress={() => confirmStatusChange("played")}
            />
          </View>

          <View style={{ marginTop: 8 }}>
            <Button
              title="Cancel match"
              color="#d11"
              onPress={() => confirmStatusChange("cancelled")}
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
  statusPill: {
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: "#E6F4FF",
    fontSize: 12,
    fontWeight: "600",
  },
});
