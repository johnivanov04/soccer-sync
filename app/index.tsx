// app/index.tsx
import { Redirect } from "expo-router";
import React from "react";
import { useAuth } from "../src/context/AuthContext";

export default function Index() {
  const { user } = useAuth();

  if (!user) {
    return <Redirect href="/(auth)/sign-in" />;
  }

  return <Redirect href="/(app)/(tabs)/matches" />;
}
