// app/(app)/(tabs)/matches.tsx
import { useRouter } from "expo-router";
import { collection, doc, onSnapshot, orderBy, query, where } from "firebase/firestore";
import React, { useEffect, useMemo, useState } from "react";
import { Button, FlatList, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useAuth } from "../../../src/context/AuthContext";
import { db } from "../../../src/firebaseConfig";

const RSVP_STATUSES = ["yes", "maybe", "no"] as const;
type RsvpStatus = (typeof RSVP_STATUSES)[number];

type MatchStatus = "scheduled" | "played" | "cancelled" | string;

type Match = {
  id: string;
  teamId: string;
  startDateTime?: any;
  locationText?: string;
  description?: string;
  maxPlayers?: number;
  minPlayers?: number;
  confirmedYesCount?: number;
  waitlistCount?: number;
  status?: MatchStatus;
  rsvpDeadline?: any;
  createdBy?: string;

  // written by Cloud Function
  lastMessageAt?: any;
  lastMessageText?: string;
  lastMessageSenderId?: string;
  lastMessageSenderName?: string;
};

type MyRsvpMini = {
  matchId: string;
  status?: RsvpStatus;
  isWaitlisted?: boolean;
};

function toDate(raw: any): Date {
  if (!raw) return new Date();
  if (typeof raw?.toDate === "function") return raw.toDate();
  return new Date(raw);
}

function toDateOrNull(raw: any): Date | null {
  if (!raw) return null;
  if (typeof raw?.toDate === "function") return raw.toDate();
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

function tsToMs(raw: any): number {
  if (!raw) return 0;
  if (typeof raw?.toMillis === "function") return raw.toMillis();
  if (typeof raw?.toDate === "function") return raw.toDate().getTime();
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === "number") return raw;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d.getTime() : 0;
}

function normalizeStatus(s?: string) {
  return (s ?? "scheduled").toLowerCase();
}

function isArchivedStatus(status?: string) {
  const st = normalizeStatus(status);
  return st === "played" || st === "cancelled" || st === "canceled";
}

function formatCountdown(ms: number) {
  const abs = Math.abs(ms);
  const sec = Math.floor(abs / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);

  const remHr = hr % 24;
  const remMin = min % 60;

  const parts: string[] = [];
  if (day > 0) parts.push(`${day}d`);
  if (remHr > 0) parts.push(`${remHr}h`);
  if (day === 0 && remMin > 0) parts.push(`${remMin}m`);
  if (parts.length === 0) parts.push("0m");

  return parts.join(" ");
}

function getChip(match: Match) {
  const status = normalizeStatus(match.status);

  if (status === "cancelled" || status === "canceled") {
    return { label: "Cancelled", variant: "cancelled" as const };
  }
  if (status === "played") {
    return { label: "Played", variant: "played" as const };
  }

  const confirmed = match.confirmedYesCount ?? 0;
  const minPlayers = match.minPlayers ?? 0;
  const maxPlayers = match.maxPlayers ?? 0;

  if (match.rsvpDeadline) {
    const deadline = toDate(match.rsvpDeadline);
    if (Date.now() > deadline.getTime()) {
      return { label: "RSVP closed", variant: "closed" as const };
    }
  }

  if (maxPlayers > 0 && confirmed >= maxPlayers) {
    return { label: "Full", variant: "full" as const };
  }

  if (minPlayers > 0) {
    const needed = Math.max(0, minPlayers - confirmed);
    if (needed === 0) return { label: "On track", variant: "ontrack" as const };
    return { label: `Needs ${needed}`, variant: "needs" as const };
  }

  const start = toDate(match.startDateTime);
  const hoursToStart = (start.getTime() - Date.now()) / (1000 * 60 * 60);
  if (hoursToStart <= 24) return { label: "At risk", variant: "atrisk" as const };

  return { label: "Scheduled", variant: "scheduled" as const };
}

function getMyRsvpBadge(r?: MyRsvpMini | null) {
  if (!r?.status) return null;

  if (r.status === "yes") {
    return r.isWaitlisted
      ? { label: "⏳ Waitlisted", variant: "waitlisted" as const }
      : { label: "✅ Confirmed", variant: "confirmed" as const };
  }
  if (r.status === "maybe") return { label: "🟦 Maybe", variant: "maybe" as const };
  return { label: "⬜ No", variant: "no" as const };
}

