// app/(app)/(tabs)/profile.tsx
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Button,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { updateProfile } from "firebase/auth";
import { doc, getDoc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { deleteObject, getDownloadURL, ref, uploadBytes } from "firebase/storage";

import { useAuth } from "../../../src/context/AuthContext";
import { db, storage } from "../../../src/firebaseConfig";

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

export default function ProfileScreen() {
  const { user, signOut } = useAuth();

  const [displayName, setDisplayName] = useState("");
  const [savedDisplayName, setSavedDisplayName] = useState("");

  const [teamId, setTeamId] = useState<string | null>(null);
  const [teamName, setTeamName] = useState<string | null>(null);

  const [photoURL, setPhotoURL] = useState<string | null>(null);
  const [photoPath, setPhotoPath] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [loadingTeam, setLoadingTeam] = useState(false);

  const lastTeamIdRef = useRef<string | null>(null);

  const initials = useMemo(() => {
    const base =
      (displayName?.trim() ||
        user?.displayName?.trim() ||
        user?.email?.split("@")[0] ||
        "U") ?? "U";
    const parts = base.split(" ").filter(Boolean);
    const first = parts[0]?.[0] ?? "U";
    const last = parts.length > 1 ? parts[parts.length - 1]?.[0] : "";
    return (first + last).toUpperCase();
  }, [displayName, user?.displayName, user?.email]);

  const isNameDirty = useMemo(() => {
    return displayName.trim() !== savedDisplayName.trim();
  }, [displayName, savedDisplayName]);

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

    // reset if no team
    if (!tid) {
      setTeamName(null);
      lastTeamIdRef.current = null;
      return;
    }

    // avoid refetch spam if snapshot fires repeatedly
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

  // ✅ Option A: upload -> Storage, save URL on users/{uid}
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

      // deterministic key (latest always overwrites)
      const newPath = `avatars/${user.uid}/avatar.jpg`;
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

            // Clear Firestore fields
            await setDoc(
              userRef,
              {
                photoURL: null,
                photoPath: null,
                updatedAt: serverTimestamp(),
              },
              { merge: true }
            );

            // Best-effort delete from Storage
            const path = photoPath || `avatars/${user.uid}/avatar.jpg`;
            try {
              await deleteObject(ref(storage, path));
            } catch (e) {
              // ok if it doesn't exist
              console.warn("Avatar delete failed (ok)", e);
            }

            // Best-effort clear Auth photoURL
            try {
              await updateProfile(user, { photoURL: null });
            } catch (e) {
              console.warn("Could not clear auth photoURL", e);
            }

            setPhotoURL(null);
            setPhotoPath(null);
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
        <View style={styles.container}>
          <Text>You’re not signed in.</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={[styles.container, { alignItems: "center", justifyContent: "center" }]}>
          <ActivityIndicator />
          <Text style={{ marginTop: 10 }}>Loading profile…</Text>
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

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.header}>Your Profile</Text>

        <View style={styles.avatarRow}>
          <View style={styles.avatarWrap}>
            {photoURL ? (
              <Image source={{ uri: photoURL }} style={styles.avatar} />
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
                style={({ pressed }) => [
                  styles.photoButton,
                  pressed && { opacity: 0.8 },
                  uploadingPhoto && { opacity: 0.6 },
                ]}
                disabled={uploadingPhoto}
              >
                {uploadingPhoto ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <ActivityIndicator />
                    <Text style={styles.photoButtonText}>Working…</Text>
                  </View>
                ) : (
                  <Text style={styles.photoButtonText}>
                    {photoURL ? "Change photo" : "Add photo"}
                  </Text>
                )}
              </Pressable>

              {!!photoURL && (
                <Pressable
                  onPress={handleRemovePhoto}
                  style={({ pressed }) => [
                    styles.removeButton,
                    pressed && { opacity: 0.8 },
                    uploadingPhoto && { opacity: 0.6 },
                  ]}
                  disabled={uploadingPhoto}
                >
                  <Text style={styles.removeButtonText}>Remove</Text>
                </Pressable>
              )}
            </View>

            <Text style={styles.helperText}>Tip: square photos look best.</Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Display name</Text>
          <TextInput
            style={styles.input}
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="How should teammates see you?"
            editable={!saving && !uploadingPhoto}
          />

          <View style={{ flexDirection: "row", gap: 10, marginTop: 10 }}>
            <View style={{ flex: 1 }}>
              <Button
                title={saving ? "Saving…" : "Save profile"}
                onPress={handleSave}
                disabled={!isNameDirty || saving || uploadingPhoto}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                title="Cancel"
                color="#777"
                onPress={handleCancelNameEdit}
                disabled={!isNameDirty || saving || uploadingPhoto}
              />
            </View>
          </View>

          <Text style={styles.label}>Current team</Text>
          <Text style={styles.value}>{effectiveTeamLabel}</Text>
          {!!teamId && !!teamName && (
            <Text style={styles.teamSubtle}>Code: {teamId}</Text>
          )}
        </View>

        <View style={{ height: 20 }} />
        <Button title="Sign out" color="#d11" onPress={signOut} />
        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { padding: 20 },
  header: {
    fontSize: 22,
    fontWeight: "700",
    marginBottom: 18,
    textAlign: "center",
  },
  avatarRow: {
    flexDirection: "row",
    gap: 14,
    alignItems: "center",
    marginBottom: 18,
  },
  avatarWrap: {
    width: 86,
    height: 86,
    borderRadius: 43,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#ddd",
  },
  avatar: { width: 86, height: 86, borderRadius: 43 },
  avatarFallback: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#eef3ff",
  },
  avatarInitials: { fontSize: 26, fontWeight: "800", color: "#2b4cff" },
  bigName: { fontSize: 18, fontWeight: "700" },
  subText: { marginTop: 2, color: "#666" },

  photoButton: {
    alignSelf: "flex-start",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#cfd7ff",
    backgroundColor: "#f3f6ff",
  },
  photoButtonText: { fontWeight: "700", color: "#2b4cff" },

  removeButton: {
    alignSelf: "flex-start",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#ffd0d0",
    backgroundColor: "#fff5f5",
  },
  removeButtonText: { fontWeight: "800", color: "#b00020" },

  helperText: { marginTop: 8, color: "#777", fontSize: 12 },

  card: {
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#ddd",
    backgroundColor: "#fff",
  },
  label: { marginTop: 10, fontSize: 13, color: "#666" },
  value: { fontSize: 16, marginTop: 6, fontWeight: "700" },
  teamSubtle: { marginTop: 4, color: "#666", fontSize: 12 },

  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    marginTop: 6,
  },
});
