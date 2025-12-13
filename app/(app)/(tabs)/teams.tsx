// app/(app)/(tabs)/teams.tsx
import {
  collection,
  doc,
  onSnapshot,
  query,
  setDoc,
  where,
} from "firebase/firestore";
import React, { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../../src/context/AuthContext";
import { db } from "../../../src/firebaseConfig";

const DEMO_TEAM_ID = "demo-team";

type Team = {
  id: string;
  name?: string;
  location?: string;
  description?: string;
  joinCode?: string;
};

export default function TeamsScreen() {
  const { user } = useAuth();
  const [team, setTeam] = useState<Team | null>(null);
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Listen to the demo team document
    const teamRef = doc(db, "teams", DEMO_TEAM_ID);
    const unsubTeam = onSnapshot(
      teamRef,
      (snap) => {
        if (snap.exists()) {
          const data = snap.data() as Omit<Team, "id">;
          setTeam({ id: snap.id, ...data });
        } else {
          setTeam(null);
        }
        setLoading(false);
      },
      (err) => {
        console.error("Error loading team", err);
        setLoading(false);
      }
    );

    let unsubMembers: (() => void) | undefined;

    // If we have a logged-in user, auto-enroll them in the demo team
    if (user?.uid) {
      // Fire and forget — don't block UI on this
      (async () => {
        try {
          const membershipId = `${DEMO_TEAM_ID}_${user.uid}`;
          const membershipRef = doc(db, "memberships", membershipId);
          await setDoc(
            membershipRef,
            {
              teamId: DEMO_TEAM_ID,
              userId: user.uid,
              role: "player",
              joinedAt: new Date(),
            },
            { merge: true }
          );
        } catch (e) {
          console.error("Error ensuring membership", e);
        }
      })();

      // Listen to all memberships for this team so we can show player count
      const membershipsCol = collection(db, "memberships");
      const q = query(membershipsCol, where("teamId", "==", DEMO_TEAM_ID));

      unsubMembers = onSnapshot(
        q,
        (snapshot) => {
          setMemberCount(snapshot.size);
        },
        (err) => {
          console.error("Error loading members", err);
        }
      );
    }

    return () => {
      unsubTeam();
      if (unsubMembers) unsubMembers();
    };
  }, [user?.uid]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <Text>Loading team...</Text>
      </View>
    );
  }

  if (!team) {
    return (
      <View style={styles.centered}>
        <Text style={styles.title}>Your Teams</Text>
        <Text style={styles.note}>
          No team configured yet. For now this app assumes a single demo team.
          We&apos;ll add team creation & join codes later.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Your Team</Text>

      <View style={styles.card}>
        <Text style={styles.teamName}>{team.name || "Demo Team"}</Text>
        {!!team.location && (
          <Text style={styles.location}>{team.location}</Text>
        )}
        {!!team.description && (
          <Text style={styles.description}>{team.description}</Text>
        )}

        <View style={styles.row}>
          <View style={styles.statBox}>
            <Text style={styles.statNumber}>
              {memberCount !== null ? memberCount : "-"}
            </Text>
            <Text style={styles.statLabel}>Players</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statNumber}>1</Text>
            <Text style={styles.statLabel}>Team</Text>
          </View>
        </View>

        {!!team.joinCode && (
          <View style={styles.joinBox}>
            <Text style={styles.joinLabel}>Team join code</Text>
            <Text style={styles.joinCode}>{team.joinCode}</Text>
            <Text style={styles.joinHint}>
              Share this code with friends you want to bring into your team.
              (Joining flow coming soon.)
            </Text>
          </View>
        )}
      </View>

      <View style={{ marginTop: 24 }}>
        <Text style={styles.sectionTitle}>What&apos;s next</Text>
        <Text style={styles.note}>
          • For now, all matches are created under this demo team.
          {"\n"}• We&apos;ll add team creation and joining other teams next.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    paddingBottom: 40,
  },
  centered: {
    flex: 1,
    padding: 16,
    justifyContent: "center",
  },
  title: {
    fontSize: 22,
    fontWeight: "600",
    marginBottom: 16,
  },
  card: {
    padding: 18,
    borderRadius: 14,
    backgroundColor: "#F2F6FF",
    borderWidth: 1,
    borderColor: "#dde3f3",
  },
  teamName: {
    fontSize: 20,
    fontWeight: "700",
  },
  location: {
    marginTop: 4,
    color: "#555",
  },
  description: {
    marginTop: 8,
    color: "#444",
  },
  row: {
    flexDirection: "row",
    marginTop: 16,
  },
  statBox: {
    flex: 1,
    alignItems: "center",
  },
  statNumber: {
    fontSize: 24,
    fontWeight: "700",
  },
  statLabel: {
    marginTop: 4,
    fontSize: 12,
    color: "#666",
  },
  joinBox: {
    marginTop: 18,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: "#dde3f3",
  },
  joinLabel: {
    fontSize: 12,
    color: "#666",
  },
  joinCode: {
    marginTop: 4,
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: 2,
  },
  joinHint: {
    marginTop: 4,
    fontSize: 12,
    color: "#777",
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "600",
  },
  note: {
    marginTop: 8,
    fontSize: 13,
    color: "#777",
  },
});
