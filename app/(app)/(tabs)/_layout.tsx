// app/(app)/(tabs)/_layout.tsx
import { Tabs } from "expo-router";
import React from "react";


export default function AppTabsLayout() {
  return (
    <Tabs screenOptions={{ headerTitleAlign: "center" }}>
      <Tabs.Screen
        name="matches"
        options={{
          title: "Matches",
          tabBarLabel: "Matches",
        }}
      />
      <Tabs.Screen
        name="teams"
        options={{
          title: "Teams",
          tabBarLabel: "Teams",
        }}
      />
      <Tabs.Screen
        name="stats"
        options={{
          title: "Fitness",
          tabBarLabel: "Fitness",
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "Profile",
          tabBarLabel: "Profile",
        }}
      />
    </Tabs>
  );
}
