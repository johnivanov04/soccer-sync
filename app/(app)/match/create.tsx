// app/(app)/match/create.tsx
import DateTimePicker from "@react-native-community/datetimepicker";
import { useRouter } from "expo-router";
import { addDoc, collection, doc, getDoc, serverTimestamp } from "firebase/firestore";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
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

  const [date, setDate] = useState<Date>(() => new Date(Date.now() + 60 * 60 * 1000));
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

        // NOTE: Your app has moved to memberships as source of truth elsewhere,
        // but this screen is still using users/{uid}.teamId. Keeping this intact for now.
        const userRef = doc(db, "users", user.uid);
        const userSnap = await getDoc(userRef);

        const data = userSnap.exists() ? (userSnap.data() as any) : null;
        const tid = data?.teamId ?? data?.teamCode ?? data?.team ?? data?.team_id ?? null;

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
          const tname = teamSnap.exists() ? (teamSnap.data() as any)?.name : "";
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

  const displayTeam = useMemo(() => teamName || teamId || "", [teamName, teamId]);

  const isDirty = useMemo(() => {
    return (
      locationText.trim().length > 0 ||
      description.trim().length > 0 ||
      maxPlayers.trim() !== "14"
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

  const dateText = useMemo(() => {
    return date.toLocaleString();
  }, [date]);

  const deadlineText = useMemo(() => {
    const d = computeRsvpDeadline(date);
    return d.toLocaleString();
  }, [date]);

  const canPublish = useMemo(() => {
    if (creating) return false;
    if (!user?.uid) return false;
    if (!teamId) return false;
    if (!locationText.trim()) return false;
    const maxPlayersNum = Number(maxPlayers);
    if (!Number.isFinite(maxPlayersNum) || !Number.isInteger(maxPlayersNum) || maxPlayersNum <= 0)
      return false;
    const now = Date.now();
    if (date.getTime() < now - 5 * 60 * 1000) return false;
    return true;
  }, [creating, user?.uid, teamId, locationText, maxPlayers, date]);

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
    if (!Number.isFinite(maxPlayersNum) || !Number.isInteger(maxPlayersNum) || maxPlayersNum <= 0) {
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
        <View style={styles.screen}>
          <View style={styles.bg}>
            <View style={styles.pitchLines} />
          </View>

          <View style={[styles.centerWrap, { paddingHorizontal: 18 }]}>
            <View style={styles.loadingCard}>
              <ActivityIndicator />
              <Text style={{ marginTop: 10, color: "rgba(255,255,255,0.75)", fontWeight: "800" }}>
                Loading your team…
              </Text>

              <Pressable
                onPress={handleCancel}
                disabled={creating}
                style={({ pressed }) => [
                  styles.secondaryBtn,
                  pressed && { transform: [{ scale: 0.99 }] },
                ]}
              >
                <Text style={styles.secondaryBtnText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (!teamId) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.screen}>
          <View style={styles.bg}>
            <View style={styles.pitchLines} />
          </View>

          <View style={[styles.centerWrap, { paddingHorizontal: 18 }]}>
            <View style={styles.card}>
              <Text style={styles.h1}>No team yet</Text>
              <Text style={styles.subtleText}>
                Join or create a team from the Teams tab before creating matches.
              </Text>

              <Pressable
                onPress={() => router.push("/(app)/(tabs)/teams")}
                style={({ pressed }) => [
                  styles.primaryBtn,
                  pressed && { transform: [{ scale: 0.99 }] },
                ]}
              >
                <Text style={styles.primaryBtnText}>Go to Teams</Text>
              </Pressable>

              <Pressable
                onPress={handleCancel}
                style={({ pressed }) => [
                  styles.secondaryBtn,
                  pressed && { transform: [{ scale: 0.99 }] },
                ]}
              >
                <Text style={styles.secondaryBtnText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.screen}>
        {/* Background */}
        <View style={styles.bg}>
          <View style={styles.pitchLines} />
        </View>

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          {/* ✅ Scroll enabled */}
          <ScrollView
            style={{ flex: 1 }}
            contentInsetAdjustmentBehavior="automatic"
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
            contentContainerStyle={styles.scrollContent}
          >
            {/* Header */}
            <View style={styles.header}>
              <Text style={styles.h1}>Create match</Text>
              <Text style={styles.subtleText}>Set the details and publish to your squad.</Text>

              {!!displayTeam && (
                <View style={styles.teamPill}>
                  <Text style={styles.teamPillText}>Creating for {displayTeam}</Text>
                </View>
              )}
            </View>

            {/* Form */}
            <View style={styles.card}>
              {/* Date & Time */}
              <Text style={styles.label}>Date & time</Text>
              <Pressable
                onPress={() => setShowPicker(true)}
                disabled={creating}
                style={({ pressed }) => [
                  styles.inputRow,
                  pressed && !creating && { transform: [{ scale: 0.997 }] },
                ]}
              >
                <Text style={styles.icon}>🗓️</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.valueText}>{dateText}</Text>
                  <Text style={styles.helper}>RSVP deadline defaults to {deadlineText}</Text>
                </View>
                <Text style={styles.chev}>›</Text>
              </Pressable>

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

              {/* Location */}
              <Text style={[styles.label, { marginTop: 14 }]}>Location</Text>
              <View style={styles.inputRow}>
                <Text style={styles.icon}>📍</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. Riverside Park, Field 3"
                  placeholderTextColor="rgba(255,255,255,0.35)"
                  value={locationText}
                  onChangeText={setLocationText}
                  editable={!creating}
                />
              </View>

              {/* Max players */}
              <Text style={[styles.label, { marginTop: 14 }]}>Max players</Text>
              <View style={styles.inputRow}>
                <Text style={styles.icon}>👥</Text>
                <TextInput
                  style={styles.input}
                  placeholder="14"
                  placeholderTextColor="rgba(255,255,255,0.35)"
                  keyboardType="numeric"
                  value={maxPlayers}
                  onChangeText={setMaxPlayers}
                  editable={!creating}
                />
              </View>
              <Text style={styles.helper}>Tip: use 10–14 for small-sided, 16–22 for full field.</Text>

              {/* Description */}
              <Text style={[styles.label, { marginTop: 14 }]}>Description (optional)</Text>
              <View style={[styles.inputRow, { alignItems: "flex-start", paddingVertical: 12 }]}>
                <Text style={[styles.icon, { marginTop: 2 }]}>📝</Text>
                <TextInput
                  style={[styles.input, { height: 96, textAlignVertical: "top" }]}
                  multiline
                  value={description}
                  onChangeText={setDescription}
                  editable={!creating}
                  placeholder="Shoes, parking, who brings balls, color shirts, etc."
                  placeholderTextColor="rgba(255,255,255,0.35)"
                />
              </View>

              {/* Actions */}
              <Pressable
                onPress={handleCreate}
                disabled={!canPublish}
                style={({ pressed }) => [
                  styles.primaryBtn,
                  !canPublish && styles.primaryBtnDisabled,
                  pressed && canPublish && { transform: [{ scale: 0.99 }] },
                ]}
              >
                {creating ? <ActivityIndicator /> : <Text style={styles.primaryBtnText}>Publish match</Text>}
              </Pressable>

              <Pressable
                onPress={handleCancel}
                disabled={creating}
                style={({ pressed }) => [
                  styles.secondaryBtn,
                  pressed && !creating && { transform: [{ scale: 0.99 }] },
                ]}
              >
                <Text style={styles.secondaryBtnText}>Cancel</Text>
              </Pressable>
            </View>

            <Text style={styles.footer}>⚽ Pro tip: put “bring a white & dark shirt” in the notes.</Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#052b22" },
  screen: { flex: 1, backgroundColor: "#052b22" },

  // Background
  bg: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#052b22",
  },
  pitchLines: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0.32,
    backgroundColor: "transparent",
  },

  // ✅ Scroll container
  scrollContent: {
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 28,
    flexGrow: 1,
  },

  // Centered shells (loading / no team)
  centerWrap: {
    flex: 1,
    justifyContent: "center",
  },

  header: {
    marginBottom: 12,
  },
  h1: {
    fontSize: 34,
    fontWeight: "900",
    color: "white",
    letterSpacing: 0.2,
  },
  subtleText: {
    marginTop: 6,
    fontSize: 15,
    fontWeight: "800",
    color: "rgba(255,255,255,0.72)",
  },

  teamPill: {
    marginTop: 12,
    alignSelf: "flex-start",
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.10)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },
  teamPillText: {
    color: "rgba(255,255,255,0.85)",
    fontWeight: "900",
    fontSize: 13,
  },

  card: {
    marginTop: 10,
    borderRadius: 22,
    padding: 18,
    backgroundColor: "rgba(10, 16, 25, 0.78)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },

  loadingCard: {
    borderRadius: 22,
    padding: 18,
    backgroundColor: "rgba(10, 16, 25, 0.78)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    alignItems: "center",
  },

  label: {
    fontSize: 16,
    fontWeight: "900",
    color: "rgba(255,255,255,0.78)",
    marginBottom: 8,
  },

  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    minHeight: 54,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  icon: { fontSize: 18, marginRight: 10, opacity: 0.9 },
  input: {
    flex: 1,
    color: "white",
    fontSize: 16,
    fontWeight: "800",
  },
  valueText: {
    color: "white",
    fontSize: 16,
    fontWeight: "900",
  },
  helper: {
    marginTop: 4,
    color: "rgba(255,255,255,0.55)",
    fontSize: 12,
    fontWeight: "800",
  },
  chev: {
    marginLeft: 10,
    color: "rgba(255,255,255,0.6)",
    fontSize: 22,
    fontWeight: "900",
  },

  primaryBtn: {
    marginTop: 18,
    height: 54,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1b7f5a",
  },
  primaryBtnDisabled: {
    opacity: 0.55,
  },
  primaryBtnText: {
    color: "#04130f",
    fontSize: 18,
    fontWeight: "900",
    textTransform: "capitalize",
  },

  secondaryBtn: {
    marginTop: 12,
    height: 54,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  secondaryBtnText: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 16,
    fontWeight: "900",
  },

  footer: {
    marginTop: 14,
    textAlign: "center",
    color: "rgba(255,255,255,0.55)",
    fontSize: 13,
    fontWeight: "800",
  },
});
