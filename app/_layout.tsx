// app/_layout.tsx
import * as Notifications from "expo-notifications";
import {
  Slot,
  useRootNavigationState,
  useRouter,
  useSegments,
} from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { AuthProvider, useAuth } from "../src/context/AuthContext";
import { initNotifications } from "../src/utils/notificationsSetup";

type PendingRoute =
  | { pathname: "/(app)/match/[matchId]"; params: { matchId: string } }
  | { pathname: "/(app)/match/chat/[matchId]"; params: { matchId: string } }
  | null;

function safeJsonParse(v: any) {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function RootNavigation() {
  const { user, initializing } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  // ✅ don't navigate until router is mounted/ready (important on cold start)
  const navState = useRootNavigationState();
  const navReady = !!navState?.key;

  // ✅ approximate “cold start” (very small nav stack)
  const routeCount = (navState as any)?.routes?.length ?? 0;
  const isColdStart = navReady && routeCount <= 1;

  // ✅ gate default auth redirects until we finish cold-start notification bootstrap
  const [notifBootstrapDone, setNotifBootstrapDone] = useState(false);

  // prevent handling the same notification twice
  const lastHandledNotificationIdRef = useRef<string | null>(null);

  // If user taps notification while logged out / not ready
  const pendingRouteRef = useRef<PendingRoute>(null);

  // Track whether we already processed a tap this launch
  const handledAnyThisLaunchRef = useRef(false);

  const buildTargetFromNotification = useCallback(
    (response: Notifications.NotificationResponse): PendingRoute => {
      const content = response?.notification?.request?.content;
      if (!content) return null;

      // Sometimes data comes as string / nested / etc.
      const rawData = safeJsonParse((content as any)?.data ?? {});
      const data = safeJsonParse((rawData as any)?.data ?? rawData) as any;

      const matchIdRaw =
        data?.matchId ??
        data?.matchID ??
        data?.match_id ??
        data?.data?.matchId ??
        null;

      if (!matchIdRaw) return null;
      const matchId = String(matchIdRaw);

      // Prefer explicit fields
      const kind = String(
        data?.type ??
          data?.screen ??
          data?.route ??
          data?.kind ??
          data?.data?.type ??
          data?.data?.screen ??
          data?.data?.route ??
          data?.data?.kind ??
          ""
      )
        .toLowerCase()
        .trim();

      const openChatExplicit =
        kind === "chat" ||
        kind === "matchchat" ||
        kind === "match_chat" ||
        data?.openChat === true ||
        data?.data?.openChat === true;

      // ✅ Fallback heuristic for cold starts where data.type is missing
      const title = String(content?.title ?? "").toLowerCase();
      const looksLikeChat =
        title.includes("match chat") || title.includes("chat");

      const goChat = openChatExplicit || looksLikeChat;

      if (goChat) {
        return {
          pathname: "/(app)/match/chat/[matchId]",
          params: { matchId },
        };
      }

      return {
        pathname: "/(app)/match/[matchId]",
        params: { matchId },
      };
    },
    []
  );

  // ✅ navigation helper that preserves Back:
  // - cold start: seed Matches with replace(), then push target
  // - warm: push target normally
  const navigateToTarget = useCallback(
    (target: PendingRoute) => {
      if (!target) return;

      if (isColdStart) {
        // Seed base so back goes to Matches instead of exiting
        router.replace("/(app)/(tabs)/matches");
        requestAnimationFrame(() => {
          router.push(target);
        });
        return;
      }

      // Warm navigation: keep existing stack
      router.push(target);
    },
    [router, isColdStart]
  );

  const handleNotificationResponse = useCallback(
    async (response: Notifications.NotificationResponse, source: string) => {
      const notifId = response?.notification?.request?.identifier ?? null;

      // de-dupe per notification id
      if (notifId && lastHandledNotificationIdRef.current === notifId) return;
      if (notifId) lastHandledNotificationIdRef.current = notifId;

      const target = buildTargetFromNotification(response);
      if (!target) return;

      handledAnyThisLaunchRef.current = true;
      // ✅ if we got a real tap/lastResponse, we can stop gating default redirects
      setNotifBootstrapDone(true);

      // Store until ready/auth'd
      if (!navReady || initializing || !user) {
        pendingRouteRef.current = target;
        return;
      }

      navigateToTarget(target);

      // ✅ Prevent stale "last response" from hijacking the next cold start (if supported)
      try {
        const anyNotif = Notifications as any;
        if (typeof anyNotif.clearLastNotificationResponseAsync === "function") {
          await anyNotif.clearLastNotificationResponseAsync();
        }
      } catch {
        // ignore
      }
    },
    [buildTargetFromNotification, navReady, initializing, user, navigateToTarget]
  );

  const tryHandleLastResponse = useCallback(
    async (label: string) => {
      try {
        const last = await Notifications.getLastNotificationResponseAsync();
        if (last) {
          await handleNotificationResponse(last, `getLast:${label}`);
        }
      } catch (e) {
        console.warn("getLastNotificationResponseAsync failed", e);
      }
    },
    [handleNotificationResponse]
  );

  // Listen for notification taps + cold start recovery
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      handleNotificationResponse(resp, "listener");
    });

    // ✅ Cold-start recovery:
    // On killed-app launch from tap, listener may miss the tap and getLast may be stale if called too early.
    // So we re-check after short delays.
    tryHandleLastResponse("t0");
    const t1 = setTimeout(() => tryHandleLastResponse("t400"), 400);
    const t2 = setTimeout(() => tryHandleLastResponse("t1200"), 1200);

    // ✅ After our bootstrap window, allow default auth routing if nothing was handled
    const tDone = setTimeout(() => setNotifBootstrapDone(true), 1400);

    return () => {
      sub.remove();
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(tDone);
    };
  }, [handleNotificationResponse, tryHandleLastResponse]);

  // ✅ Also re-check once navigation becomes ready (helps some Android timing cases)
  useEffect(() => {
    if (!navReady) return;
    // only do this if we haven't already handled something this launch
    if (!handledAnyThisLaunchRef.current) {
      tryHandleLastResponse("navReady");
    }
  }, [navReady, tryHandleLastResponse]);

  // ✅ SINGLE routing effect so pending route can't be overridden
  useEffect(() => {
    if (!navReady || initializing) return;

    // ✅ On cold start, wait until the notification bootstrap window has finished
    // (prevents auth redirect to Matches from winning the race)
    if (isColdStart && !notifBootstrapDone) return;

    const inAuthGroup = segments[0] === "(auth)";

    if (!user) {
      if (!inAuthGroup) router.replace("/(auth)/sign-in");
      return;
    }

    if (pendingRouteRef.current) {
      const target = pendingRouteRef.current;
      pendingRouteRef.current = null;

      // ✅ preserve back here too
      navigateToTarget(target);
      return;
    }

    if (inAuthGroup) {
      router.replace("/(app)/(tabs)/matches");
    }
  }, [
    navReady,
    initializing,
    user,
    segments,
    router,
    isColdStart,
    notifBootstrapDone,
    navigateToTarget,
  ]);

  if (initializing) return null;
  return <Slot />;
}

export default function RootLayout() {
  useEffect(() => {
    initNotifications();
  }, []);

  return (
    <AuthProvider>
      <RootNavigation />
    </AuthProvider>
  );
}