// No hooks in renderItem — plain helper
function formatPreviewTimeFromDate(d: Date | null): string {
  if (!d) return "";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();

  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export default function MatchesScreen() {
  const router = useRouter();
  const { user } = useAuth();

  const [teamId, setTeamId] = useState<string | null>(null);
  const [teamName, setTeamName] = useState<string | null>(null);
  const [teamLoading, setTeamLoading] = useState(true);

  const [matches, setMatches] = useState<Match[]>([]);
  const [myRsvpByMatchId, setMyRsvpByMatchId] = useState<Record<string, MyRsvpMini>>({});

  // per-match lastReadAt
  const [lastReadByMatchId, setLastReadByMatchId] = useState<Record<string, any>>({});

  // 1) Subscribe to current user's teamId
  useEffect(() => {
    if (!user?.uid) {
      setTeamId(null);
      setTeamName(null);
      setTeamLoading(false);
      return;
    }

    setTeamLoading(true);

    const userRef = doc(db, "users", user.uid);
    const unsub = onSnapshot(
      userRef,
      (snap) => {
        if (snap.exists()) {
          const data = snap.data() as any;
          const nextTeamId = data.teamId ?? data.teamCode ?? data.team ?? data.team_id ?? null;

          setTeamId(nextTeamId ?? null);
          setTeamName(data.teamName ?? null);
        } else {
          setTeamId(null);
          setTeamName(null);
        }
        setTeamLoading(false);
      },
      (err) => {
        console.error("Error listening to user team", err);
        setTeamId(null);
        setTeamName(null);
        setTeamLoading(false);
      }
    );

    return () => unsub();
  }, [user?.uid]);

  // 2) Resolve team name from teams/{teamId}
  useEffect(() => {
    if (!teamId) {
      setTeamName(null);
      return;
    }

    const teamRef = doc(db, "teams", teamId);
    const unsub = onSnapshot(
      teamRef,
      (snap) => {
        if (snap.exists()) {
          const data = snap.data() as any;
          setTeamName(data.name ?? data.teamName ?? teamId);
        } else {
          setTeamName(teamId);
        }
      },
      (err) => {
        console.error("Team doc listener error", err);
        setTeamName(teamId);
      }
    );

    return () => unsub();
  }, [teamId]);

  // 3) Subscribe to matches for team (keep this query simple; we sort client-side)
  useEffect(() => {
    if (!teamId) {
      setMatches([]);
      return;
    }

    const matchesCol = collection(db, "matches");
    const q = query(matchesCol, where("teamId", "==", teamId), orderBy("startDateTime", "asc"));

    const unsub = onSnapshot(
      q,
      (snapshot) => {
        const data: Match[] = snapshot.docs.map((d) => ({
          id: d.id,
          ...(d.data() as any),
        }));
        setMatches(data);
      },
      (err) => {
        console.error("Matches subscription error", err);
      }
    );

    return () => unsub();
  }, [teamId]);

  // 4) Subscribe to MY RSVPs
  useEffect(() => {
    if (!user?.uid) {
      setMyRsvpByMatchId({});
      return;
    }

    const rsvpsCol = collection(db, "rsvps");
    const q = query(rsvpsCol, where("userId", "==", user.uid));

    const unsub = onSnapshot(
      q,
      (snapshot) => {
        const map: Record<string, MyRsvpMini> = {};
        snapshot.docs.forEach((d) => {
          const data = d.data() as any;
          const mid = typeof data?.matchId === "string" ? data.matchId : null;
          if (!mid) return;

          map[mid] = {
            matchId: mid,
            status: data.status as RsvpStatus | undefined,
            isWaitlisted: data.isWaitlisted ?? false,
          };
        });
        setMyRsvpByMatchId(map);
      },
      (err) => {
        console.error("My RSVPs subscription error", err);
      }
    );

    return () => unsub();
  }, [user?.uid]);

  // 5) Subscribe to chatReads
  useEffect(() => {
    if (!user?.uid) {
      setLastReadByMatchId({});
      return;
    }

    const readsCol = collection(db, "users", user.uid, "chatReads");
    const unsub = onSnapshot(
      readsCol,
      (snap) => {
        const map: Record<string, any> = {};
        snap.docs.forEach((d) => {
          const data = d.data() as any;
          map[d.id] = data?.lastReadAt ?? null;
        });
        setLastReadByMatchId(map);
      },
      (err) => console.error("chatReads subscription error:", err)
    );

    return () => unsub();
  }, [user?.uid]);

  /**
   * ✅ OPTION #2: sort matches like a chat list
   * - Scheduled first, played/cancelled last
   * - Scheduled:
   *    - with chat: lastMessageAt DESC
   *    - no chat: startDateTime ASC
   */
  const sortedMatches = useMemo(() => {
    const copy = [...matches];

    copy.sort((a, b) => {
      const aArchived = isArchivedStatus(a.status);
      const bArchived = isArchivedStatus(b.status);
      if (aArchived !== bArchived) return aArchived ? 1 : -1; // archived to bottom

      const aHasChat = tsToMs(a.lastMessageAt) > 0;
      const bHasChat = tsToMs(b.lastMessageAt) > 0;
      if (aHasChat !== bHasChat) return aHasChat ? -1 : 1; // chat threads on top

      if (aHasChat && bHasChat) {
        const aLm = tsToMs(a.lastMessageAt);
        const bLm = tsToMs(b.lastMessageAt);
        if (aLm !== bLm) return bLm - aLm; // most recent chat first
        // tie-breaker: earlier start first
        return tsToMs(a.startDateTime) - tsToMs(b.startDateTime);
      }

      // no chat: upcoming soonest first
      const aStart = tsToMs(a.startDateTime);
      const bStart = tsToMs(b.startDateTime);
      if (aStart !== bStart) return aStart - bStart;

      return a.id.localeCompare(b.id);
    });

    return copy;
  }, [matches]);

  const renderItem = ({ item }: { item: Match }) => {
    const date = toDate(item.startDateTime);
    const chip = getChip(item);

    const isHost = !!user?.uid && item.createdBy === user.uid;
    const confirmed = item.confirmedYesCount ?? 0;
    const max = item.maxPlayers ?? 0;
    const waitlist = item.waitlistCount ?? 0;

    const myRsvp = myRsvpByMatchId[item.id] ?? null;
    const myBadge = getMyRsvpBadge(myRsvp);

    const desc = (item.description ?? "").trim();

    const msUntilStart = date.getTime() - Date.now();
    const startHint =
      normalizeStatus(item.status) === "played" ||
      normalizeStatus(item.status) === "cancelled" ||
      normalizeStatus(item.status) === "canceled"
        ? null
        : msUntilStart >= 0
        ? `Starts in ${formatCountdown(msUntilStart)}`
        : "In progress / started";

    // unread: lastMessageAt > lastReadAt AND not sent by me
    const lastMsgAt = toDateOrNull(item.lastMessageAt);
    const lastReadAt = toDateOrNull(lastReadByMatchId[item.id]);

    const unread =
      !!lastMsgAt &&
      item.lastMessageSenderId !== user?.uid &&
      (!lastReadAt || lastReadAt.getTime() < lastMsgAt.getTime());

    const previewText = (item.lastMessageText ?? "").trim();
    const senderLabel =
      item.lastMessageSenderId === user?.uid ? "You" : item.lastMessageSenderName ?? "Someone";

    const previewTime = formatPreviewTimeFromDate(lastMsgAt);

    return (
      <TouchableOpacity
        style={[styles.card, unread && styles.cardUnread]}
        onPress={() =>
          router.push({
            pathname: "/(app)/match/[matchId]",
            params: { matchId: item.id },
          })
        }
      >
        <View style={styles.cardTopRow}>
          <Text style={styles.title}>
            {date.toLocaleDateString()}{" "}
            {date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </Text>

          <View style={styles.topRight}>
            {unread && <View style={styles.unreadDot} />}
            <View style={[styles.chip, (styles as any)[`chip_${chip.variant}`]]}>
              <Text style={styles.chipText}>{chip.label}</Text>
            </View>
          </View>
        </View>

        {!!startHint && <Text style={styles.startHint}>{startHint}</Text>}

        {!!item.locationText && <Text style={styles.location}>{item.locationText}</Text>}

        {!!desc && (
          <Text style={styles.desc} numberOfLines={2}>
            {desc}
          </Text>
        )}

        {/* Chat preview */}
        {previewText ? (
          <View style={styles.chatRow}>
            <Text style={styles.chatPreview} numberOfLines={1}>
              {senderLabel}: {previewText}
            </Text>
            {!!previewTime && <Text style={styles.chatTime}>{previewTime}</Text>}
          </View>
        ) : (
          <Text style={styles.chatEmpty}>No chat messages yet</Text>
        )}

        <View style={styles.metaRow}>
          <Text style={styles.subtitle}>
            {confirmed}/{max || "?"} going
          </Text>

          {waitlist > 0 && <Text style={styles.waitlistText}>⏳ {waitlist} waitlist</Text>}

          {!!myBadge && (
            <View style={[styles.myBadge, (styles as any)[`myBadge_${myBadge.variant}`]]}>
              <Text style={styles.myBadgeText}>{myBadge.label}</Text>
            </View>
          )}

          {isHost && <Text style={styles.hostBadge}>👑 Host</Text>}
        </View>
      </TouchableOpacity>
    );
  };

  if (teamLoading) {
    return (
      <View style={styles.container}>
        <Text>Loading your team…</Text>
      </View>
    );
  }

  if (!teamId) {
    return (
      <View style={styles.container}>
        <Text style={styles.noTeamTitle}>You’re not on a team yet.</Text>
        <Text style={styles.noTeamSub}>
          Join or create a team in the Teams tab to see and create matches.
        </Text>
        <Button title="Go to Teams" onPress={() => router.push("/(app)/(tabs)/teams")} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.teamTag}>Team: {teamName ?? teamId}</Text>

      <Button title="Create Match" onPress={() => router.push("/(app)/match/create")} />

      <FlatList
        data={sortedMatches}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={{ paddingVertical: 12 }}
      />

      {sortedMatches.length === 0 && (
        <Text style={{ marginTop: 16, textAlign: "center" }}>
          No matches yet. Create one!
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },

  teamTag: {
    marginBottom: 10,
    paddingVertical: 4,
    paddingHorizontal: 10,
    backgroundColor: "#E6F4FF",
    borderRadius: 999,
    alignSelf: "flex-start",
    fontSize: 12,
    fontWeight: "600",
  },

  card: {
    padding: 12,
    marginBottom: 10,
    borderRadius: 10,
    borderColor: "#ddd",
    borderWidth: 1,
    backgroundColor: "#fff",
  },
  cardUnread: {
    borderColor: "#2b4cff",
  },

  cardTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },

  topRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },

  unreadDot: {
    width: 10,
    height: 10,
    borderRadius: 999,
    backgroundColor: "#2b4cff",
  },

  title: { fontWeight: "bold", flex: 1 },
  startHint: { marginTop: 6, color: "#666" },
  location: { marginTop: 6, color: "#555" },

  desc: { marginTop: 6, color: "#444", lineHeight: 18 },

  chatRow: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  chatPreview: {
    flex: 1,
    color: "#222",
    fontWeight: "600",
  },
  chatTime: { color: "#666", fontSize: 12, fontWeight: "600" },
  chatEmpty: { marginTop: 8, color: "#777" },

  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 10,
    flexWrap: "wrap",
  },

  subtitle: { color: "#777" },

  hostBadge: {
    backgroundColor: "#FFF3CD",
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 999,
    fontSize: 12,
    fontWeight: "600",
  },

  waitlistText: { color: "#7a4d00" },

  chip: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999 },
  chipText: { fontSize: 12, fontWeight: "700" },

  chip_ontrack: { backgroundColor: "#DFF7E3" },
  chip_needs: { backgroundColor: "#EDEDED" },
  chip_atrisk: { backgroundColor: "#FFE1E1" },
  chip_cancelled: { backgroundColor: "#F2F2F2" },
  chip_played: { backgroundColor: "#E6F4FF" },
  chip_full: { backgroundColor: "#FFE7B8" },
  chip_closed: { backgroundColor: "#E9E3FF" },
  chip_scheduled: { backgroundColor: "#EDEDED" },

  myBadge: { paddingVertical: 3, paddingHorizontal: 8, borderRadius: 999 },
  myBadgeText: { fontSize: 12, fontWeight: "700" },
  myBadge_confirmed: { backgroundColor: "#DFF7E3" },
  myBadge_waitlisted: { backgroundColor: "#FFE7B8" },
  myBadge_maybe: { backgroundColor: "#E6F4FF" },
  myBadge_no: { backgroundColor: "#F2F2F2" },

  noTeamTitle: { fontSize: 18, fontWeight: "700" },
  noTeamSub: { marginTop: 8, marginBottom: 16, color: "#555" },
});
