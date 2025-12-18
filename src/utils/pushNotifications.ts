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

function normalizeTokens(tokens: unknown): string[] {
  if (!Array.isArray(tokens)) return [];
  const out: string[] = [];
  for (const t of tokens) {
    if (typeof t === "string" && t.trim()) out.push(t.trim());
  }
  // de-dupe
  return Array.from(new Set(out));
}

export async function sendRemotePush(message: PushMessage) {
  const [ticket] = await sendRemotePushMany([message]);
  return ticket;
}

// ✅ Batch sender (more efficient, and helps avoid rate issues)
export async function sendRemotePushMany(messages: PushMessage[]) {
  const payload = messages.map((m) => ({
    to: m.to,
    title: m.title,
    body: m.body,
    sound: m.sound ?? "default",
    data: m.data ?? {},
  }));

  const res = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const json = await res.json();
  const tickets = json?.data;

  if (!tickets) throw new Error(`No tickets returned: ${JSON.stringify(json)}`);
  const arr = Array.isArray(tickets) ? tickets : [tickets];

  // throw if any ticket is not ok (keeps behavior similar to your old sendRemotePush)
  for (const t of arr) {
    if (t?.status !== "ok") {
      throw new Error(
        `Expo ticket error: ${t?.message ?? "Unknown"} ${JSON.stringify(t?.details ?? {})}`
      );
    }
  }

  return arr;
}

// Optional export if you ever want it elsewhere
export { normalizeTokens };
