// app/(app)/match/[matchId].tsx
import { Image } from "expo-image";
import * as ExpoLinking from "expo-linking";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  collection,
  deleteDoc,
  doc,
  documentId,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../../src/context/AuthContext";
import { db } from "../../../src/firebaseConfig";
import { addMatchToCalendar } from "../../../src/utils/calendarExport";

const RSVP_STATUSES = ["yes", "maybe", "no"] as const;
type RsvpStatus = (typeof RSVP_STATUSES)[number];

type MatchStatus = "scheduled" | "played" | "cancelled" | string;

type Match = {
  id: string;
  startDateTime?: any;
  locationText?: string;
  maxPlayers?: number;
  status?: MatchStatus;
  createdBy?: string;
  rsvpDeadline?: any;
  description?: string;

  // maintained by Cloud Function
  confirmedYesCount?: number;
  waitlistCount?: number;
};

type Rsvp = {
  id: string;
  userId?: string;
  playerName?: string;
  status?: RsvpStatus;
  isWaitlisted?: boolean;
  updatedAt?: any;
};

type UserProfileMini = {
  uid: string;
  photoURL: string | null;
  displayName: string | null;
  updatedAtMs: number | null; // used only for cache-busting
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

function formatCountdown(ms: number) {
  if (!Number.isFinite(ms)) return "";
  const sign = ms < 0 ? -1 : 1;
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

  return (sign < 0 ? "-" : "") + parts.join(" ");
}

async function openInMaps(queryText: string) {
  const q = encodeURIComponent(queryText);

  const url =
    Platform.OS === "ios"
      ? `http://maps.apple.com/?q=${q}`
      : `https://www.google.com/maps/search/?api=1&query=${q}`;

  const can = await Linking.canOpenURL(url);
  if (!can) {
    Alert.alert("Couldn’t open Maps");
    return;
  }
  await Linking.openURL(url);
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

function PersonRow({
  name,
  subtitle,
  photoURL,
  updatedAtMs,
  highlight,
}: {
  name: string;
  subtitle?: string;
  photoURL?: string | null;
  updatedAtMs?: number | null;
  highlight?: boolean;
}) {
  const uri = avatarUri(photoURL, updatedAtMs);
  const initials = initialsFromName(name);

  return (
    <View style={[styles.personRow, highlight && styles.personRowHighlight]}>
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
    </View>
  );
}

async function loadUserProfilesByUids(uids: string[]) {
  const uniq = Array.from(new Set(uids.filter(Boolean)));
  if (uniq.length === 0) return new Map<string, UserProfileMini>();

  // Firestore "in" query supports up to 10 items
  const CHUNK = 10;
  const out = new Map<string, UserProfileMini>();

  for (let i = 0; i < uniq.length; i += CHUNK) {
    const slice = uniq.slice(i, i + CHUNK);
    const usersCol = collection(db, "users");
    const q = query(usersCol, where(documentId(), "in", slice));
    const snap = await getDocs(q);

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

function Chip({
  label,
  variant,
}: {
  label: string;
  variant: "neutral" | "good" | "warn" | "bad";
}) {
  return (
    <View style={[styles.chip, (styles as any)[`chip_${variant}`]]}>
      <Text style={styles.chipText}>{label}</Text>
    </View>
  );
}

function ActionRow({
  icon,
  title,
  subtitle,
  onPress,
  disabled,
  destructive,
}: {
  icon: string;
  title: string;
  subtitle?: string;
  onPress: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.actionRow,
        destructive && styles.actionRowDestructive,
        disabled && { opacity: 0.55 },
        pressed && !disabled && { transform: [{ scale: 0.997 }] },
      ]}
    >
      <Text style={styles.actionIcon}>{icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={[styles.actionTitle, destructive && styles.actionTitleDestructive]}>
          {title}
        </Text>
        {!!subtitle && <Text style={styles.actionSub}>{subtitle}</Text>}
      </View>
      <Text style={styles.actionChev}>›</Text>
    </Pressable>
  );
}

function RsvpPill({
  label,
  active,
  disabled,
  onPress,
  tone,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onPress: () => void;
  tone: "yes" | "maybe" | "no";
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.rsvpPill,
        (styles as any)[`rsvpPill_${tone}`],
        active && styles.rsvpPillActive,
        disabled && { opacity: 0.45 },
        pressed && !disabled && { transform: [{ scale: 0.99 }] },
      ]}
    >
      <Text style={styles.rsvpPillText}>{label}</Text>
    </Pressable>
  );
}

export default function MatchDetailScreen() {
  const params = useLocalSearchParams();
  const matchIdStr = paramToString(params?.matchId);

  const { user } = useAuth();
  const router = useRouter();

  const [match, setMatch] = useState<Match | null>(null);
  const [rsvps, setRsvps] = useState<Rsvp[]>([]);
  const [userStatus, setUserStatus] = useState<RsvpStatus | null>(null);
  const [loadingMatch, setLoadingMatch] = useState(true);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const [exportingCalendar, setExportingCalendar] = useState(false);
  const [savingRsvp, setSavingRsvp] = useState(false);

  const [nowTick, setNowTick] = useState(Date.now());
  const prevWaitlistedRef = useRef<boolean | null>(null);

  // ✅ Option A: user profile map for avatars
  const [userProfiles, setUserProfiles] = useState<Record<string, UserProfileMini>>({});

  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Live subscribe: match + RSVPs
  useEffect(() => {
    if (!matchIdStr) return;

    setPermissionDenied(false);
    setLoadingMatch(true);

    const matchRef = doc(db, "matches", matchIdStr);
    const unsubMatch = onSnapshot(
      matchRef,
      (snap) => {
        setPermissionDenied(false);
        if (snap.exists()) setMatch({ id: snap.id, ...(snap.data() as any) });
        else setMatch(null);
        setLoadingMatch(false);
      },
      (err: any) => {
        console.error("Error listening to match", err);
        const code = String(err?.code ?? "");
        if (code.includes("permission-denied")) setPermissionDenied(true);
        setMatch(null);
        setLoadingMatch(false);
      }
    );

    const rsvpsCol = collection(db, "rsvps");
    const q = query(rsvpsCol, where("matchId", "==", matchIdStr));

    const unsubRsvps = onSnapshot(
      q,
      (snapshot) => {
        const list: Rsvp[] = snapshot.docs.map((d) => {
          const data = d.data() as any;
          return {
            id: d.id,
            userId: data.userId,
            playerName: data.playerName,
            status: data.status as RsvpStatus,
            isWaitlisted: data.isWaitlisted ?? false,
            updatedAt: data.updatedAt,
          };
        });

        setRsvps(list);

        if (user?.uid) {
          const mine = list.find((r) => r.userId === user.uid);
          setUserStatus((mine?.status as RsvpStatus | undefined) ?? null);

          const nowWaitlisted =
            (mine?.status === "yes" && (mine?.isWaitlisted ?? false)) ?? false;

          if (prevWaitlistedRef.current !== null) {
            if (
              prevWaitlistedRef.current === true &&
              nowWaitlisted === false &&
              mine?.status === "yes"
            ) {
              Alert.alert(
                "You’re in! ✅",
                "A spot opened up — you’re now confirmed for the match."
              );
            }
          }

          prevWaitlistedRef.current = nowWaitlisted;
        }
      },
      (err) => console.error("RSVP listener error", err)
    );

    return () => {
      unsubMatch();
      unsubRsvps();
    };
  }, [matchIdStr, user?.uid]);

  // ✅ Whenever RSVP list changes, load the relevant user docs (Option A)
  useEffect(() => {
    const uids = rsvps.map((r) => r.userId).filter(Boolean) as string[];
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
        console.warn("Failed to load user profiles for avatars", e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [rsvps]);

  const isHost = useMemo(() => {
    return !!user?.uid && !!match?.createdBy && match.createdBy === user.uid;
  }, [user?.uid, match?.createdBy]);

  const statusLabel = String(match?.status ?? "scheduled").toLowerCase();
  const isCancelled = statusLabel === "cancelled" || statusLabel === "canceled";
  const isPlayed = statusLabel === "played";

  const startAt = useMemo(() => toDate(match?.startDateTime), [match?.startDateTime]);
  const deadlineAt = useMemo(
    () => (match?.rsvpDeadline ? toDate(match.rsvpDeadline) : null),
    [match?.rsvpDeadline]
  );

  const isRsvpClosed = useMemo(() => {
    if (!deadlineAt) return false;
    return nowTick > deadlineAt.getTime();
  }, [deadlineAt, nowTick]);

  const rsvpDisabledReason = isCancelled
    ? "Match cancelled"
    : isPlayed
    ? "Match already played"
    : isRsvpClosed
    ? "RSVP closed"
    : null;

  const going = useMemo(
    () => rsvps.filter((r) => r.status === "yes" && !r.isWaitlisted),
    [rsvps]
  );
  const waitlist = useMemo(
    () => rsvps.filter((r) => r.status === "yes" && r.isWaitlisted),
    [rsvps]
  );

  const goingSorted = useMemo(() => {
    const copy = [...going];
    copy.sort((a, b) =>
      String(a.playerName ?? a.userId ?? "").localeCompare(String(b.playerName ?? b.userId ?? ""))
    );
    return copy;
  }, [going]);

  const waitlistSorted = useMemo(() => {
    const copy = [...waitlist];
    copy.sort((a, b) =>
      String(a.playerName ?? a.userId ?? "").localeCompare(String(b.playerName ?? b.userId ?? ""))
    );
    return copy;
  }, [waitlist]);

  const myRsvp = useMemo(() => rsvps.find((r) => r.userId === user?.uid), [rsvps, user?.uid]);
  const userWaitlisted = myRsvp?.isWaitlisted ?? false;

  const maxPlayers = Number(match?.maxPlayers ?? 0);
  const spotsLeft = useMemo(() => {
    if (!maxPlayers) return null;
    return clamp(maxPlayers - going.length, 0, maxPlayers);
  }, [maxPlayers, going.length]);

  const startMs = startAt.getTime() - nowTick;
  const deadlineMs = deadlineAt ? deadlineAt.getTime() - nowTick : null;

  const startLabel =
    startMs >= 0
      ? `Starts in ${formatCountdown(startMs)}`
      : `Started ${formatCountdown(-startMs)} ago`;

  const rsvpLabel = deadlineAt
    ? deadlineMs !== null && deadlineMs >= 0
      ? `RSVP closes in ${formatCountdown(deadlineMs)}`
      : `RSVP closed (${deadlineAt.toLocaleString()})`
    : "No RSVP deadline";

  const statusText =
    statusLabel === "played" ? "Played" : isCancelled ? "Cancelled" : "Scheduled";

  const handleOpenChat = () => {
    if (!matchIdStr) return;
    router.push({
      pathname: "/(app)/match/chat/[matchId]",
      params: { matchId: String(matchIdStr) },
    });
  };

  const handleShareMatch = async () => {
    if (!matchIdStr) return;

    const url = ExpoLinking.createURL(`/match/${String(matchIdStr)}`);

    const when = match?.startDateTime
      ? `${startAt.toLocaleDateString()} ${startAt.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}`
      : "Pickup Soccer";

    const loc = match?.locationText?.trim() ? `\n📍 ${match.locationText.trim()}` : "";
    const msg = `⚽ ${when}${loc}\n\nOpen this match in the app:\n${url}`;

    try {
      await Share.share(
        Platform.OS === "ios"
          ? { message: msg, url }
          : { message: msg }
      );
    } catch (e) {
      console.warn("share failed", e);
      Alert.alert("Couldn’t share link");
    }
  };

  const handleRsvp = async (status: RsvpStatus) => {
    if (!user || !matchIdStr) return;

    if (rsvpDisabledReason && status !== "no") {
      Alert.alert(rsvpDisabledReason);
      return;
    }

    const rsvpId = `${matchIdStr}_${user.uid}`;

    try {
      setSavingRsvp(true);

      const matchRef = doc(db, "matches", matchIdStr);
      const matchSnap = await getDoc(matchRef);

      if (!matchSnap.exists()) {
        Alert.alert("Match not found");
        return;
      }

      const matchData = matchSnap.data() as any;
      const maxPlayersFresh: number = Number(matchData.maxPlayers ?? 0);
      const matchStatus = String(matchData.status ?? "scheduled").toLowerCase();

      if ((matchStatus === "cancelled" || matchStatus === "canceled") && status !== "no") {
        Alert.alert("Match cancelled", "You can’t RSVP YES/MAYBE for a cancelled match.");
        return;
      }
      if (matchStatus === "played" && status !== "no") {
        Alert.alert("Match already played", "This match is finished.");
        return;
      }

      if (matchData.rsvpDeadline) {
        const deadline = toDate(matchData.rsvpDeadline);
        if (new Date() > deadline && status !== "no") {
          Alert.alert(
            "RSVP closed",
            "The RSVP deadline has passed. You can still leave the match (set NO), but you can’t RSVP YES/MAYBE."
          );
          return;
        }
      }

      let isWaitlisted = false;
      if (status === "yes" && maxPlayersFresh > 0) {
        const confirmedFromMatch = Number(matchData.confirmedYesCount);
        const localConfirmed = rsvps.filter((r) => r.status === "yes" && !r.isWaitlisted).length;
        const confirmed = Number.isFinite(confirmedFromMatch) ? confirmedFromMatch : localConfirmed;
        isWaitlisted = confirmed >= maxPlayersFresh;
      }

      if (status === "no") isWaitlisted = false;

      let playerName = user.email ?? user.uid;
      try {
        const userDocRef = doc(db, "users", user.uid);
        const userSnap = await getDoc(userDocRef);
        if (userSnap.exists()) {
          const data = userSnap.data() as any;
          if (data?.displayName) playerName = data.displayName;
        }
      } catch {}

      const rsvpRef = doc(db, "rsvps", rsvpId);
      await setDoc(
        rsvpRef,
        {
          matchId: matchIdStr,
          userId: user.uid,
          playerName,
          status,
          isWaitlisted,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      setUserStatus(status);

      if (status === "yes" && isWaitlisted) {
        Alert.alert(
          "You’re on the waitlist",
          "This match is already full. If someone drops, you’ll move into a confirmed spot."
        );
      }
    } catch (e) {
      console.error("RSVP error:", e);
      Alert.alert("Error", "Could not update RSVP right now.");
    } finally {
      setSavingRsvp(false);
    }
  };

  const removeRsvpDoc = async () => {
    if (!user || !matchIdStr) return;

    const rsvpId = `${matchIdStr}_${user.uid}`;
    const rsvpRef = doc(db, "rsvps", rsvpId);

    try {
      setSavingRsvp(true);
      await deleteDoc(rsvpRef);
      setUserStatus(null);
      prevWaitlistedRef.current = null;
    } catch (e) {
      console.error("Remove RSVP error:", e);
      Alert.alert("Error", "Could not remove RSVP right now.");
    } finally {
      setSavingRsvp(false);
    }
  };

  const confirmRemoveRsvp = () => {
    Alert.alert("Remove RSVP?", "This will delete your RSVP record for this match.", [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => void removeRsvpDoc() },
    ]);
  };

  const setMatchStatus = async (nextStatus: "scheduled" | "played" | "cancelled") => {
    if (!matchIdStr) return;
    try {
      const matchRef = doc(db, "matches", matchIdStr);
      await updateDoc(matchRef, {
        status: nextStatus,
        updatedBy: user?.uid ?? null,
        statusUpdatedBy: user?.uid ?? null,
        statusUpdatedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (e) {
      console.error("Error updating match status", e);
      Alert.alert("Error", "Could not update match status.");
    }
  };

  const confirmStatusChange = (nextStatus: "played" | "cancelled") => {
    const label = nextStatus === "played" ? "mark this match as played" : "cancel this match";
    Alert.alert("Confirm", `Are you sure you want to ${label}?`, [
      { text: "No", style: "cancel" },
      { text: "Yes", style: "destructive", onPress: () => setMatchStatus(nextStatus) },
    ]);
  };

  const handleAddToCalendar = async () => {
    if (!matchIdStr || !match) return;

    try {
      setExportingCalendar(true);

      const endAt = new Date(startAt.getTime() + 90 * 60 * 1000);
      const deadlineText = deadlineAt ? `RSVP deadline: ${deadlineAt.toLocaleString()}` : "";

      const notes = [
        "Pickup soccer match",
        match.locationText ? `Location: ${match.locationText}` : "",
        deadlineText,
        match.description ? `Notes: ${match.description}` : "",
        `Match ID: ${String(matchIdStr)}`,
      ]
        .filter(Boolean)
        .join("\n");

      await addMatchToCalendar({
        id: String(matchIdStr),
        title: "Pickup Soccer",
        startAt,
        endAt,
        location: match.locationText ?? "",
        notes,
      });
    } catch (e: any) {
      console.error("Calendar export error", e);
      Alert.alert(
        "Couldn’t add to calendar",
        e?.message ?? "Unknown error. Did you allow calendar permissions?"
      );
    } finally {
      setExportingCalendar(false);
    }
  };

  const renderScreen = (children: React.ReactNode) => {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.screen}>
          <View style={styles.bg}>
            <View style={styles.pitchLines} />
          </View>

          <ScrollView
            style={{ flex: 1 }}
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={styles.scrollContent}
          >
            {children}
          </ScrollView>
        </View>
      </SafeAreaView>
    );
  };

  if (!matchIdStr) return renderScreen(<Text style={styles.subtleText}>Missing match id.</Text>);

  if (loadingMatch) {
    return renderScreen(
      <View style={[styles.card, { alignItems: "center" }]}>
        <ActivityIndicator />
        <Text style={[styles.subtleText, { marginTop: 10 }]}>Loading match…</Text>
      </View>
    );
  }

  if (!match) {
    return renderScreen(
      <View style={styles.card}>
        <Text style={styles.h1}>{permissionDenied ? "No access" : "Match not found"}</Text>
        <Text style={styles.subtleText}>
          {permissionDenied
            ? "You might not be in the team for this match yet. Join the team and then reopen this link."
            : "This match may have been deleted."}
        </Text>

        {permissionDenied && (
          <Pressable
            onPress={() =>
              router.push({
                pathname: "/(app)/(tabs)/teams",
                params: { pendingMatchId: String(matchIdStr) },
              })
            }
            style={({ pressed }) => [
              styles.secondaryBtn,
              pressed && { transform: [{ scale: 0.99 }] },
            ]}
          >
            <Text style={styles.secondaryBtnText}>Go to Teams</Text>
          </Pressable>
        )}

        <Pressable
          onPress={() => router.back()}
          style={({ pressed }) => [styles.secondaryBtn, pressed && { transform: [{ scale: 0.99 }] }]}
        >
          <Text style={styles.secondaryBtnText}>Back</Text>
        </Pressable>
      </View>
    );
  }

  const headerDate = `${startAt.toLocaleDateString()} ${startAt.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;

  const disabledYesMaybe = !!rsvpDisabledReason;
  const showNotes = !!match.description?.trim();
  const showLocation = !!match.locationText?.trim();

  const chipVariantStatus =
    statusText === "Cancelled" ? "bad" : statusText === "Played" ? "warn" : "neutral";

  const spotsLabel =
    maxPlayers > 0 && spotsLeft !== null
      ? spotsLeft === 0
        ? "Full"
        : `${spotsLeft} spot${spotsLeft === 1 ? "" : "s"} left`
      : null;

  return renderScreen(
    <>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.h1}>{headerDate}</Text>
        <Text style={styles.subtleText}>{startLabel}</Text>
        <Text style={styles.subtleText}>{rsvpLabel}</Text>

        {showLocation && <Text style={styles.locationText}>{match.locationText!.trim()}</Text>}

        {showNotes && (
          <View style={{ marginTop: 10 }}>
            <Text style={styles.sectionTitle}>Notes</Text>
            <Text style={styles.bodyText}>{match.description!.trim()}</Text>
          </View>
        )}

        <View style={styles.chipRow}>
          <Chip label={`Status: ${statusText}`} variant={chipVariantStatus} />
          {isHost && <Chip label={"👑 Host"} variant="warn" />}
          {!!spotsLabel && <Chip label={spotsLabel} variant={spotsLeft === 0 ? "bad" : "good"} />}
        </View>

        <Text style={styles.metaLine}>
          {going.length}/{match.maxPlayers ?? "?"} going
          {waitlist.length > 0 ? ` • ${waitlist.length} waitlist` : ""}
        </Text>

        {rsvpDisabledReason && <Text style={styles.dangerText}>{rsvpDisabledReason}</Text>}
      </View>

      {/* Actions */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Actions</Text>

        <ActionRow
          icon="🔗"
          title="Share match link"
          subtitle="Send a link that opens this match"
          onPress={handleShareMatch}
        />

        <ActionRow
          icon={exportingCalendar ? "⏳" : "📅"}
          title={exportingCalendar ? "Opening calendar…" : "Add to Calendar"}
          subtitle="Create an event with location + notes"
          onPress={handleAddToCalendar}
          disabled={exportingCalendar}
        />

        {showLocation && (
          <ActionRow
            icon="🗺️"
            title="Open in Maps"
            subtitle="Get directions"
            onPress={() => openInMaps(match.locationText!.trim())}
          />
        )}

        <ActionRow
          icon="💬"
          title="Open Match Chat"
          subtitle="See messages for this match"
          onPress={handleOpenChat}
        />
      </View>

      {/* RSVP */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Your RSVP</Text>

        <View style={styles.rsvpRow}>
          <RsvpPill
            label="YES"
            tone="yes"
            active={userStatus === "yes"}
            disabled={savingRsvp || (disabledYesMaybe && true)}
            onPress={() => handleRsvp("yes")}
          />
          <RsvpPill
            label="MAYBE"
            tone="maybe"
            active={userStatus === "maybe"}
            disabled={savingRsvp || (disabledYesMaybe && true)}
            onPress={() => handleRsvp("maybe")}
          />
          <RsvpPill
            label="NO"
            tone="no"
            active={userStatus === "no"}
            disabled={savingRsvp}
            onPress={() => handleRsvp("no")}
          />
        </View>

        <Text style={styles.userStatusNote}>
          {userStatus === "yes"
            ? userWaitlisted
              ? "You’re on the waitlist for this match."
              : "You’re confirmed for this match."
            : userStatus === "maybe"
            ? "You’re marked as maybe."
            : userStatus === "no"
            ? "You’re marked as not going."
            : "Tap YES, MAYBE, or NO to update your status."}
        </Text>

        {!!myRsvp && (
          <View style={{ marginTop: 12 }}>
            <ActionRow
              icon="🚪"
              title="Leave match (set to NO)"
              subtitle="Keep your RSVP record but mark not going"
              onPress={() => handleRsvp("no")}
              disabled={savingRsvp}
            />
            <ActionRow
              icon="🗑️"
              title="Remove RSVP (delete)"
              subtitle="Deletes your RSVP record"
              onPress={confirmRemoveRsvp}
              disabled={savingRsvp}
              destructive
            />
          </View>
        )}
      </View>

      {/* Going + Waitlist */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Going</Text>
        {goingSorted.length === 0 && <Text style={styles.bodyMuted}>No confirmed players yet.</Text>}

        {goingSorted.map((r) => {
          const uid = r.userId ?? "";
          const prof = uid ? userProfiles[uid] : undefined;

          const name = String(r.playerName || prof?.displayName || r.userId || "Unknown");
          const subtitle = uid && uid === match.createdBy ? "Host" : uid === user?.uid ? "You" : "";

          return (
            <PersonRow
              key={r.id}
              name={name}
              subtitle={subtitle || undefined}
              photoURL={prof?.photoURL ?? null}
              updatedAtMs={prof?.updatedAtMs ?? null}
              highlight={uid === user?.uid}
            />
          );
        })}

        {waitlistSorted.length > 0 && (
          <>
            <Text style={[styles.sectionTitle, { marginTop: 14 }]}>Waitlist</Text>
            {waitlistSorted.map((r) => {
              const uid = r.userId ?? "";
              const prof = uid ? userProfiles[uid] : undefined;

              const name = String(r.playerName || prof?.displayName || r.userId || "Unknown");
              const subtitle = uid === user?.uid ? "You" : undefined;

              return (
                <PersonRow
                  key={r.id}
                  name={name}
                  subtitle={subtitle}
                  photoURL={prof?.photoURL ?? null}
                  updatedAtMs={prof?.updatedAtMs ?? null}
                  highlight={uid === user?.uid}
                />
              );
            })}
          </>
        )}
      </View>

      {/* Host tools */}
      {isHost && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Host tools</Text>

          <ActionRow
            icon={isPlayed ? "📝" : "✅"}
            title={isPlayed ? "Edit attendance + minutes" : "Complete match"}
            subtitle="Confirm who attended and assign minutes (updates Stats)"
            onPress={() =>
              router.push({
                pathname: "/(app)/match/complete/[matchId]",
                params: { matchId: String(matchIdStr) },
              })
            }
            disabled={isCancelled}
          />

          <ActionRow
            icon="✏️"
            title="Edit match details"
            subtitle="Change time, players, notes, deadline"
            onPress={() =>
              router.push({
                pathname: "/(app)/match/edit",
                params: { matchId: String(matchIdStr) },
              })
            }
          />

          <ActionRow
            icon="⛔"
            title="Cancel match"
            subtitle="Notifies everyone (except you)"
            onPress={() => confirmStatusChange("cancelled")}
            destructive
          />
        </View>
      )}

      <Pressable
        onPress={() => router.back()}
        style={({ pressed }) => [styles.secondaryBtn, pressed && { transform: [{ scale: 0.99 }] }]}
      >
        <Text style={styles.secondaryBtnText}>Back to matches</Text>
      </Pressable>

      <View style={{ height: 22 }} />
    </>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#052b22" },
  screen: { flex: 1, backgroundColor: "#052b22" },

  bg: { ...StyleSheet.absoluteFillObject, backgroundColor: "#052b22" },
  pitchLines: { ...StyleSheet.absoluteFillObject, opacity: 0.32, backgroundColor: "transparent" },

  scrollContent: { paddingHorizontal: 18, paddingTop: 12, paddingBottom: 28 },

  header: { marginBottom: 12 },
  h1: { fontSize: 30, fontWeight: "900", color: "white", letterSpacing: 0.2 },
  subtleText: {
    marginTop: 6,
    fontSize: 14,
    fontWeight: "800",
    color: "rgba(255,255,255,0.72)",
  },

  locationText: {
    marginTop: 10,
    fontSize: 15,
    fontWeight: "900",
    color: "rgba(255,255,255,0.82)",
  },

  sectionTitle: {
    fontSize: 16,
    fontWeight: "900",
    color: "rgba(255,255,255,0.78)",
    marginBottom: 10,
  },
  bodyText: { color: "rgba(255,255,255,0.82)", fontWeight: "800", lineHeight: 19 },
  bodyMuted: { color: "rgba(255,255,255,0.60)", fontWeight: "800" },

  metaLine: { marginTop: 12, color: "rgba(255,255,255,0.70)", fontWeight: "900" },
  dangerText: { marginTop: 8, color: "#ff7a7a", fontWeight: "900" },

  chipRow: { marginTop: 12, flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1 },
  chipText: { fontSize: 12, fontWeight: "900", color: "rgba(255,255,255,0.88)" },
  chip_neutral: {
    backgroundColor: "rgba(255,255,255,0.10)",
    borderColor: "rgba(255,255,255,0.12)",
  },
  chip_good: { backgroundColor: "rgba(27,127,90,0.22)", borderColor: "rgba(27,127,90,0.35)" },
  chip_warn: { backgroundColor: "rgba(255,231,184,0.16)", borderColor: "rgba(255,231,184,0.22)" },
  chip_bad: { backgroundColor: "rgba(255,122,122,0.14)", borderColor: "rgba(255,122,122,0.22)" },

  card: {
    marginTop: 12,
    borderRadius: 22,
    padding: 18,
    backgroundColor: "rgba(10, 16, 25, 0.78)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },

  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 56,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    marginTop: 10,
    gap: 12,
  },
  actionRowDestructive: {
    backgroundColor: "rgba(255,122,122,0.08)",
    borderColor: "rgba(255,122,122,0.18)",
  },
  actionIcon: { fontSize: 18, opacity: 0.95 },
  actionTitle: { color: "white", fontWeight: "900", fontSize: 15 },
  actionTitleDestructive: { color: "rgba(255,200,200,0.95)" },
  actionSub: { marginTop: 3, color: "rgba(255,255,255,0.55)", fontWeight: "800", fontSize: 12 },
  actionChev: { color: "rgba(255,255,255,0.60)", fontSize: 22, fontWeight: "900" },

  rsvpRow: { flexDirection: "row", gap: 10, marginTop: 8 },
  rsvpPill: { flex: 1, height: 46, borderRadius: 14, alignItems: "center", justifyContent: "center", borderWidth: 1 },
  rsvpPillText: { fontSize: 14, fontWeight: "900", color: "rgba(255,255,255,0.90)", letterSpacing: 0.2 },
  rsvpPill_yes: { backgroundColor: "rgba(27,127,90,0.18)", borderColor: "rgba(27,127,90,0.35)" },
  rsvpPill_maybe: { backgroundColor: "rgba(255,255,255,0.08)", borderColor: "rgba(255,255,255,0.12)" },
  rsvpPill_no: { backgroundColor: "rgba(255,122,122,0.10)", borderColor: "rgba(255,122,122,0.22)" },
  rsvpPillActive: { borderColor: "rgba(255,255,255,0.45)" },

  userStatusNote: { marginTop: 10, textAlign: "center", color: "rgba(255,255,255,0.70)", fontSize: 13, fontWeight: "800" },

  personRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 14,
    marginTop: 8,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  personRowHighlight: { borderColor: "rgba(27,127,90,0.35)", backgroundColor: "rgba(27,127,90,0.12)" },

  avatarSmWrap: { width: 36, height: 36, borderRadius: 18, overflow: "hidden", borderWidth: 1, borderColor: "rgba(255,255,255,0.18)" },
  avatarSm: { width: 36, height: 36, borderRadius: 18 },
  avatarSmFallback: { alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.10)" },
  avatarSmText: { fontWeight: "900", color: "rgba(255,255,255,0.85)", fontSize: 12 },
  personName: { fontSize: 14, fontWeight: "900", color: "rgba(255,255,255,0.92)" },
  personSub: { marginTop: 2, fontSize: 12, color: "rgba(255,255,255,0.60)", fontWeight: "800" },

  secondaryBtn: {
    marginTop: 14,
    height: 54,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  secondaryBtnText: { color: "rgba(255,255,255,0.85)", fontSize: 16, fontWeight: "900" },
});
