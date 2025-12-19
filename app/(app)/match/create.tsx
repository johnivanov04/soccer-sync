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
import { useAuth } from "../../../src/context/AuthContext";
import { db } from "../../../src/firebaseConfig";

export default function CreateMatchScreen() {
  const router = useRouter();
  const { user } = useAuth();

  // Form state
  const [date, setDate] = useState(new Date(Date.now() + 2 * 60 * 60 * 1000)); // 2h from now
  const [showPicker, setShowPicker] = useState(false);
  const [locationText, setLocationText] = useState("");
  const [maxPlayers, setMaxPlayers] = useState("14");

  // (You can keep this UI for now, but we won't write it to Firestore unless rules allow it)
  const [description, setDescription] = useState("");

  // Team state
  const [teamId, setTeamId] = useState<string | null>(null);
  const [teamName, setTeamName] = useState<string | null>(null);
  const [teamLoading, setTeamLoading] = useState(true);

  const displayTeam = useMemo(() => teamName || teamId, [teamName, teamId]);

  useEffect(() => {
    if (!user?.uid) {
      setTeamLoading(false);
      return;
    }

    const loadUserProfile = async () => {
      try {
        const userRef = doc(db, "users", user.uid);
        const snap = await getDoc(userRef);

        if (snap.exists()) {
          const data = snap.data() as any;
          const currentTeamId = data.teamId ?? null;
          setTeamId(currentTeamId);

          const name =
            (data.teamName as string | undefined) ??
            (currentTeamId as string | null);
          setTeamName(name ?? null);
        } else {
          setTeamId(null);
          setTeamName(null);
        }
      } catch (err) {
        console.error("Error loading user profile for match creation", err);
        setTeamId(null);
        setTeamName(null);
      } finally {
        setTeamLoading(false);
      }
    };

    loadUserProfile();
  }, [user?.uid]);

  function computeRsvpDeadline(start: Date): Date {
    const now = new Date();

    // If match is >= 24h away => deadline = 24h before
    // Else deadline = 30 minutes before start (so it doesn't instantly close)
    const msUntilStart = start.getTime() - now.getTime();
    const dayMs = 24 * 60 * 60 * 1000;
    const min30Ms = 30 * 60 * 1000;

    if (msUntilStart >= dayMs) {
      return new Date(start.getTime() - dayMs);
    }

    // clamp: never after start, never wildly in the past
    const d = new Date(start.getTime() - min30Ms);
    if (d.getTime() < now.getTime()) return start; // RSVP open until kickoff for soon matches
    return d;
  }

  const handleCreate = async () => {
    if (!user?.uid) {
      Alert.alert("Please sign in again.");
      return;
    }

    if (!teamId) {
      Alert.alert(
        "Join a team first",
        "You need to join or create a team before creating matches."
      );
      return;
    }

    if (!locationText.trim()) {
      Alert.alert("Location required");
      return;
    }

    const maxPlayersNum = Math.floor(Number(maxPlayers));
    if (!Number.isFinite(maxPlayersNum) || maxPlayersNum <= 0) {
      Alert.alert("Max players must be a positive number.");
      return;
    }

    // simple default; keep it consistent
    const minPlayersNum = 8;
    if (minPlayersNum > maxPlayersNum) {
      Alert.alert("Min players cannot be greater than max players.");
      return;
    }

    const now = Date.now();
    if (date.getTime() < now - 5 * 60 * 1000) {
      Alert.alert("Start time must be in the future.");
      return;
    }

    try {
      const rsvpDeadline = computeRsvpDeadline(date);

      // IMPORTANT:
      // Your Firestore rules for /matches/{matchId} create currently whitelist fields.
      // So we ONLY send allowed keys here.
      const matchesCol = collection(db, "matches");
      const docRef = await addDoc(matchesCol, {
        teamId,
        createdBy: user.uid,
        startDateTime: date,
        locationText: locationText.trim(),
        maxPlayers: maxPlayersNum,
        minPlayers: minPlayersNum,
        rsvpDeadline,
        status: "scheduled",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        description: description.trim(),

        // If your rules allow these at creation (0/0) you can include them,
        // but safest is to omit and let Cloud Function manage.
        // confirmedYesCount: 0,
        // waitlistCount: 0,
      });

      // NOTE: description is not written because your current rules don't allow it.
      // If you want it stored, we should add "description" to your rules allowlist.

      router.replace({
        pathname: "/(app)/match/[matchId]",
        params: { matchId: docRef.id },
      });
    } catch (e) {
      console.error(e);
      Alert.alert("Error", "Could not create match.");
    }
  };

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
        <Text style={styles.label}>You’re not on a team yet.</Text>
        <Text style={{ marginTop: 8, marginBottom: 16 }}>
          Join or create a team from the Teams tab before creating matches.
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
      <Text style={styles.teamTag}>Creating match for {displayTeam}</Text>

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
        placeholder="e.g., Riverside Park, Field 3"
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
        placeholder="(Not saved yet — we can enable once rules allow it)"
      />

      <Button title="Publish Match" onPress={handleCreate} />
    </View>
  );
}

const styles = StyleSheet.create({
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
