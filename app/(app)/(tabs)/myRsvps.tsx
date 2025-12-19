// app/(app)/(tabs)/myRsvps.tsx
import { useRouter } from "expo-router";
import {
    collection,
    doc,
    onSnapshot,
    query,
    where,
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
import { useAuth } from "../../../src/context/AuthContext";
import { db } from "../../../src/firebaseConfig";

const RSVP_STATUSES = ["yes", "maybe", "no"] as const;
type RsvpStatus = (typeof RSVP_STATUSES)[number];

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

function getMatchChip(match: Match | null) {
  if (!match) return { label: "Unavailable", variant: "unavailable" as const };

  const status = normalizeStatus(match.status);
  if (status === "cancelled" || status === "canceled")
    return { label: "Cancelled", variant: "cancelled" as const };
  if (status === "played") return { label: "Played", variant: "played" as const };

  if (match.rsvpDeadline) {
    const deadline = toDate(match.rsvpDeadline);
    if (Date.now() > deadline.getTime())
      return { label: "RSVP closed", variant: "closed" as const };
  }

  const confirmed = match.confirmedYesCount ?? 0;
  const max = match.maxPlayers ?? 0;
  if (max > 0 && confirmed >= max) return { label: "Full", variant: "full" as const };

  return { label: "Scheduled", variant: "scheduled" as const };
}

function getMyChip(r: MyRsvp) {
  if (r.status === "yes") {
    return r.isWaitlisted
      ? { label: "Waitlist", variant: "waitlist" as const }
      : { label: "Confirmed", variant: "confirmed" as const };
  }
  if (r.status === "maybe") return { label: "Maybe", variant: "maybe" as const };
  return { label: "No", variant: "no" as const };
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

    const q = query(collection(db, "rsvps"), where("userId", "==", user.uid));

    const unsub = onSnapshot(
      q,
      (snapshot) => {
        const list: MyRsvp[] = snapshot.docs
          .map((d) => {
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
          .filter((r) => !!r.matchId && r.userId === user.uid);

        setRsvps(list);
        setLoading(false);
      },
      (err) => {
        console.error("My RSVPs subscription error", err);
        setErrorText("Could not load your RSVPs (permissions).");
        setRsvps([]);
        setLoading(false);
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

  // 2) Subscribe to each match doc individually (avoids "in" query being denied by one bad id)
  const matchUnsubsRef = useRef<Record<string, () => void>>({});

  useEffect(() => {
    // stop any previous listeners
    Object.values(matchUnsubsRef.current).forEach((u) => u());
    matchUnsubsRef.current = {};

    if (!matchIds.length) {
      setMatchesById({});
      return;
    }

    // prune cache to only current ids
    setMatchesById((prev) => {
      const keep = new Set(matchIds);
      const next: Record<string, Match | null> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (keep.has(k)) next[k] = v;
      }
      return next;
    });

    // start listeners
    matchIds.forEach((id) => {
      const matchRef = doc(db, "matches", id);

      const unsub = onSnapshot(
        matchRef,
        (snap) => {
          setMatchesById((prev) => {
            const next = { ...prev };
            if (snap.exists()) next[id] = { id: snap.id, ...(snap.data() as any) };
            else next[id] = null; // deleted / missing
            return next;
          });
        },
        (err) => {
          // If this specific match is not readable, don't kill the whole screen
          console.error("My RSVPs match doc listener error", id, err);
          setMatchesById((prev) => ({ ...prev, [id]: null }));
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

      const startMs = match?.startDateTime ? toDate(match.startDateTime).getTime() : Number.POSITIVE_INFINITY;
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

  if (!user?.uid) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>My RSVPs</Text>
        <Text style={{ marginTop: 8 }}>Please sign in to view your RSVPs.</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>My RSVPs</Text>
        <View style={{ marginTop: 16 }}>
          <ActivityIndicator />
        </View>
      </View>
    );
  }

  if (errorText) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>My RSVPs</Text>
        <Text style={{ marginTop: 12, color: "#a00" }}>{errorText}</Text>
      </View>
    );
  }

  if (!rsvps.length) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>My RSVPs</Text>
        <Text style={{ marginTop: 12, color: "#555" }}>
          No RSVPs yet. Go to Matches and tap YES/MAYBE/NO on a match.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>My RSVPs</Text>

      <SectionList
        sections={sections}
        keyExtractor={(item) => item.rsvp.id}
        contentContainerStyle={{ paddingVertical: 12 }}
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionHeader}>{section.title}</Text>
        )}
        renderItem={({ item }) => {
          const { rsvp, match } = item;
          const myChip = getMyChip(rsvp);
          const matchChip = getMatchChip(match);

          const date = match?.startDateTime ? toDate(match.startDateTime) : null;
          const confirmed = match?.confirmedYesCount ?? 0;
          const max = match?.maxPlayers ?? 0;
          const waitlist = match?.waitlistCount ?? 0;

          const isHost = !!match?.createdBy && match.createdBy === user.uid;

          const canOpen = !!match;

          return (
            <TouchableOpacity
              style={[styles.card, !canOpen && { opacity: 0.6 }]}
              disabled={!canOpen}
              onPress={() =>
                router.push({
                  pathname: "/(app)/match/[matchId]",
                  params: { matchId: rsvp.matchId },
                })
              }
            >
              <View style={styles.cardTopRow}>
                <Text style={styles.cardTitle} numberOfLines={1}>
                  {date
                    ? `${date.toLocaleDateString()} ${date.toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}`
                    : "Match unavailable"}
                </Text>

                <View style={[styles.chip, (styles as any)[`chip_${matchChip.variant}`]]}>
                  <Text style={styles.chipText}>{matchChip.label}</Text>
                </View>
              </View>

              {!!match?.locationText && (
                <Text style={styles.location} numberOfLines={2}>
                  {match.locationText}
                </Text>
              )}

              {!!match?.description?.trim() && (
                <Text style={styles.description} numberOfLines={2}>
                  {match.description.trim()}
                </Text>
              )}

              <View style={styles.metaRow}>
                <View style={[styles.chip, (styles as any)[`chip_${myChip.variant}`]]}>
                  <Text style={styles.chipText}>
                    {myChip.label}
                    {myChip.variant === "confirmed" ? " ✅" : ""}
                  </Text>
                </View>

                {!!match && (
                  <>
                    <Text style={styles.subtitle}>
                      {confirmed}/{max || "?"} going
                    </Text>

                    {waitlist > 0 && (
                      <Text style={styles.waitlistText}>⏳ {waitlist} waitlist</Text>
                    )}

                    {isHost && <Text style={styles.hostBadge}>👑 Host</Text>}
                  </>
                )}
              </View>
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  title: { fontSize: 18, fontWeight: "700" },

  sectionHeader: {
    marginTop: 14,
    marginBottom: 8,
    fontSize: 14,
    fontWeight: "700",
    color: "#333",
  },

  card: {
    padding: 12,
    marginBottom: 10,
    borderRadius: 10,
    borderColor: "#ddd",
    borderWidth: 1,
  },

  cardTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },

  cardTitle: { fontWeight: "bold", flex: 1 },
  location: { marginTop: 6, color: "#555" },
  description: { marginTop: 4, color: "#666" },

  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 10,
    flexWrap: "wrap",
  },

  subtitle: { color: "#777" },
  waitlistText: { color: "#7a4d00" },

  hostBadge: {
    backgroundColor: "#FFF3CD",
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 999,
    fontSize: 12,
    fontWeight: "600",
  },

  chip: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
  },
  chipText: { fontSize: 12, fontWeight: "700" },

  chip_confirmed: { backgroundColor: "#DFF7E3" },
  chip_waitlist: { backgroundColor: "#FFE7B8" },
  chip_maybe: { backgroundColor: "#E9E3FF" },
  chip_no: { backgroundColor: "#F2F2F2" },

  chip_played: { backgroundColor: "#E6F4FF" },
  chip_cancelled: { backgroundColor: "#F2F2F2" },
  chip_closed: { backgroundColor: "#E9E3FF" },
  chip_full: { backgroundColor: "#FFE7B8" },
  chip_scheduled: { backgroundColor: "#EDEDED" },
  chip_unavailable: { backgroundColor: "#F2F2F2" },
});
