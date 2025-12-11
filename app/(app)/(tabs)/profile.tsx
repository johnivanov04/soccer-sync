// app/(app)/(tabs)/profile.tsx
import React from "react";
import { Button, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../../src/context/AuthContext";

export default function ProfileScreen() {
  const { user, signOut } = useAuth();

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Profile</Text>
      {user && (
        <>
          <Text style={styles.label}>Email</Text>
          <Text style={styles.value}>{user.email}</Text>
        </>
      )}
      <View style={{ marginTop: 24 }}>
        <Button title="Sign Out" onPress={signOut} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  title: { fontSize: 20, fontWeight: "bold", marginBottom: 12 },
  label: { fontWeight: "600", marginTop: 8 },
  value: { marginTop: 4 },
});
