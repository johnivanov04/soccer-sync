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

export default function CreateMatchScreen() {
  const router = useRouter();
  const { user } = useAuth();

  // Form state
  const [date, setDate] = useState(
    new Date(Date.now() + 2 * 60 * 60 * 1000) // default = 2h from now
  );
  const [showPicker, setShowPicker] = useState(false);
  const [locationText, setLocationText] = useState("");
  const [maxPlayers, setMaxPlayers] = useState("14");
  const [description, setDescription] = useState("");

  // Team state
  const [teamId, setTeamId] = useState<string | null>(null);
  const [teamName, setTeamName] = useState<string | null>(null);
  const [teamLoading, setTeamLoading] = useState(true);

  // Load the current user's team
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

          // Prefer explicit teamName, otherwise fall back to teamId
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

    const maxPlayersNum = Number(maxPlayers);
    if (!Number.isFinite(maxPlayersNum) || maxPlayersNum <= 0) {
      Alert.alert("Max players must be a positive number.");
      return;
    }

    const now = Date.now();
    if (date.getTime() < now - 5 * 60 * 1000) {
      Alert.alert("Start time must be in the future.");
      return;
    }

    try {
      const rsvpDeadline = new Date(
        date.getTime() - 24 * 60 * 60 * 1000 // 24h before
      );

      const matchesCol = collection(db, "matches");
      const docRef = await addDoc(matchesCol, {
        teamId,
        startDateTime: date,
        locationText: locationText.trim(),
        maxPlayers: maxPlayersNum,
        minPlayers: 8, // simple default; we can make this editable later
        rsvpDeadline,
        description: description.trim(),
        status: "scheduled", // treat new matches as scheduled/open
        confirmedYesCount: 0,
        maybeCount: 0,
        waitlistCount: 0,
        createdBy: user.uid, // 👈 HOST / ORGANIZER
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
    }
  };

  // While we’re loading the user’s team
  if (teamLoading) {
    return (
      <View style={styles.container}>
        <Text>Loading your team...</Text>
      </View>
    );
  }

  // User has no team → push them to Teams tab
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

  const displayTeam = teamName || teamId; // 👈 fallback

  // Normal create form when user has a team
  return (
    <View style={styles.container}>
      <Text style={styles.teamTag}>
        Creating match for {displayTeam}
      </Text>

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
