// app/(app)/(tabs)/teams.tsx
import { doc, getDoc, setDoc } from "firebase/firestore";
import React, { useEffect, useState } from "react";
import {
  Alert,
  Button,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useAuth } from "../../../src/context/AuthContext";
import { db } from "../../../src/firebaseConfig";

type Team = {
  id: string;
  name?: string;
  homeCity?: string;
  defaultMaxPlayers?: number;
};

const DEMO_TEAM_ID = "demo-team";

export default function TeamsScreen() {
  const { user } = useAuth();
  const [teamId, setTeamId] = useState<string | null>(null);
  const [team, setTeam] = useState<Team | null>(null);
  const [joinCode, setJoinCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // 1️⃣ Load user's current teamId
  useEffect(() => {
    const load = async () => {
      if (!user?.uid) {
        setTeamId(null);
        setTeam(null);
        setLoading(false);
        return;
      }

      try {
        const userRef = doc(db, "users", user.uid);
        const snap = await getDoc(userRef);

        if (snap.exists()) {
          const data = snap.data() as any;
          setTeamId(data.teamId || null);

          // also load the team document if we have one
          if (data.teamId) {
            const teamRef = doc(db, "teams", data.teamId);
            const teamSnap = await getDoc(teamRef);
            if (teamSnap.exists()) {
              setTeam({ id: teamSnap.id, ...(teamSnap.data() as any) });
            } else {
              setTeam(null);
            }
          } else {
            setTeam(null);
          }
        } else {
          setTeamId(null);
          setTeam(null);
        }
      } catch (err) {
        console.error("Error loading team info:", err);
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [user?.uid]);

  const handleJoinTeam = async (code: string) => {
    if (!user?.uid) {
      Alert.alert("Sign in required", "Please sign in to join a team.");
      return;
    }

    const trimmed = code.trim();
    if (!trimmed) {
      Alert.alert("Invalid code", "Please enter a team code.");
      return;
    }

    setSaving(true);
    try {
      const teamRef = doc(db, "teams", trimmed);
      const teamSnap = await getDoc(teamRef);

      if (!teamSnap.exists()) {
        Alert.alert("Team not found", "Check the code and try again.");
        setSaving(false);
        return;
      }

      // Update user's teamId
      const userRef = doc(db, "users", user.uid);
      await setDoc(
        userRef,
        {
          email: user.email ?? "",
          teamId: trimmed,
        },
        { merge: true }
      );

      setTeamId(trimmed);
      setTeam({ id: teamSnap.id, ...(teamSnap.data() as any) });
      Alert.alert("Joined team", "You’re now part of this team!");
    } catch (err) {
      console.error("Error joining team:", err);
      Alert.alert("Error", "Could not join team. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleJoinDemoTeam = () => {
    handleJoinTeam(DEMO_TEAM_ID);
  };

  if (loading) {
    return (
      <View style={styles.container}>
        <Text>Loading team info...</Text>
      </View>
    );
  }

  if (!user) {
    return (
      <View style={styles.container}>
        <Text>Please sign in to manage your team.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Your Team</Text>

      {teamId && team ? (
        <View style={styles.card}>
          <Text style={styles.teamName}>{team.name ?? team.id}</Text>
          {team.homeCity && (
            <Text style={styles.teamMeta}>Home: {team.homeCity}</Text>
          )}
          {typeof team.defaultMaxPlayers === "number" && (
            <Text style={styles.teamMeta}>
              Default max players: {team.defaultMaxPlayers}
            </Text>
          )}
          <Text style={styles.teamMeta}>Team code: {team.id}</Text>
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.teamMeta}>
            You’re not in a team yet. Join an existing team using its code.
          </Text>
        </View>
      )}

      <View style={styles.joinSection}>
        <Text style={styles.sectionTitle}>Join by team code</Text>
        <TextInput
          style={styles.input}
          placeholder="Enter team code (e.g. demo-team)"
          value={joinCode}
          onChangeText={setJoinCode}
          autoCapitalize="none"
        />
        <Button
          title={saving ? "Joining..." : "Join Team"}
          onPress={() => handleJoinTeam(joinCode)}
          disabled={saving}
        />
      </View>

      <View style={styles.demoSection}>
        <Text style={styles.sectionTitle}>Quick start</Text>
        <Text style={styles.teamMeta}>
          For testing, there’s a built-in team with code <Text style={{ fontWeight: "600" }}>demo-team</Text>.
        </Text>
        <Button title="Join demo team" onPress={handleJoinDemoTeam} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  title: {
    fontSize: 22,
    fontWeight: "700",
    marginBottom: 16,
  },
  card: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#ddd",
    marginBottom: 24,
  },
  teamName: {
    fontSize: 20,
    fontWeight: "700",
    marginBottom: 4,
  },
  teamMeta: {
    fontSize: 14,
    color: "#555",
    marginTop: 2,
  },
  joinSection: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
  },
  demoSection: {
    marginTop: 8,
  },
});
