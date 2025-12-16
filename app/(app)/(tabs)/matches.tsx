// app/(app)/(tabs)/matches.tsx
import { useRouter } from "expo-router";
import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import React, { useEffect, useState } from "react";
import {
  Button,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useAuth } from "../../../src/context/AuthContext";
import { db } from "../../../src/firebaseConfig";

type MatchStatus = "scheduled" | "played" | "cancelled" | string;

type Match = {
  id: string;
  teamId: string;
  startDateTime?: any;
  locationText?: string;
  maxPlayers?: number;
  minPlayers?: number;
  confirmedYesCount?: number;
  waitlistCount?: number;
  status?: MatchStatus;
  rsvpDeadline?: any;
  createdBy?: string;
};

function toDate(raw: any): Date {
  if (!raw) return new Date();
  if (typeof raw?.toDate === "function") return raw.toDate();
  return new Date(raw);
}

function normalizeStatus(s?: string) {
  return (s ?? "scheduled").toLowerCase();
}

function getChip(match: Match) {
  const status = normalizeStatus(match.status);

  // terminal states
  if (status === "cancelled" || status === "canceled") {
    return { label: "Cancelled", variant: "cancelled" as const };
  }
  if (status === "played") {
    return { label: "Played", variant: "played" as const };
  }

  const confirmed = match.confirmedYesCount ?? 0;
  const minPlayers = match.minPlayers ?? 0;
  const maxPlayers = match.maxPlayers ?? 0;

  // RSVP deadline-based chip (only for scheduled matches)
  if (match.rsvpDeadline) {
    const deadline = toDate(match.rsvpDeadline);
    if (Date.now() > deadline.getTime()) {
      return { label: "RSVP closed", variant: "closed" as const };
    }
  }

  // capacity chip
  if (maxPlayers > 0 && confirmed >= maxPlayers) {
    return { label: "Full", variant: "full" as const };
  }

  // “On track / Needs X”
  if (minPlayers > 0) {
    const needed = Math.max(0, minPlayers - confirmed);
    if (needed === 0) {
      return { label: "On track", variant: "ontrack" as const };
    }
    // show exact number needed (more actionable than generic “Needs players”)
    return { label: `Needs ${needed}`, variant: "needs" as const };
  }

  // time-to-start risk (fallback when no minPlayers)
  const start = toDate(match.startDateTime);
  const hoursToStart = (start.getTime() - Date.now()) / (1000 * 60 * 60);
  if (hoursToStart <= 24) {
    return { label: "At risk", variant: "atrisk" as const };
  }

  return { label: "Scheduled", variant: "scheduled" as const };
}

