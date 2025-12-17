// src/utils/pushNotifications.ts
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

const EXPO_PUSH_SEND_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_PUSH_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";

type ExpoPushTicket = {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: Record<string, any>;
};

type ExpoPushReceipt = {
  status: "ok" | "error";
  message?: string;
  details?: Record<string, any>;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function testLocalNotification() {
  const perms = await Notifications.getPermissionsAsync();
  console.log("🔎 permissions:", perms);

  const id = await Notifications.scheduleNotificationAsync({
    content: {
      title: "Local test ✅",
      body: "If you see this, local notifications are working.",
      sound: "default",
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: 2,
      repeats: false,
    },
  });

  console.log("✅ scheduled local notification id:", id);
}

export async function registerForPushNotificationsAsync(): Promise<string | null> {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "default",
      importance: Notifications.AndroidImportance.MAX,
    });
  }

  if (!Device.isDevice) {
    console.warn("Must use a physical device for push notifications.");
    return null;
  }

  const perms = await Notifications.getPermissionsAsync();
  console.log("🔔 Notification permissions:", perms);

  if (perms.status !== "granted") {
    const req = await Notifications.requestPermissionsAsync();
    console.log("🔔 Permission request result:", req);
    if (req.status !== "granted") return null;
  }

  // Optional: native token (APNs on iOS)
  try {
    const native = await Notifications.getDevicePushTokenAsync();
    console.log("📱 Native push token:", native);
  } catch (e) {
    console.warn("Could not get native push token:", e);
  }

  const projectId =
    Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId;

  if (!projectId) {
    console.warn("Missing EAS projectId; cannot reliably get Expo push token.");
  }

  try {
    const tokenResp = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : {}
    );
    console.log("🧾 Expo push token:", tokenResp.data);
    return tokenResp.data;
  } catch (e) {
    console.error("getExpoPushTokenAsync failed", e);
    return null;
  }
}

export async function sendRemotePushAndCheckReceipt(params: {
  to: string;
  title: string;
  body: string;
  data?: Record<string, any>;
  sound?: "default" | null;
  receiptWaitMs?: number;
}): Promise<{
  ticket?: ExpoPushTicket;
  receipt?: ExpoPushReceipt;
}> {
  const message = {
    to: params.to,
    title: params.title,
    body: params.body,
    sound: params.sound ?? "default",
    data: params.data ?? {},
  };

  // 1) Send (ticket)
  const sendRes = await fetch(EXPO_PUSH_SEND_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Accept-encoding": "gzip, deflate",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });

  const sendJson = await sendRes.json();
  console.log("📨 Expo push send response:", sendJson);

  const ticket: ExpoPushTicket | undefined = Array.isArray(sendJson?.data)
    ? sendJson.data[0]
    : sendJson?.data;

  if (!ticket) return {};
  if (ticket.status !== "ok" || !ticket.id) return { ticket };

  // 2) Receipt (APNs/FCM delivery result)
  await sleep(params.receiptWaitMs ?? 3000);

  const receiptRes = await fetch(EXPO_PUSH_RECEIPTS_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Accept-encoding": "gzip, deflate",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ids: [ticket.id] }),
  });

  const receiptJson = await receiptRes.json();
  console.log("🧾 Expo push receipt response:", receiptJson);

  const receipt: ExpoPushReceipt | undefined = receiptJson?.data?.[ticket.id];

  return { ticket, receipt };
}
