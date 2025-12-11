// app/(app)/(tabs)/teams.tsx
import React from "react";
import { StyleSheet, Text, View } from "react-native";

export default function TeamsScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Teams</Text>
      <Text>Team management coming soon.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  title: { fontSize: 20, fontWeight: "bold", marginBottom: 12 },
});
