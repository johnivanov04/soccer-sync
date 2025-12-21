// app/(app)/match/[matchId].tsx
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../../src/context/AuthContext";
import { db } from "../../../src/firebaseConfig";
import { addMatchToCalendar } from "../../../src/utils/calendarExport";

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
  description?: string;

  // maintained by Cloud Function
  confirmedYesCount?: number;
  waitlistCount?: number;
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

function paramToString(v: any): string | null {
  if (!v) return null;
  if (Array.isArray(v)) return v[0] ? String(v[0]) : null;
  return String(v);
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function formatCountdown(ms: number) {
  if (!Number.isFinite(ms)) return "";
  const sign = ms < 0 ? -1 : 1;
  const abs = Math.abs(ms);

  const sec = Math.floor(abs / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);

  const remHr = hr % 24;
  const remMin = min % 60;

  const parts: string[] = [];
  if (day > 0) parts.push(`${day}d`);
  if (remHr > 0) parts.push(`${remHr}h`);
  if (day === 0 && remMin > 0) parts.push(`${remMin}m`);
  if (parts.length === 0) parts.push("0m");

  return (sign < 0 ? "-" : "") + parts.join(" ");
}

async function openInMaps(queryText: string) {
  const q = encodeURIComponent(queryText);

  // Prefer Google Maps on Android; Apple Maps on iOS
  const url =
    Platform.OS === "ios"
      ? `http://maps.apple.com/?q=${q}`
      : `https://www.google.com/maps/search/?api=1&query=${q}`;

  const can = await Linking.canOpenURL(url);
  if (!can) {
    Alert.alert("Couldn’t open Maps");
    return;
  }
  await Linking.openURL(url);
}

export default function MatchDetailScreen() {
  const params = useLocalSearchParams();
  const matchIdStr = paramToString(params?.matchId);

  const { user } = useAuth();
  const router = useRouter();

  const [match, setMatch] = useState<Match | null>(null);
  const [rsvps, setRsvps] = useState<Rsvp[]>([]);
  const [userStatus, setUserStatus] = useState<RsvpStatus | null>(null);
  const [loadingMatch, setLoadingMatch] = useState(true);

  const [exportingCalendar, setExportingCalendar] = useState(false);
  const [savingRsvp, setSavingRsvp] = useState(false);

  // tick for countdown updates
  const [nowTick, setNowTick] = useState(Date.now());

  // only for on-screen "you got promoted" alert
  const prevWaitlistedRef = useRef<boolean | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Live subscribe: match + RSVPs
  useEffect(() => {
    if (!matchIdStr) return;

    const matchRef = doc(db, "matches", matchIdStr);
    const unsubMatch = onSnapshot(
      matchRef,
      (snap) => {
        if (snap.exists()) setMatch({ id: snap.id, ...(snap.data() as any) });
        else setMatch(null);
        setLoadingMatch(false);
      },
      (err) => {
        console.error("Error listening to match", err);
        setMatch(null);
        setLoadingMatch(false);
      }
    );

    const rsvpsCol = collection(db, "rsvps");
    const q = query(rsvpsCol, where("matchId", "==", matchIdStr));

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

          // If you were waitlisted and now you're confirmed while viewing the screen,
          // show an in-app alert (Cloud Function will also send a push).
          if (prevWaitlistedRef.current !== null) {
            if (
              prevWaitlistedRef.current === true &&
              nowWaitlisted === false &&
              mine?.status === "yes"
            ) {
              Alert.alert(
                "You’re in! ✅",
                "A spot opened up — you’re now confirmed for the match."
              );
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
  }, [matchIdStr, user?.uid]);

  const isHost = useMemo(() => {
    return !!user?.uid && !!match?.createdBy && match.createdBy === user.uid;
  }, [user?.uid, match?.createdBy]);

  const statusLabel = String(match?.status ?? "scheduled").toLowerCase();
  const isCancelled = statusLabel === "cancelled" || statusLabel === "canceled";
  const isPlayed = statusLabel === "played";

  const startAt = useMemo(() => toDate(match?.startDateTime), [match?.startDateTime]);
  const deadlineAt = useMemo(
    () => (match?.rsvpDeadline ? toDate(match.rsvpDeadline) : null),
    [match?.rsvpDeadline]
  );

  const isRsvpClosed = useMemo(() => {
    if (!deadlineAt) return false;
    return nowTick > deadlineAt.getTime();
  }, [deadlineAt, nowTick]);

  const rsvpDisabledReason =
    isCancelled
      ? "Match cancelled"
      : isPlayed
      ? "Match already played"
      : isRsvpClosed
      ? "RSVP closed"
      : null;

  const going = useMemo(
    () => rsvps.filter((r) => r.status === "yes" && !r.isWaitlisted),
    [rsvps]
  );
  const waitlist = useMemo(
    () => rsvps.filter((r) => r.status === "yes" && r.isWaitlisted),
    [rsvps]
  );

  const myRsvp = useMemo(
    () => rsvps.find((r) => r.userId === user?.uid),
    [rsvps, user?.uid]
  );
  const userWaitlisted = myRsvp?.isWaitlisted ?? false;

  const maxPlayers = Number(match?.maxPlayers ?? 0);
  const spotsLeft = useMemo(() => {
    if (!maxPlayers) return null;
    return clamp(maxPlayers - going.length, 0, maxPlayers);
  }, [maxPlayers, going.length]);

  const startMs = startAt.getTime() - nowTick;
  const deadlineMs = deadlineAt ? deadlineAt.getTime() - nowTick : null;

  const startLabel =
    startMs >= 0
      ? `Starts in ${formatCountdown(startMs)}`
      : `Started ${formatCountdown(-startMs)} ago`;

  const rsvpLabel = deadlineAt
    ? deadlineMs !== null && deadlineMs >= 0
      ? `RSVP closes in ${formatCountdown(deadlineMs)}`
      : `RSVP closed (${deadlineAt.toLocaleString()})`
    : "No RSVP deadline";

  const handleRsvp = async (status: RsvpStatus) => {
    if (!user || !matchIdStr) return;

    // allow NO even when RSVP is closed / cancelled / played
    if (rsvpDisabledReason && status !== "no") {
      Alert.alert(rsvpDisabledReason);
      return;
    }

    const rsvpId = `${matchIdStr}_${user.uid}`;

    try {
      setSavingRsvp(true);

      // Always read match fresh for maxPlayers/status/deadline
      const matchRef = doc(db, "matches", matchIdStr);
      const matchSnap = await getDoc(matchRef);

      if (!matchSnap.exists()) {
        Alert.alert("Match not found");
        return;
      }

      const matchData = matchSnap.data() as any;
      const maxPlayersFresh: number = Number(matchData.maxPlayers ?? 0);

      const matchStatus = String(matchData.status ?? "scheduled").toLowerCase();

      // If cancelling/played, still allow user to set NO (withdraw), but block YES/MAYBE
      if ((matchStatus === "cancelled" || matchStatus === "canceled") && status !== "no") {
        Alert.alert("Match cancelled", "You can’t RSVP YES/MAYBE for a cancelled match.");
        return;
      }
      if (matchStatus === "played" && status !== "no") {
        Alert.alert("Match already played", "This match is finished.");
        return;
      }

      // If deadline passed, still allow NO but block YES/MAYBE
      if (matchData.rsvpDeadline) {
        const deadline = toDate(matchData.rsvpDeadline);
        if (new Date() > deadline && status !== "no") {
          Alert.alert(
            "RSVP closed",
            "The RSVP deadline has passed. You can still leave the match (set NO), but you can’t RSVP YES/MAYBE."
          );
          return;
        }
      }

      // Determine waitlist flag without heavy queries
      let isWaitlisted = false;
      if (status === "yes" && maxPlayersFresh > 0) {
        const confirmedFromMatch = Number(matchData.confirmedYesCount);
        const localConfirmed = rsvps.filter((r) => r.status === "yes" && !r.isWaitlisted).length;

        const confirmed = Number.isFinite(confirmedFromMatch) ? confirmedFromMatch : localConfirmed;
        isWaitlisted = confirmed >= maxPlayersFresh;
      }

      // If leaving, never be waitlisted
      if (status === "no") isWaitlisted = false;

      // Load displayName best-effort
      let playerName = user.email ?? user.uid;
      try {
        const userDocRef = doc(db, "users", user.uid);
        const userSnap = await getDoc(userDocRef);
        if (userSnap.exists()) {
          const data = userSnap.data() as any;
          if (data?.displayName) playerName = data.displayName;
        }
      } catch (innerErr) {
        console.warn("Could not load user profile for RSVP", innerErr);
      }

      // Overwrite to avoid “extra field” rule failures
      const rsvpRef = doc(db, "rsvps", rsvpId);
      await setDoc(rsvpRef, {
        matchId: matchIdStr,
        userId: user.uid,
        playerName,
        status,
        isWaitlisted,
        updatedAt: serverTimestamp(),
      });

      setUserStatus(status);

      if (status === "yes" && isWaitlisted) {
        Alert.alert(
          "You’re on the waitlist",
          "This match is already full. If someone drops, you’ll move into a confirmed spot."
        );
      }
    } catch (e) {
      console.error("RSVP error:", e);
      Alert.alert("Error", "Could not update RSVP right now.");
    } finally {
      setSavingRsvp(false);
    }
  };

  const removeRsvpDoc = async () => {
    if (!user || !matchIdStr) return;

    const rsvpId = `${matchIdStr}_${user.uid}`;
    const rsvpRef = doc(db, "rsvps", rsvpId);

    try {
      setSavingRsvp(true);
      await deleteDoc(rsvpRef);

      // local UI cleanup (snapshots will also update shortly)
      setUserStatus(null);
      prevWaitlistedRef.current = null;
    } catch (e) {
      console.error("Remove RSVP error:", e);
      Alert.alert("Error", "Could not remove RSVP right now.");
    } finally {
      setSavingRsvp(false);
    }
  };

  const confirmRemoveRsvp = () => {
    Alert.alert("Remove RSVP?", "This will delete your RSVP record for this match.", [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => void removeRsvpDoc() },
    ]);
  };

  const setMatchStatus = async (nextStatus: "scheduled" | "played" | "cancelled") => {
    if (!matchIdStr) return;
    try {
      const matchRef = doc(db, "matches", matchIdStr);
      await updateDoc(matchRef, { status: nextStatus, updatedAt: serverTimestamp() });
    } catch (e) {
      console.error("Error updating match status", e);
      Alert.alert("Error", "Could not update match status.");
    }
  };

  const confirmStatusChange = (nextStatus: "played" | "cancelled") => {
    const label = nextStatus === "played" ? "mark this match as played" : "cancel this match";
    Alert.alert("Confirm", `Are you sure you want to ${label}?`, [
      { text: "No", style: "cancel" },
      { text: "Yes", style: "destructive", onPress: () => setMatchStatus(nextStatus) },
    ]);
  };

  const handleAddToCalendar = async () => {
    if (!matchIdStr || !match) return;

    try {
      setExportingCalendar(true);

      const endAt = new Date(startAt.getTime() + 90 * 60 * 1000);

      const deadlineText = deadlineAt ? `RSVP deadline: ${deadlineAt.toLocaleString()}` : "";

      const notes = [
        "Pickup soccer match",
        match.locationText ? `Location: ${match.locationText}` : "",
        deadlineText,
        match.description ? `Notes: ${match.description}` : "",
        `Match ID: ${String(matchIdStr)}`,
      ]
        .filter(Boolean)
        .join("\n");

      const res = await addMatchToCalendar({
        id: String(matchIdStr),
        title: "Pickup Soccer",
        startAt,
        endAt,
        location: match.locationText ?? "",
        notes,
      });

      if ((res.action || "").toLowerCase().includes("cancel")) return;
    } catch (e: any) {
      console.error("Calendar export error", e);
      Alert.alert(
        "Couldn’t add to calendar",
        e?.message ?? "Unknown error. Did you allow calendar permissions?"
      );
    } finally {
      setExportingCalendar(false);
    }
  };

  const handleOpenChat = () => {
    if (!matchIdStr) return;
    router.push({
      pathname: "/(app)/match/chat/[matchId]",
      params: { matchId: String(matchIdStr) },
    });
  };

  const renderScroll = (children: React.ReactNode) => {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ScrollView
          style={{ flex: 1 }}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.container}
        >
          {children}
        </ScrollView>
      </SafeAreaView>
    );
  };

  if (!matchIdStr) {
    return renderScroll(<Text>Missing match id.</Text>);
  }

  if (loadingMatch || !match) {
    return renderScroll(<Text>Loading match...</Text>);
  }

  const statusText =
    statusLabel === "played"
      ? "Played"
      : statusLabel === "cancelled" || statusLabel === "canceled"
      ? "Cancelled"
      : "Scheduled";

  return renderScroll(
    <>
      <Text style={styles.title}>
        {startAt.toLocaleDateString()}{" "}
        {startAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </Text>

      <Text style={styles.subtle}>{startLabel}</Text>
      <Text style={styles.subtle}>{rsvpLabel}</Text>

      {!!match.locationText && <Text style={styles.location}>{match.locationText}</Text>}

      {!!match.description?.trim() && (
        <View style={{ marginTop: 10 }}>
          <Text style={styles.sectionTitle}>Notes</Text>
          <Text style={styles.description}>{match.description.trim()}</Text>
        </View>
      )}

      <View style={{ marginTop: 12, flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Text style={styles.statusPill}>Status: {statusText}</Text>
        {isHost && <Text style={styles.hostPill}>👑 Host</Text>}
        {maxPlayers > 0 && spotsLeft !== null && (
          <Text style={spotsLeft === 0 ? styles.fullPill : styles.spotsPill}>
            {spotsLeft === 0 ? "Full" : `${spotsLeft} spot${spotsLeft === 1 ? "" : "s"} left`}
          </Text>
        )}
      </View>

      <Text style={{ marginTop: 12 }}>
        {going.length}/{match.maxPlayers ?? "?"} going
        {waitlist.length > 0 ? ` • ${waitlist.length} waitlist` : ""}
      </Text>

      {rsvpDisabledReason && (
        <Text style={{ marginTop: 8, color: "#a00" }}>{rsvpDisabledReason}</Text>
      )}

      <View style={{ marginTop: 12, alignSelf: "flex-start" }}>
        <Button
          title={exportingCalendar ? "Opening calendar..." : "Add to Calendar"}
          onPress={handleAddToCalendar}
          disabled={exportingCalendar}
        />
      </View>

      {!!match.locationText?.trim() && (
        <View style={{ marginTop: 10, alignSelf: "flex-start" }}>
          <Button title="Open in Maps" onPress={() => openInMaps(match.locationText!.trim())} />
        </View>
      )}

      {/* ✅ Match Chat button */}
      <View style={{ marginTop: 10, alignSelf: "flex-start" }}>
        <Button title="Open Match Chat" onPress={handleOpenChat} />
      </View>

      <Text style={styles.sectionTitle}>Your RSVP</Text>
      <View style={styles.rsvpRow}>
        {RSVP_STATUSES.map((s) => (
          <Button
            key={s}
            title={s.toUpperCase()}
            color={userStatus === s ? "#007AFF" : "#aaa"}
            onPress={() => handleRsvp(s)}
            // allow "NO" even when disabled; block YES/MAYBE
            disabled={savingRsvp || (!!rsvpDisabledReason && s !== "no")}
          />
        ))}
      </View>

      <Text style={styles.userStatusNote}>
        {userStatus === "yes"
          ? userWaitlisted
            ? "You’re on the waitlist for this match."
            : "You’re confirmed for this match."
          : userStatus === "maybe"
          ? "You’re marked as maybe."
          : userStatus === "no"
          ? "You’re marked as not going."
          : "Tap YES, MAYBE, or NO to update your status."}
      </Text>

      {!!myRsvp && (
        <View style={{ marginTop: 10 }}>
          <Button
            title="Leave match (set to NO)"
            onPress={() => handleRsvp("no")}
            disabled={savingRsvp}
          />
          <View style={{ height: 8 }} />
          <Button
            title="Remove RSVP (delete)"
            color="#d11"
            onPress={confirmRemoveRsvp}
            disabled={savingRsvp}
          />
        </View>
      )}

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
                  params: { matchId: String(matchIdStr) },
                })
              }
            />
          </View>

          <View style={{ marginTop: 8 }}>
            <Button title="Mark as played" onPress={() => confirmStatusChange("played")} />
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
    </>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { padding: 16 },
  title: { fontSize: 20, fontWeight: "bold" },

  subtle: { marginTop: 4, color: "#666" },

  location: { marginTop: 10, color: "#444" },

  sectionTitle: { marginTop: 16, fontWeight: "700" },
  description: { marginTop: 6, color: "#444", lineHeight: 18 },

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
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: "#E6F4FF",
    fontSize: 12,
    fontWeight: "700",
  },

  hostPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: "#FFF3CD",
    fontSize: 12,
    fontWeight: "700",
  },

  spotsPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: "#DFF7E3",
    fontSize: 12,
    fontWeight: "700",
  },

  fullPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: "#FFE7B8",
    fontSize: 12,
    fontWeight: "700",
  },
});
