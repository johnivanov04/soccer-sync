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

  // ✅ Helpful debug: tells us if a notification is delivered while app is foreground
  Notifications.addNotificationReceivedListener((n) => {
    console.log("🔔 RECEIVED (foreground):", {
      id: n?.request?.identifier,
      title: n?.request?.content?.title,
      body: n?.request?.content?.body,
      data: n?.request?.content?.data,
    });
  });

  console.log("✅ initNotifications() ran");
}
