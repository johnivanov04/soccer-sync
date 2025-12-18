// src/utils/pushNotifications.ts
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

export async function registerForPushNotificationsAsync(): Promise<string | null> {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "default",
      importance: Notifications.AndroidImportance.MAX,
    });
  }

  if (!Device.isDevice) return null;

  const perms = await Notifications.getPermissionsAsync();
  let status = perms.status;

  if (status !== "granted") {
    const req = await Notifications.requestPermissionsAsync();
    status = req.status;
  }

  if (status !== "granted") return null;

  const projectId =
    Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId;

  const tokenResp = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : {}
  );
  return tokenResp.data;
}

export async function notifyWaitlistPromotionLocal() {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: "You’re in! ✅",
      body: "A spot opened up — you’re now confirmed for the match.",
      sound: "default",
    },
    trigger: null, // fire immediately
  });
}

export type PushMessage = {
  to: string;
  title: string;
  body: string;
  data?: Record<string, any>;
  sound?: "default" | null;
};

export async function sendRemotePush(message: PushMessage) {
  const res = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: message.to,
      title: message.title,
      body: message.body,
      sound: message.sound ?? "default",
      data: message.data ?? {},
    }),
  });

  const json = await res.json();
  const ticket = json?.data;
  if (!ticket) throw new Error(`No ticket returned: ${JSON.stringify(json)}`);

  const t = Array.isArray(ticket) ? ticket[0] : ticket;
  if (t?.status !== "ok") {
    throw new Error(
      `Expo ticket error: ${t?.message ?? "Unknown"} ${JSON.stringify(t?.details ?? {})}`
    );
  }

  return t;
}