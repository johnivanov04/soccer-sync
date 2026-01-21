// src/utils/notificationsSetup.ts
import * as Notifications from "expo-notifications";

let didInit = false;

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

  // Helpful debug: delivered while app is foreground
  Notifications.addNotificationReceivedListener((n) => {
    console.log("🔔 RECEIVED (foreground):", {
      id: n?.request?.identifier,
      title: n?.request?.content?.title,
      body: n?.request?.content?.body,
      data: n?.request?.content?.data,
    });
  });

  // ✅ IMPORTANT:
  // Do NOT add addNotificationResponseReceivedListener here.
  // Tap-to-open routing is handled in app/_layout.tsx to support:
  // - auth gating
  // - pending routes while logged out
  // - cold-start “seed matches then push” back behavior

  console.log("✅ initNotifications() ran");
}
