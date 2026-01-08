// app/(app)/(tabs)/profile.tsx
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import React, { useEffect, useMemo, useRef, useState } from "react";
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

import { updateProfile } from "firebase/auth";
import {
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { deleteObject, getDownloadURL, ref, uploadBytes } from "firebase/storage";

import { useAuth } from "../../../src/context/AuthContext";
import { db, storage } from "../../../src/firebaseConfig";

// ✅ same logo as auth screens
const LOGO = require("../../../assets/images/pickupsoccerlogo.png");

type UserDoc = {
  displayName?: string;
  teamId?: string | null;
  photoURL?: string | null;
  photoPath?: string | null;
  updatedAt?: any;
};

type TeamDoc = {
  name?: string;
};

function initialsFromBase(base: string) {
  const parts = base.split(" ").filter(Boolean);
  const first = parts[0]?.[0] ?? "U";
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] : "";
  return (first + last).toUpperCase();
}

// Cache-bust avatar after upload (some CDNs cache aggressively)
function withCacheBuster(url: string, v: number) {
  if (!url) return url;
  return url.includes("?") ? `${url}&v=${v}` : `${url}?v=${v}`;
}

export default function ProfileScreen() {
  const { user, signOut } = useAuth();

  const [displayName, setDisplayName] = useState("");
  const [savedDisplayName, setSavedDisplayName] = useState("");

  const [teamId, setTeamId] = useState<string | null>(null);
  const [teamName, setTeamName] = useState<string | null>(null);

  const [photoURL, setPhotoURL] = useState<string | null>(null);
  const [photoPath, setPhotoPath] = useState<string | null>(null);
  const [photoVersion, setPhotoVersion] = useState<number>(Date.now());

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [loadingTeam, setLoadingTeam] = useState(false);

  const lastTeamIdRef = useRef<string | null>(null);

  const baseForInitials = useMemo(() => {
    return (
      displayName?.trim() ||
      user?.displayName?.trim() ||
      user?.email?.split("@")[0] ||
      "U"
    );
  }, [displayName, user?.displayName, user?.email]);

  const initials = useMemo(() => initialsFromBase(baseForInitials), [baseForInitials]);

  const isNameDirty = useMemo(() => {
    return displayName.trim() !== savedDisplayName.trim();
  }, [displayName, savedDisplayName]);

  const canSave = useMemo(() => {
    return isNameDirty && !saving && !uploadingPhoto && displayName.trim().length > 0;
  }, [isNameDirty, saving, uploadingPhoto, displayName]);

  // ✅ Live subscribe to user doc so photo/name/team updates show immediately
  useEffect(() => {
    if (!user?.uid) return;

    const userRef = doc(db, "users", user.uid);

    const unsub = onSnapshot(
      userRef,
      (snap) => {
        const data = (snap.exists() ? (snap.data() as UserDoc) : null) ?? null;

        const name =
          (data?.displayName as string) ||
          user.displayName ||
          user.email?.split("@")[0] ||
          "";

        setDisplayName(name);
        setSavedDisplayName(name);

        const tid = (data?.teamId as string) ?? null;
        setTeamId(tid);

        const url = (data?.photoURL as string) ?? user.photoURL ?? null;
        setPhotoURL(url);

        const path = (data?.photoPath as string) ?? null;
        setPhotoPath(path);

        setLoading(false);
      },
      (err) => {
        console.error("Error listening to profile", err);
        Alert.alert("Error", "Could not load your profile.");
        setLoading(false);
      }
    );

    return () => unsub();
  }, [user?.uid]);

  // ✅ Fetch team name when teamId changes
  useEffect(() => {
    const tid = teamId ? String(teamId) : null;

    if (!tid) {
      setTeamName(null);
      lastTeamIdRef.current = null;
      return;
    }

    if (lastTeamIdRef.current === tid) return;
    lastTeamIdRef.current = tid;

    let alive = true;
    setLoadingTeam(true);

    (async () => {
      try {
        const teamRef = doc(db, "teams", tid);
        const snap = await getDoc(teamRef);
        const data = snap.exists() ? (snap.data() as TeamDoc) : null;
        if (!alive) return;
        setTeamName((data?.name as string) || null);
      } catch (e) {
        console.warn("Failed to load team name", e);
        if (!alive) return;
        setTeamName(null);
      } finally {
        if (alive) setLoadingTeam(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [teamId]);

  const handleSave = async () => {
    if (!user) return;

    const trimmed = displayName.trim();
    if (!trimmed) {
      Alert.alert("Display name required", "Please enter a name.");
      return;
    }

    try {
      setSaving(true);

      const userRef = doc(db, "users", user.uid);
      await setDoc(
        userRef,
        {
          displayName: trimmed,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      // Optional: keep Firebase Auth displayName in sync
      try {
        await updateProfile(user, { displayName: trimmed });
      } catch (e) {
        console.warn("Could not update auth displayName", e);
      }

      setSavedDisplayName(trimmed);
      Alert.alert("Saved", "Your profile has been updated.");
    } catch (err) {
      console.error("Error saving profile", err);
      Alert.alert("Error", "Could not save your profile.");
    } finally {
      setSaving(false);
    }
  };

  const handleCancelNameEdit = () => {
    setDisplayName(savedDisplayName);
  };

  // ✅ upload -> Storage, save URL + path on users/{uid}
  const handlePickPhoto = async () => {
    if (!user?.uid) return;

    setUploadingPhoto(true);

    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          "Permission needed",
          "Please allow photo library access to choose a profile picture."
        );
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.85,
      });

      if (result.canceled) return;

      const asset = result.assets?.[0];
      if (!asset?.uri) return;

      const resp = await fetch(asset.uri);
      const blob = await resp.blob();

      const newPath = `avatars/${user.uid}/avatar.jpg`; // deterministic (overwrite)
      const storageRef = ref(storage, newPath);

      await uploadBytes(storageRef, blob, {
        contentType: blob.type || "image/jpeg",
      });

      const url = await getDownloadURL(storageRef);

      const userRef = doc(db, "users", user.uid);
      await setDoc(
        userRef,
        {
          photoURL: url,
          photoPath: newPath,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      try {
        await updateProfile(user, { photoURL: url });
      } catch (e) {
        console.warn("Could not update auth photoURL", e);
      }

      setPhotoURL(url);
      setPhotoPath(newPath);
      setPhotoVersion(Date.now());

      Alert.alert("Updated", "Your profile picture has been updated.");
    } catch (err: any) {
      console.error("Photo upload failed:", err);
      Alert.alert("Upload failed", err?.message ?? "Could not update profile picture.");
    } finally {
      setUploadingPhoto(false);
    }
  };

  const handleRemovePhoto = async () => {
    if (!user?.uid) return;

    Alert.alert("Remove photo?", "This will remove your profile picture.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          setUploadingPhoto(true);
          try {
            const userRef = doc(db, "users", user.uid);

            await setDoc(
              userRef,
              {
                photoURL: null,
                photoPath: null,
                updatedAt: serverTimestamp(),
              },
              { merge: true }
            );

            const path = photoPath || `avatars/${user.uid}/avatar.jpg`;
            try {
              await deleteObject(ref(storage, path));
            } catch (e) {
              console.warn("Avatar delete failed (ok)", e);
            }

            try {
              await updateProfile(user, { photoURL: null });
            } catch (e) {
              console.warn("Could not clear auth photoURL", e);
            }

            setPhotoURL(null);
            setPhotoPath(null);
            setPhotoVersion(Date.now());
          } catch (e) {
            console.error("Remove photo failed", e);
            Alert.alert("Error", "Could not remove photo.");
          } finally {
            setUploadingPhoto(false);
          }
        },
      },
    ]);
  };

  if (!user) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={[styles.screen, styles.center]}>
          <Text style={{ color: "white", fontWeight: "800" }}>You’re not signed in.</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={[styles.screen, styles.center]}>
          <ActivityIndicator color="white" />
          <Text style={{ marginTop: 10, color: "rgba(255,255,255,0.75)", fontWeight: "800" }}>
            Loading profile…
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const effectiveTeamLabel = teamId
    ? teamName
      ? teamName
      : loadingTeam
      ? "Loading team…"
      : teamId
    : "Not in a team yet";

  const avatarUri = photoURL ? withCacheBuster(photoURL, photoVersion) : null;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.screen}>
        <View style={styles.bg} />

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView
            contentContainerStyle={styles.container}
            keyboardShouldPersistTaps="handled"
          >
            {/* Hero */}
            <View style={styles.hero}>
              <View style={styles.logoWrap}>
                <Image source={LOGO} style={styles.logo} contentFit="contain" />
              </View>

              <Text style={styles.heroTitle}>Your Profile</Text>
              <Text style={styles.heroSub}>
                Set your name + photo so your squad recognizes you.
              </Text>
            </View>

            {/* Main Card */}
            <View style={styles.card}>
              {/* Avatar + info row */}
              <View style={styles.avatarRow}>
                <View style={styles.avatarWrap}>
                  {avatarUri ? (
                    <Image source={{ uri: avatarUri }} style={styles.avatar} contentFit="cover" />
                  ) : (
                    <View style={[styles.avatar, styles.avatarFallback]}>
                      <Text style={styles.avatarInitials}>{initials}</Text>
                    </View>
                  )}
                </View>

                <View style={{ flex: 1 }}>
                  <Text style={styles.bigName}>{displayName || initials}</Text>
                  <Text style={styles.subText}>{user.email}</Text>

                  <View style={{ height: 10 }} />

                  <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
                    <Pressable
                      onPress={handlePickPhoto}
                      disabled={uploadingPhoto || saving}
                      style={({ pressed }) => [
                        styles.secondaryBtnSm,
                        (uploadingPhoto || saving) && { opacity: 0.65 },
                        pressed && !(uploadingPhoto || saving) && { transform: [{ scale: 0.99 }] },
                      ]}
                    >
                      {uploadingPhoto ? (
                        <ActivityIndicator color="white" />
                      ) : (
                        <Text style={styles.secondaryBtnSmText}>
                          {photoURL ? "Change photo" : "Add photo"}
                        </Text>
                      )}
                    </Pressable>

                    {!!photoURL && (
                      <Pressable
                        onPress={handleRemovePhoto}
                        disabled={uploadingPhoto || saving}
                        style={({ pressed }) => [
                          styles.dangerBtnSm,
                          (uploadingPhoto || saving) && { opacity: 0.65 },
                          pressed && !(uploadingPhoto || saving) && { transform: [{ scale: 0.99 }] },
                        ]}
                      >
                        <Text style={styles.dangerBtnSmText}>Remove</Text>
                      </Pressable>
                    )}
                  </View>

                  <Text style={styles.tip}>Tip: square photos look best.</Text>
                </View>
              </View>

              {/* Name edit */}
              <Text style={[styles.label, { marginTop: 16 }]}>Display name</Text>
              <View style={styles.inputRow}>
                <Text style={styles.icon}>👤</Text>
                <TextInput
                  style={styles.input}
                  value={displayName}
                  onChangeText={setDisplayName}
                  placeholder="How should teammates see you?"
                  placeholderTextColor="rgba(255,255,255,0.35)"
                  editable={!saving && !uploadingPhoto}
                  autoCapitalize="words"
                  returnKeyType="done"
                />
              </View>

              {/* Actions */}
              <View style={styles.btnRow}>
                <Pressable
                  onPress={handleSave}
                  disabled={!canSave}
                  style={({ pressed }) => [
                    styles.primaryBtn,
                    !canSave && styles.primaryBtnDisabled,
                    pressed && canSave && { transform: [{ scale: 0.99 }] },
                  ]}
                >
                  {saving ? (
                    <ActivityIndicator color="#04130f" />
                  ) : (
                    <Text style={styles.primaryBtnText}>Save profile</Text>
                  )}
                </Pressable>

                <Pressable
                  onPress={handleCancelNameEdit}
                  disabled={!isNameDirty || saving || uploadingPhoto}
                  style={({ pressed }) => [
                    styles.ghostBtn,
                    (!isNameDirty || saving || uploadingPhoto) && { opacity: 0.6 },
                    pressed && isNameDirty && !(saving || uploadingPhoto) && {
                      transform: [{ scale: 0.99 }],
                    },
                  ]}
                >
                  <Text style={styles.ghostBtnText}>Cancel</Text>
                </Pressable>
              </View>

              {/* Team */}
              <View style={styles.divider} />
              <Text style={styles.sectionLabel}>Current team</Text>
              <Text style={styles.sectionValue}>{effectiveTeamLabel}</Text>
              {!!teamId && !!teamName && (
                <Text style={styles.teamSubtle}>Code: {teamId}</Text>
              )}
            </View>

            {/* Sign out */}
            <Pressable
              onPress={signOut}
              style={({ pressed }) => [
                styles.signOutBtn,
                pressed && { transform: [{ scale: 0.99 }] },
              ]}
            >
              <Text style={styles.signOutText}>Sign out</Text>
            </Pressable>

            <Text style={styles.footer}>⚽ Keep it updated for easier invites + RSVPs.</Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#052b22" },

  screen: { flex: 1, backgroundColor: "#052b22" },
  bg: { ...StyleSheet.absoluteFillObject, backgroundColor: "#052b22" },

  center: { alignItems: "center", justifyContent: "center" },

  container: {
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 40,
  },

  hero: { alignItems: "center", marginBottom: 14 },
  logoWrap: { width: 140, height: 90, marginBottom: 8 },
  logo: { width: "100%", height: "100%" },

  heroTitle: { fontSize: 34, fontWeight: "900", color: "white" },
  heroSub: {
    marginTop: 8,
    fontSize: 15,
    fontWeight: "700",
    color: "rgba(255,255,255,0.7)",
    textAlign: "center",
    lineHeight: 20,
    maxWidth: 340,
  },

  card: {
    marginTop: 6,
    borderRadius: 22,
    padding: 18,
    backgroundColor: "rgba(10, 16, 25, 0.78)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },

  avatarRow: { flexDirection: "row", gap: 14, alignItems: "center" },

  avatarWrap: {
    width: 86,
    height: 86,
    borderRadius: 43,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
  },
  avatar: { width: "100%", height: "100%" },
  avatarFallback: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  avatarInitials: { fontSize: 26, fontWeight: "900", color: "white" },

  bigName: { fontSize: 18, fontWeight: "900", color: "white" },
  subText: { marginTop: 2, color: "rgba(255,255,255,0.65)", fontWeight: "700" },

  secondaryBtnSm: {
    alignSelf: "flex-start",
    height: 40,
    paddingHorizontal: 14,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.10)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
  },
  secondaryBtnSmText: { color: "white", fontWeight: "900" },

  dangerBtnSm: {
    alignSelf: "flex-start",
    height: 40,
    paddingHorizontal: 14,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,107,107,0.12)",
    borderWidth: 1,
    borderColor: "rgba(255,107,107,0.30)",
  },
  dangerBtnSmText: { color: "#ff8f8f", fontWeight: "900" },

  tip: {
    marginTop: 8,
    color: "rgba(255,255,255,0.5)",
    fontSize: 12,
    fontWeight: "700",
  },

  label: {
    fontSize: 16,
    fontWeight: "800",
    color: "rgba(255,255,255,0.78)",
    marginBottom: 8,
  },

  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 16,
    paddingHorizontal: 14,
    height: 54,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  icon: { fontSize: 18, marginRight: 10, opacity: 0.9 },
  input: { flex: 1, color: "white", fontSize: 16, fontWeight: "700" },

  btnRow: { marginTop: 16, gap: 10 },

  primaryBtn: {
    height: 54,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1b7f5a",
  },
  primaryBtnDisabled: { opacity: 0.55 },
  primaryBtnText: { color: "#04130f", fontSize: 18, fontWeight: "900" },

  ghostBtn: {
    height: 50,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  ghostBtnText: { color: "rgba(255,255,255,0.85)", fontSize: 16, fontWeight: "900" },

  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: "rgba(255,255,255,0.12)",
    marginTop: 18,
    marginBottom: 14,
  },

  sectionLabel: { color: "rgba(255,255,255,0.70)", fontWeight: "800" },
  sectionValue: { marginTop: 6, color: "white", fontWeight: "900", fontSize: 18 },
  teamSubtle: { marginTop: 4, color: "rgba(255,255,255,0.55)", fontSize: 12, fontWeight: "700" },

  signOutBtn: { marginTop: 18, alignItems: "center", justifyContent: "center" },
  signOutText: { color: "#ff6b6b", fontWeight: "900", fontSize: 18 },

  footer: {
    marginTop: 16,
    textAlign: "center",
    color: "rgba(255,255,255,0.55)",
    fontSize: 14,
    fontWeight: "700",
  },
});
