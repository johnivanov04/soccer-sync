// app/(app)/match/complete/[matchId].tsx
import { Image } from "expo-image";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
    collection,
    doc,
    documentId,
    getDocs,
    onSnapshot,
    query,
    serverTimestamp,
    where,
    writeBatch
} from "firebase/firestore";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../../../src/context/AuthContext";
import { db } from "../../../../src/firebaseConfig";

const RSVP_STATUSES = ["yes", "maybe", "no"] as const;
type RsvpStatus = (typeof RSVP_STATUSES)[number];
type MatchStatus = "scheduled" | "played" | "cancelled" | string;

type Match = {
  id: string;
  startDateTime?: any;
  locationText?: string;
  status?: MatchStatus;
  createdBy?: string;
  description?: string;
  maxPlayers?: number;
  minPlayers?: number;
  confirmedYesCount?: number;
  waitlistCount?: number;

  completedAt?: any;
  completedBy?: string | null;
};

type Rsvp = {
  id: string;
  userId?: string;
  playerName?: string;
  status?: RsvpStatus;
  isWaitlisted?: boolean;
};

type AttendanceDoc = {
  userId: string;
  attended: boolean;
  minutes: number;
  updatedAt?: any;
};

type UserProfileMini = {
  uid: string;
  photoURL: string | null;
  displayName: string | null;
  updatedAtMs: number | null;
};

type Row = {
  uid: string;
  name: string;
  rsvpStatus: RsvpStatus | null;
  isWaitlisted: boolean;
  attended: boolean;
  minutes: number;
};

function toDate(raw: any): Date {
  if (!raw) return new Date();
  if (typeof raw?.toDate === "function") return raw.toDate();
  return new Date(raw);
}

function paramToString(v: any): string | null {
  if (!v) return null;
  if (Array.isArray(v)) return v[0] ? String(v[0]) : null;
  return String(v);
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function initialsFromName(name?: string | null) {
  const base = (name ?? "").trim();
  if (!base) return "U";
  const parts = base.split(" ").filter(Boolean);
  const first = parts[0]?.[0] ?? "U";
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] : "";
  return (first + last).toUpperCase();
}

function avatarUri(photoURL?: string | null, updatedAtMs?: number | null) {
  if (!photoURL) return null;
  const v = Number.isFinite(updatedAtMs as any) ? String(updatedAtMs) : "0";
  return photoURL.includes("?") ? `${photoURL}&v=${v}` : `${photoURL}?v=${v}`;
}

