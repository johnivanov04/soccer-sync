// app/(app)/(tabs)/profile.tsx
import { doc, getDoc, setDoc } from "firebase/firestore";
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

export default function ProfileScreen() {
  const { user, signOut } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [teamId, setTeamId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;

    const loadProfile = async () => {
      try {
        const userRef = doc(db, "users", user.uid);
        const snap = await getDoc(userRef);

        if (snap.exists()) {
          const data = snap.data() as any;
          if (data.displayName) setDisplayName(data.displayName);
          else setDisplayName(user.email?.split("@")[0] ?? "");

          if (data.teamId) setTeamId(data.teamId);
          else setTeamId(null);
        } else {
          // No user doc yet – fall back to email prefix
          setDisplayName(user.email?.split("@")[0] ?? "");
          setTeamId(null);
        }
      } catch (err) {
        console.error("Error loading profile", err);
        Alert.alert("Error", "Could not load your profile.");
      } finally {
        setLoading(false);
      }
    };

    loadProfile();
  }, [user?.uid]);

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
          updatedAt: new Date(),
        },
        { merge: true }
      );

      Alert.alert("Saved", "Your profile has been updated.");
    } catch (err) {
      console.error("Error saving profile", err);
      Alert.alert("Error", "Could not save your profile.");
    } finally {
      setSaving(false);
    }
  };

  if (!user) {
    return (
      <View style={styles.container}>
        <Text>You’re not signed in.</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.container}>
        <Text>Loading profile…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.header}>Your Profile</Text>

      <Text style={styles.label}>Email</Text>
      <Text style={styles.value}>{user.email}</Text>

      <Text style={styles.label}>Display name</Text>
      <TextInput
        style={styles.input}
        value={displayName}
        onChangeText={setDisplayName}
        placeholder="How should teammates see you?"
      />

      <Text style={styles.label}>Current team</Text>
      <Text style={styles.value}>{teamId ?? "Not in a team yet"}</Text>

      <View style={{ height: 16 }} />
      <Button
        title={saving ? "Saving…" : "Save profile"}
        onPress={handleSave}
        disabled={saving}
      />

      <View style={{ height: 32 }} />
      <Button title="Sign out" color="#d11" onPress={signOut} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
  },
  header: {
    fontSize: 22,
    fontWeight: "600",
    marginBottom: 24,
    textAlign: "center",
  },
  label: {
    marginTop: 12,
    fontSize: 13,
    color: "#666",
  },
  value: {
    fontSize: 16,
    marginTop: 2,
  },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginTop: 4,
  },
});
