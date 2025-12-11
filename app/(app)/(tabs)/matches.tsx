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
import { db } from "../../../src/firebaseConfig";

const DEMO_TEAM_ID = "demo-team";

// (optional but nicer)
type Match = {
  id: string;
  startDateTime: any;
  locationText: string;
  confirmedYesCount?: number;
  maxPlayers?: number;
};

export default function MatchesScreen() {
  const router = useRouter();
  const [matches, setMatches] = useState<Match[]>([]);  // 👈 typed

  useEffect(() => {
    const matchesCol = collection(db, "matches");
    const q = query(
      matchesCol,
      where("teamId", "==", DEMO_TEAM_ID),
      orderBy("startDateTime", "asc")
    );

    const unsub = onSnapshot(q, (snapshot) => {
      const data: Match[] = snapshot.docs.map((d) => ({
        id: d.id,
        ...(d.data() as any),
      }));
      setMatches(data);
    });

    return () => unsub();
  }, []);

  // 👇 explicitly type the param so "item" isn't implicit any
  const renderItem = ({ item }: { item: Match }) => {
    const date =
      item.startDateTime?.toDate?.() || new Date(item.startDateTime);

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
        <Text style={styles.location}>{item.locationText}</Text>
        <Text style={styles.subtitle}>
          {item.confirmedYesCount || 0}/{item.maxPlayers} going
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
  title: { fontWeight: "bold" },
  location: { marginTop: 4, color: "#555" },
  subtitle: { marginTop: 4, color: "#777" },
});
