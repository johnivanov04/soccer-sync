// app/(app)/match/create.tsx
import DateTimePicker from "@react-native-community/datetimepicker";
import { useRouter } from "expo-router";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  serverTimestamp,
} from "firebase/firestore";
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

function computeRsvpDeadline(start: Date) {
  // default: 24h before start
  const d = new Date(start.getTime() - 24 * 60 * 60 * 1000);
  // if that deadline is already in the past, set it a little into the future
  if (d.getTime() < Date.now()) {
    return new Date(Date.now() + 15 * 60 * 1000);
  }
  return d;
}

export default function CreateMatchScreen() {
  const router = useRouter();
  const { user } = useAuth();

  const [date, setDate] = useState<Date>(
    () => new Date(Date.now() + 60 * 60 * 1000)
  );
  const [showPicker, setShowPicker] = useState(false);

  const [locationText, setLocationText] = useState("");
  const [maxPlayers, setMaxPlayers] = useState("14");
  const [description, setDescription] = useState("");

  const [creating, setCreating] = useState(false);

  const [teamLoading, setTeamLoading] = useState(true);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [teamName, setTeamName] = useState<string>("");

  // Load the user's teamId, then optionally team name
  useEffect(() => {
    let alive = true;

    async function loadTeam() {
      try {
        if (!user?.uid) {
          if (!alive) return;
          setTeamId(null);
          setTeamName("");
          setTeamLoading(false);
          return;
        }

        setTeamLoading(true);

        const userRef = doc(db, "users", user.uid);
        const userSnap = await getDoc(userRef);

        const data = userSnap.exists() ? (userSnap.data() as any) : null;
        const tid =
          data?.teamId ??
          data?.teamCode ??
          data?.team ??
          data?.team_id ??
          null;

        if (!alive) return;

        if (!tid) {
          setTeamId(null);
          setTeamName("");
          setTeamLoading(false);
          return;
        }

        setTeamId(String(tid));

        // Optional: look up team name if you have teams/{teamId}.name
        try {
          const teamRef = doc(db, "teams", String(tid));
          const teamSnap = await getDoc(teamRef);
          const tname = teamSnap.exists()
            ? (teamSnap.data() as any)?.name
            : "";
          if (alive) setTeamName(tname || "");
        } catch {
          // ignore name lookup errors
        }

        if (alive) setTeamLoading(false);
      } catch (e) {
        console.error("Error loading team", e);
        if (!alive) return;
        setTeamId(null);
        setTeamName("");
        setTeamLoading(false);
      }
    }

    loadTeam();
    return () => {
      alive = false;
    };
  }, [user?.uid]);

  const displayTeam = useMemo(
    () => teamName || teamId || "",
    [teamName, teamId]
  );

  const isDirty = useMemo(() => {
    return (
      locationText.trim().length > 0 ||
      description.trim().length > 0 ||
      maxPlayers.trim() !== "14"
      // (date is always set; we don't treat it as "dirty" by default)
    );
  }, [locationText, description, maxPlayers]);

  const handleCancel = () => {
    const leave = () => router.back();

    if (!isDirty) {
      leave();
      return;
    }

    Alert.alert("Discard match?", "Your draft match details will be lost.", [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: leave },
    ]);
  };

  const handleCreate = async () => {
    if (!user?.uid) {
      Alert.alert("Please sign in");
      return;
    }
    if (!teamId) {
      Alert.alert("You’re not on a team yet.");
      return;
    }
    if (!locationText.trim()) {
      Alert.alert("Location required");
      return;
    }

    const now = Date.now();
    if (date.getTime() < now - 5 * 60 * 1000) {
      Alert.alert("Start time must be in the future.");
      return;
    }

    const maxPlayersNum = Number(maxPlayers);
    if (
      !Number.isFinite(maxPlayersNum) ||
      !Number.isInteger(maxPlayersNum) ||
      maxPlayersNum <= 0
    ) {
      Alert.alert("Max players must be a positive whole number.");
      return;
    }

    try {
      setCreating(true);

      const rsvpDeadline = computeRsvpDeadline(date);

      const matchesCol = collection(db, "matches");
      const docRef = await addDoc(matchesCol, {
        teamId: String(teamId),
        startDateTime: date,
        locationText: locationText.trim(),
        maxPlayers: maxPlayersNum,
        description: description.trim() || "",
        rsvpDeadline,

        createdBy: user.uid,
        status: "scheduled",

        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      router.replace({
        pathname: "/(app)/match/[matchId]",
        params: { matchId: docRef.id },
      });
    } catch (e) {
      console.error(e);
      Alert.alert("Error", "Could not create match.");
    } finally {
      setCreating(false);
    }
  };

  if (teamLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.container}>
          <Text>Loading your team...</Text>
          <View style={{ marginTop: 12 }}>
            <Button
              title="Cancel"
              color="#999"
              onPress={handleCancel}
              disabled={creating}
            />
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (!teamId) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.container}>
          <Text style={styles.label}>You’re not on a team yet.</Text>
          <Text style={{ marginTop: 8, marginBottom: 16 }}>
            Join or create a team from the Teams tab before creating matches.
          </Text>
          <Button
            title="Go to Teams"
            onPress={() => router.push("/(app)/(tabs)/teams")}
          />
          <View style={{ marginTop: 12 }}>
            <Button title="Cancel" color="#999" onPress={handleCancel} />
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.container}>
        {!!displayTeam && (
          <Text style={styles.teamTag}>Creating match for {displayTeam}</Text>
        )}

        <Text style={styles.label}>Date & Time</Text>
        <Text style={styles.link} onPress={() => setShowPicker(true)}>
          {date.toLocaleString()}
        </Text>

        {showPicker && (
          <DateTimePicker
            value={date}
            mode="datetime"
            onChange={(event, selectedDate) => {
              setShowPicker(false);
              if (selectedDate) setDate(selectedDate);
            }}
          />
        )}

        <Text style={styles.label}>Location</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. Riverside Park, Field 3"
          value={locationText}
          onChangeText={setLocationText}
        />

        <Text style={styles.label}>Max Players</Text>
        <TextInput
          style={styles.input}
          keyboardType="numeric"
          value={maxPlayers}
          onChangeText={setMaxPlayers}
        />

        <Text style={styles.label}>Description (optional)</Text>
        <TextInput
          style={[styles.input, { height: 80 }]}
          multiline
          value={description}
          onChangeText={setDescription}
          placeholder="Anything players should know (shoes, parking, who brings balls, etc.)"
        />

        <View style={{ marginTop: 24 }}>
          <Button
            title={creating ? "Publishing..." : "Publish Match"}
            onPress={handleCreate}
            disabled={creating}
          />
        </View>

        <View style={{ marginTop: 12 }}>
          <Button
            title="Cancel"
            color="#999"
            onPress={handleCancel}
            disabled={creating}
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { flex: 1, padding: 16 },
  label: { marginTop: 16, marginBottom: 4, fontWeight: "600" },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    padding: 10,
  },
  link: { color: "blue" },
  teamTag: {
    marginBottom: 8,
    paddingVertical: 4,
    paddingHorizontal: 10,
    backgroundColor: "#E6F4FF",
    borderRadius: 999,
    alignSelf: "flex-start",
    fontSize: 12,
    fontWeight: "600",
  },
});
