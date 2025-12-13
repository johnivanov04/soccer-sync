// app/(app)/(tabs)/matches.tsx
import { useRouter } from "expo-router";
import {
  collection,
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

const DEMO_TEAM_ID = "demo-team";

type MatchStatus = "scheduled" | "played" | "cancelled";

export default function MatchesScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const [matches, setMatches] = useState<any[]>([]);

  useEffect(() => {
    const matchesCol = collection(db, "matches");
    const q = query(
      matchesCol,
      where("teamId", "==", DEMO_TEAM_ID),
      orderBy("startDateTime", "asc")
    );

    const unsub = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      }));
      setMatches(data);
    });

    return () => unsub();
  }, []);

  const renderItem = ({ item }: { item: any }) => {
    const date =
      item.startDateTime?.toDate?.() || new Date(item.startDateTime);

    const status: MatchStatus = (item.status as MatchStatus) || "scheduled";
    const isHost = !!user && item.createdBy === user.uid;

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
        <View style={styles.cardHeader}>
          <Text style={styles.title}>
            {date.toLocaleDateString()}{" "}
            {date.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </Text>
          {isHost && <Text style={styles.hostPill}>Host</Text>}
        </View>

        <Text style={styles.location}>{item.locationText}</Text>
        <Text style={styles.subtitle}>
          {(item.confirmedYesCount || 0)}/{item.maxPlayers} going
        </Text>

        <Text
          style={[
            styles.statusText,
            status === "played" && styles.statusPlayed,
            status === "cancelled" && styles.statusCancelled,
          ]}
        >
          {status === "scheduled" && "Scheduled"}
          {status === "played" && "Played"}
          {status === "cancelled" && "Cancelled"}
        </Text>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
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
          No upcoming matches yet.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  card: {
    padding: 12,
    marginBottom: 10,
    borderRadius: 8,
    borderColor: "#ddd",
    borderWidth: 1,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  hostPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: "#E6F4FF",
    fontSize: 11,
    color: "#0057B8",
  },
  title: { fontWeight: "bold" },
  location: { marginTop: 4, color: "#555" },
  subtitle: { marginTop: 4, color: "#777" },
  statusText: {
    marginTop: 6,
    fontSize: 12,
    color: "#555",
  },
  statusPlayed: {
    color: "#22863a",
  },
  statusCancelled: {
    color: "#b00020",
  },
});
