// app/(app)/(tabs)/profile.tsx
import { doc, onSnapshot, updateDoc } from "firebase/firestore";
import React, { useEffect, useState } from "react";
import { Button, StyleSheet, Text, TextInput, View } from "react-native";
import { useAuth } from "../../../src/context/AuthContext";
import { db } from "../../../src/firebaseConfig";

export default function ProfileScreen() {
  const { user, signOut } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [teamId, setTeamId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user?.uid) return;

    const userRef = doc(db, "users", user.uid);
    const unsub = onSnapshot(userRef, (snap) => {
      const data = snap.data() as any | undefined;
      if (!data) return;
      if (typeof data.displayName === "string") {
        setDisplayName(data.displayName);
      }
      if (typeof data.teamId === "string") {
        setTeamId(data.teamId);
      }
    });

    return () => unsub();
  }, [user?.uid]);

  const handleSave = async () => {
    if (!user?.uid) return;
    setSaving(true);
    try {
      await updateDoc(doc(db, "users", user.uid), {
        displayName: displayName.trim(),
      });
    } catch (e) {
      console.error("Error updating profile", e);
    } finally {
      setSaving(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut();
      // Root layout already switches to the auth stack when user becomes null.
    } catch (e) {
      console.error("Error signing out", e);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Your profile</Text>

      <Text style={styles.label}>Email</Text>
      <Text style={styles.value}>{user?.email}</Text>

      <Text style={styles.label}>Display name</Text>
      <TextInput
        style={styles.input}
        value={displayName}
        onChangeText={setDisplayName}
        placeholder="How teammates see you"
      />

      <Button
        title={saving ? "Saving..." : "Save profile"}
        onPress={handleSave}
        disabled={saving}
      />

      {teamId && (
        <>
          <Text style={[styles.label, { marginTop: 24 }]}>Current team code</Text>
          <Text style={styles.value}>{teamId}</Text>
        </>
      )}

      <View style={{ height: 40 }} />

      <Button title="Sign out" color="#d9534f" onPress={handleSignOut} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  title: {
    fontSize: 22,
    fontWeight: "600",
    marginBottom: 24,
    textAlign: "left",
  },
  label: {
    fontSize: 14,
    fontWeight: "500",
    marginTop: 12,
  },
  value: {
    fontSize: 16,
    marginTop: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    padding: 10,
    marginTop: 4,
  },
});