async function loadUserProfilesByUids(uids: string[]) {
  const uniq = Array.from(new Set(uids.filter(Boolean)));
  if (uniq.length === 0) return new Map<string, UserProfileMini>();

  const CHUNK = 10;
  const out = new Map<string, UserProfileMini>();

  for (let i = 0; i < uniq.length; i += CHUNK) {
    const slice = uniq.slice(i, i + CHUNK);
    const usersCol = collection(db, "publicUsers");
    const qy = query(usersCol, where(documentId(), "in", slice));
    const snap = await getDocs(qy);

    for (const d of snap.docs) {
      const data = d.data() as any;
      const updatedAtMs =
        typeof data?.updatedAt?.toMillis === "function"
          ? data.updatedAt.toMillis()
          : typeof data?.updatedAt?.toDate === "function"
          ? data.updatedAt.toDate().getTime()
          : null;

      out.set(d.id, {
        uid: d.id,
        photoURL: (data?.photoURL as string) ?? null,
        displayName: (data?.displayName as string) ?? null,
        updatedAtMs: typeof updatedAtMs === "number" ? updatedAtMs : null,
      });
    }
  }

  return out;
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

function PersonRow({
  name,
  subtitle,
  photoURL,
  updatedAtMs,
  right,
}: {
  name: string;
  subtitle?: string;
  photoURL?: string | null;
  updatedAtMs?: number | null;
  right?: React.ReactNode;
}) {
  const uri = avatarUri(photoURL, updatedAtMs);
  const initials = initialsFromName(name);

  return (
    <View style={styles.personRow}>
      <View style={styles.avatarSmWrap}>
        {uri ? (
          <Image source={{ uri }} style={styles.avatarSm} />
        ) : (
          <View style={[styles.avatarSm, styles.avatarSmFallback]}>
            <Text style={styles.avatarSmText}>{initials}</Text>
          </View>
        )}
      </View>

      <View style={{ flex: 1 }}>
        <Text style={styles.personName} numberOfLines={1}>
          {name}
        </Text>
        {!!subtitle && <Text style={styles.personSub}>{subtitle}</Text>}
      </View>

      {right}
    </View>
  );
}

function Pill({
  label,
  onPress,
  tone,
  disabled,
}: {
  label: string;
  onPress?: () => void;
  tone: "neutral" | "good" | "warn";
  disabled?: boolean;
}) {
  const Comp = onPress ? Pressable : View;
  // @ts-ignore
  return (
    <Comp
      // @ts-ignore
      onPress={onPress}
      // @ts-ignore
      disabled={!!disabled}
      style={({ pressed }: any) => [
        styles.pill,
        (styles as any)[`pill_${tone}`],
        pressed && onPress && !disabled && { transform: [{ scale: 0.99 }] },
        disabled && { opacity: 0.55 },
      ]}
    >
      <Text style={styles.pillText}>{label}</Text>
    </Comp>
  );
}

export default function CompleteMatchScreen() {
  const params = useLocalSearchParams();
  const matchId = paramToString(params?.matchId);

  const { user } = useAuth();
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [match, setMatch] = useState<Match | null>(null);
  const [rsvps, setRsvps] = useState<Rsvp[]>([]);
  const [attendanceByUid, setAttendanceByUid] = useState<Record<string, AttendanceDoc>>({});
  const [saving, setSaving] = useState(false);

  const [userProfiles, setUserProfiles] = useState<Record<string, UserProfileMini>>({});
  const didInitRowsRef = useRef(false);

  // subscribe: match + rsvps + attendance
  useEffect(() => {
    if (!matchId) return;

    setLoading(true);

    const matchRef = doc(db, "matches", matchId);
    const unsubMatch = onSnapshot(
      matchRef,
      (snap) => {
        if (snap.exists()) setMatch({ id: snap.id, ...(snap.data() as any) });
        else setMatch(null);
      },
      (err) => console.error("complete: match listener error", err)
    );

    const rsvpsCol = collection(db, "rsvps");
    const qRsvps = query(rsvpsCol, where("matchId", "==", matchId));
    const unsubRsvps = onSnapshot(
      qRsvps,
      (snap) => {
        const list: Rsvp[] = snap.docs.map((d) => {
          const data = d.data() as any;
          return {
            id: d.id,
            userId: data.userId,
            playerName: data.playerName,
            status: data.status as RsvpStatus,
            isWaitlisted: data.isWaitlisted ?? false,
          };
        });
        setRsvps(list);
      },
      (err) => console.error("complete: rsvps listener error", err)
    );

    const attCol = collection(db, "matches", matchId, "attendance");
    const unsubAtt = onSnapshot(
      attCol,
      (snap) => {
        const map: Record<string, AttendanceDoc> = {};
        snap.docs.forEach((d) => {
          const data = d.data() as any;
          map[d.id] = {
            userId: String(data.userId ?? d.id),
            attended: !!data.attended,
            minutes: Number(data.minutes ?? 0),
            updatedAt: data.updatedAt ?? null,
          };
        });
        setAttendanceByUid(map);
      },
      (err) => console.error("complete: attendance listener error", err)
    );

    const done = setTimeout(() => setLoading(false), 250);

    return () => {
      clearTimeout(done);
      unsubMatch();
      unsubRsvps();
      unsubAtt();
    };
  }, [matchId]);

  const isHost = !!user?.uid && !!match?.createdBy && match.createdBy === user.uid;

  // Candidate list = YES + MAYBE RSVPs (waitlisted included, but default attended=false for waitlisted)
  const candidateRows = useMemo(() => {
    const base = rsvps
      .filter((r) => !!r.userId)
      .filter((r) => (r.status === "yes" || r.status === "maybe") as any);

    // stable sort by name
    const copy = [...base].sort((a, b) =>
      String(a.playerName ?? a.userId ?? "").localeCompare(String(b.playerName ?? b.userId ?? ""))
    );

    // default minutes
    const DEFAULT_MIN = 90;

    const rows: Row[] = copy.map((r) => {
      const uid = String(r.userId);
      const att = attendanceByUid[uid];

      const name = String(r.playerName ?? uid);
      const status = (r.status as RsvpStatus) ?? null;
      const isWaitlisted = !!r.isWaitlisted;

      // if attendance doc exists, use it
      if (att) {
        return {
          uid,
          name,
          rsvpStatus: status,
          isWaitlisted,
          attended: !!att.attended,
          minutes: clamp(Number(att.minutes ?? 0), 0, 300),
        };
      }

      // else init defaults
      const defaultAttended = status === "yes" && !isWaitlisted;
      return {
        uid,
        name,
        rsvpStatus: status,
        isWaitlisted,
        attended: defaultAttended,
        minutes: defaultAttended ? DEFAULT_MIN : 0,
      };
    });

    return rows;
  }, [rsvps, attendanceByUid]);

  // Editable rows state (so toggling doesn't fight the snapshots)
  const [rowsByUid, setRowsByUid] = useState<Record<string, Row>>({});

  // Initialize rowsByUid once we have candidates (and also merge new people if they appear later)
  useEffect(() => {
    const incoming = candidateRows;
    if (incoming.length === 0) return;

    setRowsByUid((prev) => {
      const next = { ...prev };
      let changed = false;

      for (const r of incoming) {
        if (!next[r.uid]) {
          next[r.uid] = r;
          changed = true;
        } else if (!didInitRowsRef.current) {
          // first time: hydrate from snapshot defaults (including attendance docs)
          next[r.uid] = r;
          changed = true;
        } else if (attendanceByUid[r.uid]) {
          // if attendance docs exist, prefer them (host might open on a second device)
          const att = attendanceByUid[r.uid];
          next[r.uid] = {
            ...next[r.uid],
            attended: !!att.attended,
            minutes: clamp(Number(att.minutes ?? 0), 0, 300),
            isWaitlisted: r.isWaitlisted,
            rsvpStatus: r.rsvpStatus,
            name: r.name,
          };
          changed = true;
        } else {
          // keep local edits, but refresh name/status flags
          next[r.uid] = {
            ...next[r.uid],
            name: r.name,
            rsvpStatus: r.rsvpStatus,
            isWaitlisted: r.isWaitlisted,
          };
        }
      }

      didInitRowsRef.current = true;
      return changed ? next : prev;
    });
  }, [candidateRows, attendanceByUid]);

  // Load user profiles for avatars
  useEffect(() => {
    const uids = Object.keys(rowsByUid);
    if (uids.length === 0) return;

    let cancelled = false;

    (async () => {
      try {
        const map = await loadUserProfilesByUids(uids);
        if (cancelled) return;

        const obj: Record<string, UserProfileMini> = {};
        map.forEach((v, k) => (obj[k] = v));
        setUserProfiles((prev) => ({ ...prev, ...obj }));
      } catch (e) {
        console.warn("complete: failed to load user profiles", e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [Object.keys(rowsByUid).join("|")]);

  const rows = useMemo(() => {
    return Object.values(rowsByUid).sort((a, b) => a.name.localeCompare(b.name));
  }, [rowsByUid]);

  const matchTitle = useMemo(() => {
    const d = match?.startDateTime ? toDate(match.startDateTime) : null;
    if (!d) return "Complete match";
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  }, [match?.startDateTime]);

  const statusLabel = String(match?.status ?? "scheduled").toLowerCase();
  const isCancelled = statusLabel === "cancelled" || statusLabel === "canceled";

  const goingCount = rows.filter((r) => r.attended && r.minutes > 0).length;
  const totalMinutes = rows.reduce((sum, r) => sum + (r.attended ? r.minutes : 0), 0);

  const setRow = (uid: string, patch: Partial<Row>) => {
    setRowsByUid((prev) => {
      const cur = prev[uid];
      if (!cur) return prev;
      return { ...prev, [uid]: { ...cur, ...patch } };
    });
  };

  const toggleAttended = (uid: string) => {
    const cur = rowsByUid[uid];
    if (!cur) return;
    const nextAttended = !cur.attended;

    setRow(uid, {
      attended: nextAttended,
      minutes: nextAttended ? Math.max(cur.minutes || 90, 10) : 0,
    });
  };

  const bumpMinutes = (uid: string, delta: number) => {
    const cur = rowsByUid[uid];
    if (!cur) return;
    const next = clamp((cur.minutes ?? 0) + delta, 0, 300);
    setRow(uid, { minutes: next, attended: next > 0 });
  };

  const applyMinutesToAllAttended = (minutes: number) => {
    setRowsByUid((prev) => {
      const next = { ...prev };
      Object.keys(next).forEach((uid) => {
        if (next[uid].attended) next[uid] = { ...next[uid], minutes };
      });
      return next;
    });
  };

  const handleSave = async () => {
    if (!user?.uid || !matchId || !match) return;
    if (!isHost) {
      Alert.alert("Not allowed", "Only the host can complete this match.");
      return;
    }
    if (isCancelled) {
      Alert.alert("Match cancelled", "You can’t complete a cancelled match.");
      return;
    }

    const anyAttended = rows.some((r) => r.attended && r.minutes > 0);
    if (!anyAttended) {
      Alert.alert("No attendees", "Mark at least one person as attended with minutes.");
      return;
    }

    try {
      setSaving(true);

      const batch = writeBatch(db);

      // 1) mark match as played + completed
      const matchRef = doc(db, "matches", matchId);
      batch.update(matchRef, {
        status: "played",
        completedAt: serverTimestamp(),
        completedBy: user.uid,
        updatedAt: serverTimestamp(),
      });

      const startAt = match.startDateTime ?? serverTimestamp();

      // 2) attendance + minutes logs
      for (const r of rows) {
        const uid = r.uid;

        const attRef = doc(db, "matches", matchId, "attendance", uid);
        batch.set(
          attRef,
          {
            userId: uid,
            attended: !!r.attended,
            minutes: r.attended ? Number(r.minutes ?? 0) : 0,
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );

        const minutesRef = doc(db, "users", uid, "minutes", matchId);

        if (r.attended && (r.minutes ?? 0) > 0) {
          batch.set(
            minutesRef,
            {
              matchId,
              minutes: Number(r.minutes),
              startAt,
              // optional useful metadata for stats screens / filtering
              // teamId: match.teamId ?? null,
              updatedAt: serverTimestamp(),
            },
            { merge: true }
          );
        } else {
          // If they were previously marked attended, clearing should remove the minutes log
          batch.delete(minutesRef);
        }
      }

      await batch.commit();

      Alert.alert("Saved ✅", "Attendance + minutes updated.");
      router.back();
    } catch (e) {
      console.error("complete: save error", e);
      Alert.alert("Error", "Could not save attendance right now.");
    } finally {
      setSaving(false);
    }
  };

  if (!matchId) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.screen}>
          <View style={styles.bg} />
          <View style={styles.pitchLines} />
          <View style={[styles.glassNotice, { margin: 18 }]}>
            <Text style={styles.noticeTitle}>Missing match id.</Text>
            <Text style={styles.noticeSub}>Go back and try again.</Text>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (loading || !match) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.screen}>
          <View style={styles.bg} />
          <View style={styles.pitchLines} />
          <View style={[styles.glassNotice, { margin: 18 }]}>
            <Text style={styles.noticeTitle}>Loading…</Text>
            <Text style={styles.noticeSub}>Preparing attendance.</Text>
            <View style={{ marginTop: 14 }}>
              <ActivityIndicator />
            </View>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (!isHost) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.screen}>
          <View style={styles.bg} />
          <View style={styles.pitchLines} />
          <View style={[styles.glassNotice, { margin: 18 }]}>
            <Text style={styles.noticeTitle}>Host only</Text>
            <Text style={styles.noticeSub}>Only the host can complete a match.</Text>
            <View style={{ marginTop: 12 }}>
              <SecondaryButton title="Back" onPress={() => router.back()} />
            </View>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.screen}>
        <View style={styles.bg} />
        <View style={styles.pitchLines} />

        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          <Text style={styles.heroTitle}>Complete match</Text>
          <Text style={styles.heroSub}>{matchTitle}</Text>

          {isCancelled && (
            <View style={[styles.glassNotice, { marginTop: 14 }]}>
              <Text style={styles.noticeTitle}>This match is cancelled.</Text>
              <Text style={styles.noticeSub}>You can’t complete a cancelled match.</Text>
            </View>
          )}

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Quick tools</Text>
            <View style={styles.quickRow}>
              <Pill
                tone="neutral"
                label="Set all attended → 60m"
                onPress={() => applyMinutesToAllAttended(60)}
                disabled={saving}
              />
              <Pill
                tone="neutral"
                label="Set all attended → 90m"
                onPress={() => applyMinutesToAllAttended(90)}
                disabled={saving}
              />
            </View>

            <Text style={[styles.noticeSub, { marginTop: 10 }]}>
              Tip: tap a player row to toggle attended. Use +/- to adjust minutes.
            </Text>
          </View>

          <View style={styles.card}>
            <View style={styles.summaryRow}>
              <Text style={styles.sectionTitle}>Attendance</Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Pill tone="good" label={`${goingCount} attended`} />
                <Pill tone="warn" label={`${totalMinutes} min`} />
              </View>
            </View>

            {rows.length === 0 ? (
              <Text style={styles.bodyMuted}>
                No YES/MAYBE RSVPs found. (If someone didn’t RSVP, they won’t appear here yet.)
              </Text>
            ) : (
              rows.map((r) => {
                const prof = userProfiles[r.uid];
                const right = (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Pill
                      tone={r.attended ? "good" : "neutral"}
                      label={r.attended ? "Attended" : "No show"}
                      onPress={() => toggleAttended(r.uid)}
                      disabled={saving}
                    />
                    <View style={styles.minsBox}>
                      <Pressable
                        onPress={() => bumpMinutes(r.uid, -10)}
                        disabled={saving}
                        style={({ pressed }) => [
                          styles.minsBtn,
                          pressed && !saving && { transform: [{ scale: 0.98 }] },
                        ]}
                      >
                        <Text style={styles.minsBtnText}>-</Text>
                      </Pressable>

                      <Text style={styles.minsText}>{r.attended ? r.minutes : 0}m</Text>

                      <Pressable
                        onPress={() => bumpMinutes(r.uid, +10)}
                        disabled={saving}
                        style={({ pressed }) => [
                          styles.minsBtn,
                          pressed && !saving && { transform: [{ scale: 0.98 }] },
                        ]}
                      >
                        <Text style={styles.minsBtnText}>+</Text>
                      </Pressable>
                    </View>
                  </View>
                );

                const subtitleParts: string[] = [];
                if (r.rsvpStatus === "yes") subtitleParts.push(r.isWaitlisted ? "YES (waitlisted)" : "YES");
                else if (r.rsvpStatus === "maybe") subtitleParts.push("MAYBE");
                if (r.uid === match.createdBy) subtitleParts.push("Host");
                const subtitle = subtitleParts.join(" • ");

                return (
                  <Pressable
                    key={r.uid}
                    onPress={() => toggleAttended(r.uid)}
                    disabled={saving}
                    style={({ pressed }) => [
                      { marginTop: 10 },
                      pressed && !saving && { transform: [{ scale: 0.997 }] },
                    ]}
                  >
                    <PersonRow
                      name={String(prof?.displayName ?? r.name)}
                      subtitle={subtitle}
                      photoURL={prof?.photoURL ?? null}
                      updatedAtMs={prof?.updatedAtMs ?? null}
                      right={right}
                    />
                  </Pressable>
                );
              })
            )}
          </View>

          <View style={{ marginTop: 12 }}>
            <PrimaryButton title={saving ? "Saving…" : "Save & mark played"} onPress={handleSave} disabled={saving || isCancelled} />
            <View style={{ marginTop: 10 }}>
              <SecondaryButton title="Back" onPress={() => router.back()} disabled={saving} />
            </View>
          </View>

          <View style={{ height: 22 }} />
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#052b22" },
  screen: { flex: 1, backgroundColor: "#052b22" },

  bg: { ...StyleSheet.absoluteFillObject, backgroundColor: "#052b22" },
  pitchLines: { ...StyleSheet.absoluteFillObject, opacity: 0.32, backgroundColor: "transparent" },

  scrollContent: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 26 },

  heroTitle: { fontSize: 44, fontWeight: "900", color: "white", letterSpacing: 0.2 },
  heroSub: {
    marginTop: 6,
    fontSize: 16,
    fontWeight: "700",
    color: "rgba(255,255,255,0.70)",
    lineHeight: 20,
  },

  card: {
    marginTop: 12,
    padding: 14,
    borderRadius: 18,
    backgroundColor: "rgba(10, 16, 25, 0.78)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },

  sectionTitle: { fontSize: 18, fontWeight: "900", color: "rgba(255,255,255,0.92)" },
  bodyMuted: { marginTop: 10, color: "rgba(255,255,255,0.60)", fontWeight: "800" },

  glassNotice: {
    borderRadius: 22,
    padding: 18,
    backgroundColor: "rgba(10, 16, 25, 0.78)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  noticeTitle: { fontSize: 18, fontWeight: "900", color: "rgba(255,255,255,0.92)" },
  noticeSub: {
    marginTop: 6,
    color: "rgba(255,255,255,0.70)",
    fontWeight: "700",
    lineHeight: 18,
  },

  summaryRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },

  quickRow: { marginTop: 10, flexDirection: "row", gap: 10, flexWrap: "wrap" },

  pill: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  pillText: { fontSize: 12, fontWeight: "900", color: "rgba(255,255,255,0.92)" },
  pill_neutral: { backgroundColor: "rgba(255,255,255,0.08)" },
  pill_good: { backgroundColor: "rgba(27, 127, 90, 0.25)" },
  pill_warn: { backgroundColor: "rgba(255, 231, 184, 0.20)" },

  personRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  avatarSmWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
  },
  avatarSm: { width: 36, height: 36, borderRadius: 18 },
  avatarSmFallback: { alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.10)" },
  avatarSmText: { fontWeight: "900", color: "rgba(255,255,255,0.85)", fontSize: 12 },
  personName: { fontSize: 14, fontWeight: "900", color: "rgba(255,255,255,0.92)" },
  personSub: { marginTop: 2, fontSize: 12, color: "rgba(255,255,255,0.60)", fontWeight: "800" },

  minsBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  minsBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.10)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  minsBtnText: { color: "rgba(255,255,255,0.92)", fontWeight: "900", fontSize: 16 },
  minsText: { color: "rgba(255,255,255,0.92)", fontWeight: "900" },

  primaryBtn: {
    height: 54,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1b7f5a",
  },
  primaryBtnDisabled: { opacity: 0.55 },
  primaryBtnText: { color: "#04130f", fontSize: 18, fontWeight: "900" },

  secondaryBtn: {
    height: 54,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.10)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },
  secondaryBtnText: { color: "rgba(255,255,255,0.92)", fontSize: 17, fontWeight: "900" },
});