export default function MatchesScreen() {
  const router = useRouter();
  const { user } = useAuth();

  const [teamId, setTeamId] = useState<string | null>(null);
  const [teamName, setTeamName] = useState<string | null>(null);
  const [teamLoading, setTeamLoading] = useState(true);

  const [matches, setMatches] = useState<Match[]>([]);

  // 1) LIVE subscribe to current user's teamId
  useEffect(() => {
    if (!user?.uid) {
      setTeamId(null);
      setTeamName(null);
      setTeamLoading(false);
      return;
    }

    setTeamLoading(true);

    const userRef = doc(db, "users", user.uid);
    const unsub = onSnapshot(
      userRef,
      (snap) => {
        if (snap.exists()) {
          const data = snap.data() as any;
          const nextTeamId =
            data.teamId ?? data.teamCode ?? data.team ?? data.team_id ?? null;

          setTeamId(nextTeamId ?? null);
          setTeamName(data.teamName ?? null); // fallback (older docs)
        } else {
          setTeamId(null);
          setTeamName(null);
        }
        setTeamLoading(false);
      },
      (err) => {
        console.error("Error listening to user team", err);
        setTeamId(null);
        setTeamName(null);
        setTeamLoading(false);
      }
    );

    return () => unsub();
  }, [user?.uid]);

  // 2) Resolve team name from teams/{teamId}
  useEffect(() => {
    if (!teamId) {
      setTeamName(null);
      return;
    }

    const teamRef = doc(db, "teams", teamId);
    const unsub = onSnapshot(
      teamRef,
      (snap) => {
        if (snap.exists()) {
          const data = snap.data() as any;
          setTeamName(data.name ?? data.teamName ?? teamId);
        } else {
          setTeamName(teamId);
        }
      },
      (err) => {
        console.error("Team doc listener error", err);
        setTeamName(teamId);
      }
    );

    return () => unsub();
  }, [teamId]);

  // 3) Subscribe to matches for team
  useEffect(() => {
    if (!teamId) {
      setMatches([]);
      return;
    }

    const matchesCol = collection(db, "matches");
    const q = query(
      matchesCol,
      where("teamId", "==", teamId),
      orderBy("startDateTime", "asc")
    );

    const unsub = onSnapshot(
      q,
      (snapshot) => {
        const data: Match[] = snapshot.docs.map((d) => ({
          id: d.id,
          ...(d.data() as any),
        }));
        setMatches(data);
      },
      (err) => {
        console.error("Matches subscription error", err);
      }
    );

    return () => unsub();
  }, [teamId]);

  const renderItem = ({ item }: { item: Match }) => {
    const date = toDate(item.startDateTime);
    const chip = getChip(item);

    const isHost = !!user?.uid && item.createdBy === user.uid;
    const confirmed = item.confirmedYesCount ?? 0;
    const max = item.maxPlayers ?? 0;
    const waitlist = item.waitlistCount ?? 0;

    return (
      <TouchableOpacity
        style={styles.card}
        onPress={() =>
          router.push({
            pathname: "/(app)/match/[matchId]",
            params: { matchId: item.id },
          })
        }
      >
        <View style={styles.cardTopRow}>
          <Text style={styles.title}>
            {date.toLocaleDateString()}{" "}
            {date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </Text>

          <View style={[styles.chip, styles[`chip_${chip.variant}`]]}>
            <Text style={styles.chipText}>{chip.label}</Text>
          </View>
        </View>

        {!!item.locationText && (
          <Text style={styles.location}>{item.locationText}</Text>
        )}

        <View style={styles.metaRow}>
          <Text style={styles.subtitle}>
            {confirmed}/{max || "?"} going
          </Text>

          {waitlist > 0 && (
            <Text style={styles.waitlistText}>⏳ {waitlist} waitlist</Text>
          )}

          {isHost && <Text style={styles.hostBadge}>👑 Host</Text>}
        </View>
      </TouchableOpacity>
    );
  };

  if (teamLoading) {
    return (
      <View style={styles.container}>
        <Text>Loading your team…</Text>
      </View>
    );
  }

  if (!teamId) {
    return (
      <View style={styles.container}>
        <Text style={styles.noTeamTitle}>You’re not on a team yet.</Text>
        <Text style={styles.noTeamSub}>
          Join or create a team in the Teams tab to see and create matches.
        </Text>
        <Button
          title="Go to Teams"
          onPress={() => router.push("/(app)/(tabs)/teams")}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.teamTag}>Team: {teamName ?? teamId}</Text>

      <Button
        title="Create Match"
        onPress={() => router.push("/(app)/match/create")}
      />

      <FlatList
        data={matches}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={{ paddingVertical: 12 }}
      />

      {matches.length === 0 && (
        <Text style={{ marginTop: 16, textAlign: "center" }}>
          No matches yet. Create one!
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },

  teamTag: {
    marginBottom: 10,
    paddingVertical: 4,
    paddingHorizontal: 10,
    backgroundColor: "#E6F4FF",
    borderRadius: 999,
    alignSelf: "flex-start",
    fontSize: 12,
    fontWeight: "600",
  },

  card: {
    padding: 12,
    marginBottom: 10,
    borderRadius: 10,
    borderColor: "#ddd",
    borderWidth: 1,
  },

  cardTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },

  title: { fontWeight: "bold", flex: 1 },
  location: { marginTop: 6, color: "#555" },

  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 8,
    flexWrap: "wrap",
  },

  subtitle: { color: "#777" },

  hostBadge: {
    backgroundColor: "#FFF3CD",
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 999,
    fontSize: 12,
    fontWeight: "600",
  },

  waitlistText: { color: "#7a4d00" },

  chip: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
  },
  chipText: { fontSize: 12, fontWeight: "700" },

  chip_ontrack: { backgroundColor: "#DFF7E3" },
  chip_needs: { backgroundColor: "#EDEDED" },
  chip_atrisk: { backgroundColor: "#FFE1E1" },
  chip_cancelled: { backgroundColor: "#F2F2F2" },
  chip_played: { backgroundColor: "#E6F4FF" },

  // NEW variants
  chip_full: { backgroundColor: "#FFE7B8" },
  chip_closed: { backgroundColor: "#E9E3FF" },
  chip_scheduled: { backgroundColor: "#EDEDED" },

  noTeamTitle: { fontSize: 18, fontWeight: "700" },
  noTeamSub: { marginTop: 8, marginBottom: 16, color: "#555" },
});
