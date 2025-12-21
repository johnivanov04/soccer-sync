// app/(app)/(tabs)/teams.tsx
import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import React, { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../../src/context/AuthContext";
import { db } from "../../../src/firebaseConfig";

type Team = {
  id: string;
  name?: string;
  homeCity?: string;
  defaultMaxPlayers?: number;
};

function normalizeCode(raw: string) {
  return raw.trim().toLowerCase();
}

function isValidTeamCode(code: string) {
  // 3–24 chars: letters, numbers, hyphen only
  return /^[a-z0-9-]{3,24}$/.test(code);
}

export default function TeamsScreen() {
  const { user } = useAuth();

  const [teamId, setTeamId] = useState<string | null>(null);
  const [team, setTeam] = useState<Team | null>(null);

  // Join
  const [joinCode, setJoinCode] = useState("");

  // Create
  const [newTeamName, setNewTeamName] = useState("");
  const [newTeamCode, setNewTeamCode] = useState("");

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
          const tid = data.teamId || null;
          setTeamId(tid);

          // also load the team document if we have one
          if (tid) {
            const teamRef = doc(db, "teams", tid);
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

  const currentTeamLabel = useMemo(() => team?.name ?? team?.id ?? teamId ?? "", [
    team?.name,
    team?.id,
    teamId,
  ]);

  const writeUserTeam = async (nextTeamId: string, nextTeamName: string) => {
    if (!user?.uid) return;

    const userRef = doc(db, "users", user.uid);
    await setDoc(
      userRef,
      {
        email: user.email ?? "",
        teamId: nextTeamId,
        teamName: nextTeamName,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  };

  const handleJoinTeam = async (codeRaw: string) => {
    if (!user?.uid) {
      Alert.alert("Sign in required", "Please sign in to join a team.");
      return;
    }

    const trimmed = normalizeCode(codeRaw);
    if (!trimmed) {
      Alert.alert("Invalid code", "Please enter a team code.");
      return;
    }

    const doJoin = async () => {
      setSaving(true);
      try {
        const teamRef = doc(db, "teams", trimmed);
        const teamSnap = await getDoc(teamRef);

        if (!teamSnap.exists()) {
          Alert.alert("Team not found", "Check the code and try again.");
          return;
        }

        const teamData = teamSnap.data() as any;
        const teamName = String(teamData?.name ?? teamSnap.id);

        await writeUserTeam(trimmed, teamName);

        setTeamId(trimmed);
        setTeam({ id: teamSnap.id, ...(teamData as any) });
        setJoinCode("");

        Alert.alert("Joined team", "You’re now part of this team!");
      } catch (err) {
        console.error("Error joining team:", err);
        Alert.alert("Error", "Could not join team. Please try again.");
      } finally {
        setSaving(false);
      }
    };

    // If they're already in a team and joining a different one, confirm.
    if (teamId && trimmed !== teamId) {
      Alert.alert(
        "Switch teams?",
        `You’re currently in ${currentTeamLabel || "your team"}. Join ${trimmed} instead?`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Join", style: "default", onPress: () => void doJoin() },
        ]
      );
      return;
    }

    await doJoin();
  };

  const handleCreateTeam = async () => {
    if (!user?.uid) {
      Alert.alert("Sign in required", "Please sign in to create a team.");
      return;
    }

    const name = newTeamName.trim();
    const code = normalizeCode(newTeamCode);

    if (!name) {
      Alert.alert("Team name required", "Please enter a team name.");
      return;
    }
    if (!code) {
      Alert.alert("Team code required", "Please enter a team code.");
      return;
    }
    if (!isValidTeamCode(code)) {
      Alert.alert(
        "Invalid team code",
        "Use 3–24 characters: lowercase letters, numbers, and hyphens only."
      );
      return;
    }

    const doCreate = async () => {
      setSaving(true);
      try {
        const teamRef = doc(db, "teams", code);
        const existing = await getDoc(teamRef);

        if (existing.exists()) {
          Alert.alert("Code taken", "That team code is already in use. Pick another.");
          return;
        }

        // Create team doc (teamId == code)
        await setDoc(teamRef, {
          name,
          code,
          createdBy: user.uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        // Put creator into that team
        await writeUserTeam(code, name);

        // Update local UI
        setTeamId(code);
        setTeam({ id: code, name });

        // Clear inputs
        setNewTeamName("");
        setNewTeamCode("");

        Alert.alert("Team created", `Created ${name} (${code}).`);
      } catch (err) {
        console.error("Error creating team:", err);
        Alert.alert("Error", "Could not create team. Please try again.");
      } finally {
        setSaving(false);
      }
    };

    // If already in a team, confirm switching
    if (teamId && teamId !== code) {
      Alert.alert(
        "Create and switch teams?",
        `You’re currently in ${currentTeamLabel || "your team"}. Creating "${name}" will switch you to the new team.`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Create", style: "default", onPress: () => void doCreate() },
        ]
      );
      return;
    }

    await doCreate();
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.container}>
          <Text>Loading team info...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!user) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.container}>
          <Text>Please sign in to manage your team.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
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
              You’re not in a team yet. Join an existing team using its code, or create a new team.
            </Text>
          </View>
        )}

        {/* Join by team code */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Join by team code</Text>
          <TextInput
            style={styles.input}
            placeholder="Enter team code (e.g. goats)"
            value={joinCode}
            onChangeText={setJoinCode}
            autoCapitalize="none"
            editable={!saving}
          />
          <Button
            title={saving ? "Working..." : "Join Team"}
            onPress={() => handleJoinTeam(joinCode)}
            disabled={saving}
          />
        </View>

        {/* Create new team */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Create a new team</Text>

          <Text style={styles.label}>Team name</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. goatfc"
            value={newTeamName}
            onChangeText={setNewTeamName}
            editable={!saving}
          />

          <Text style={styles.label}>Team code</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. goats (letters/numbers/hyphens)"
            value={newTeamCode}
            onChangeText={setNewTeamCode}
            autoCapitalize="none"
            editable={!saving}
          />
          <Text style={styles.helper}>
            3–24 chars, lowercase letters/numbers/hyphens only.
          </Text>

          <Button
            title={saving ? "Working..." : "Create Team"}
            onPress={handleCreateTeam}
            disabled={saving}
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
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
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 8,
  },
  label: {
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 6,
    marginTop: 8,
  },
  helper: {
    fontSize: 12,
    color: "#666",
    marginBottom: 10,
  },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
  },
});
