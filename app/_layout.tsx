// app/_layout.tsx
import { Slot, useRouter, useSegments } from "expo-router";
import React, { useEffect } from "react";
import { AuthProvider, useAuth } from "../src/context/AuthContext";
import { initNotifications } from "../src/utils/notificationsSetup";

function RootNavigation() {
  const { user, initializing } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  // ✅ Ensure notification handler is installed once at app start
  useEffect(() => {
    initNotifications();
  }, []);

  useEffect(() => {
    if (initializing) return;

    const inAuthGroup = segments[0] === "(auth)";

    if (!user && !inAuthGroup) {
      router.replace("/(auth)/sign-in");
    } else if (user && inAuthGroup) {
      router.replace("/(app)/(tabs)/matches");
    }
  }, [user, initializing, segments, router]);

  if (initializing) {
    return null;
  }

  return <Slot />;
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <RootNavigation />
    </AuthProvider>
  );
}
