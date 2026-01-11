// app/(app)/(tabs)/myRsvps.tsx
import { useRouter } from "expo-router";
import {
  collection,
  doc,
  query,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  SectionList,
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
  teamId?: string;
  startDateTime?: any;
  locationText?: string;
  maxPlayers?: number;
  minPlayers?: number;
  confirmedYesCount?: number;
  waitlistCount?: number;
  status?: MatchStatus;
  rsvpDeadline?: any;
  createdBy?: string;
  description?: string;
};

type MyRsvp = {
  id: string;
  matchId: string;
  userId: string;
  playerName?: string;
  status: RsvpStatus;
  isWaitlisted: boolean;
  updatedAt?: any;
};

function toDate(raw: any): Date {
  if (!raw) return new Date();
  if (typeof raw?.toDate === "function") return raw.toDate();
  return new Date(raw);
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

// Match chip logic aligned with Matches screen (cancelled/played/closed/full/minPlayers/etc.)
function getChip(match: Match | null) {
  if (!match) return { label: "Unavailable", variant: "unavailable" as const };

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

  const start = match.startDateTime ? toDate(match.startDateTime) : new Date();
  const hoursToStart = (start.getTime() - Date.now()) / (1000 * 60 * 60);
  if (hoursToStart <= 24) return { label: "At risk", variant: "atrisk" as const };

  return { label: "Scheduled", variant: "scheduled" as const };
}

// My RSVP badge aligned with Matches screen styling
function getMyRsvpBadge(r: MyRsvp) {
  if (!r.status) return null;

  if (r.status === "yes") {
    return r.isWaitlisted
      ? { label: "⏳ Waitlisted", variant: "waitlisted" as const }
      : { label: "✅ Confirmed", variant: "confirmed" as const };
  }
  if (r.status === "maybe") return { label: "🟦 Maybe", variant: "maybe" as const };
  return { label: "⬜ No", variant: "no" as const };
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
    <TouchableOpacity
      onPress={onPress}
      disabled={!!disabled}
      activeOpacity={0.92}
      style={[styles.primaryBtn, disabled && styles.primaryBtnDisabled]}
    >
      <Text style={styles.primaryBtnText}>{title}</Text>
    </TouchableOpacity>
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
    <TouchableOpacity
      onPress={onPress}
      disabled={!!disabled}
      activeOpacity={0.92}
      style={[styles.secondaryBtn, disabled && styles.primaryBtnDisabled]}
    >
      <Text style={styles.secondaryBtnText}>{title}</Text>
    </TouchableOpacity>
  );
}

