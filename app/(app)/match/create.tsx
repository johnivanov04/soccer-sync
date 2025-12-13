// app/(app)/match/create.tsx
import DateTimePicker from "@react-native-community/datetimepicker";
import { useRouter } from "expo-router";
import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import React, { useState } from "react";
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

const DEMO_TEAM_ID = "demo-team";

export default function CreateMatchScreen() {
  const router = useRouter();
  const { user } = useAuth();

  const [date, setDate] = useState(
    new Date(Date.now() + 2 * 60 * 60 * 1000) // default = 2h from now
  );
  const [showPicker, setShowPicker] = useState(false);
  const [locationText, setLocationText] = useState("");
  const [maxPlayers, setMaxPlayers] = useState("14");
  const [description, setDescription] = useState("");

  const handleCreate = async () => {
    if (!user) {
      Alert.alert("Please sign in", "You need to be signed in to create a match.");
      return;
    }

    if (!locationText.trim()) {
      Alert.alert("Location required", "Please enter where you’re playing.");
      return;
    }

    try {
      // Simple v1 logic: RSVP deadline = 24h before kickoff
      const rsvpDeadline = new Date(date.getTime() - 24 * 60 * 60 * 1000);

      const matchesCol = collection(db, "matches");
      const docRef = await addDoc(matchesCol, {
        teamId: DEMO_TEAM_ID,
        startDateTime: date,
        locationText: locationText.trim(),
        maxPlayers: Number(maxPlayers) || 14,
        minPlayers: 8,
        rsvpDeadline,
        description: description.trim() || "",

        // ✅ host + status fields
        createdBy: user.uid,
        status: "scheduled", // "scheduled" | "played" | "cancelled"

        // counters used in the UI
        confirmedYesCount: 0,
        maybeCount: 0,
        waitlistCount: 0,

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

  return (
    <View style={styles.container}>
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
});
