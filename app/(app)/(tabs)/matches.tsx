// app/(app)/(tabs)/matches.tsx
import { useRouter } from "expo-router";
import {
  collection,
  doc,
  orderBy,
  query,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import React, { useEffect, useMemo, useState } from "react";
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../../src/context/AuthContext";
import { db } from "../../../src/firebaseConfig";
import { onSnapshotSafe } from "../../../src/firestoreSafe";

const RSVP_STATUSES = ["yes", "maybe", "no"] as const;
type RsvpStatus = (typeof RSVP_STATUSES)[number];
type QDoc = QueryDocumentSnapshot<DocumentData>;
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

  lastMessageAt?: any;
  lastMessageText?: string;
  lastMessageSenderId?: string;
  lastMessageSenderName?: string;

  lastMessageSeq?: number;
};

type Membership = {
  id: string;
  teamId: string;
  teamName?: string;
  userId: string;
  role: "owner" | "admin" | "member";
  status: "pending" | "active" | "removed" | "left";
};

type MyRsvpMini = {
  matchId: string;
  status?: RsvpStatus;
  isWaitlisted?: boolean;
};

type ChatReadMini = {
  lastReadAt?: any;
  lastReadSeq?: number | null;
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

function PrimaryButton({
  title,
  onPress,
  disabled,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!!disabled}
      style={({ pressed }) => [
        styles.primaryBtn,
        disabled && styles.primaryBtnDisabled,
        pressed && !disabled && { transform: [{ scale: 0.99 }] },
      ]}
    >
      <Text style={styles.primaryBtnText}>{title}</Text>
    </Pressable>
  );
}

function SecondaryButton({
  title,
  onPress,
  disabled,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!!disabled}
      style={({ pressed }) => [
        styles.secondaryBtn,
        disabled && styles.primaryBtnDisabled,
        pressed && !disabled && { transform: [{ scale: 0.99 }] },
      ]}
    >
      <Text style={styles.secondaryBtnText}>{title}</Text>
    </Pressable>
  );
}

