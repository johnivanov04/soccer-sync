// app/_layout.tsx
import * as Notifications from "expo-notifications";
import { Slot, useRouter, useSegments } from "expo-router";
import React, { useEffect, useRef } from "react";
import { AuthProvider, useAuth } from "../src/context/AuthContext";
import { initNotifications } from "../src/utils/notificationsSetup";

type PendingRoute =
  | { pathname: "/(app)/match/[matchId]"; params: { matchId: string } }
  | null;

function RootNavigation() {
  const { user, initializing } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  // prevent handling the same notification twice
  const lastHandledNotificationIdRef = useRef<string | null>(null);

  // if user taps a notification while logged out, remember where to go after login
  const pendingRouteRef = useRef<PendingRoute>(null);

  const handleNotificationResponse = (response: Notifications.NotificationResponse) => {
    const notifId = response?.notification?.request?.identifier ?? null;
    if (notifId && lastHandledNotificationIdRef.current === notifId) return;
    if (notifId) lastHandledNotificationIdRef.current = notifId;

    const data = (response?.notification?.request?.content?.data ?? {}) as any;
    const matchId = data?.matchId ?? data?.matchID ?? data?.match_id;

    if (!matchId) return;

    const target: PendingRoute = {
      pathname: "/(app)/match/[matchId]",
      params: { matchId: String(matchId) },
    };

    // If not ready / not logged in yet, store it and let auth routing handle later
    if (initializing || !user) {
      pendingRouteRef.current = target;
      return;
    }

    router.push(target);
  };

  // Listen for notification taps + app opened from a notification
  useEffect(() => {
    const responseSub =
      Notifications.addNotificationResponseReceivedListener(handleNotificationResponse);

    (async () => {
      try {
        const last = await Notifications.getLastNotificationResponseAsync();
        if (last) handleNotificationResponse(last);
      } catch (e) {
        console.warn("getLastNotificationResponseAsync failed", e);
      }
    })();

    return () => {
      responseSub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, initializing, router]);

  // Auth-based routing + pending notification navigation support
  useEffect(() => {
    if (initializing) return;

    const inAuthGroup = segments[0] === "(auth)";

    // If we have a pending route and user is now logged in, go there first.
    if (user && pendingRouteRef.current) {
      const target = pendingRouteRef.current;
      pendingRouteRef.current = null;
      router.replace(target);
      return;
    }

    if (!user && !inAuthGroup) {
      router.replace("/(auth)/sign-in");
    } else if (user && inAuthGroup) {
      router.replace("/(app)/(tabs)/matches");
    }
  }, [user, initializing, segments, router]);

  if (initializing) return null;
  return <Slot />;
}

export default function RootLayout() {
  // ✅ initialize notification handler + debug listeners exactly once
  useEffect(() => {
    initNotifications();
  }, []);

  return (
    <AuthProvider>
      <RootNavigation />
    </AuthProvider>
  );
}
