// app/(app)/team/[teamId]/settings.tsx
import { useLocalSearchParams, useRouter } from "expo-router";
import {
    deleteDoc,
    doc,
    getDoc,
    onSnapshot,
    serverTimestamp,
    setDoc,
    type Unsubscribe,
} from "firebase/firestore";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useAuth } from "../../../../src/context/AuthContext";
import { db } from "../../../../src/firebaseConfig";


type TeamRole = "owner" | "admin" | "member" | "none";

type TeamDoc = {
  name?: string;
  homeCity?: string;
  defaultMaxPlayers?: number;

  // common ownership/admin patterns
  ownerId?: string;
  ownerUid?: string;
  createdBy?: string;

  adminUids?: string[];
  admins?: string[];

  deleted?: boolean;
  inviteCode?: string | null;
};

function paramToString(v: any): string | null {
  if (!v) return null;
  if (Array.isArray(v)) return v[0] ? String(v[0]) : null;
  return String(v);
}

function safeInt(v: string, fallback: number) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : fallback;
}

export default function TeamSettingsScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const teamId = paramToString((params as any)?.teamId);

  const { user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [team, setTeam] = useState<TeamDoc | null>(null);
  const [role, setRole] = useState<TeamRole>("none");

  // form
  const [name, setName] = useState("");
  const [homeCity, setHomeCity] = useState("");
  const [defaultMaxPlayersText, setDefaultMaxPlayersText] = useState("10");

  const [error, setError] = useState("");

  const didInitFormRef = useRef(false);

  const canEdit = role === "owner" || role === "admin";
  const isOwner = role === "owner";

  // ---------- load team + compute role ----------
  useEffect(() => {
    let unsubTeam: Unsubscribe | null = null;
    let unsubMember: Unsubscribe | null = null;

    setError("");

    if (!teamId) {
      setLoading(false);
      setTeam(null);
      setRole("none");
      return;
    }

    // Team doc
    const teamRef = doc(db, "teams", teamId);
    unsubTeam = onSnapshot(
      teamRef,
      (snap) => {
        if (!snap.exists()) {
          setTeam(null);
          setLoading(false);
          return;
        }

        const data = snap.data() as any as TeamDoc;
        setTeam(data);
        setLoading(false);

        // initialize form once (don’t clobber edits on live updates)
        if (!didInitFormRef.current) {
          setName(String(data?.name ?? ""));
          setHomeCity(String(data?.homeCity ?? ""));
          setDefaultMaxPlayersText(String(data?.defaultMaxPlayers ?? 10));
          didInitFormRef.current = true;
        }

        // compute role from team doc fields (owner/admin arrays)
        const uid = user?.uid ?? "";
        if (!uid) {
          setRole("none");
          return;
        }

        const ownerUid =
          data?.ownerId ?? data?.ownerUid ?? data?.createdBy ?? null;

        if (ownerUid && String(ownerUid) === uid) {
          setRole("owner");
          return;
        }

        const admins = (data?.adminUids ?? data?.admins ?? []) as any[];
        if (Array.isArray(admins) && admins.map(String).includes(uid)) {
          setRole((prev) => (prev === "owner" ? "owner" : "admin"));
          return;
        }

        // otherwise role might come from membership doc below
        setRole((prev) => (prev === "owner" || prev === "admin" ? prev : "member"));
      },
      (err) => {
        console.warn("team settings team onSnapshot error:", err);
        setError("Could not load team.");
        setLoading(false);
      }
    );

    // Membership doc (optional, but helps determine admin)
    // Assumption: teams/{teamId}/members/{uid} has { role: "owner"|"admin"|"member" }
    if (user?.uid) {
      const memberRef = doc(db, "teams", teamId, "members", user.uid);
      unsubMember = onSnapshot(
        memberRef,
        (snap) => {
          if (!snap.exists()) {
            // keep whatever role we already inferred
            return;
          }
          const d = snap.data() as any;
          const r = String(d?.role ?? "").toLowerCase();

          if (r === "owner") setRole("owner");
          else if (r === "admin") setRole((prev) => (prev === "owner" ? "owner" : "admin"));
          else if (r === "member") setRole((prev) => (prev === "owner" || prev === "admin" ? prev : "member"));
        },
        () => {
          // ignore membership read errors; team doc inference may still work
        }
      );
    }

    return () => {
      try {
        unsubTeam?.();
      } catch {}
      try {
        unsubMember?.();
      } catch {}
    };
  }, [teamId, user?.uid]);

  const normalized = useMemo(() => {
    const nm = name.trim();
    const city = homeCity.trim();
    const fallbackMax = team?.defaultMaxPlayers ?? 10;
    const maxPlayers = safeInt(defaultMaxPlayersText.trim(), fallbackMax);
    return { nm, city, maxPlayers };
  }, [name, homeCity, defaultMaxPlayersText, team?.defaultMaxPlayers]);

  const canSave = useMemo(() => {
    if (!teamId) return false;
    if (!user?.uid) return false;
    if (!team) return false;
    if (team?.deleted) return false;
    if (!canEdit) return false;
    if (saving) return false;

    const { nm, maxPlayers } = normalized;
    if (!nm) return false;
    if (!Number.isFinite(maxPlayers) || maxPlayers < 2 || maxPlayers > 50) return false;

    return true;
  }, [teamId, user?.uid, team, canEdit, saving, normalized]);

  const handleSave = async () => {
    if (!teamId || !user?.uid) return;
    if (!canEdit) {
      setError("Only owners/admins can edit team settings.");
      return;
    }

    const { nm, city, maxPlayers } = normalized;

    if (!nm) return setError("Team name is required.");
    if (!Number.isFinite(maxPlayers) || maxPlayers < 2 || maxPlayers > 50) {
      return setError("Default max players must be between 2 and 50.");
    }

    try {
      setError("");
      setSaving(true);

      const teamRef = doc(db, "teams", teamId);

      await setDoc(
        teamRef,
        {
          name: nm,
          homeCity: city,
          defaultMaxPlayers: maxPlayers,
          updatedAt: serverTimestamp(),
          updatedBy: user.uid,
        },
        { merge: true }
      );

      Alert.alert("Saved", "Team settings updated.");
    } catch (e: any) {
      console.error(e);
      setError(e?.message || "Could not save team settings.");
    } finally {
      setSaving(false);
    }
  };

  // ---------- Danger zone ----------
  const handleLeaveTeam = async () => {
    if (!teamId || !user?.uid) return;

    if (isOwner) {
      Alert.alert(
        "Owner can’t leave",
        "Owners can’t leave the team. Transfer ownership or delete the team instead."
      );
      return;
    }

    Alert.alert(
      "Leave team?",
      "You’ll lose access to team matches and chats.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Leave",
          style: "destructive",
          onPress: async () => {
            try {
              setSaving(true);
              setError("");

              // Assumption: membership doc is teams/{teamId}/members/{uid}
              const memberRef = doc(db, "teams", teamId, "members", user.uid);
              const snap = await getDoc(memberRef);
              if (snap.exists()) {
                await deleteDoc(memberRef);
              }

              Alert.alert("Left team", "You’ve left the team.");
              router.replace("/(app)/(tabs)/teams");
            } catch (e: any) {
              console.error(e);
              setError(e?.message || "Could not leave the team. (Check rules + membership path.)");
            } finally {
              setSaving(false);
            }
          },
        },
      ]
    );
  };

  const handleDeleteTeam = async () => {
    if (!teamId || !user?.uid) return;

    if (!isOwner) {
      Alert.alert("Owners only", "Only the team owner can delete the team.");
      return;
    }

    Alert.alert(
      "Delete team?",
      "This will disable the team and prevent new joins. (Recommended: soft delete.)",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              setSaving(true);
              setError("");

              const teamRef = doc(db, "teams", teamId);

              // Soft delete: hide team in UI + disable invites
              await setDoc(
                teamRef,
                {
                  deleted: true,
                  deletedAt: serverTimestamp(),
                  deletedBy: user.uid,
                  inviteCode: null,
                  updatedAt: serverTimestamp(),
                },
                { merge: true }
              );

              Alert.alert("Deleted", "Team deleted.");
              router.replace("/(app)/(tabs)/teams");
            } catch (e: any) {
              console.error(e);
              setError(e?.message || "Could not delete team.");
            } finally {
              setSaving(false);
            }
          },
        },
      ]
    );
  };

  // ---------- UI ----------
  if (!teamId) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <View style={styles.centerCard}>
          <Text style={styles.h1}>Missing team id</Text>
          <Pressable onPress={() => router.back()} style={styles.secondaryBtn}>
            <Text style={styles.secondaryBtnText}>Back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <View style={styles.centerCard}>
          <ActivityIndicator />
          <Text style={styles.subtle}>&nbsp;Loading team…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!team) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <View style={styles.centerCard}>
          <Text style={styles.h1}>Team not found</Text>
          <Text style={styles.subtle}>You may not have access, or it was deleted.</Text>
          <Pressable onPress={() => router.back()} style={styles.secondaryBtn}>
            <Text style={styles.secondaryBtnText}>Back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const disabled = !canEdit || saving || !!team.deleted;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {/* Header */}
        <View style={styles.header}>
          <Pressable
            onPress={() => router.back()}
            style={({ pressed }) => [styles.headerBtn, pressed && styles.pressed]}
          >
            <Text style={styles.headerBtnText}>‹ Back</Text>
          </Pressable>

          <View style={{ flex: 1, alignItems: "center" }}>
            <Text style={styles.headerTitle}>Team settings</Text>
            <Text style={styles.headerSub}>
              {role === "owner"
                ? "Owner"
                : role === "admin"
                ? "Admin"
                : role === "member"
                ? "Member"
                : "—"}
            </Text>
          </View>

          <Pressable
            onPress={handleSave}
            disabled={!canSave}
            style={({ pressed }) => [
              styles.saveBtn,
              !canSave && { opacity: 0.6 },
              pressed && canSave && styles.pressed,
            ]}
          >
            {saving ? (
              <ActivityIndicator color="#04130f" />
            ) : (
              <Text style={styles.saveBtnText}>Save</Text>
            )}
          </Pressable>
        </View>

        <View style={styles.container}>
          {!!error && <Text style={styles.error}>{error}</Text>}

          {!canEdit && (
            <View style={styles.infoPill}>
              <Text style={styles.infoText}>Only owners/admins can edit team settings.</Text>
            </View>
          )}

          {team.deleted && (
            <View style={[styles.infoPill, { backgroundColor: "rgba(255, 80, 80, 0.14)" }]}>
              <Text style={[styles.infoText, { color: "rgba(255,200,200,0.95)" }]}>
                This team is deleted.
              </Text>
            </View>
          )}

          {/* Settings card */}
          <View style={styles.card}>
            <Text style={styles.label}>Team name</Text>
            <View style={styles.inputRow}>
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={setName}
                editable={!disabled}
                placeholder="e.g., Pasadena FC"
                placeholderTextColor="rgba(255,255,255,0.35)"
              />
            </View>

            <Text style={[styles.label, { marginTop: 14 }]}>Home city</Text>
            <View style={styles.inputRow}>
              <TextInput
                style={styles.input}
                value={homeCity}
                onChangeText={setHomeCity}
                editable={!disabled}
                placeholder="e.g., Pasadena"
                placeholderTextColor="rgba(255,255,255,0.35)"
              />
            </View>

            <Text style={[styles.label, { marginTop: 14 }]}>Default max players</Text>
            <View style={styles.inputRow}>
              <TextInput
                style={styles.input}
                value={defaultMaxPlayersText}
                onChangeText={(t) => setDefaultMaxPlayersText(t.replace(/[^\d]/g, ""))}
                editable={!disabled}
                keyboardType="number-pad"
                placeholder="10"
                placeholderTextColor="rgba(255,255,255,0.35)"
              />
            </View>

            <Text style={styles.helpText}>Used as the default when creating matches.</Text>
          </View>

          {/* Danger zone */}
          <View style={[styles.card, styles.dangerCard]}>
            <Text style={styles.dangerTitle}>Danger zone</Text>
            <Text style={styles.dangerSub}>
              Leave the team or delete it. Deleting is owner-only.
            </Text>

            <Pressable
              onPress={handleLeaveTeam}
              disabled={saving || !user?.uid || !!team.deleted}
              style={({ pressed }) => [
                styles.dangerBtn,
                pressed && styles.pressed,
                (saving || !!team.deleted) && { opacity: 0.65 },
              ]}
            >
              <Text style={styles.dangerBtnText}>
                {isOwner ? "Owner can’t leave" : "Leave team"}
              </Text>
            </Pressable>

            <Pressable
              onPress={handleDeleteTeam}
              disabled={!isOwner || saving || !!team.deleted}
              style={({ pressed }) => [
                styles.deleteBtn,
                (!isOwner || saving || !!team.deleted) && { opacity: 0.55 },
                pressed && isOwner && !saving && styles.pressed,
              ]}
            >
              <Text style={styles.deleteBtnText}>Delete team</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#052b22" },

  pressed: { transform: [{ scale: 0.99 }] },

  header: {
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.10)",
    backgroundColor: "#052b22",
  },
  headerBtn: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.07)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    minWidth: 72,
    alignItems: "center",
    justifyContent: "center",
  },
  headerBtnText: { color: "rgba(255,255,255,0.88)", fontWeight: "900" },

  headerTitle: { color: "white", fontWeight: "900", fontSize: 16, letterSpacing: 0.2 },
  headerSub: { marginTop: 2, color: "rgba(255,255,255,0.60)", fontWeight: "800", fontSize: 12 },

  saveBtn: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: "#1b7f5a",
    minWidth: 72,
    alignItems: "center",
    justifyContent: "center",
  },
  saveBtnText: { color: "#04130f", fontWeight: "900", fontSize: 14 },

  container: { flex: 1, paddingHorizontal: 14, paddingTop: 14, paddingBottom: 18, gap: 12 },

  error: {
    color: "#ffb4b4",
    fontWeight: "800",
    textAlign: "center",
    marginBottom: 2,
  },

  infoPill: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  infoText: { color: "rgba(255,255,255,0.82)", fontWeight: "800", textAlign: "center" },

  card: {
    borderRadius: 22,
    padding: 16,
    backgroundColor: "rgba(10, 16, 25, 0.78)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },

  label: {
    fontSize: 15,
    fontWeight: "900",
    color: "rgba(255,255,255,0.78)",
    marginBottom: 8,
  },
  inputRow: {
    borderRadius: 16,
    paddingHorizontal: 14,
    height: 54,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    justifyContent: "center",
  },
  input: { color: "white", fontSize: 16, fontWeight: "800" },

  helpText: {
    marginTop: 10,
    color: "rgba(255,255,255,0.55)",
    fontWeight: "800",
    fontSize: 12,
  },

  dangerCard: {
    borderColor: "rgba(255, 80, 80, 0.22)",
    backgroundColor: "rgba(10, 16, 25, 0.78)",
  },
  dangerTitle: { color: "rgba(255,200,200,0.95)", fontWeight: "900", fontSize: 16 },
  dangerSub: {
    marginTop: 6,
    color: "rgba(255,255,255,0.62)",
    fontWeight: "800",
    lineHeight: 18,
  },

  dangerBtn: {
    marginTop: 12,
    height: 52,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  dangerBtnText: { color: "rgba(255,255,255,0.90)", fontWeight: "900" },

  deleteBtn: {
    marginTop: 10,
    height: 52,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 80, 80, 0.14)",
    borderWidth: 1,
    borderColor: "rgba(255, 80, 80, 0.26)",
  },
  deleteBtnText: { color: "rgba(255,200,200,0.95)", fontWeight: "900" },

  centerCard: {
    marginTop: 40,
    marginHorizontal: 14,
    borderRadius: 22,
    padding: 18,
    backgroundColor: "rgba(10, 16, 25, 0.78)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    alignItems: "center",
  },
  h1: { color: "white", fontWeight: "900", fontSize: 18 },
  subtle: { marginTop: 8, color: "rgba(255,255,255,0.65)", fontWeight: "800", textAlign: "center" },

  secondaryBtn: {
    marginTop: 14,
    height: 52,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  secondaryBtnText: { color: "rgba(255,255,255,0.88)", fontSize: 16, fontWeight: "900" },
});