export default function MatchesScreen() {
  const router = useRouter();
  const { user } = useAuth();

  const [activeMembership, setActiveMembership] = useState<Membership | null>(null);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [teamName, setTeamName] = useState<string | null>(null);
  const [teamLoading, setTeamLoading] = useState(true);

  const [matches, setMatches] = useState<Match[]>([]);
  const [myRsvpByMatchId, setMyRsvpByMatchId] = useState<Record<string, MyRsvpMini>>({});
  const [lastReadByMatchId, setLastReadByMatchId] = useState<Record<string, ChatReadMini>>({});

  // ✅ 1) Source of truth: memberships (not users/{uid}.teamId)
  useEffect(() => {
    if (!user?.uid) {
      setActiveMembership(null);
      setTeamId(null);
      setTeamName(null);
      setTeamLoading(false);
      return;
    }

    setTeamLoading(true);

    const qMine = query(collection(db, "memberships"), where("userId", "==", user.uid));
    const unsub = onSnapshotSafe(
      qMine,
      (snap) => {
        const list: Membership[] = snap.docs.map((d: QDoc) => ({ id: d.id, ...(d.data() as any) }));
        const active = list.find((m) => m.status === "active") ?? null;

        setActiveMembership(active);
        setTeamId(active?.teamId ?? null);
        setTeamName(active?.teamName ?? null);
        setTeamLoading(false);
      },
      {
        label: "matches:memberships(userId)",
        onError: (err) => {
          console.warn("memberships(userId) listener failed:", err);
          setActiveMembership(null);
          setTeamId(null);
          setTeamName(null);
          setTeamLoading(false);
        },
        onPermissionDenied: () => {
          setActiveMembership(null);
          setTeamId(null);
          setTeamName(null);
          setTeamLoading(false);
        },
      }
    );

    return () => unsub();
  }, [user?.uid]);

  // ✅ 2) Optional: resolve team name from teams/{teamId} (only while active)
  useEffect(() => {
    if (!teamId || !activeMembership) return;

    const teamRef = doc(db, "teams", teamId);
    const unsub = onSnapshotSafe(
      teamRef,
      (snap) => {
        if (snap.exists()) {
          const data = snap.data() as any;
          setTeamName(data.name ?? data.teamName ?? teamId);
        } else {
          setTeamName(teamId);
        }
      },
      {
        label: "matches:teamDoc",
        onPermissionDenied: () => {},
      }
    );

    return () => unsub();
  }, [teamId, !!activeMembership]);

  // ✅ 3) Subscribe to matches ONLY when membership is active
  useEffect(() => {
    if (!teamId || !activeMembership) {
      setMatches([]);
      return;
    }

    const matchesCol = collection(db, "matches");
    const q = query(matchesCol, where("teamId", "==", teamId), orderBy("startDateTime", "asc"));

    const unsub = onSnapshotSafe(
      q,
      (snapshot) => {
        const data: Match[] = snapshot.docs.map((d: QDoc) => ({
          id: d.id,
          ...(d.data() as any),
        }));
        setMatches(data);
      },
      {
        label: "matches:matches(teamId)",
        onPermissionDenied: () => setMatches([]),
        onError: (err) => {
          console.warn("Matches subscription error", err);
          setMatches([]);
        },
      }
    );

    return () => unsub();
  }, [teamId, !!activeMembership]);

  // 4) Subscribe to MY RSVPs
  useEffect(() => {
    if (!user?.uid) {
      setMyRsvpByMatchId({});
      return;
    }

    const rsvpsCol = collection(db, "rsvps");
    const q = query(rsvpsCol, where("userId", "==", user.uid));

    const unsub = onSnapshotSafe(
      q,
      (snapshot) => {
        const map: Record<string, MyRsvpMini> = {};
        snapshot.docs.forEach((d: QDoc) => {
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
      {
        label: "matches:myRsvps",
        onError: (err) => console.warn("My RSVPs subscription error", err),
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
    const unsub = onSnapshotSafe(
      readsCol,
      (snap) => {
        const map: Record<string, ChatReadMini> = {};
        snap.docs.forEach((d: QDoc) => {
          const data = d.data() as any;
          map[d.id] = {
            lastReadAt: data?.lastReadAt ?? null,
            lastReadSeq: typeof data?.lastReadSeq === "number" ? data.lastReadSeq : null,
          };
        });
        setLastReadByMatchId(map);
      },
      {
        label: "matches:chatReads",
        onError: (err) => console.warn("chatReads subscription error:", err),
      }
    );

    return () => unsub();
  }, [user?.uid]);

  const sortedMatches = useMemo(() => {
    const copy = [...matches];

    copy.sort((a, b) => {
      const aArchived = isArchivedStatus(a.status);
      const bArchived = isArchivedStatus(b.status);
      if (aArchived !== bArchived) return aArchived ? 1 : -1;

      const aHasChat = tsToMs(a.lastMessageAt) > 0;
      const bHasChat = tsToMs(b.lastMessageAt) > 0;
      if (aHasChat !== bHasChat) return aHasChat ? -1 : 1;

      if (aHasChat && bHasChat) {
        const aLm = tsToMs(a.lastMessageAt);
        const bLm = tsToMs(b.lastMessageAt);
        if (aLm !== bLm) return bLm - aLm;
        return tsToMs(a.startDateTime) - tsToMs(b.startDateTime);
      }

      const aStart = tsToMs(a.startDateTime);
      const bStart = tsToMs(b.startDateTime);
      if (aStart !== bStart) return aStart - bStart;

      return a.id.localeCompare(b.id);
    });

    return copy;
  }, [matches]);

  const header = () => {
    if (!teamId || !activeMembership) return null;

    return (
      <View style={{ paddingTop: 6, paddingBottom: 10 }}>
        <Text style={styles.heroTitle}>Matches</Text>
        <Text style={styles.heroSub}>
          Schedule games, track RSVPs, and keep the chat flowing.
        </Text>

        <View style={styles.pillRow}>
          <View style={styles.teamPill}>
            <Text style={styles.teamPillText}>Team: {teamName ?? teamId}</Text>
          </View>
        </View>

        <View style={{ marginTop: 12 }}>
          <PrimaryButton title="Create Match" onPress={() => router.push("/(app)/match/create")} />
        </View>

        <Text style={styles.sectionTitle}>Upcoming & recent</Text>
      </View>
    );
  };

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

    const read = lastReadByMatchId[item.id];
    const lastSeq = typeof item.lastMessageSeq === "number" ? item.lastMessageSeq : null;
    const readSeq = typeof read?.lastReadSeq === "number" ? read.lastReadSeq : null;

    const lastMsgAt = toDateOrNull(item.lastMessageAt);
    const lastReadAt = toDateOrNull(read?.lastReadAt);

    let unreadCount = 0;

    if (item.lastMessageSenderId !== user?.uid) {
      if (lastSeq != null && lastSeq > 0) {
        unreadCount = Math.max(0, lastSeq - (readSeq ?? 0));
      } else if (!!lastMsgAt) {
        const unreadLegacy = !lastReadAt || lastReadAt.getTime() < lastMsgAt.getTime();
        unreadCount = unreadLegacy ? 1 : 0;
      }
    }

    const unread = unreadCount > 0;

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
        activeOpacity={0.92}
      >
        <View style={styles.cardTopRow}>
          <Text style={styles.cardTitle}>
            {date.toLocaleDateString()}{" "}
            {date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </Text>

          <View style={styles.topRight}>
            {unread && <View style={styles.unreadDot} />}

            {unreadCount > 0 && (
              <View style={styles.unreadPill}>
                <Text style={styles.unreadPillText}>{unreadCount > 99 ? "99+" : unreadCount}</Text>
              </View>
            )}

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
          <Text style={styles.metaText}>
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

  // ---- States ----
  if (teamLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={["left", "right", "bottom"]}>
        <View style={styles.screen}>
          <View style={styles.bg} />
          <View style={styles.pitchBlobs} />
          <View style={styles.centerWrap}>
            <View style={styles.glassNotice}>
              <Text style={styles.noticeTitle}>Loading…</Text>
              <Text style={styles.noticeSub}>Getting your team + matches.</Text>
            </View>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (!teamId || !activeMembership) {
    return (
      <SafeAreaView style={styles.safe} edges={["left", "right", "bottom"]}>
        <View style={styles.screen}>
          <View style={styles.bg} />
          <View style={styles.pitchBlobs} />

          <View style={[styles.centerWrap, { paddingHorizontal: 18 }]}>
            <Text style={styles.heroTitle}>Matches</Text>
            <Text style={styles.heroSub}>
              You need to join or create a team first.
            </Text>

            <View style={[styles.glassNotice, { marginTop: 14 }]}>
              <Text style={styles.noticeTitle}>You’re not on a team yet.</Text>
              <Text style={styles.noticeSub}>
                Go to Teams to join with an invite code or create a new team.
              </Text>

              <View style={{ marginTop: 12 }}>
                <PrimaryButton
                  title="Go to Teams"
                  onPress={() => router.push("/(app)/(tabs)/teams")}
                />
              </View>
            </View>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["left", "right", "bottom"]}>
      <View style={styles.screen}>
        {/* Background layers */}
        <View style={styles.bg} />
        <View style={styles.pitchBlobs} />

        <FlatList
          data={sortedMatches}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          ListHeaderComponent={header}
          ListEmptyComponent={
            <View style={{ marginTop: 6 }}>
              <View style={styles.glassNotice}>
                <Text style={styles.noticeTitle}>No matches yet.</Text>
                <Text style={styles.noticeSub}>Create one and invite your squad.</Text>
                <View style={{ marginTop: 12 }}>
                  <SecondaryButton
                    title="Create your first match"
                    onPress={() => router.push("/(app)/match/create")}
                  />
                </View>
              </View>
            </View>
          }
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  // Safe area
  safe: { flex: 1, backgroundColor: "#052b22" },

  // Screen
  screen: { flex: 1, backgroundColor: "#052b22" },

  // Background
  bg: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#052b22",
  },

  // soft “pitch blobs” (no center circle outline)
  pitchBlobs: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0.35,
    backgroundColor: "transparent",
  },

  listContent: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 24,
  },

  // Hero
  heroTitle: {
    fontSize: 44,
    fontWeight: "900",
    color: "white",
    letterSpacing: 0.2,
  },
  heroSub: {
    marginTop: 6,
    fontSize: 16,
    fontWeight: "700",
    color: "rgba(255,255,255,0.70)",
    lineHeight: 20,
  },
  sectionTitle: {
    marginTop: 18,
    fontSize: 18,
    fontWeight: "900",
    color: "rgba(255,255,255,0.92)",
  },

  pillRow: { marginTop: 10, flexDirection: "row", flexWrap: "wrap", gap: 10 },
  teamPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    alignSelf: "flex-start",
  },
  teamPillText: {
    fontSize: 12,
    fontWeight: "800",
    color: "rgba(255,255,255,0.80)",
  },

  // Buttons
  primaryBtn: {
    height: 54,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1b7f5a",
  },
  primaryBtnDisabled: { opacity: 0.55 },
  primaryBtnText: {
    color: "#04130f",
    fontSize: 18,
    fontWeight: "900",
  },
  secondaryBtn: {
    height: 54,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.10)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },
  secondaryBtnText: {
    color: "rgba(255,255,255,0.92)",
    fontSize: 17,
    fontWeight: "900",
  },

  // Cards
  card: {
    marginTop: 12,
    padding: 14,
    borderRadius: 18,
    backgroundColor: "rgba(10, 16, 25, 0.78)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  cardUnread: {
    borderColor: "rgba(43, 76, 255, 0.65)",
  },

  cardTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  cardTitle: {
    flex: 1,
    fontWeight: "900",
    color: "white",
    fontSize: 15,
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
    backgroundColor: "rgba(43, 76, 255, 0.95)",
  },

  unreadPill: {
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderRadius: 999,
    backgroundColor: "rgba(43, 76, 255, 0.95)",
  },
  unreadPillText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "900",
  },

  startHint: { marginTop: 8, color: "rgba(255,255,255,0.65)", fontWeight: "700" },
  location: { marginTop: 6, color: "rgba(255,255,255,0.78)", fontWeight: "700" },
  desc: { marginTop: 6, color: "rgba(255,255,255,0.72)", lineHeight: 18, fontWeight: "600" },

  // Chat preview
  chatRow: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  chatPreview: {
    flex: 1,
    color: "rgba(255,255,255,0.92)",
    fontWeight: "800",
  },
  chatTime: { color: "rgba(255,255,255,0.60)", fontSize: 12, fontWeight: "800" },
  chatEmpty: { marginTop: 10, color: "rgba(255,255,255,0.55)", fontWeight: "700" },

  // Meta row
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 12,
    flexWrap: "wrap",
  },
  metaText: { color: "rgba(255,255,255,0.65)", fontWeight: "800" },
  waitlistText: { color: "rgba(255,231,184,0.95)", fontWeight: "900" },

  hostBadge: {
    backgroundColor: "rgba(255, 243, 205, 0.22)",
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
    fontSize: 12,
    fontWeight: "900",
    color: "rgba(255,255,255,0.92)",
    overflow: "hidden",
  },

  // Chips
  chip: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  chipText: { fontSize: 12, fontWeight: "900", color: "rgba(255,255,255,0.92)" },

  chip_ontrack: { backgroundColor: "rgba(27, 127, 90, 0.25)" },
  chip_needs: { backgroundColor: "rgba(255,255,255,0.10)" },
  chip_atrisk: { backgroundColor: "rgba(255, 120, 120, 0.18)" },
  chip_cancelled: { backgroundColor: "rgba(255,255,255,0.08)" },
  chip_played: { backgroundColor: "rgba(120, 180, 255, 0.20)" },
  chip_full: { backgroundColor: "rgba(255, 231, 184, 0.20)" },
  chip_closed: { backgroundColor: "rgba(180, 150, 255, 0.20)" },
  chip_scheduled: { backgroundColor: "rgba(255,255,255,0.10)" },

  // My RSVP badge
  myBadge: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  myBadgeText: { fontSize: 12, fontWeight: "900", color: "rgba(255,255,255,0.92)" },
  myBadge_confirmed: { backgroundColor: "rgba(27, 127, 90, 0.25)" },
  myBadge_waitlisted: { backgroundColor: "rgba(255, 231, 184, 0.20)" },
  myBadge_maybe: { backgroundColor: "rgba(120, 180, 255, 0.20)" },
  myBadge_no: { backgroundColor: "rgba(255,255,255,0.08)" },

  // Empty / notices
  centerWrap: { flex: 1, justifyContent: "center", alignItems: "center" },
  glassNotice: {
    width: "100%",
    borderRadius: 22,
    padding: 18,
    backgroundColor: "rgba(10, 16, 25, 0.78)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  noticeTitle: {
    fontSize: 18,
    fontWeight: "900",
    color: "rgba(255,255,255,0.92)",
  },
  noticeSub: {
    marginTop: 6,
    color: "rgba(255,255,255,0.70)",
    fontWeight: "700",
    lineHeight: 18,
  },
});
