// app/(app)/match/chat/[matchId].tsx
import { useFocusEffect } from "@react-navigation/native";
import { Image } from "expo-image";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  addDoc,
  collection,
  doc,
  getDoc,
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
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
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
  photoURL?: string | null;
  createdAt?: any;

  // stable timestamp for grouping
  stableMs: number;
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

  // Initial scroll
  useEffect(() => {
    if (didInitialScroll.current) return;
    if (messages.length === 0) return;

    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: false });
      didInitialScroll.current = true;
    });
  }, [messages.length]);

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
        listRef.current?.scrollToEnd({ animated: true });
      });

      scheduleMarkChatRead();
    } catch (e) {
      console.error("Send message error:", e);
      Alert.alert("Error", "Could not send message.");
    } finally {
      setSending(false);
    }
  };

  const handleBack = () => router.back();

  if (!matchIdStr) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.container}>
          <Text>Missing match id.</Text>
          <TouchableOpacity style={styles.backBtn} onPress={handleBack}>
            <Text style={styles.backBtnText}>Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.container}>
          <Text>Loading chat...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!matchTeamId) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.container}>
          <Text>Match not found.</Text>
          <TouchableOpacity style={styles.backBtn} onPress={handleBack}>
            <Text style={styles.backBtnText}>Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 64 : 0}
      >
        <View style={styles.header}>
          <TouchableOpacity
            onPress={handleBack}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={styles.backText}>‹ Back</Text>
          </TouchableOpacity>

          <Text style={styles.headerTitle}>Match Chat</Text>

          <TouchableOpacity
            onPress={toggleMute}
            disabled={togglingMute}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={[styles.muteText, muted && styles.muteTextOn]}>
              {togglingMute ? "…" : muted ? "Unmute" : "Mute"}
            </Text>
          </TouchableOpacity>
        </View>

        <FlatList
          ref={listRef}
          style={{ flex: 1 }}
          contentContainerStyle={styles.messagesContainer}
          data={messages}
          keyExtractor={(m) => m.id}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          ListEmptyComponent={<Text style={styles.emptyText}>No messages yet. Say hi 👋</Text>}
          renderItem={({ item, index }) => {
            const mine = item.userId === user?.uid;
            const initials = initialsFromName(item.displayName);

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
            const spacing = joinsPrev ? 3 : 10;

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
                        {item.photoURL ? (
                          <Image source={{ uri: item.photoURL }} style={styles.avatarImg} />
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
                        {item.photoURL ? (
                          <Image source={{ uri: item.photoURL }} style={styles.avatarImg} />
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

        <View style={styles.composer}>
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder="Message…"
            maxLength={500}
            multiline
          />

          <TouchableOpacity
            style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
            onPress={handleSend}
            disabled={!canSend}
            activeOpacity={0.85}
          >
            <Text style={styles.sendButtonText}>{sending ? "…" : "Send"}</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const AVATAR = 32;

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { flex: 1, padding: 16 },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ddd",
  },
  backText: { fontSize: 16, color: "#007AFF", fontWeight: "600", width: 60 },
  headerTitle: { fontSize: 18, fontWeight: "700" },

  muteText: { fontSize: 14, fontWeight: "800", color: "#007AFF", width: 60, textAlign: "right" },
  muteTextOn: { color: "#d11" },

  messagesContainer: { padding: 16, paddingBottom: 8 },
  emptyText: { color: "#666" },

  row: { flexDirection: "row", alignItems: "flex-end" },
  rowMine: { justifyContent: "flex-end" },
  rowOther: { justifyContent: "flex-start" },

  avatarWrap: {
    width: AVATAR,
    height: AVATAR,
    borderRadius: AVATAR / 2,
    overflow: "hidden",
    marginHorizontal: 8,
  },
  avatarImg: { width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2 },
  avatarFallback: {
    width: AVATAR,
    height: AVATAR,
    borderRadius: AVATAR / 2,
    backgroundColor: "#eef3ff",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontSize: 12, fontWeight: "800", color: "#2b4cff" },
  avatarSpacer: { width: AVATAR, height: AVATAR, marginHorizontal: 8, opacity: 0 },

  bubble: { maxWidth: "70%", paddingVertical: 8, paddingHorizontal: 10, borderRadius: 12 },
  bubbleMine: { backgroundColor: "#D7EBFF" },
  bubbleOther: { backgroundColor: "#F2F2F2" },
  bubbleName: { fontSize: 12, fontWeight: "700", marginBottom: 4, color: "#333" },
  bubbleText: { color: "#111" },
  timeText: { marginTop: 6, fontSize: 11, color: "#666", alignSelf: "flex-end" },

  dateSepWrap: { alignItems: "center", marginBottom: 6, marginTop: 2 },
  dateSepPill: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: "#eee",
  },
  dateSepText: { fontSize: 12, fontWeight: "700", color: "#666" },

  composer: {
    flexDirection: "row",
    gap: 10,
    padding: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#ddd",
    alignItems: "flex-end",
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  sendButton: {
    width: 80,
    height: 40,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#007AFF",
  },
  sendButtonDisabled: { backgroundColor: "#9cc7ff" },
  sendButtonText: { color: "#fff", fontWeight: "800" },

  backBtn: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: "#eee",
    alignSelf: "flex-start",
    marginTop: 12,
  },
  backBtnText: { fontWeight: "700" },
});
