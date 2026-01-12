// app/(app)/(tabs)/stats.tsx
import { useRouter } from "expo-router";
import {
  collection,
  documentId,
  getDocs,
  onSnapshot,
  query,
  where,
} from "firebase/firestore";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../../src/context/AuthContext";
import { db } from "../../../src/firebaseConfig";

type RsvpStatus = "yes" | "maybe" | "no";

type Rsvp = {
  id: string;
  matchId: string;
  status: RsvpStatus;
  isWaitlisted?: boolean;
};

type MinutesDoc = {
  matchId: string;
  minutes: number;
  startAt?: any;
  updatedAt?: any;
};

type MatchMini = {
  id: string;
  status?: string;
  startDateTime?: any;
  locationText?: string;
  description?: string;
};

type Session = {
  matchId: string;
  minutes: number;
  startAtMs: number;
  source: "real" | "fallback";
};

const EST_MIN_PER_MATCH = 90;

function toMs(raw: any): number {
  if (!raw) return 0;
  if (typeof raw?.toMillis === "function") return raw.toMillis();
  if (typeof raw?.toDate === "function") return raw.toDate().getTime();
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === "number") return raw;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d.getTime() : 0;
}

function normalizeStatus(s?: string) {
  return String(s ?? "scheduled").toLowerCase();
}

function isCancelledStatus(s?: string) {
  const st = normalizeStatus(s);
  return st === "cancelled" || st === "canceled";
}

function isPlayedStatus(s?: string) {
  return normalizeStatus(s) === "played";
}

