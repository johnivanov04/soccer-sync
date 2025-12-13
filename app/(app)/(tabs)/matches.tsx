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

interface Match {
  id: string;
  teamId?: string;
  startDateTime?: any;
  locationText?: string;
  maxPlayers?: number;
  confirmedYesCount?: number;
}

export default function MatchesScreen() {
  const router = useRouter();
  const { user } = useAuth();

  const [teamId, setTeamId] = useState<string | null>(null);
  const [userLoaded, setUserLoaded] = useState(false);

  const [matches, setMatches] = useState<Match[]>([]);
  const [matchesLoading, setMatchesLoading] = useState(false);

  // 1) Listen to the user doc so teamId updates live when they join/switch teams
  useEffect(() => {
    if (!user?.uid) {
      setTeamId(null);
      setUserLoaded(true);
      return;
    }

    const userRef = doc(db, "users", user.uid);
    const unsub = onSnapshot(
      userRef,
      (snap) => {
        const data = snap.data() as { teamId?: string } | undefined;
        setTeamId(data?.teamId ?? null);
        setUserLoaded(true);
      },
      (err) => {
        console.error("Error listening to user doc", err);
        setUserLoaded(true);
      }
    );

    return () => unsub();
  }, [user?.uid]);

  // 2) When teamId changes, listen to matches for that team
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

    setMatchesLoading(true);

    const unsub = onSnapshot(
      q,
      (snapshot) => {
        const data: Match[] = snapshot.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<Match, "id">),
        }));
        setMatches(data);
        setMatchesLoading(false);
      },
      (err) => {
        console.error("Error loading matches", err);
        setMatchesLoading(false);
      }
    );

    return () => unsub();
  }, [teamId]);

  const renderItem = ({ item }: { item: Match }) => {
    const rawDate = item.startDateTime;
    const date =
      (rawDate as any)?.toDate?.() ||
      (typeof rawDate === "string" || typeof rawDate === "number"
        ? new Date(rawDate)
        : new Date());

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
        <Text style={styles.title}>
          {date.toLocaleDateString()}{" "}
          {date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </Text>
        {!!item.locationText && (
          <Text style={styles.location}>{item.locationText}</Text>
        )}
        <Text style={styles.subtitle}>
          {item.confirmedYesCount || 0}/{item.maxPlayers ?? 14} going
        </Text>
      </TouchableOpacity>
    );
  };

  if (!user) {
    return (
      <View style={styles.container}>
        <Text style={{ textAlign: "center" }}>
          Please sign in to see your matches.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Button
        title="Create Match"
        onPress={() => router.push("/(app)/match/create")}
        disabled={!teamId}
      />

      {!userLoaded ? (
        <Text style={{ marginTop: 16, textAlign: "center" }}>
          Loading your team...
        </Text>
      ) : !teamId ? (
        <Text style={{ marginTop: 16, textAlign: "center" }}>
          You&apos;re not in a team yet.
          {"\n"}
          Go to the <Text style={{ fontWeight: "600" }}>Teams</Text> tab to
          join or create one.
        </Text>
      ) : matchesLoading ? (
        <Text style={{ marginTop: 16, textAlign: "center" }}>
          Loading matches...
        </Text>
      ) : matches.length === 0 ? (
        <Text style={{ marginTop: 16, textAlign: "center" }}>
          No upcoming matches for this team yet.
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
  card: {
    padding: 12,
    marginTop: 12,
    borderRadius: 8,
    borderColor: "#ddd",
    borderWidth: 1,
    backgroundColor: "#fff",
  },
  title: { fontWeight: "bold", fontSize: 16 },
  location: { marginTop: 4, color: "#555" },
  subtitle: { marginTop: 4, color: "#777" },
});
