// app/(app)/match/chat/[matchId].tsx
import { useFocusEffect } from "@react-navigation/native";
import { Image } from "expo-image";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  addDoc,
  collection,
  doc,
  documentId,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../../../src/context/AuthContext";
import { db } from "../../../../src/firebaseConfig";
import { onSnapshotSafe } from "../../../../src/firestoreSafe";

type QDoc = QueryDocumentSnapshot<DocumentData>;
type ChatMessage = {
  id: string;
  matchId: string;
  teamId: string;
  userId: string;
  displayName: string;
  text: string;
  // legacy field (we won't trust it for rendering in Option A)
  photoURL?: string | null;
  createdAt?: any;

  // stable timestamp for grouping
  stableMs: number;
};

type UserProfileMini = {
  uid: string;
  displayName: string | null;
  photoURL: string | null;
  // Prefer photoUpdatedAtMs if present, else updatedAtMs
  photoVersionMs: number | null;
};

function paramToString(v: any): string | null {
  if (!v) return null;
  if (Array.isArray(v)) return v[0] ? String(v[0]) : null;
  return String(v);
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

function minutesDiffMs(a: number, b: number) {
  return Math.abs(a - b) / 60000;
}

function isSameDayMs(a: number, b: number) {
  const da = new Date(a);
  const dbb = new Date(b);
  return (
    da.getFullYear() === dbb.getFullYear() &&
    da.getMonth() === dbb.getMonth() &&
    da.getDate() === dbb.getDate()
  );
}

function initialsFromName(name: string) {
  const base = (name || "").trim();
  if (!base) return "U";
  const parts = base.split(" ").filter(Boolean);
  const first = parts[0]?.[0] ?? "U";
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] : "";
  return (first + last).toUpperCase();
}

