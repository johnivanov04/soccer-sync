// app/(app)/(tabs)/stats.tsx
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  where,
} from "firebase/firestore";
import React, { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../../src/context/AuthContext";
import { db } from "../../../src/firebaseConfig";

type RsvpStatus = "yes" | "maybe" | "no";

type Rsvp = {
  id: string;
  matchId: string;
  status: RsvpStatus;
  isWaitlisted?: boolean; // 👈 new
};

type FitnessSummary = {
  yesTotal: number;
  sessionsPlayed: number;
  upcomingYes: number;
  cancelledYes: number;
  totalMinutes: number;
  thisWeekMinutes: number;
  lastPlayedDate: Date | null;
};

const EST_MIN_PER_MATCH = 90; // v1 assumption

export default function StatsScreen() {
  const { user } = useAuth();
  const [summary, setSummary] = useState<FitnessSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.uid) return;

    setLoading(true);

    const rsvpsCol = collection(db, "rsvps");
    const q = query(rsvpsCol, where("userId", "==", user.uid));

    const unsub = onSnapshot(
      q,
      async (snapshot) => {
        const rsvps: Rsvp[] = snapshot.docs.map((d) => {
          const data = d.data() as any;
          return {
            id: d.id,
            matchId: data.matchId,
            status: data.status as RsvpStatus,
            // old docs won't have isWaitlisted set, so default to false
            isWaitlisted: data.isWaitlisted ?? false,
          };
        });

        if (rsvps.length === 0) {
          setSummary({
            yesTotal: 0,
            sessionsPlayed: 0,
            upcomingYes: 0,
            cancelledYes: 0,
            totalMinutes: 0,
            thisWeekMinutes: 0,
            lastPlayedDate: null,
          });
          setLoading(false);
          return;
        }

        // Fetch all related matches
        const matchesById: Record<
          string,
          { status?: string; startDateTime?: any }
        > = {};

        await Promise.all(
          rsvps.map(async (r) => {
            if (!r.matchId) return;
            try {
              const matchRef = doc(db, "matches", r.matchId);
              const snap = await getDoc(matchRef);
              if (snap.exists()) {
                matchesById[r.matchId] = snap.data() as any;
              }
            } catch (err) {
              console.error("Error loading match for stats", err);
            }
          })
        );

        const now = new Date();
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        let yesTotal = 0;
        let sessionsPlayed = 0;
        let upcomingYes = 0;
        let cancelledYes = 0;
        let totalMinutes = 0;
        let thisWeekMinutes = 0;
        let lastPlayedDate: Date | null = null;

        for (const r of rsvps) {
          // 👇 Only count confirmed YES (not waitlisted) towards fitness
          if (r.status !== "yes" || r.isWaitlisted) continue;
          yesTotal++;

          const match = matchesById[r.matchId];
          if (!match) continue;

          const status: string = match.status ?? "scheduled";
          const rawDate = match.startDateTime;
          const start: Date =
            rawDate?.toDate?.() instanceof Date
              ? rawDate.toDate()
              : rawDate
              ? new Date(rawDate)
              : new Date();

          if (status === "played") {
            sessionsPlayed++;
            totalMinutes += EST_MIN_PER_MATCH;

            if (start >= weekAgo) {
              thisWeekMinutes += EST_MIN_PER_MATCH;
            }

            if (!lastPlayedDate || start > lastPlayedDate) {
              lastPlayedDate = start;
            }
          } else if (status === "scheduled") {
            upcomingYes++;
          } else if (status === "cancelled") {
            cancelledYes++;
          }
        }

        setSummary({
          yesTotal,
          sessionsPlayed,
          upcomingYes,
          cancelledYes,
          totalMinutes,
          thisWeekMinutes,
          lastPlayedDate,
        });
        setLoading(false);
      },
      (err) => {
        console.error("Error loading RSVPs for stats", err);
        setLoading(false);
      }
    );

    return () => unsub();
  }, [user?.uid]);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Your Soccer Fitness</Text>

      {loading || !summary ? (
        <Text>Loading…</Text>
      ) : (
        <>
          {/* Main card: sessions + total minutes */}
          <View style={styles.mainCard}>
            <Text style={styles.bigNumber}>{summary.sessionsPlayed}</Text>
            <Text style={styles.mainLabel}>Matches played</Text>
            <Text style={styles.mainSub}>
              Counted only from matches marked as “Played” where you RSVP’d YES
              (and weren’t waitlisted).
            </Text>

            <Text style={[styles.mainSub, { marginTop: 12 }]}>
              Estimated minutes on the pitch:
            </Text>
            <Text style={styles.bigNumberSmall}>
              {summary.totalMinutes} min
            </Text>

            {summary.lastPlayedDate && (
              <Text style={styles.mainSub}>
                Last match:{" "}
                {summary.lastPlayedDate.toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
              </Text>
            )}
          </View>

          {/* This week + upcoming */}
          <View style={styles.row}>
            <View style={styles.smallCard}>
              <Text style={styles.smallNumber}>
                {summary.thisWeekMinutes}
              </Text>
              <Text style={styles.smallLabel}>Minutes this week</Text>
            </View>
            <View style={styles.smallCard}>
              <Text style={styles.smallNumber}>
                {summary.upcomingYes}
              </Text>
              <Text style={styles.smallLabel}>
                Upcoming matches (confirmed YES)
              </Text>
            </View>
          </View>

          {/* Cancelled / meta info */}
          <View style={[styles.row, { marginTop: 12 }]}>
            <View style={styles.smallCard}>
              <Text style={styles.smallNumber}>
                {summary.cancelledYes}
              </Text>
              <Text style={styles.smallLabel}>
                Cancelled matches you were in for
              </Text>
            </View>
            <View style={styles.smallCard}>
              <Text style={styles.smallNumber}>{summary.yesTotal}</Text>
              <Text style={styles.smallLabel}>
                Total confirmed YES RSVPs
              </Text>
            </View>
          </View>

          {summary.sessionsPlayed === 0 && (
            <Text style={styles.note}>
              Once your host marks matches as “Played”, they’ll start counting
              as real soccer sessions here.
            </Text>
          )}

          {summary.sessionsPlayed > 0 && (
            <Text style={styles.note}>
              This is v1: every “Played” match with a confirmed YES RSVP counts
              as a full {EST_MIN_PER_MATCH}-minute session. Later we can
              upgrade this to use real minutes and position-based load.
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
    marginBottom: 16,
  },
  bigNumber: {
    fontSize: 40,
    fontWeight: "700",
  },
  bigNumberSmall: {
    fontSize: 28,
    fontWeight: "600",
    marginTop: 4,
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
    marginRight: 8,
  },
  smallNumber: {
    fontSize: 20,
    fontWeight: "600",
  },
  smallLabel: {
    marginTop: 4,
    color: "#555",
    fontSize: 12,
  },
  note: {
    marginTop: 20,
    fontSize: 13,
    color: "#777",
  },
});
