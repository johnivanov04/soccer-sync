// app/_layout.tsx
import * as ExpoLinking from "expo-linking";
import * as Notifications from "expo-notifications";
import { Slot, useRootNavigationState, useRouter, useSegments } from "expo-router";
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

  // ✅ gate default auth redirects until we finish cold-start bootstrap
  const [bootstrapDone, setBootstrapDone] = useState(false);

  // prevent handling the same notification twice
  const lastHandledNotificationIdRef = useRef<string | null>(null);

  // If user taps notification / opens deep link while logged out / not ready
  const pendingRouteRef = useRef<PendingRoute>(null);

  // Track whether we already processed a tap/link this launch
  const handledAnyThisLaunchRef = useRef(false);

  const buildTargetFromNotification = useCallback(
    (response: Notifications.NotificationResponse): PendingRoute => {
      const content = response?.notification?.request?.content;
      if (!content) return null;

      // Sometimes data comes as string / nested / etc.
      const rawData = safeJsonParse((content as any)?.data ?? {});
      const data = safeJsonParse((rawData as any)?.data ?? rawData) as any;

      const matchIdRaw =
        data?.matchId ?? data?.matchID ?? data?.match_id ?? data?.data?.matchId ?? null;

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
      const looksLikeChat = title.includes("match chat") || title.includes("chat");

      const goChat = openChatExplicit || looksLikeChat;

      if (goChat) {
        return { pathname: "/(app)/match/chat/[matchId]", params: { matchId } };
      }
      return { pathname: "/(app)/match/[matchId]", params: { matchId } };
    },
    []
  );

  // ✅ Parse deep links like:
  // soccersyncmobile://match/<matchId>
  // soccersyncmobile://match/chat/<matchId>
  //
  // IMPORTANT: In scheme URLs, "match" is often treated as hostname, not path.
  // ExpoLinking.parse("soccersyncmobile://match/chat/123") =>
  //   hostname="match", path="chat/123"
  const buildTargetFromUrl = useCallback((url: string): PendingRoute => {
    if (!url) return null;

    try {
      const parsed = ExpoLinking.parse(url);

      const host = String((parsed as any)?.hostname ?? (parsed as any)?.host ?? "").toLowerCase();
      const path = String(parsed?.path ?? "").replace(/^\/+/, "");
      const parts = path.split("/").filter(Boolean);

      // ✅ Style A: soccersyncmobile://match/chat/<id>  (host="match", path="chat/<id>")
      // ✅ Style A: soccersyncmobile://match/<id>       (host="match", path="<id>")
      if (host === "match") {
        if (parts[0] && parts[0] !== "chat") {
          return { pathname: "/(app)/match/[matchId]", params: { matchId: String(parts[0]) } };
        }
        if (parts[0] === "chat" && parts[1]) {
          return {
            pathname: "/(app)/match/chat/[matchId]",
            params: { matchId: String(parts[1]) },
          };
        }
      }

      // ✅ Style B: soccersyncmobile:///match/chat/<id> (path starts with match)
      // ✅ Style B: soccersyncmobile:///match/<id>
      const idx = parts.findIndex((p) => p === "match");
      if (idx >= 0) {
        const p1 = parts[idx + 1];
        const p2 = parts[idx + 2];

        if (p1 && p1 !== "chat") {
          return { pathname: "/(app)/match/[matchId]", params: { matchId: String(p1) } };
        }
        if (p1 === "chat" && p2) {
          return { pathname: "/(app)/match/chat/[matchId]", params: { matchId: String(p2) } };
        }
      }

      // ✅ also support ?matchId=<id>
      const qMatchId = (parsed as any)?.queryParams?.matchId;
      if (qMatchId) {
        return { pathname: "/(app)/match/[matchId]", params: { matchId: String(qMatchId) } };
      }

      return null;
    } catch {
      return null;
    }
  }, []);

  // ✅ navigation helper that preserves Back:
  // - cold start: seed Matches with replace(), then push target
  // - warm: push target normally
  const navigateToTarget = useCallback(
    (target: PendingRoute) => {
      if (!target) return;

      if (isColdStart) {
        router.replace("/(app)/(tabs)/matches");
        requestAnimationFrame(() => {
          router.push(target);
        });
        return;
      }

      router.push(target);
    },
    [router, isColdStart]
  );

  const handleNotificationResponse = useCallback(
    async (response: Notifications.NotificationResponse) => {
      const notifId = response?.notification?.request?.identifier ?? null;

      if (notifId && lastHandledNotificationIdRef.current === notifId) return;
      if (notifId) lastHandledNotificationIdRef.current = notifId;

      const target = buildTargetFromNotification(response);
      if (!target) return;

      handledAnyThisLaunchRef.current = true;
      setBootstrapDone(true);

      if (!navReady || initializing || !user) {
        pendingRouteRef.current = target;
        return;
      }

      navigateToTarget(target);

      // ✅ prevent stale "last response" from hijacking next cold start (if supported)
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

  const tryHandleLastResponse = useCallback(async () => {
    try {
      const last = await Notifications.getLastNotificationResponseAsync();
      if (last) await handleNotificationResponse(last);
    } catch (e) {
      console.warn("getLastNotificationResponseAsync failed", e);
    }
  }, [handleNotificationResponse]);

  const handleIncomingUrl = useCallback(
    (url: string) => {
      const target = buildTargetFromUrl(url);
      if (!target) return;

      handledAnyThisLaunchRef.current = true;
      setBootstrapDone(true);

      if (!navReady || initializing || !user) {
        pendingRouteRef.current = target;
        return;
      }

      navigateToTarget(target);
    },
    [buildTargetFromUrl, navReady, initializing, user, navigateToTarget]
  );

  // ✅ Handle deep links (initial + runtime)
  useEffect(() => {
    let sub: any;

    (async () => {
      try {
        const initialUrl = await ExpoLinking.getInitialURL();
        if (initialUrl) handleIncomingUrl(initialUrl);
      } catch {}
    })();

    try {
      sub = ExpoLinking.addEventListener("url", ({ url }) => {
        if (url) handleIncomingUrl(url);
      });
    } catch {}

    return () => {
      try {
        sub?.remove?.();
      } catch {}
    };
  }, [handleIncomingUrl]);

  // ✅ Notification taps (ONLY here; notificationsSetup.ts should NOT navigate)
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      handleNotificationResponse(resp);
    });

    // Cold-start recovery attempts
    tryHandleLastResponse();
    const t1 = setTimeout(() => tryHandleLastResponse(), 400);
    const t2 = setTimeout(() => tryHandleLastResponse(), 1200);

    // After bootstrap window, allow default auth routing
    const tDone = setTimeout(() => setBootstrapDone(true), 1400);

    return () => {
      sub.remove();
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(tDone);
    };
  }, [handleNotificationResponse, tryHandleLastResponse]);

  // Also re-check once navigation becomes ready
  useEffect(() => {
    if (!navReady) return;
    if (!handledAnyThisLaunchRef.current) {
      tryHandleLastResponse();
    }
  }, [navReady, tryHandleLastResponse]);

  // ✅ SINGLE routing effect so pending route can't be overridden
  useEffect(() => {
    if (!navReady || initializing) return;

    if (isColdStart && !bootstrapDone) return;

    const inAuthGroup = segments?.[0] === "(auth)";
    const inVerifyEmail = segments?.includes("verify-email");

    if (!user) {
      if (!inAuthGroup) router.replace("/(auth)/sign-in");
      return;
    }

    // ✅ Email verification gate
    if (!user.emailVerified) {
      if (!inAuthGroup || !inVerifyEmail) {
        router.replace("/(auth)/verify-email");
      }
      return;
    }

    if (pendingRouteRef.current) {
      const target = pendingRouteRef.current;
      pendingRouteRef.current = null;
      navigateToTarget(target);
      return;
    }

    if (inAuthGroup) {
      router.replace("/(app)/(tabs)/matches");
    }
  }, [navReady, initializing, user, segments, router, isColdStart, bootstrapDone, navigateToTarget]);

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