function formatTimeMs(ms: number) {
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDayLabelMs(ms: number) {
  const d = new Date(ms);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const that = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

  const diffDays = Math.round((today - that) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";

  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

// ✅ cache-busted avatar URI (critical when overwriting avatar.jpg)
function avatarUri(photoURL?: string | null, versionMs?: number | null) {
  if (!photoURL) return null;
  const v = Number.isFinite(versionMs as any) ? String(versionMs) : "0";
  return photoURL.includes("?") ? `${photoURL}&v=${v}` : `${photoURL}?v=${v}`;
}

async function loadUserProfilesByUids(uids: string[]) {
  const uniq = Array.from(new Set(uids.filter(Boolean)));
  const out = new Map<string, UserProfileMini>();
  if (uniq.length === 0) return out;

  const CHUNK = 10; // Firestore "in" limit
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

      const photoUpdatedAtMs =
        typeof data?.photoUpdatedAtMs === "number" && Number.isFinite(data.photoUpdatedAtMs)
          ? data.photoUpdatedAtMs
          : null;

      out.set(d.id, {
        uid: d.id,
        displayName: (data?.displayName as string) ?? null,
        photoURL: (data?.photoURL as string) ?? null,
        photoVersionMs: photoUpdatedAtMs ?? (typeof updatedAtMs === "number" ? updatedAtMs : null),
      });
    }
  }

  return out;
}

export default function MatchChatScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const matchIdStr = paramToString(params?.matchId);
  const { user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [matchTeamId, setMatchTeamId] = useState<string | null>(null);

  // ✅ latest seq from matches/{matchId}
  const [lastMessageSeq, setLastMessageSeq] = useState<number>(0);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  // ✅ per-match mute state (stored at users/{uid}/chatPrefs/{matchId})
  const [muted, setMuted] = useState(false);
  const [togglingMute, setTogglingMute] = useState(false);

  // ✅ Option A: profiles map so avatars update live
  const [userProfiles, setUserProfiles] = useState<Record<string, UserProfileMini>>({});

  const listRef = useRef<FlatList<ChatMessage>>(null);
  const didInitialScroll = useRef(false);

  // Freeze stable timestamps per message id
  const stableMsByIdRef = useRef<Map<string, number>>(new Map());

  const META_ON_FIRST_MESSAGE_IN_CLUSTER = false;
  const CLUSTER_MINUTES = 5;

  // -------------------------------
  // ✅ Mark-as-read (SEQ + TIME)
  // -------------------------------
  const markReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markChatReadNow = useCallback(async () => {
    if (!user?.uid || !matchIdStr) return;

    try {
      const ref = doc(db, "users", user.uid, "chatReads", matchIdStr);

      await setDoc(
        ref,
        {
          lastReadAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          lastReadSeq: Number.isFinite(lastMessageSeq) ? lastMessageSeq : 0,
        },
        { merge: true }
      );
    } catch (e) {
      console.warn("markChatReadNow failed:", e);
    }
  }, [user?.uid, matchIdStr, lastMessageSeq]);

  const scheduleMarkChatRead = useCallback(() => {
    if (!user?.uid || !matchIdStr) return;

    if (markReadTimerRef.current) clearTimeout(markReadTimerRef.current);
    markReadTimerRef.current = setTimeout(() => {
      markChatReadNow();
    }, 250);
  }, [user?.uid, matchIdStr, markChatReadNow]);

  useEffect(() => {
    return () => {
      if (markReadTimerRef.current) clearTimeout(markReadTimerRef.current);
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      scheduleMarkChatRead();
      return () => {};
    }, [scheduleMarkChatRead])
  );

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") scheduleMarkChatRead();
    });
    return () => sub.remove();
  }, [scheduleMarkChatRead]);

  // -------------------------------
  // ✅ Scroll-to-bottom + unseen count
  // -------------------------------
  const [atBottom, setAtBottom] = useState(true);
  const [unseenCount, setUnseenCount] = useState(0);
  const contentHRef = useRef(0);
  const layoutHRef = useRef(0);
  const yRef = useRef(0);
  const prevMsgCountRef = useRef(0);

  const updateAtBottom = useCallback(() => {
    const contentH = contentHRef.current;
    const layoutH = layoutHRef.current;
    const y = yRef.current;

    if (!contentH || !layoutH) return;

    const dist = contentH - (y + layoutH);
    const isBottom = dist <= 90; // threshold
    setAtBottom(isBottom);
    if (isBottom) setUnseenCount(0);
  }, []);

  const scrollToBottom = useCallback(
    (animated = true) => {
      requestAnimationFrame(() => {
        listRef.current?.scrollToEnd({ animated });
      });
      setUnseenCount(0);
      setAtBottom(true);
      scheduleMarkChatRead();
    },
    [scheduleMarkChatRead]
  );

  // -------------------------------
  // ✅ Local typing indicator (just polish)
  // -------------------------------
  const [inputFocused, setInputFocused] = useState(false);
  const showTyping = inputFocused && text.trim().length > 0 && !sending;

  const [typingDots, setTypingDots] = useState("");
  useEffect(() => {
    if (!showTyping) {
      setTypingDots("");
      return;
    }
    let i = 0;
    const t = setInterval(() => {
      i = (i + 1) % 4; // "", ".", "..", "..."
      setTypingDots(".".repeat(i));
    }, 420);
    return () => clearInterval(t);
  }, [showTyping]);

  // ✅ Subscribe to match doc to get teamId + lastMessageSeq
  useEffect(() => {
    if (!matchIdStr) {
      setLoading(false);
      setMatchTeamId(null);
      setLastMessageSeq(0);
      return;
    }

    const matchRef = doc(db, "matches", matchIdStr);
    const unsub = onSnapshotSafe(
      matchRef,
      (snap) => {
        if (!snap.exists()) {
          setMatchTeamId(null);
          setLastMessageSeq(0);
          setLoading(false);
          return;
        }

        const data = snap.data() as any;
        setMatchTeamId(data?.teamId ? String(data.teamId) : null);

        const seq = typeof data?.lastMessageSeq === "number" ? data.lastMessageSeq : 0;
        setLastMessageSeq(seq);

        setLoading(false);
      },
      {
        label: "chat:matchDoc",
        onPermissionDenied: () => {
          setMatchTeamId(null);
          setLastMessageSeq(0);
          setLoading(false);
        },
        onError: (err) => {
          console.error("match doc listener error:", err);
          setMatchTeamId(null);
          setLastMessageSeq(0);
          setLoading(false);
        },
      }
    );

    return () => unsub();
  }, [matchIdStr]);

  useEffect(() => {
    if (!matchIdStr) return;
    scheduleMarkChatRead();
  }, [lastMessageSeq, matchIdStr, scheduleMarkChatRead]);

  // ✅ Subscribe to my mute pref doc
  useEffect(() => {
    if (!user?.uid || !matchIdStr) {
      setMuted(false);
      return;
    }

    const prefRef = doc(db, "users", user.uid, "chatPrefs", matchIdStr);
    const unsub = onSnapshotSafe(
      prefRef,
      (snap) => {
        const d = snap.data() as any;
        setMuted(d?.muted === true);
      },
      {
        label: "chat:mutePref",
        onError: () => setMuted(false),
        onPermissionDenied: () => setMuted(false),
      }
    );

    return () => unsub();
  }, [user?.uid, matchIdStr]);

  const toggleMute = useCallback(async () => {
    if (!user?.uid || !matchIdStr) return;

    try {
      setTogglingMute(true);

      const prefRef = doc(db, "users", user.uid, "chatPrefs", matchIdStr);
      const next = !muted;

      await setDoc(
        prefRef,
        {
          muted: next,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      Alert.alert(
        next ? "Muted" : "Unmuted",
        next
          ? "You won’t get push notifications for this match chat."
          : "You’ll get push notifications again for this match chat."
      );

      scheduleMarkChatRead();
    } catch (e) {
      console.warn("toggleMute failed:", e);
      Alert.alert("Error", "Could not update mute setting.");
    } finally {
      setTogglingMute(false);
    }
  }, [user?.uid, matchIdStr, muted, scheduleMarkChatRead]);

  // Subscribe to messages
  useEffect(() => {
    if (!matchIdStr) return;

    const colRef = collection(db, "matchMessages");
    const qy = query(
      colRef,
      where("matchId", "==", matchIdStr),
      orderBy("createdAt", "desc"),
      limit(200)
    );

    const unsub = onSnapshotSafe(
      qy,
      (snap) => {
        const stableMap = stableMsByIdRef.current;
        const nextIds = new Set<string>();

        const list: ChatMessage[] = snap.docs.map((d: QDoc) => {
          const data = d.data({ serverTimestamps: "estimate" }) as any;

          const id = d.id;
          nextIds.add(id);

          const candidateMs = tsToMs(data.createdAt) || Date.now();

          const stableMs = stableMap.has(id) ? (stableMap.get(id) as number) : candidateMs;
          if (!stableMap.has(id)) stableMap.set(id, stableMs);

          return {
            id,
            matchId: String(data.matchId ?? ""),
            teamId: String(data.teamId ?? ""),
            userId: String(data.userId ?? ""),
            displayName: String(data.displayName ?? "Someone"),
            text: String(data.text ?? ""),
            // keep legacy for older clients, but UI will ignore it for avatar rendering
            photoURL: (data.photoURL as string) ?? null,
            createdAt: data.createdAt,
            stableMs,
          };
        });

        for (const k of stableMap.keys()) {
          if (!nextIds.has(k)) stableMap.delete(k);
        }

        list.sort((a, b) => {
          const dt = a.stableMs - b.stableMs;
          if (dt !== 0) return dt;
          return a.id.localeCompare(b.id);
        });

        setMessages(list);
      },
      {
        label: "chat:messages",
        onPermissionDenied: () => setMessages([]),
        onError: (err) => console.error("Chat listener error:", err),
      }
    );

    return () => unsub();
  }, [matchIdStr]);

  // ✅ Option A: load user profiles for all message senders (avatars)
  useEffect(() => {
    const uids = Array.from(new Set(messages.map((m) => m.userId).filter(Boolean)));
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
        console.warn("Failed to load user profiles for chat avatars", e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [messages]);

  // Initial scroll
  useEffect(() => {
    if (didInitialScroll.current) return;
    if (messages.length === 0) return;

    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: false });
      didInitialScroll.current = true;
      setAtBottom(true);
      setUnseenCount(0);
      prevMsgCountRef.current = messages.length;
    });
  }, [messages.length]);

  // If new messages arrive:
  // - when at bottom => keep you pinned to bottom
  // - when not at bottom => show "scroll to bottom" + count
  useEffect(() => {
    const prev = prevMsgCountRef.current;
    const curr = messages.length;
    prevMsgCountRef.current = curr;

    if (!didInitialScroll.current) return;
    if (curr <= prev) return;

    const added = curr - prev;

    if (atBottom) {
      scrollToBottom(true);
    } else {
      setUnseenCount((c) => c + added);
    }
  }, [messages.length, atBottom, scrollToBottom]);

  const canSend = useMemo(() => {
    return (
      !!user?.uid &&
      !!matchIdStr &&
      !!matchTeamId &&
      text.trim().length > 0 &&
      text.trim().length <= 500 &&
      !sending
    );
  }, [user?.uid, matchIdStr, matchTeamId, text, sending]);

  const handleSend = async () => {
    if (!user?.uid) return Alert.alert("Please sign in");
    if (!matchIdStr) return Alert.alert("Missing match id");
    if (!matchTeamId) return Alert.alert("Match not found");

    const body = text.trim();
    if (!body) return;
    if (body.length > 500) return Alert.alert("Too long", "Keep under 500 characters.");

    try {
      setSending(true);

      let displayName = user.email ?? "Player";
      let photoURL: string | null = null;

      try {
        const userRef = doc(db, "users", user.uid);
        const userSnap = await getDoc(userRef);
        if (userSnap.exists()) {
          const ud = userSnap.data() as any;
          if (ud?.displayName) displayName = String(ud.displayName);
          if (ud?.photoURL) photoURL = String(ud.photoURL);
        }
      } catch {
        // ignore
      }

      // We still store photoURL for backwards compat, but UI renders from users/{uid}
      await addDoc(collection(db, "matchMessages"), {
        matchId: matchIdStr,
        teamId: matchTeamId,
        userId: user.uid,
        displayName,
        photoURL: photoURL ?? null,
        text: body,
        createdAt: serverTimestamp(),
      });

      setText("");

      requestAnimationFrame(() => {
        scrollToBottom(true);
      });
    } catch (e) {
      console.error("Send message error:", e);
      Alert.alert("Error", "Could not send message.");
    } finally {
      setSending(false);
    }
  };

  const handleBack = () => router.back();

  // ✅ Background now covers safe areas too (fixes top/bottom tint)
  const renderShell = (content: React.ReactNode) => {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
          <View style={styles.bg} />
          <View style={styles.pitchLines} />
        </View>

        {content}
      </SafeAreaView>
    );
  };

  if (!matchIdStr) {
    return renderShell(
      <View style={styles.centerWrap}>
        <View style={styles.stateCard}>
          <Text style={styles.stateTitle}>Missing match id</Text>
          <Pressable
            onPress={handleBack}
            style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
          >
            <Text style={styles.secondaryBtnText}>Back</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (loading) {
    return renderShell(
      <View style={styles.centerWrap}>
        <View style={styles.stateCard}>
          <Text style={styles.stateTitle}>Loading chat…</Text>
          <Text style={styles.stateSubtle}>Pulling messages and match info.</Text>
        </View>
      </View>
    );
  }

  if (!matchTeamId) {
    return renderShell(
      <View style={styles.centerWrap}>
        <View style={styles.stateCard}>
          <Text style={styles.stateTitle}>Match not found</Text>
          <Text style={styles.stateSubtle}>You may not have access, or it was deleted.</Text>
          <Pressable
            onPress={handleBack}
            style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
          >
            <Text style={styles.secondaryBtnText}>Back</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    yRef.current = e.nativeEvent.contentOffset.y;
    updateAtBottom();
  };

  return renderShell(
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 64 : 0}
    >
      {/* Header */}
      <View style={styles.header}>
        <Pressable
          onPress={handleBack}
          hitSlop={10}
          style={({ pressed }) => [styles.headerBtn, pressed && styles.pressed]}
        >
          <Text style={styles.headerBtnText}>‹ Back</Text>
        </Pressable>

        <View style={{ flex: 1, alignItems: "center" }}>
          <Text style={styles.headerTitle}>Match chat</Text>
          <Text style={styles.headerSub}>
            {muted ? "Muted (no push notifications)" : "Say hi to your squad"}
          </Text>
        </View>

        <Pressable
          onPress={toggleMute}
          disabled={togglingMute}
          hitSlop={10}
          style={({ pressed }) => [
            styles.mutePill,
            muted && styles.mutePillOn,
            pressed && !togglingMute && styles.pressed,
            togglingMute && { opacity: 0.7 },
          ]}
        >
          <Text style={[styles.mutePillText, muted && styles.mutePillTextOn]}>
            {togglingMute ? "…" : muted ? "Unmute" : "Mute"}
          </Text>
        </Pressable>
      </View>

      {/* Messages */}
      <FlatList
        ref={listRef}
        style={{ flex: 1 }}
        contentContainerStyle={styles.messagesContainer}
        data={messages}
        keyExtractor={(m) => m.id}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        scrollEventThrottle={16}
        onScroll={onScroll}
        onLayout={(e) => {
          layoutHRef.current = e.nativeEvent.layout.height;
          updateAtBottom();
        }}
        onContentSizeChange={(_, h) => {
          contentHRef.current = h;
          updateAtBottom();
        }}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyTitle}>No messages yet</Text>
            <Text style={styles.emptySub}>Be the first one to say hi 👋</Text>
          </View>
        }
        renderItem={({ item, index }) => {
          const mine = item.userId === user?.uid;

          // ✅ Option A: derive avatar from users/{uid}
          const prof = item.userId ? userProfiles[item.userId] : undefined;
          const nameForInitials = item.displayName || prof?.displayName || "Someone";
          const initials = initialsFromName(nameForInitials);
          const uri = avatarUri(prof?.photoURL ?? null, prof?.photoVersionMs ?? null);

          const prev = messages[index - 1];
          const next = messages[index + 1];

          const tCur = item.stableMs;
          const tPrev = prev?.stableMs ?? 0;
          const tNext = next?.stableMs ?? 0;

          const joinsPrev =
            !!prev &&
            prev.userId === item.userId &&
            tCur > 0 &&
            tPrev > 0 &&
            minutesDiffMs(tCur, tPrev) <= CLUSTER_MINUTES;

          const joinsNext =
            !!next &&
            next.userId === item.userId &&
            tCur > 0 &&
            tNext > 0 &&
            minutesDiffMs(tCur, tNext) <= CLUSTER_MINUTES;

          const isClusterStart = !joinsPrev;
          const isClusterEnd = !joinsNext;

          const showMeta = META_ON_FIRST_MESSAGE_IN_CLUSTER ? isClusterStart : isClusterEnd;

          const showDateSeparator = tCur > 0 && (!prev || !isSameDayMs(tCur, tPrev));
          const timeLabel = showMeta ? formatTimeMs(tCur) : "";
          const spacing = joinsPrev ? 4 : 12;

          return (
            <View style={{ marginTop: spacing }}>
              {showDateSeparator && (
                <View style={styles.dateSepWrap}>
                  <View style={styles.dateSepPill}>
                    <Text style={styles.dateSepText}>{formatDayLabelMs(tCur)}</Text>
                  </View>
                </View>
              )}

              <View style={[styles.row, mine ? styles.rowMine : styles.rowOther]}>
                {!mine ? (
                  showMeta ? (
                    <View style={styles.avatarWrap}>
                      {uri ? (
                        <Image source={{ uri }} style={styles.avatarImg} cachePolicy="none" />
                      ) : (
                        <View style={styles.avatarFallback}>
                          <Text style={styles.avatarText}>{initials}</Text>
                        </View>
                      )}
                    </View>
                  ) : (
                    <View style={styles.avatarSpacer} />
                  )
                ) : (
                  <View style={styles.avatarSpacer} />
                )}

                <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleOther]}>
                  {!mine && showMeta && <Text style={styles.bubbleName}>{item.displayName}</Text>}
                  <Text style={styles.bubbleText}>{item.text}</Text>
                  {showMeta && !!timeLabel && <Text style={styles.timeText}>{timeLabel}</Text>}
                </View>

                {mine ? (
                  showMeta ? (
                    <View style={styles.avatarWrap}>
                      {uri ? (
                        <Image source={{ uri }} style={styles.avatarImg} cachePolicy="none" />
                      ) : (
                        <View style={styles.avatarFallback}>
                          <Text style={styles.avatarText}>{initials}</Text>
                        </View>
                      )}
                    </View>
                  ) : (
                    <View style={styles.avatarSpacer} />
                  )
                ) : (
                  <View style={styles.avatarSpacer} />
                )}
              </View>
            </View>
          );
        }}
      />

      {/* Scroll-to-bottom button (shows when you're not at bottom) */}
      {!atBottom && messages.length > 0 && (
        <View pointerEvents="box-none" style={styles.fabWrap}>
          <Pressable
            onPress={() => scrollToBottom(true)}
            style={({ pressed }) => [styles.fab, pressed && styles.pressed]}
            hitSlop={10}
          >
            <Text style={styles.fabArrow}>↓</Text>
            <Text style={styles.fabText}>Bottom</Text>
            {unseenCount > 0 && (
              <View style={styles.fabBadge}>
                <Text style={styles.fabBadgeText}>{unseenCount > 99 ? "99+" : String(unseenCount)}</Text>
              </View>
            )}
          </Pressable>
        </View>
      )}

      {/* Typing indicator (local-only) */}
      {showTyping && (
        <View style={styles.typingWrap} pointerEvents="none">
          <Text style={styles.typingText}>Typing{typingDots}</Text>
        </View>
      )}

      {/* Composer */}
      <View style={styles.composer}>
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder="Message…"
            placeholderTextColor="rgba(255,255,255,0.40)"
            maxLength={500}
            multiline
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
          />
        </View>

        <Pressable
          onPress={handleSend}
          disabled={!canSend}
          style={({ pressed }) => [
            styles.sendBtn,
            !canSend && styles.sendBtnDisabled,
            pressed && canSend && styles.pressed,
          ]}
        >
          <Text style={styles.sendBtnText}>{sending ? "…" : "Send"}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const AVATAR = 32;

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#052b22" },

  // Background layers
  bg: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#052b22",
  },
  pitchLines: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0.26,
    backgroundColor: "transparent",
  },

  pressed: { transform: [{ scale: 0.99 }] },

  // Header
  header: {
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.10)",
    backgroundColor: "#052b22",
  },

  headerBtn: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.07)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    minWidth: 72,
    alignItems: "center",
    justifyContent: "center",
  },
  headerBtnText: { color: "rgba(255,255,255,0.88)", fontWeight: "900" },

  headerTitle: { color: "white", fontWeight: "900", fontSize: 16, letterSpacing: 0.2 },
  headerSub: { marginTop: 2, color: "rgba(255,255,255,0.60)", fontWeight: "800", fontSize: 12 },

  mutePill: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.07)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    minWidth: 80,
    alignItems: "center",
    justifyContent: "center",
  },
  mutePillOn: {
    backgroundColor: "rgba(255, 80, 80, 0.12)",
    borderColor: "rgba(255, 80, 80, 0.22)",
  },
  mutePillText: { color: "rgba(255,255,255,0.88)", fontWeight: "900", fontSize: 13 },
  mutePillTextOn: { color: "rgba(255, 190, 190, 0.95)" },

  // Centered state cards
  centerWrap: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 18 },
  stateCard: {
    width: "100%",
    borderRadius: 22,
    padding: 18,
    backgroundColor: "rgba(10, 16, 25, 0.78)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    alignItems: "center",
  },
  stateTitle: { color: "white", fontWeight: "900", fontSize: 18 },
  stateSubtle: { marginTop: 8, color: "rgba(255,255,255,0.65)", fontWeight: "800", textAlign: "center" },

  secondaryBtn: {
    marginTop: 14,
    height: 52,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  secondaryBtnText: { color: "rgba(255,255,255,0.88)", fontSize: 16, fontWeight: "900" },

  // List
  messagesContainer: { paddingHorizontal: 14, paddingTop: 14, paddingBottom: 10 },

  emptyWrap: {
    marginTop: 24,
    alignItems: "center",
    padding: 18,
    borderRadius: 18,
    backgroundColor: "rgba(10, 16, 25, 0.55)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  emptyTitle: { color: "white", fontWeight: "900", fontSize: 16 },
  emptySub: { marginTop: 6, color: "rgba(255,255,255,0.65)", fontWeight: "800", textAlign: "center" },

  // Chat row / bubbles
  row: { flexDirection: "row", alignItems: "flex-end" },
  rowMine: { justifyContent: "flex-end" },
  rowOther: { justifyContent: "flex-start" },

  avatarWrap: {
    width: AVATAR,
    height: AVATAR,
    borderRadius: AVATAR / 2,
    overflow: "hidden",
    marginHorizontal: 8,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  avatarImg: { width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2 },
  avatarFallback: {
    width: AVATAR,
    height: AVATAR,
    borderRadius: AVATAR / 2,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.10)",
  },
  avatarText: { fontSize: 12, fontWeight: "900", color: "rgba(255,255,255,0.9)" },
  avatarSpacer: { width: AVATAR, height: AVATAR, marginHorizontal: 8, opacity: 0 },

  bubble: {
    maxWidth: "72%",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1,
  },
  bubbleMine: {
    backgroundColor: "rgba(27, 127, 90, 0.55)",
    borderColor: "rgba(27, 127, 90, 0.30)",
  },
  bubbleOther: {
    backgroundColor: "rgba(255,255,255,0.08)",
    borderColor: "rgba(255,255,255,0.12)",
  },

  bubbleName: { fontSize: 12, fontWeight: "900", marginBottom: 6, color: "rgba(255,255,255,0.78)" },
  bubbleText: { color: "white", fontSize: 15, fontWeight: "700", lineHeight: 20 },
  timeText: { marginTop: 8, fontSize: 11, color: "rgba(255,255,255,0.55)", alignSelf: "flex-end", fontWeight: "800" },

  // Date separator
  dateSepWrap: { alignItems: "center", marginBottom: 8, marginTop: 2 },
  dateSepPill: {
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: "rgba(10, 16, 25, 0.65)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  dateSepText: { fontSize: 12, fontWeight: "900", color: "rgba(255,255,255,0.65)" },

  // Scroll-to-bottom FAB
  fabWrap: {
    position: "absolute",
    right: 14,
    bottom: 12 + 48 + 12, // composer height-ish + padding
    zIndex: 20,
  },
  fab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: "rgba(10, 16, 25, 0.78)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },
  fabArrow: { color: "rgba(255,255,255,0.92)", fontWeight: "900", fontSize: 14 },
  fabText: { color: "rgba(255,255,255,0.92)", fontWeight: "900", fontSize: 13 },
  fabBadge: {
    marginLeft: 2,
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 6,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(27, 127, 90, 0.95)",
  },
  fabBadgeText: { color: "#04130f", fontWeight: "900", fontSize: 12 },

  // Typing indicator (local-only)
  typingWrap: {
    position: "absolute",
    left: 14,
    right: 14,
    bottom: 12 + 48 + 12 + 8, // just above composer
    alignItems: "flex-start",
    zIndex: 10,
  },
  typingText: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.07)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    color: "rgba(255,255,255,0.70)",
    fontWeight: "900",
    fontSize: 12,
  },

  // Composer
  composer: {
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 12,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.10)",
    backgroundColor: "#052b22",
    flexDirection: "row",
    gap: 10,
    alignItems: "flex-end",
  },

  inputRow: {
    flex: 1,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    minHeight: 48,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  input: {
    color: "white",
    fontSize: 16,
    fontWeight: "800",
    maxHeight: 120,
  },

  sendBtn: {
    width: 84,
    height: 48,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1b7f5a",
  },
  sendBtnDisabled: { opacity: 0.55 },
  sendBtnText: { color: "#04130f", fontWeight: "900", fontSize: 16 },
});
