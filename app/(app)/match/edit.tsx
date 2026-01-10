// app/(app)/match/edit.tsx
import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import { useLocalSearchParams, useRouter } from "expo-router";
import { deleteField, doc, getDoc, serverTimestamp, updateDoc } from "firebase/firestore";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../../src/context/AuthContext";
import { db } from "../../../src/firebaseConfig";

type MatchStatus = "scheduled" | "played" | "cancelled" | string;

function toDate(raw: any): Date {
  if (!raw) return new Date();
  if (typeof raw?.toDate === "function") return raw.toDate();
  return new Date(raw);
}

function openAndroidDateTimePicker(initial: Date, onPicked: (d: Date | null) => void) {
  DateTimePickerAndroid.open({
    value: initial,
    mode: "date",
    is24Hour: false,
    onChange: (event, selectedDate) => {
      if (event.type === "dismissed" || !selectedDate) return onPicked(null);

      const base = new Date(initial);
      base.setFullYear(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate());

      DateTimePickerAndroid.open({
        value: base,
        mode: "time",
        is24Hour: false,
        onChange: (event2, selectedTime) => {
          if (event2.type === "dismissed" || !selectedTime) return onPicked(null);

          base.setHours(selectedTime.getHours(), selectedTime.getMinutes(), 0, 0);
          onPicked(base);
        },
      });
    },
  });
}