function formatShortDate(ms: number) {
  if (!ms) return "";
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatTime(ms: number) {
  if (!ms) return "";
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function startOfWeekMs(date: Date) {
  // Sunday 00:00 local
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=Sun
  d.setDate(d.getDate() - day);
  return d.getTime();
}

async function loadMatchesByIds(ids: string[]) {
  const uniq = Array.from(new Set(ids.filter(Boolean)));
  const out: Record<string, MatchMini> = {};
  if (uniq.length === 0) return out;

  const CHUNK = 10;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const slice = uniq.slice(i, i + CHUNK);
    try {
      const qy = query(collection(db, "matches"), where(documentId(), "in", slice));
      const snap = await getDocs(qy);
      snap.docs.forEach((d) => {
        out[d.id] = { id: d.id, ...(d.data() as any) };
      });
    } catch (e) {
      // If permissions prevent reading some match docs, we still keep fitness working from minutes docs.
      console.warn("stats: loadMatchesByIds chunk failed", e);
    }
  }
  return out;
}

function TogglePill({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.togglePill,
        active && styles.togglePillActive,
        pressed && { transform: [{ scale: 0.99 }] },
      ]}
    >
      <Text style={[styles.togglePillText, active && styles.togglePillTextActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

function GlassCard({ children }: { children: React.ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

export default function StatsScreen() {
  const router = useRouter();
  const { user } = useAuth();

  const [loading, setLoading] = useState(true);

  const [range, setRange] = useState<"7d" | "30d" | "all">("30d");

  const [rsvps, setRsvps] = useState<Rsvp[]>([]);
  const [minutesDocs, setMinutesDocs] = useState<MinutesDoc[]>([]);
  const [matchesById, setMatchesById] = useState<Record<string, MatchMini>>({});

  const fetchSeq = useRef(0);

  // 1) Subscribe: my RSVPs
  useEffect(() => {
    if (!user?.uid) {
      setRsvps([]);
      return;
    }

    const qy = query(collection(db, "rsvps"), where("userId", "==", user.uid));
    const unsub = onSnapshot(
      qy,
      (snap) => {
        const list: Rsvp[] = snap.docs
          .map((d) => {
            const data = d.data() as any;
            return {
              id: d.id,
              matchId: String(data.matchId ?? ""),
              status: (data.status as RsvpStatus) ?? "no",
              isWaitlisted: data.isWaitlisted ?? false,
            };
          })
          .filter((r) => !!r.matchId);
        setRsvps(list);
      },
      (err) => {
        console.warn("stats: rsvps listener error", err);
        setRsvps([]);
      }
    );

    return () => unsub();
  }, [user?.uid]);

  // 2) Subscribe: my minutes docs (real source of truth)
  useEffect(() => {
    if (!user?.uid) {
      setMinutesDocs([]);
      return;
    }

    const col = collection(db, "users", user.uid, "minutes");
    const unsub = onSnapshot(
      col,
      (snap) => {
        const list: MinutesDoc[] = snap.docs.map((d) => {
          const data = d.data() as any;
          return {
            matchId: String(data.matchId ?? d.id),
            minutes: Number(data.minutes ?? 0),
            startAt: data.startAt ?? null,
            updatedAt: data.updatedAt ?? null,
          };
        });
        setMinutesDocs(list);
      },
      (err) => {
        console.warn("stats: minutes listener error", err);
        setMinutesDocs([]);
      }
    );

    return () => unsub();
  }, [user?.uid]);

  // 3) Load match docs in batches (for statuses + location + recent sessions list)
  useEffect(() => {
    if (!user?.uid) return;

    const ids = Array.from(
      new Set([
        ...rsvps.map((r) => r.matchId),
        ...minutesDocs.map((m) => m.matchId),
      ].filter(Boolean))
    );

    const seq = ++fetchSeq.current;
    (async () => {
      setLoading(true);
      try {
        const map = await loadMatchesByIds(ids);
        if (fetchSeq.current !== seq) return;
        setMatchesById(map);
      } finally {
        if (fetchSeq.current === seq) setLoading(false);
      }
    })();
  }, [user?.uid, rsvps, minutesDocs]);

  const computed = useMemo(() => {
    const nowMs = Date.now();
    const rangeStartMs =
      range === "7d"
        ? nowMs - 7 * 24 * 60 * 60 * 1000
        : range === "30d"
        ? nowMs - 30 * 24 * 60 * 60 * 1000
        : Number.NEGATIVE_INFINITY;

    // confirmed YES RSVPs (not waitlisted)
    const yesConfirmed = rsvps.filter((r) => r.status === "yes" && !r.isWaitlisted);

    // real minutes map (existence matters even if minutes=0)
    const minutesByMatchId: Record<string, MinutesDoc> = {};
    minutesDocs.forEach((m) => {
      if (!m.matchId) return;
      minutesByMatchId[m.matchId] = m;
    });

    // sessions = real minutes (minutes>0) + fallback (played+yes confirmed, no minutes doc exists)
    const sessions: Session[] = [];

    // Real sessions
    for (const m of minutesDocs) {
      const startAtMs = toMs(m.startAt) || toMs(matchesById[m.matchId]?.startDateTime) || 0;
      const mins = Math.max(0, Number(m.minutes ?? 0));
      if (mins > 0) {
        sessions.push({ matchId: m.matchId, minutes: mins, startAtMs, source: "real" });
      }
    }

    const hasMinutesDoc = (matchId: string) => !!minutesByMatchId[matchId];

    // Fallback sessions
    for (const r of yesConfirmed) {
      const mid = r.matchId;
      if (!mid) continue;
      if (hasMinutesDoc(mid)) continue; // even a 0-minute doc means "don’t estimate"
      const match = matchesById[mid];
      if (!match) continue;
      if (!isPlayedStatus(match.status)) continue;

      const startAtMs = toMs(match.startDateTime) || 0;
      sessions.push({ matchId: mid, minutes: EST_MIN_PER_MATCH, startAtMs, source: "fallback" });
    }

    // Upcoming confirmed YES
    let upcomingYes = 0;
    let cancelledYes = 0;
    for (const r of yesConfirmed) {
      const match = matchesById[r.matchId];
      if (!match) continue;

      const st = normalizeStatus(match.status);
      const startAtMs = toMs(match.startDateTime);

      if (isCancelledStatus(st)) cancelledYes++;
      else if (st === "scheduled" && startAtMs >= nowMs) upcomingYes++;
    }

    // “matches played” + minutes in current range
    const sessionsInRange = sessions.filter((s) => s.startAtMs >= rangeStartMs);
    const minutesInRange = sessionsInRange.reduce((sum, s) => sum + s.minutes, 0);

    // last match overall (from sessions)
    const lastSession = [...sessions].sort((a, b) => b.startAtMs - a.startAtMs)[0] ?? null;

    // minutes in last 7 days (separate from range toggle)
    const weekStart = nowMs - 7 * 24 * 60 * 60 * 1000;
    const minutesLast7d = sessions
      .filter((s) => s.startAtMs >= weekStart)
      .reduce((sum, s) => sum + s.minutes, 0);

    // Last 4 weeks trend buckets (Sunday weeks)
    const thisWeekStart = startOfWeekMs(new Date(nowMs));
    const weekStarts = [
      thisWeekStart - 3 * 7 * 24 * 60 * 60 * 1000,
      thisWeekStart - 2 * 7 * 24 * 60 * 60 * 1000,
      thisWeekStart - 1 * 7 * 24 * 60 * 60 * 1000,
      thisWeekStart,
    ];

    const weekBuckets = weekStarts.map((ws) => {
      const we = ws + 7 * 24 * 60 * 60 * 1000;
      const total = sessions
        .filter((s) => s.startAtMs >= ws && s.startAtMs < we)
        .reduce((sum, s) => sum + s.minutes, 0);
      return { weekStartMs: ws, totalMinutes: total };
    });

    // Recent sessions list
    const recentSessions = [...sessions]
      .filter((s) => s.startAtMs > 0)
      .sort((a, b) => b.startAtMs - a.startAtMs)
      .slice(0, 8);

    return {
      yesTotal: yesConfirmed.length,
      upcomingYes,
      cancelledYes,
      minutesInRange,
      sessionsInRangeCount: sessionsInRange.length,
      minutesLast7d,
      lastSession,
      weekBuckets,
      recentSessions,
    };
  }, [range, rsvps, minutesDocs, matchesById]);

  if (!user?.uid) {
    return (
      <SafeAreaView style={styles.safe} edges={["left", "right", "bottom"]}>
        <View style={styles.screen}>
          <View style={styles.bg} />
          <View style={styles.pitchBlobs} />
          <View style={[styles.centerWrap, { paddingHorizontal: 18 }]}>
            <Text style={styles.heroTitle}>Fitness</Text>
            <Text style={styles.heroSub}>Sign in to see your minutes + sessions.</Text>

            <View style={[styles.card, { marginTop: 14 }]}>
              <Text style={styles.noticeTitle}>You’re not signed in.</Text>
              <Text style={styles.noticeSub}>
                Once you play matches and your host logs attendance, your stats will show up here.
              </Text>
            </View>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["left", "right", "bottom"]}>
      <View style={styles.screen}>
        <View style={styles.bg} />
        <View style={styles.pitchBlobs} />

        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.heroTitle}>Fitness</Text>
          <Text style={styles.heroSub}>
            Minutes played + sessions (real attendance when available).
          </Text>

          {/* Range toggle */}
          <View style={styles.toggleRow}>
            <TogglePill label="7d" active={range === "7d"} onPress={() => setRange("7d")} />
            <TogglePill label="30d" active={range === "30d"} onPress={() => setRange("30d")} />
            <TogglePill label="All" active={range === "all"} onPress={() => setRange("all")} />
          </View>

          {/* Main summary card */}
          <GlassCard>
            {loading ? (
              <View style={{ alignItems: "center", paddingVertical: 10 }}>
                <ActivityIndicator />
                <Text style={[styles.noticeSub, { marginTop: 10 }]}>Loading stats…</Text>
              </View>
            ) : (
              <>
                <Text style={styles.bigNumber}>{computed.minutesInRange}</Text>
                <Text style={styles.bigLabel}>Minutes ({range})</Text>

                <View style={styles.chipRow}>
                  <View style={styles.chip}>
                    <Text style={styles.chipText}>
                      {computed.sessionsInRangeCount} session
                      {computed.sessionsInRangeCount === 1 ? "" : "s"}
                    </Text>
                  </View>

                  <View style={styles.chip}>
                    <Text style={styles.chipText}>
                      {computed.yesTotal} total confirmed YES
                    </Text>
                  </View>

                  {computed.lastSession?.startAtMs ? (
                    <View style={styles.chip}>
                      <Text style={styles.chipText}>
                        Last: {formatShortDate(computed.lastSession.startAtMs)}
                      </Text>
                    </View>
                  ) : null}
                </View>

                <Text style={[styles.noticeSub, { marginTop: 10 }]}>
                  Uses real minutes from completed matches when available. If a match was marked
                  “Played” before minutes logging existed, it falls back to {EST_MIN_PER_MATCH} min
                  for confirmed YES (not waitlisted).
                </Text>
              </>
            )}
          </GlassCard>

          {/* 2x2 mini cards */}
          <View style={styles.grid}>
            <View style={styles.miniCard}>
              <Text style={styles.miniNumber}>{computed.minutesLast7d}</Text>
              <Text style={styles.miniLabel}>Minutes last 7 days</Text>
            </View>

            <View style={styles.miniCard}>
              <Text style={styles.miniNumber}>{computed.upcomingYes}</Text>
              <Text style={styles.miniLabel}>Upcoming (confirmed YES)</Text>
            </View>

            <View style={styles.miniCard}>
              <Text style={styles.miniNumber}>{computed.cancelledYes}</Text>
              <Text style={styles.miniLabel}>Cancelled you were in</Text>
            </View>

            <View style={styles.miniCard}>
              <Text style={styles.miniNumber}>{computed.yesTotal}</Text>
              <Text style={styles.miniLabel}>Total confirmed YES</Text>
            </View>
          </View>

          {/* Trend */}
          <GlassCard>
            <Text style={styles.sectionTitle}>Last 4 weeks</Text>

            <View style={styles.trendRow}>
              {(() => {
                const max = Math.max(...computed.weekBuckets.map((w) => w.totalMinutes), 1);
                return computed.weekBuckets.map((w) => {
                  const h = Math.round((w.totalMinutes / max) * 44); // 0..44
                  return (
                    <View key={String(w.weekStartMs)} style={styles.trendCol}>
                      <View style={styles.trendBarTrack}>
                        <View style={[styles.trendBarFill, { height: Math.max(3, h) }]} />
                      </View>
                      <Text style={styles.trendLabel}>{formatShortDate(w.weekStartMs)}</Text>
                      <Text style={styles.trendValue}>{w.totalMinutes}m</Text>
                    </View>
                  );
                });
              })()}
            </View>
          </GlassCard>

          {/* Recent sessions */}
          <GlassCard>
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionTitle}>Recent sessions</Text>
              <Text style={styles.sectionHint}>Tap to open match</Text>
            </View>

            {computed.recentSessions.length === 0 ? (
              <Text style={styles.noticeSub}>
                No sessions yet. After a host completes a match, your minutes will show up here.
              </Text>
            ) : (
              computed.recentSessions.map((s) => {
                const match = matchesById[s.matchId];
                const when = s.startAtMs ? `${formatShortDate(s.startAtMs)} • ${formatTime(s.startAtMs)}` : "Session";
                const whereText = (match?.locationText ?? "").trim();

                return (
                  <Pressable
                    key={`${s.matchId}_${s.startAtMs}_${s.source}`}
                    onPress={() =>
                      router.push({
                        pathname: "/(app)/match/[matchId]",
                        params: { matchId: s.matchId },
                      })
                    }
                    style={({ pressed }) => [
                      styles.sessionRow,
                      pressed && { transform: [{ scale: 0.997 }] },
                    ]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.sessionTitle}>{when}</Text>
                      {!!whereText && (
                        <Text style={styles.sessionSub} numberOfLines={1}>
                          {whereText}
                        </Text>
                      )}
                      {!whereText && (
                        <Text style={styles.sessionSub} numberOfLines={1}>
                          Match ID: {s.matchId}
                        </Text>
                      )}
                    </View>

                    <View style={styles.sessionRight}>
                      <Text style={styles.sessionMins}>{s.minutes}m</Text>
                      <Text style={styles.sessionChev}>›</Text>
                    </View>
                  </Pressable>
                );
              })
            )}
          </GlassCard>

          <View style={{ height: 24 }} />
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  // Match your app aesthetic
  safe: { flex: 1, backgroundColor: "#052b22" },
  screen: { flex: 1, backgroundColor: "#052b22" },

  bg: { ...StyleSheet.absoluteFillObject, backgroundColor: "#052b22" },
  pitchBlobs: { ...StyleSheet.absoluteFillObject, opacity: 0.35, backgroundColor: "transparent" },

  content: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 28 },

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

  centerWrap: { flex: 1, justifyContent: "center" },

  // Toggle pills
  toggleRow: { marginTop: 14, flexDirection: "row", gap: 10 },
  togglePill: {
    flex: 1,
    height: 44,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },
  togglePillActive: {
    backgroundColor: "rgba(27, 127, 90, 0.24)",
    borderColor: "rgba(27, 127, 90, 0.38)",
  },
  togglePillText: {
    color: "rgba(255,255,255,0.86)",
    fontSize: 14,
    fontWeight: "900",
  },
  togglePillTextActive: {
    color: "rgba(255,255,255,0.95)",
  },

  // Glass card
  card: {
    marginTop: 12,
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

  // Main numbers
  bigNumber: { fontSize: 46, fontWeight: "900", color: "white", letterSpacing: 0.2 },
  bigLabel: { marginTop: 2, color: "rgba(255,255,255,0.82)", fontWeight: "900" },

  chipRow: { marginTop: 12, flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  chipText: { color: "rgba(255,255,255,0.88)", fontWeight: "900", fontSize: 12 },

  // Grid mini cards
  grid: {
    marginTop: 12,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  miniCard: {
    width: "48.5%",
    borderRadius: 18,
    padding: 14,
    backgroundColor: "rgba(10, 16, 25, 0.78)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  miniNumber: { fontSize: 26, fontWeight: "900", color: "white" },
  miniLabel: {
    marginTop: 6,
    color: "rgba(255,255,255,0.70)",
    fontWeight: "800",
    lineHeight: 18,
  },

  // Trend
  sectionTitle: {
    fontSize: 16,
    fontWeight: "900",
    color: "rgba(255,255,255,0.88)",
  },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
  },
  sectionHint: { color: "rgba(255,255,255,0.55)", fontWeight: "800", fontSize: 12 },

  trendRow: {
    marginTop: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10,
  },
  trendCol: { flex: 1, alignItems: "center" },
  trendBarTrack: {
    width: "100%",
    height: 50,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    justifyContent: "flex-end",
    padding: 6,
  },
  trendBarFill: {
    width: "100%",
    borderRadius: 10,
    backgroundColor: "rgba(27, 127, 90, 0.55)",
  },
  trendLabel: { marginTop: 8, fontSize: 11, fontWeight: "900", color: "rgba(255,255,255,0.70)" },
  trendValue: { marginTop: 2, fontSize: 11, fontWeight: "900", color: "rgba(255,255,255,0.86)" },

  // Sessions list
  sessionRow: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  sessionTitle: { color: "rgba(255,255,255,0.92)", fontWeight: "900" },
  sessionSub: { marginTop: 3, color: "rgba(255,255,255,0.60)", fontWeight: "800", fontSize: 12 },
  sessionRight: { flexDirection: "row", alignItems: "center", gap: 10 },
  sessionMins: { color: "white", fontWeight: "900", fontSize: 16 },
  sessionChev: { color: "rgba(255,255,255,0.60)", fontSize: 22, fontWeight: "900" },
});
