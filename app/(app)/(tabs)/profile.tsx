// app/(app)/(tabs)/profile.tsx
import React from "react";
import { Alert, Button, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../../src/context/AuthContext";

export default function ProfileScreen() {
  const { user, signOut } = useAuth();

  const handleSignOut = async () => {
    try {
      await signOut();
      // Root layout should automatically switch back to the auth stack
    } catch (err: any) {
      console.error("Error signing out:", err);
      Alert.alert("Error", "Could not sign out. Please try again.");
    }
  };

  if (!user) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Profile</Text>
        <Text style={styles.value}>You’re not signed in.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Profile</Text>

      <Text style={styles.label}>Email</Text>
      <Text style={styles.value}>{user.email}</Text>

      <Text style={styles.label}>User ID</Text>
      <Text style={styles.value}>{user.uid}</Text>

      {/* Later we can show team name, position, etc here */}

      <View style={styles.divider} />

      <Button title="Sign Out" onPress={handleSignOut} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
    marginBottom: 24,
  },
  label: {
    fontSize: 14,
    fontWeight: "600",
    marginTop: 12,
  },
  value: {
    fontSize: 16,
    marginTop: 4,
  },
  divider: {
    height: 1,
    backgroundColor: "#ddd",
    marginVertical: 24,
  },
});
