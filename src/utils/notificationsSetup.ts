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

  // ✅ Tells us if a notification is actually delivered to the app (foreground)
  Notifications.addNotificationReceivedListener((n) => {
    console.log("🔔 RECEIVED (foreground):", {
      id: n?.request?.identifier,
      title: n?.request?.content?.title,
      body: n?.request?.content?.body,
      data: n?.request?.content?.data,
    });
  });

  // ✅ Tells us if you tapped a notification
  Notifications.addNotificationResponseReceivedListener((resp) => {
    console.log("👉 TAPPED:", {
      id: resp?.notification?.request?.identifier,
      data: resp?.notification?.request?.content?.data,
    });
  });

  console.log("✅ initNotifications() ran");
}