export default function EditMatchScreen() {
  const { matchId } = useLocalSearchParams();
  const { user } = useAuth();
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [match, setMatch] = useState<any | null>(null);

  const [date, setDate] = useState<Date | null>(null);

  const [locationText, setLocationText] = useState("");
  const [maxPlayers, setMaxPlayers] = useState("");
  const [minPlayers, setMinPlayers] = useState("");
  const [description, setDescription] = useState("");

  const [useDeadline, setUseDeadline] = useState(false);
  const [deadlineDate, setDeadlineDate] = useState<Date | null>(null);

  // iOS picker sheet state
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<"start" | "deadline">("start");
  const [tempPickerDate, setTempPickerDate] = useState<Date>(new Date());

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
    () => String(match?.status ?? "scheduled").toLowerCase(),
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

  const openStartPicker = () => {
    if (!date || saving) return;

    if (Platform.OS === "ios") {
      setPickerTarget("start");
      setTempPickerDate(date);
      setPickerOpen(true);
      return;
    }

    openAndroidDateTimePicker(date, (picked) => {
      if (picked) setDate(picked);
    });
  };

  const openDeadlinePicker = () => {
    if (!date || saving) return;

    const initial = deadlineDate ?? new Date(date.getTime() - 24 * 60 * 60 * 1000);

    if (Platform.OS === "ios") {
      setPickerTarget("deadline");
      setTempPickerDate(initial);
      setPickerOpen(true);
      return;
    }

    openAndroidDateTimePicker(initial, (picked) => {
      if (picked) {
        setUseDeadline(true);
        setDeadlineDate(picked);
      }
    });
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
      Alert.alert("Start time must be in the future (or very close to now).");
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

        updatedBy: user?.uid ?? null,
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

  const startText = useMemo(() => (date ? date.toLocaleString() : ""), [date]);
  const deadlineText = useMemo(() => (deadlineDate ? deadlineDate.toLocaleString() : ""), [deadlineDate]);

  // Loading / guard states (styled)
  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.screen}>
          <View style={styles.bg}>
            <View style={styles.pitchLines} />
          </View>
          <View style={[styles.centerWrap, { paddingHorizontal: 18 }]}>
            <View style={styles.loadingCard}>
              <ActivityIndicator />
              <Text style={styles.centerText}>Loading match…</Text>

              <Pressable
                onPress={() => router.back()}
                style={({ pressed }) => [styles.secondaryBtn, pressed && { transform: [{ scale: 0.99 }] }]}
              >
                <Text style={styles.secondaryBtnText}>Back</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (!match) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.screen}>
          <View style={styles.bg}>
            <View style={styles.pitchLines} />
          </View>
          <View style={[styles.centerWrap, { paddingHorizontal: 18 }]}>
            <View style={styles.card}>
              <Text style={styles.h1}>Match not found</Text>
              <Text style={styles.subtleText}>This match may have been deleted.</Text>
              <Pressable
                onPress={() => router.back()}
                style={({ pressed }) => [styles.primaryBtn, pressed && { transform: [{ scale: 0.99 }] }]}
              >
                <Text style={styles.primaryBtnText}>Back</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (!isHost) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.screen}>
          <View style={styles.bg}>
            <View style={styles.pitchLines} />
          </View>
          <View style={[styles.centerWrap, { paddingHorizontal: 18 }]}>
            <View style={styles.card}>
              <Text style={styles.h1}>Not allowed</Text>
              <Text style={styles.subtleText}>Only the organizer can edit this match.</Text>
              <Pressable
                onPress={() => router.back()}
                style={({ pressed }) => [styles.primaryBtn, pressed && { transform: [{ scale: 0.99 }] }]}
              >
                <Text style={styles.primaryBtnText}>Back</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (!isEditable) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.screen}>
          <View style={styles.bg}>
            <View style={styles.pitchLines} />
          </View>
          <View style={[styles.centerWrap, { paddingHorizontal: 18 }]}>
            <View style={styles.card}>
              <Text style={styles.h1}>Locked</Text>
              <Text style={styles.subtleText}>Played/cancelled matches can’t be edited (status: {String(status)}).</Text>
              <Pressable
                onPress={() => router.back()}
                style={({ pressed }) => [styles.primaryBtn, pressed && { transform: [{ scale: 0.99 }] }]}
              >
                <Text style={styles.primaryBtnText}>Back</Text>
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
        <View style={styles.bg}>
          <View style={styles.pitchLines} />
        </View>

        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <ScrollView
            style={{ flex: 1 }}
            contentInsetAdjustmentBehavior="automatic"
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
            contentContainerStyle={styles.scrollContent}
          >
            <View style={styles.header}>
              <Text style={styles.h1}>Edit match</Text>
              <Text style={styles.subtleText}>Update details for your squad.</Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.label}>Date & time</Text>
              <Pressable
                onPress={openStartPicker}
                disabled={saving}
                style={({ pressed }) => [styles.inputRow, pressed && !saving && { transform: [{ scale: 0.997 }] }]}
              >
                <Text style={styles.icon}>🗓️</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.valueText}>{startText}</Text>
                  <Text style={styles.helper}>Tap to change start time</Text>
                </View>
                <Text style={styles.chev}>›</Text>
              </Pressable>

              <Text style={[styles.label, { marginTop: 14 }]}>Location</Text>
              <View style={styles.inputRow}>
                <Text style={styles.icon}>📍</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. Riverside Park, Field 3"
                  placeholderTextColor="rgba(255,255,255,0.35)"
                  value={locationText}
                  onChangeText={setLocationText}
                  editable={!saving}
                />
              </View>

              <Text style={[styles.label, { marginTop: 14 }]}>Max players</Text>
              <View style={styles.inputRow}>
                <Text style={styles.icon}>👥</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. 12"
                  placeholderTextColor="rgba(255,255,255,0.35)"
                  keyboardType="numeric"
                  value={maxPlayers}
                  onChangeText={setMaxPlayers}
                  editable={!saving}
                />
              </View>

              <Text style={[styles.label, { marginTop: 14 }]}>Min players</Text>
              <View style={styles.inputRow}>
                <Text style={styles.icon}>🧍</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. 8"
                  placeholderTextColor="rgba(255,255,255,0.35)"
                  keyboardType="numeric"
                  value={minPlayers}
                  onChangeText={setMinPlayers}
                  editable={!saving}
                />
              </View>

              <View style={styles.deadlineHeaderRow}>
                <Text style={styles.label}>RSVP deadline</Text>
                <View style={styles.switchRow}>
                  <Text style={styles.switchText}>{useDeadline ? "On" : "Off"}</Text>
                  <Switch
                    value={useDeadline}
                    onValueChange={(v) => {
                      setUseDeadline(v);
                      if (v && !deadlineDate && date) {
                        setDeadlineDate(new Date(date.getTime() - 24 * 60 * 60 * 1000));
                      }
                    }}
                  />
                </View>
              </View>

              {useDeadline && (
                <>
                  <Pressable
                    onPress={openDeadlinePicker}
                    disabled={saving}
                    style={({ pressed }) => [
                      styles.inputRow,
                      pressed && !saving && { transform: [{ scale: 0.997 }] },
                    ]}
                  >
                    <Text style={styles.icon}>⏱️</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.valueText}>{deadlineText || "Pick a deadline"}</Text>
                      <Text style={styles.helper}>Must be before match start</Text>
                    </View>
                    <Text style={styles.chev}>›</Text>
                  </Pressable>

                  <Pressable
                    onPress={setDeadline24hBefore}
                    disabled={saving}
                    style={({ pressed }) => [
                      styles.secondaryBtnSmall,
                      pressed && !saving && { transform: [{ scale: 0.99 }] },
                    ]}
                  >
                    <Text style={styles.secondaryBtnText}>Set to 24 hours before start</Text>
                  </Pressable>
                </>
              )}

              <Text style={[styles.label, { marginTop: 14 }]}>Description (optional)</Text>
              <View style={[styles.inputRow, { alignItems: "flex-start", paddingVertical: 12 }]}>
                <Text style={[styles.icon, { marginTop: 2 }]}>📝</Text>
                <TextInput
                  style={[styles.input, { height: 96, textAlignVertical: "top" }]}
                  multiline
                  value={description}
                  onChangeText={setDescription}
                  editable={!saving}
                  placeholder="Any key details players should know…"
                  placeholderTextColor="rgba(255,255,255,0.35)"
                />
              </View>
              <Text style={styles.charCount}>{description.trim().length}/800</Text>

              <Pressable
                onPress={handleSave}
                disabled={saving}
                style={({ pressed }) => [
                  styles.primaryBtn,
                  pressed && !saving && { transform: [{ scale: 0.99 }] },
                ]}
              >
                {saving ? <ActivityIndicator /> : <Text style={styles.primaryBtnText}>Save changes</Text>}
              </Pressable>

              <Pressable
                onPress={() => router.back()}
                disabled={saving}
                style={({ pressed }) => [
                  styles.secondaryBtn,
                  pressed && !saving && { transform: [{ scale: 0.99 }] },
                ]}
              >
                <Text style={styles.secondaryBtnText}>Cancel</Text>
              </Pressable>
            </View>

            <Text style={styles.footer}>⚽ Tip: keep notes short — players actually read them.</Text>
          </ScrollView>
        </KeyboardAvoidingView>

        {/* iOS bottom-sheet picker for start/deadline */}
        <Modal transparent visible={pickerOpen} animationType="fade" onRequestClose={() => setPickerOpen(false)}>
          <View style={styles.modalRoot}>
            <Pressable style={styles.backdrop} onPress={() => setPickerOpen(false)} />

            <View style={styles.sheetWrap}>
              <View style={styles.sheet}>
                <View style={styles.sheetHeader}>
                  <Pressable onPress={() => setPickerOpen(false)} style={styles.sheetBtn}>
                    <Text style={styles.sheetBtnText}>Cancel</Text>
                  </Pressable>

                  <Text style={styles.sheetTitle}>
                    {pickerTarget === "start" ? "Start time" : "RSVP deadline"}
                  </Text>

                  <Pressable
                    onPress={() => {
                      if (pickerTarget === "start") {
                        setDate(tempPickerDate);
                      } else {
                        setUseDeadline(true);
                        setDeadlineDate(tempPickerDate);
                      }
                      setPickerOpen(false);
                    }}
                    style={styles.sheetBtn}
                  >
                    <Text style={styles.sheetBtnTextStrong}>Done</Text>
                  </Pressable>
                </View>

                <View style={styles.sheetBody}>
                  <DateTimePicker
                    value={tempPickerDate}
                    mode="datetime"
                    display="spinner"
                    themeVariant="dark"
                    onChange={(_, selected) => {
                      if (selected) setTempPickerDate(selected);
                    }}
                  />
                  {pickerTarget === "deadline" && date ? (
                    <Text style={styles.sheetHint}>Deadline must be before {date.toLocaleString()}</Text>
                  ) : (
                    <Text style={styles.sheetHint}>Pick the exact date & time</Text>
                  )}
                </View>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#052b22" },
  screen: { flex: 1, backgroundColor: "#052b22" },

  bg: { ...StyleSheet.absoluteFillObject, backgroundColor: "#052b22" },
  pitchLines: { ...StyleSheet.absoluteFillObject, opacity: 0.32, backgroundColor: "transparent" },

  scrollContent: {
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 28,
    flexGrow: 1,
  },

  centerWrap: { flex: 1, justifyContent: "center" },
  loadingCard: {
    borderRadius: 22,
    padding: 18,
    backgroundColor: "rgba(10, 16, 25, 0.78)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    alignItems: "center",
  },
  centerText: { marginTop: 10, color: "rgba(255,255,255,0.75)", fontWeight: "800" },

  header: { marginBottom: 12 },
  h1: { fontSize: 34, fontWeight: "900", color: "white", letterSpacing: 0.2 },
  subtleText: { marginTop: 6, fontSize: 15, fontWeight: "800", color: "rgba(255,255,255,0.72)" },

  card: {
    marginTop: 10,
    borderRadius: 22,
    padding: 18,
    backgroundColor: "rgba(10, 16, 25, 0.78)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },

  label: { fontSize: 16, fontWeight: "900", color: "rgba(255,255,255,0.78)", marginBottom: 8 },

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
  input: { flex: 1, color: "white", fontSize: 16, fontWeight: "800" },
  valueText: { color: "white", fontSize: 16, fontWeight: "900" },
  helper: { marginTop: 4, color: "rgba(255,255,255,0.55)", fontSize: 12, fontWeight: "800" },
  chev: { marginLeft: 10, color: "rgba(255,255,255,0.6)", fontSize: 22, fontWeight: "900" },

  deadlineHeaderRow: { marginTop: 14, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  switchText: { color: "rgba(255,255,255,0.75)", fontWeight: "900" },

  charCount: { marginTop: 6, color: "rgba(255,255,255,0.55)", fontWeight: "800", fontSize: 12 },

  primaryBtn: {
    marginTop: 18,
    height: 54,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1b7f5a",
  },
  primaryBtnText: { color: "#04130f", fontSize: 18, fontWeight: "900", textTransform: "capitalize" },

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
  secondaryBtnSmall: {
    marginTop: 10,
    height: 44,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  secondaryBtnText: { color: "rgba(255,255,255,0.85)", fontSize: 16, fontWeight: "900" },

  footer: { marginTop: 14, textAlign: "center", color: "rgba(255,255,255,0.55)", fontSize: 13, fontWeight: "800" },

  // Modal sheet
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.45)" },
  sheetWrap: { paddingHorizontal: 12, paddingBottom: 12 },
  sheet: {
    borderRadius: 20,
    overflow: "hidden",
    backgroundColor: "rgba(10, 16, 25, 0.98)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.10)",
  },
  sheetTitle: { color: "white", fontWeight: "900", fontSize: 16 },
  sheetBtn: { paddingVertical: 6, paddingHorizontal: 8 },
  sheetBtnText: { color: "rgba(255,255,255,0.75)", fontWeight: "900", fontSize: 14 },
  sheetBtnTextStrong: { color: "white", fontWeight: "900", fontSize: 14 },
  sheetBody: { paddingHorizontal: 12, paddingBottom: 14, paddingTop: 10 },
  sheetHint: { marginTop: 10, color: "rgba(255,255,255,0.60)", fontSize: 12, fontWeight: "800" },
});
