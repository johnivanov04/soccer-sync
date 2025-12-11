// app/(app)/(tabs)/stats.tsx
import { collection, onSnapshot, query, where } from "firebase/firestore";
import React, { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../../src/context/AuthContext";
import { db } from "../../../src/firebaseConfig";

export default function StatsScreen() {
  const { user } = useAuth();
  const [rsvps, setRsvps] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.uid) return;

    const rsvpsCol = collection(db, "rsvps");
    const q = query(rsvpsCol, where("userId", "==", user.uid));

    const unsub = onSnapshot(
      q,
      (snapshot) => {
        const data = snapshot.docs.map((d) => ({
          id: d.id,
          ...d.data(),
        }));
        setRsvps(data);
        setLoading(false);
      },
      (err) => {
        console.error("Error loading RSVPs", err);
        setLoading(false);
      }
    );

    return () => unsub();
  }, [user?.uid]);

  const yesRsvps = rsvps.filter((r) => r.status === "yes");
  const maybeRsvps = rsvps.filter((r) => r.status === "maybe");
  const noRsvps = rsvps.filter((r) => r.status === "no");

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Your Soccer Fitness</Text>

      {loading ? (
        <Text>Loading...</Text>
      ) : (
        <>
          <View style={styles.mainCard}>
            <Text style={styles.bigNumber}>{yesRsvps.length}</Text>
            <Text style={styles.mainLabel}>Matches you’re in for</Text>
            <Text style={styles.mainSub}>
              Counted from all your “YES” RSVPs.
            </Text>
          </View>

          <View style={styles.row}>
            <View style={styles.smallCard}>
              <Text style={styles.smallNumber}>{maybeRsvps.length}</Text>
              <Text style={styles.smallLabel}>Maybe</Text>
            </View>
            <View style={styles.smallCard}>
              <Text style={styles.smallNumber}>{noRsvps.length}</Text>
              <Text style={styles.smallLabel}>No</Text>
            </View>
          </View>

          {rsvps.length === 0 && (
            <Text style={styles.note}>
              RSVP to some matches and we’ll start tracking your soccer
              sessions here.
            </Text>
          )}

          {rsvps.length > 0 && (
            <Text style={styles.note}>
              This is v1: every “YES” RSVP counts as a soccer session. Later
              we’ll upgrade this to track minutes played and streaks over time.
            </Text>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    paddingBottom: 40,
  },
  title: {
    fontSize: 22,
    fontWeight: "600",
    marginBottom: 16,
  },
  mainCard: {
    padding: 18,
    borderRadius: 14,
    backgroundColor: "#E6F4FF",
    alignItems: "center",
    marginBottom: 16,
  },
  bigNumber: {
    fontSize: 40,
    fontWeight: "700",
  },
  mainLabel: {
    marginTop: 4,
    fontSize: 16,
  },
  mainSub: {
    marginTop: 4,
    fontSize: 12,
    color: "#555",
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  smallCard: {
    flex: 1,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#ddd",
    alignItems: "center",
    marginRight: 8,
  },
  smallNumber: {
    fontSize: 24,
    fontWeight: "600",
  },
  smallLabel: {
    marginTop: 4,
    color: "#555",
  },
  note: {
    marginTop: 20,
    fontSize: 13,
    color: "#777",
  },
});
