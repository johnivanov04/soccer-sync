// src/utils/calendarExport.ts
import * as Calendar from "expo-calendar";

export type MatchForCalendar = {
  id: string;
  title: string; // e.g. "Pickup Soccer"
  startAt: Date; // match start
  endAt?: Date; // optional; if missing we’ll default to +90 min
  location?: string; // e.g. park name/address
  notes?: string; // extra description
};

function computeEnd(startAt: Date, endAt?: Date) {
  if (endAt && endAt.getTime() > startAt.getTime()) return endAt;
  return new Date(startAt.getTime() + 90 * 60 * 1000); // default 90 minutes
}

/**
 * Opens the OS “Create Event” dialog pre-filled with your match info.
 * - iOS: presents Apple Calendar event editor (user can choose calendar/account)
 * - Android: opens the system calendar app “new event” screen
 */
export async function addMatchToCalendar(match: MatchForCalendar): Promise<{
  action: "saved" | "done" | "canceled" | "deleted" | "responded" | string;
  eventId?: string;
}> {
  const perm = await Calendar.requestCalendarPermissionsAsync();
  if (perm.status !== "granted") {
    throw new Error("Calendar permission not granted.");
  }

  const startDate = match.startAt;
  const endDate = computeEnd(match.startAt, match.endAt);

  const result = (await Calendar.createEventInCalendarAsync({
    title: match.title || "Pickup Soccer",
    startDate,
    endDate,
    location: match.location,
    notes: match.notes,
  })) as any;

  return {
    action: result?.action ?? "done",
    eventId: result?.eventId,
  };
}
