// src/utils/notificationsSetup.ts
import * as Notifications from "expo-notifications";

let didInit = false;

export function initNotifications() {
  if (didInit) return;
  didInit = true;

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });

  // ✅ Tells us if a notification is actually delivered to the app (foreground)
  Notifications.addNotificationReceivedListener((n) => {
    console.log("🔔 RECEIVED (foreground):", n.request.content);
  });

  // ✅ Tells us if you tapped a notification
  Notifications.addNotificationResponseReceivedListener((resp) => {
    console.log("👉 TAPPED:", resp.notification.request.content);
  });

  console.log("✅ initNotifications() ran");
}