export default function MyRsvpsScreen() {
  const router = useRouter();
  const { user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [rsvps, setRsvps] = useState<MyRsvp[]>([]);
  const [matchesById, setMatchesById] = useState<Record<string, Match | null>>({});
  const [errorText, setErrorText] = useState<string | null>(null);

  // 1) Subscribe to my RSVPs (by userId)
  useEffect(() => {
    if (!user?.uid) {
      setRsvps([]);
      setMatchesById({});
      setLoading(false);
      return;
    }

    setLoading(true);
    setErrorText(null);

    const qy = query(collection(db, "rsvps"), where("userId", "==", user.uid));

    const unsub = onSnapshotSafe(
      qy,
      (snapshot) => {
        const list: MyRsvp[] = snapshot.docs
          .map((d: QDoc) => {
            const data = d.data() as any;
            return {
              id: d.id,
              matchId: String(data.matchId ?? ""),
              userId: String(data.userId ?? ""),
              playerName: data.playerName,
              status: (data.status as RsvpStatus) ?? "no",
              isWaitlisted: !!data.isWaitlisted,
              updatedAt: data.updatedAt,
            };
          })
          .filter((r: MyRsvp) => !!r.matchId && r.userId === user.uid);

        setRsvps(list);
        setLoading(false);
      },
      {
        label: "myRsvps:rsvps(userId)",
        onError: (err) => {
          console.error("My RSVPs subscription error", err);
          setErrorText("Could not load your RSVPs (permissions).");
          setRsvps([]);
          setLoading(false);
        },
        onPermissionDenied: () => {
          setErrorText("Could not load your RSVPs (permissions).");
          setRsvps([]);
          setLoading(false);
        },
      }
    );

    return () => unsub();
  }, [user?.uid]);

  // stable, sorted matchIds
  const matchIds = useMemo(() => {
    const uniq = new Set<string>();
    rsvps.forEach((r) => uniq.add(r.matchId));
    return Array.from(uniq).sort();
  }, [rsvps]);

  const matchIdsKey = useMemo(() => matchIds.join("|"), [matchIds]);

  // 2) Subscribe to each match doc individually
  const matchUnsubsRef = useRef<Record<string, () => void>>({});

  useEffect(() => {
    Object.values(matchUnsubsRef.current).forEach((u) => u());
    matchUnsubsRef.current = {};

    if (!matchIds.length) {
      setMatchesById({});
      return;
    }

    setMatchesById((prev) => {
      const keep = new Set(matchIds);
      const next: Record<string, Match | null> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (keep.has(k)) next[k] = v;
      }
      return next;
    });

    matchIds.forEach((id) => {
      const matchRef = doc(db, "matches", id);

      const unsub = onSnapshotSafe(
        matchRef,
        (snap) => {
          setMatchesById((prev) => {
            const next = { ...prev };
            if (snap.exists()) next[id] = { id: snap.id, ...(snap.data() as any) };
            else next[id] = null;
            return next;
          });
        },
        {
          label: `myRsvps:matchDoc(${id})`,
          onPermissionDenied: () => {
            setMatchesById((prev) => ({ ...prev, [id]: null }));
          },
          onError: (err) => {
            console.error("My RSVPs match doc listener error", id, err);
            setMatchesById((prev) => ({ ...prev, [id]: null }));
          },
        }
      );

      matchUnsubsRef.current[id] = unsub;
    });

    return () => {
      Object.values(matchUnsubsRef.current).forEach((u) => u());
      matchUnsubsRef.current = {};
    };
  }, [matchIdsKey]);

  const sections = useMemo(() => {
    const now = Date.now();

    const merged = rsvps.map((r) => {
      const match = matchesById[r.matchId] ?? null;

      const startMs = match?.startDateTime
        ? toDate(match.startDateTime).getTime()
        : Number.POSITIVE_INFINITY;

      const matchStatus = normalizeStatus(match?.status);

      const isUnavailable = !match;
      const isPast =
        !isUnavailable &&
        (matchStatus === "played" ||
          matchStatus === "cancelled" ||
          matchStatus === "canceled" ||
          startMs < now);

      return { rsvp: r, match, startMs, isPast, isUnavailable };
    });

    const upcoming = merged
      .filter((x) => !x.isUnavailable && !x.isPast)
      .sort((a, b) => a.startMs - b.startMs);

    const past = merged
      .filter((x) => !x.isUnavailable && x.isPast)
      .sort((a, b) => b.startMs - a.startMs);

    const unavailable = merged
      .filter((x) => x.isUnavailable)
      .sort((a, b) => a.rsvp.matchId.localeCompare(b.rsvp.matchId));

    return [
      { title: "Upcoming", data: upcoming },
      { title: "Past", data: past },
      { title: "Unavailable", data: unavailable },
    ].filter((s) => s.data.length > 0);
  }, [rsvps, matchesById]);

  const header = () => {
    return (
      <View style={{ paddingTop: 6, paddingBottom: 10 }}>
        <Text style={styles.heroTitle}>My RSVPs</Text>
        <Text style={styles.heroSub}>
          Track what you said yes to, what you’re on the fence about, and what you skipped.
        </Text>

        <Text style={styles.sectionTitle}>Your list</Text>
      </View>
    );
  };

  const EmptyNotice = ({
    title,
    sub,
    buttonTitle,
    onPress,
    secondary,
  }: {
    title: string;
    sub: string;
    buttonTitle?: string;
    onPress?: () => void;
    secondary?: boolean;
  }) => {
    return (
      <View style={{ marginTop: 6 }}>
        <View style={styles.glassNotice}>
          <Text style={styles.noticeTitle}>{title}</Text>
          <Text style={styles.noticeSub}>{sub}</Text>

          {!!buttonTitle && !!onPress && (
            <View style={{ marginTop: 12 }}>
              {secondary ? (
                <SecondaryButton title={buttonTitle} onPress={onPress} />
              ) : (
                <PrimaryButton title={buttonTitle} onPress={onPress} />
              )}
            </View>
          )}
        </View>
      </View>
    );
  };

  // ---- States ----
  if (!user?.uid) {
    return (
      <SafeAreaView style={styles.safe} edges={["left", "right", "bottom"]}>
        <View style={styles.screen}>
          <View style={styles.bg} />
          <View style={styles.pitchBlobs} />

          <View style={[styles.centerWrap, { paddingHorizontal: 18 }]}>
            <Text style={styles.heroTitle}>My RSVPs</Text>
            <Text style={styles.heroSub}>Sign in to view your RSVPs.</Text>

            <EmptyNotice
              title="You’re signed out."
              sub="Sign in, then come back here to see your RSVP history."
            />
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={["left", "right", "bottom"]}>
        <View style={styles.screen}>
          <View style={styles.bg} />
          <View style={styles.pitchBlobs} />
          <View style={styles.centerWrap}>
            <View style={styles.glassNotice}>
              <Text style={styles.noticeTitle}>Loading…</Text>
              <Text style={styles.noticeSub}>Pulling your RSVPs.</Text>
              <View style={{ marginTop: 14 }}>
                <ActivityIndicator />
              </View>
            </View>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (errorText) {
    return (
      <SafeAreaView style={styles.safe} edges={["left", "right", "bottom"]}>
        <View style={styles.screen}>
          <View style={styles.bg} />
          <View style={styles.pitchBlobs} />
          <View style={[styles.centerWrap, { paddingHorizontal: 18 }]}>
            <Text style={styles.heroTitle}>My RSVPs</Text>
            <Text style={styles.heroSub}>Something went wrong.</Text>

            <EmptyNotice title="Couldn’t load RSVPs." sub={errorText} />
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (!rsvps.length) {
    return (
      <SafeAreaView style={styles.safe} edges={["left", "right", "bottom"]}>
        <View style={styles.screen}>
          <View style={styles.bg} />
          <View style={styles.pitchBlobs} />

          <View style={[styles.centerWrap, { paddingHorizontal: 18 }]}>
            <Text style={styles.heroTitle}>My RSVPs</Text>
            <Text style={styles.heroSub}>No activity yet — it’ll show up here.</Text>

            <EmptyNotice
              title="No RSVPs yet."
              sub="Go to Matches and tap YES / MAYBE / NO on a match."
              buttonTitle="Go to Matches"
              onPress={() => router.push("/(app)/(tabs)/matches")}
              secondary
            />
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

        <SectionList
          sections={sections}
          keyExtractor={(item) => item.rsvp.id}
          ListHeaderComponent={header}
          stickySectionHeadersEnabled={false}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.listContent}
          renderSectionHeader={({ section }) => (
            <Text style={styles.sectionTitle}>{section.title}</Text>
          )}
          renderItem={({ item }) => {
            const { rsvp, match } = item;

            const date = match?.startDateTime ? toDate(match.startDateTime) : null;
            const chip = getChip(match);
            const myBadge = getMyRsvpBadge(rsvp);

            const confirmed = match?.confirmedYesCount ?? 0;
            const max = match?.maxPlayers ?? 0;
            const waitlist = match?.waitlistCount ?? 0;

            const isHost = !!match?.createdBy && match.createdBy === user.uid;
            const desc = (match?.description ?? "").trim();

            const startHint = (() => {
              if (!match || !date) return null;
              if (isArchivedStatus(match.status)) return null;

              const msUntilStart = date.getTime() - Date.now();
              return msUntilStart >= 0
                ? `Starts in ${formatCountdown(msUntilStart)}`
                : "In progress / started";
            })();

            const canOpen = !!match;

            return (
              <TouchableOpacity
                style={[styles.card, !canOpen && { opacity: 0.6 }]}
                disabled={!canOpen}
                activeOpacity={0.92}
                onPress={() =>
                  router.push({
                    pathname: "/(app)/match/[matchId]",
                    params: { matchId: rsvp.matchId },
                  })
                }
              >
                <View style={styles.cardTopRow}>
                  <Text style={styles.cardTitle}>
                    {date
                      ? `${date.toLocaleDateString()} ${date.toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}`
                      : "Match unavailable"}
                  </Text>

                  <View style={styles.topRight}>
                    <View style={[styles.chip, (styles as any)[`chip_${chip.variant}`]]}>
                      <Text style={styles.chipText}>{chip.label}</Text>
                    </View>
                  </View>
                </View>

                {!!startHint && <Text style={styles.startHint}>{startHint}</Text>}

                {!!match?.locationText && (
                  <Text style={styles.location} numberOfLines={2}>
                    {match.locationText}
                  </Text>
                )}

                {!!desc && (
                  <Text style={styles.desc} numberOfLines={2}>
                    {desc}
                  </Text>
                )}

                <View style={styles.metaRow}>
                  {!!match && (
                    <Text style={styles.metaText}>
                      {confirmed}/{max || "?"} going
                    </Text>
                  )}

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
          }}
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

  // soft “pitch blobs”
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

  // Buttons (same as Matches)
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

  // Cards (same as Matches)
  card: {
    marginTop: 12,
    padding: 14,
    borderRadius: 18,
    backgroundColor: "rgba(10, 16, 25, 0.78)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
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

  startHint: { marginTop: 8, color: "rgba(255,255,255,0.65)", fontWeight: "700" },
  location: { marginTop: 6, color: "rgba(255,255,255,0.78)", fontWeight: "700" },
  desc: { marginTop: 6, color: "rgba(255,255,255,0.72)", lineHeight: 18, fontWeight: "600" },

  // Meta row (same as Matches)
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

  // Chips (same as Matches + unavailable)
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
  chip_unavailable: { backgroundColor: "rgba(255,255,255,0.08)" },

  // My RSVP badge (same as Matches)
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

  // Empty / notices (same as Matches)
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
