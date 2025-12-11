// app/(app)/(tabs)/_layout.tsx
import { Tabs } from "expo-router";
import React from "react";

export default function AppTabsLayout() {
  return (
    <Tabs>
      <Tabs.Screen
        name="matches"
        options={{
          title: "Matches",
        }}
      />
      <Tabs.Screen
        name="teams"
        options={{
          title: "Teams",
        }}
      />
      <Tabs.Screen
        name="stats"
        options={{
          title: "Stats",
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "Profile",
        }}
      />
    </Tabs>
  );
}
