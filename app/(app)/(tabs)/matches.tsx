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

type Match = {
  id: string;
  startDateTime?: any;
  locationText?: string;
  maxPlayers?: number;
  confirmedYesCount?: number;
  status?: string;
  createdBy?: string;
};

export default function MatchesScreen() {
  const router = useRouter();
  const { user } = useAuth();

  const [teamId, setTeamId] = useState<string | null>(null);
  const [teamName, setTeamName] = useState<string | null>(null);
  const [teamLoading, setTeamLoading] = useState(true);

  const [matches, setMatches] = useState<Match[]>([]);
  const [matchesLoading, setMatchesLoading] = useState(false);

  // Watch the user doc to get teamId / teamName
  useEffect(() => {
    if (!user?.uid) {
      setTeamId(null);
      setTeamName(null);
      setTeamLoading(false);
      return;
    }

    const userRef = doc(db, "users", user.uid);
    const unsubscribe = onSnapshot(
      userRef,
      (snap) => {
        if (snap.exists()) {
          const data = snap.data() as any;
          const currentTeamId = data.teamId ?? null;
          setTeamId(currentTeamId);
          setTeamName(data.teamName ?? currentTeamId);
        } else {
          setTeamId(null);
          setTeamName(null);
        }
        setTeamLoading(false);
      },
      (err) => {
        console.error("Error loading user doc in MatchesScreen", err);
        setTeamId(null);
        setTeamName(null);
        setTeamLoading(false);
      }
    );

    return () => unsubscribe();
  }, [user?.uid]);

  // Subscribe to matches for that team
  useEffect(() => {
    if (!teamId) {
      setMatches([]);
      return;
    }

    setMatchesLoading(true);

    const matchesCol = collection(db, "matches");
    const q = query(
      matchesCol,
      where("teamId", "==", teamId),
      orderBy("startDateTime", "asc")
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const data: Match[] = snapshot.docs
          .map((d) => ({ id: d.id, ...(d.data() as any) }))
          .filter((m) => m.status !== "canceled");

        setMatches(data);
        setMatchesLoading(false);
      },
      (err) => {
        console.error("Error loading matches", err);
        setMatches([]);
        setMatchesLoading(false);
      }
    );

    return () => unsubscribe();
  }, [teamId]);

  const renderItem = ({ item }: { item: Match }) => {
    const date =
      item.startDateTime?.toDate?.() ||
      (item.startDateTime ? new Date(item.startDateTime) : null);

    const isHost = !!user?.uid && item.createdBy === user.uid;

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
        <View style={styles.titleRow}>
          {date && (
            <Text style={styles.title}>
              {date.toLocaleDateString()}{" "}
              {date.toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </Text>
          )}

          {isHost && (
            <View style={styles.hostPill}>
              <Text style={styles.hostPillText}>You</Text>
            </View>
          )}
        </View>

        {!!item.locationText && (
          <Text style={styles.location}>{item.locationText}</Text>
        )}

        <Text style={styles.subtitle}>
          {item.confirmedYesCount ?? 0}/{item.maxPlayers ?? 0} going
        </Text>

        {item.status &&
          item.status !== "scheduled" &&
          item.status !== "published" && (
            <Text style={styles.statusTag}>
              {item.status.toUpperCase()}
            </Text>
          )}
      </TouchableOpacity>
    );
  };

  // States

  if (!user?.uid) {
    return (
      <View style={styles.container}>
        <Text>Please sign in to view matches.</Text>
      </View>
    );
  }

  if (teamLoading) {
    return (
      <View style={styles.container}>
        <Text>Loading your team...</Text>
      </View>
    );
  }

  if (!teamId) {
    return (
      <View style={styles.container}>
        <Text style={{ marginBottom: 12 }}>
          You’re not in a team yet. Join or create one from the Teams tab.
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
      {teamName && (
        <Text style={styles.teamHeader}>Matches for {teamName}</Text>
      )}

      <Button
        title="Create Match"
        onPress={() => router.push("/(app)/match/create")}
      />

      {matchesLoading && matches.length === 0 ? (
        <Text style={{ marginTop: 16 }}>Loading matches...</Text>
      ) : matches.length === 0 ? (
        <Text style={{ marginTop: 16, textAlign: "center" }}>
          No upcoming matches yet. Tap “Create Match” to schedule one.
        </Text>
      ) : (
        <FlatList
          data={matches}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={{ paddingVertical: 12 }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  teamHeader: { fontWeight: "600", marginBottom: 8 },
  card: {
    padding: 12,
    marginTop: 12,
    borderRadius: 8,
    borderColor: "#ddd",
    borderWidth: 1,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: { fontWeight: "bold" },
  hostPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: "#E6F4FF",
  },
  hostPillText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#007AFF",
  },
  location: { marginTop: 4, color: "#555" },
  subtitle: { marginTop: 4, color: "#777" },
  statusTag: {
    marginTop: 6,
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: "#888",
  },
});
