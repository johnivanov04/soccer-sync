// app/(app)/match/edit.tsx
import DateTimePicker from "@react-native-community/datetimepicker";
import { useLocalSearchParams, useRouter } from "expo-router";
import { doc, getDoc, serverTimestamp, updateDoc } from "firebase/firestore";
import React, { useEffect, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Button,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View,
} from "react-native";
import { useAuth } from "../../../src/context/AuthContext";
import { db } from "../../../src/firebaseConfig";

export default function EditMatchScreen() {
  const { matchId } = useLocalSearchParams();
  const { user } = useAuth();
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [match, setMatch] = useState<any | null>(null);

  const [date, setDate] = useState<Date | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [locationText, setLocationText] = useState("");
  const [maxPlayers, setMaxPlayers] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (!matchId) return;

    const loadMatch = async () => {
      try {
        const matchRef = doc(db, "matches", String(matchId));
        const snap = await getDoc(matchRef);

        if (!snap.exists()) {
          Alert.alert("Match not found");
          router.back();
          return;
        }

        const data = snap.data() as any;
        setMatch({ id: snap.id, ...data });

        // Convert Firestore Timestamp or string into Date
        const start =
          data.startDateTime?.toDate?.() || new Date(data.startDateTime);

        setDate(start);
        setLocationText(data.locationText || "");
        setMaxPlayers(
          data.maxPlayers !== undefined ? String(data.maxPlayers) : ""
        );
        setDescription(data.description || "");
      } catch (e) {
        console.error("Error loading match for edit", e);
        Alert.alert("Error", "Could not load match.");
        router.back();
      } finally {
        setLoading(false);
      }
    };

    loadMatch();
  }, [matchId]);

  const isHost = !!user?.uid && match?.createdBy === user.uid;

  const handleSave = async () => {
    if (!matchId || !date) return;

    if (!isHost) {
      Alert.alert("Only the organizer can edit this match.");
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
    if (!Number.isFinite(maxPlayersNum) || maxPlayersNum <= 0) {
      Alert.alert("Max players must be a positive number.");
      return;
    }

    try {
      setSaving(true);

      const rsvpDeadline = new Date(
        date.getTime() - 24 * 60 * 60 * 1000
      );

      const matchRef = doc(db, "matches", String(matchId));
      await updateDoc(matchRef, {
        startDateTime: date,
        locationText: locationText.trim(),
        maxPlayers: maxPlayersNum,
        description: description.trim(),
        rsvpDeadline,
        updatedAt: serverTimestamp(),
      });

      Alert.alert("Saved", "Match updated.");
      router.back();
    } catch (e) {
      console.error("Error saving match changes", e);
      Alert.alert("Error", "Could not update match.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
        <Text style={{ marginTop: 8 }}>Loading match...</Text>
      </View>
    );
  }

  if (!match) {
    return (
      <View style={styles.centered}>
        <Text>Match not found.</Text>
        <Button title="Back" onPress={() => router.back()} />
      </View>
    );
  }

  if (!isHost) {
    return (
      <View style={styles.centered}>
        <Text>Only the organizer can edit this match.</Text>
        <Button title="Back" onPress={() => router.back()} />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.header}>Edit match</Text>

      <Text style={styles.label}>Date & Time</Text>
      <Text
        style={styles.link}
        onPress={() => setShowPicker(true)}
      >
        {date?.toLocaleString()}
      </Text>
      {showPicker && date && (
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

      <View style={{ marginTop: 24 }}>
        <Button
          title={saving ? "Saving..." : "Save changes"}
          onPress={handleSave}
          disabled={saving}
        />
      </View>

      <View style={{ marginTop: 12 }}>
        <Button title="Cancel" color="#999" onPress={() => router.back()} />
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
    justifyContent: "center",
    alignItems: "center",
    padding: 16,
  },
  header: {
    fontSize: 22,
    fontWeight: "600",
    marginBottom: 16,
  },
  label: {
    marginTop: 16,
    marginBottom: 4,
    fontWeight: "600",
  },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    padding: 10,
  },
  link: {
    color: "blue",
  },
});
