// src/utils/notificationsSetup.ts
import * as Notifications from "expo-notifications";
import { router } from "expo-router";

let didInit = false;

// Dedup handling (foreground tap + cold start can both fire)
let lastHandledNotificationId: string | null = null;

function safeString(v: any): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function handleNotificationNav(data: any) {
  const matchId = safeString(data?.matchId);
  if (!matchId) return;

  // Cloud Function chat push: { matchId, type: "chat" }
  if (data?.type === "chat") {
    router.push({ pathname: "/(app)/match/chat/[matchId]", params: { matchId } });
    return;
  }

  // Match update push: { type: "matchUpdate", matchId, kind: "cancelled" | "edited" }
  if (data?.type === "matchUpdate" || data?.kind === "cancelled" || data?.kind === "edited") {
    router.push({ pathname: "/(app)/match/[matchId]", params: { matchId } });
    return;
  }

  // Promotion push: { kind: "promoted", matchId }
  if (data?.kind === "promoted") {
    router.push({ pathname: "/(app)/match/[matchId]", params: { matchId } });
    return;
  }

  // Fallback: open match detail
  router.push({ pathname: "/(app)/match/[matchId]", params: { matchId } });
}

export function initNotifications() {
  if (didInit) return;
  didInit = true;

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });

  // Helpful debug: tells us if a notification is delivered while app is foreground
  Notifications.addNotificationReceivedListener((n) => {
    console.log("🔔 RECEIVED (foreground):", {
      id: n?.request?.identifier,
      title: n?.request?.content?.title,
      body: n?.request?.content?.body,
      data: n?.request?.content?.data,
    });
  });

  // ✅ Tap-to-open routing
  const handleResponse = (resp: Notifications.NotificationResponse) => {
    const n = resp?.notification;
    const id = n?.request?.identifier ?? null;

    if (id && lastHandledNotificationId === id) return;
    if (id) lastHandledNotificationId = id;

    const data = (n?.request?.content?.data ?? {}) as any;

    // Defer a tick to ensure router is mounted
    setTimeout(() => handleNotificationNav(data), 0);
  };

  Notifications.addNotificationResponseReceivedListener(handleResponse);

  // ✅ Cold start: app launched via tapping a notification
  (async () => {
    try {
      const last = await Notifications.getLastNotificationResponseAsync();
      if (last) handleResponse(last);
    } catch (e) {
      console.warn("getLastNotificationResponseAsync failed:", e);
    }
  })();

  console.log("✅ initNotifications() ran");
}
