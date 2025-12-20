// app/(app)/match/edit.tsx
import DateTimePicker from "@react-native-community/datetimepicker";
import { useLocalSearchParams, useRouter } from "expo-router";
import { deleteField, doc, getDoc, serverTimestamp, updateDoc } from "firebase/firestore";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Button,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useAuth } from "../../../src/context/AuthContext";
import { db } from "../../../src/firebaseConfig";

type MatchStatus = "scheduled" | "played" | "cancelled" | string;

function toDate(raw: any): Date {
  if (!raw) return new Date();
  if (typeof raw?.toDate === "function") return raw.toDate();
  return new Date(raw);
}

export default function EditMatchScreen() {
  const { matchId } = useLocalSearchParams();
  const { user } = useAuth();
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [match, setMatch] = useState<any | null>(null);

  const [date, setDate] = useState<Date | null>(null);
  const [showStartPicker, setShowStartPicker] = useState(false);

  const [locationText, setLocationText] = useState("");
  const [maxPlayers, setMaxPlayers] = useState("");
  const [minPlayers, setMinPlayers] = useState("");
  const [description, setDescription] = useState("");

  const [useDeadline, setUseDeadline] = useState(false);
  const [deadlineDate, setDeadlineDate] = useState<Date | null>(null);
  const [showDeadlinePicker, setShowDeadlinePicker] = useState(false);

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

        const start = toDate(data.startDateTime);
        setDate(start);

        setLocationText(data.locationText || "");
        setMaxPlayers(data.maxPlayers != null ? String(data.maxPlayers) : "");
        setMinPlayers(data.minPlayers != null ? String(data.minPlayers) : "");
        setDescription(data.description || "");

        if (data.rsvpDeadline) {
          const d = toDate(data.rsvpDeadline);
          setUseDeadline(true);
          setDeadlineDate(d);
        } else {
          setUseDeadline(false);
          setDeadlineDate(null);
        }
      } catch (e) {
        console.error("Error loading match for edit", e);
        Alert.alert("Error", "Could not load match.");
        router.back();
      } finally {
        setLoading(false);
      }
    };

    loadMatch();
  }, [matchId, router]);

  const isHost = !!user?.uid && match?.createdBy === user.uid;

  const status: MatchStatus = useMemo(
    () => ((match?.status ?? "scheduled") as string).toLowerCase(),
    [match?.status]
  );

  const isEditable = status !== "played" && status !== "cancelled" && status !== "canceled";

  const setDeadline24hBefore = () => {
    if (!date) return;
    const d = new Date(date.getTime() - 24 * 60 * 60 * 1000);
    setUseDeadline(true);
    setDeadlineDate(d);
  };

  const parseNonNegativeInt = (label: string, raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      throw new Error(`${label} must be a whole number (0 or more).`);
    }
    return n;
  };

  const parsePositiveInt = (label: string, raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      throw new Error(`${label} must be a whole number greater than 0.`);
    }
    return n;
  };

  const handleSave = async () => {
    if (!matchId || !date) return;

    if (!isHost) {
      Alert.alert("Only the organizer can edit this match.");
      return;
    }

    if (!isEditable) {
      Alert.alert("This match can’t be edited", "Played/cancelled matches are locked.");
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

    const desc = description.trim();
    if (desc.length > 800) {
      Alert.alert("Description too long", "Keep it under 800 characters.");
      return;
    }

    let maxPlayersNum: number;
    let minPlayersNum: number;

    try {
      maxPlayersNum = parsePositiveInt("Max players", maxPlayers.trim());
      minPlayersNum = minPlayers.trim() ? parseNonNegativeInt("Min players", minPlayers.trim()) : 0;

      if (minPlayersNum > maxPlayersNum) {
        Alert.alert("Min players can’t exceed max players.");
        return;
      }

      if (useDeadline) {
        if (!deadlineDate) {
          Alert.alert("RSVP deadline required", "Pick a deadline or disable RSVP deadline.");
          return;
        }
        if (deadlineDate.getTime() > date.getTime()) {
          Alert.alert("RSVP deadline must be before the match start time.");
          return;
        }
      }
    } catch (err: any) {
      Alert.alert("Invalid input", err?.message ?? "Please check your values.");
      return;
    }

    try {
      setSaving(true);

      const matchRef = doc(db, "matches", String(matchId));
      await updateDoc(matchRef, {
        startDateTime: date,
        locationText: locationText.trim(),
        maxPlayers: maxPlayersNum,
        minPlayers: minPlayersNum,
        description: desc,
        ...(useDeadline ? { rsvpDeadline: deadlineDate } : { rsvpDeadline: deleteField() }),
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

  if (!isEditable) {
    return (
      <View style={styles.centered}>
        <Text>This match can’t be edited (status: {String(status)}).</Text>
        <Button title="Back" onPress={() => router.back()} />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.header}>Edit match</Text>

      <Text style={styles.label}>Date & Time</Text>
      <Text style={styles.link} onPress={() => setShowStartPicker(true)}>
        {date?.toLocaleString()}
      </Text>
      {showStartPicker && date && (
        <DateTimePicker
          value={date}
          mode="datetime"
          onChange={(event, selectedDate) => {
            setShowStartPicker(false);
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
        placeholder="e.g., 12"
      />

      <Text style={styles.label}>Min Players</Text>
      <TextInput
        style={styles.input}
        keyboardType="numeric"
        value={minPlayers}
        onChangeText={setMinPlayers}
        placeholder="e.g., 8"
      />

      <View style={styles.deadlineRow}>
        <Text style={styles.label}>RSVP Deadline</Text>
        <View style={styles.switchRow}>
          <Text style={{ marginRight: 8 }}>{useDeadline ? "On" : "Off"}</Text>
          <Switch value={useDeadline} onValueChange={setUseDeadline} />
        </View>
      </View>

      {useDeadline && (
        <>
          <Text style={styles.link} onPress={() => setShowDeadlinePicker(true)}>
            {deadlineDate ? deadlineDate.toLocaleString() : "Pick a deadline"}
          </Text>

          {showDeadlinePicker && (deadlineDate ?? date) && (
            <DateTimePicker
              value={deadlineDate ?? date!}
              mode="datetime"
              onChange={(event, selected) => {
                setShowDeadlinePicker(false);
                if (selected) setDeadlineDate(selected);
              }}
            />
          )}

          <View style={{ marginTop: 8 }}>
            <Button title="Set to 24 hours before start" onPress={setDeadline24hBefore} />
          </View>
        </>
      )}

      <Text style={styles.label}>Description (optional)</Text>
      <TextInput
        style={[styles.input, { height: 80 }]}
        multiline
        value={description}
        onChangeText={setDescription}
      />
      <Text style={styles.subtle}>{description.trim().length}/800</Text>

      <View style={{ marginTop: 24 }}>
        <Button title={saving ? "Saving..." : "Save changes"} onPress={handleSave} disabled={saving} />
      </View>

      <View style={{ marginTop: 12 }}>
        <Button title="Cancel" color="#999" onPress={() => router.back()} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, paddingBottom: 40 },
  centered: { flex: 1, justifyContent: "center", alignItems: "center", padding: 16 },
  header: { fontSize: 22, fontWeight: "600", marginBottom: 16 },
  label: { marginTop: 16, marginBottom: 4, fontWeight: "600" },
  subtle: { marginTop: 6, color: "#666" },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10 },
  link: { color: "blue", paddingVertical: 6 },
  deadlineRow: {
    marginTop: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  switchRow: { flexDirection: "row", alignItems: "center" },
});
