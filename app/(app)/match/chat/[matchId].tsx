// app/(app)/match/chat/[matchId].tsx
import { Image } from "expo-image";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
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

type ChatMessage = {
  id: string;
  matchId: string;
  teamId: string;
  userId: string;
  displayName: string;
  text: string;
  photoURL?: string | null;
  createdAt?: any;

  // ✅ frozen per message id so clustering never “switches back”
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

  // ✅ NEW: match-level sequence for unread counts
  const [matchLastSeq, setMatchLastSeq] = useState<number>(0);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const listRef = useRef<FlatList<ChatMessage>>(null);
  const didInitialScroll = useRef(false);

  // ✅ Freeze a stable timestamp per msgId so order/clustering never flips
  const stableMsByIdRef = useRef<Map<string, number>>(new Map());

  // If you ever decide you want meta on the FIRST message instead, set this to true.
  const META_ON_FIRST_MESSAGE_IN_CLUSTER = false;

  // -------------------------------
  // ✅ Mark-as-read plumbing
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
          lastReadSeq: matchLastSeq ?? 0,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    } catch (e) {
      console.warn("markChatReadNow failed:", e);
    }
  }, [user?.uid, matchIdStr, matchLastSeq]);

  const scheduleMarkChatRead = useCallback(() => {
    if (!user?.uid || !matchIdStr) return;

    if (markReadTimerRef.current) clearTimeout(markReadTimerRef.current);
    markReadTimerRef.current = setTimeout(() => {
      markChatReadNow();
    }, 350);
  }, [user?.uid, matchIdStr, markChatReadNow]);

  useEffect(() => {
    return () => {
      if (markReadTimerRef.current) clearTimeout(markReadTimerRef.current);
    };
  }, []);

  // Mark read when app returns to foreground
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") scheduleMarkChatRead();
    });
    return () => sub.remove();
  }, [scheduleMarkChatRead]);

  // ✅ Live subscribe to match doc (teamId + lastMessageSeq)
  useEffect(() => {
    if (!matchIdStr) {
      setLoading(false);
      setMatchTeamId(null);
      setMatchLastSeq(0);
      return;
    }

    const matchRef = doc(db, "matches", matchIdStr);
    const unsub = onSnapshot(
      matchRef,
      (snap) => {
        if (!snap.exists()) {
          setMatchTeamId(null);
          setMatchLastSeq(0);
          setLoading(false);
          return;
        }

        const data = snap.data() as any;
        const tid = data?.teamId ? String(data.teamId) : null;
        const seq = typeof data?.lastMessageSeq === "number" ? data.lastMessageSeq : 0;

        setMatchTeamId(tid);
        setMatchLastSeq(seq);
        setLoading(false);
      },
      (err) => {
        console.error("Error listening to match for chat:", err);
        setMatchTeamId(null);
        setMatchLastSeq(0);
        setLoading(false);
      }
    );

    return () => unsub();
  }, [matchIdStr]);

  // Live subscribe to messages (query DESC for index, but we sort stably in state)
  useEffect(() => {
    if (!matchIdStr) return;

    const colRef = collection(db, "matchMessages");
    const q = query(
      colRef,
      where("matchId", "==", matchIdStr),
      orderBy("createdAt", "desc"),
      limit(200)
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        const stableMap = stableMsByIdRef.current;
        const nextIds = new Set<string>();

        const list: ChatMessage[] = snap.docs.map((d) => {
          const data = d.data({ serverTimestamps: "estimate" }) as any;

          const id = d.id;
          nextIds.add(id);

          const candidateMs = tsToMs(data.createdAt) || Date.now();

          // ✅ Freeze first-seen stable timestamp
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

        // prune old ids (keeps memory tiny)
        for (const k of stableMap.keys()) {
          if (!nextIds.has(k)) stableMap.delete(k);
        }

        // ✅ Stable sort: oldest -> newest, tie-break by id
        list.sort((a, b) => {
          const dt = a.stableMs - b.stableMs;
          if (dt !== 0) return dt;
          return a.id.localeCompare(b.id);
        });

        setMessages(list);
      },
      (err) => console.error("Chat listener error:", err)
    );

    return () => unsub();
  }, [matchIdStr]);

  // Initial scroll to bottom once
  useEffect(() => {
    if (didInitialScroll.current) return;
    if (messages.length === 0) return;

    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: false });
      didInitialScroll.current = true;
    });
  }, [messages.length]);

  // ✅ Mark read when opening chat + when latest message changes + when match seq changes
  const lastMsgId = messages[messages.length - 1]?.id ?? null;
  useEffect(() => {
    scheduleMarkChatRead();
  }, [scheduleMarkChatRead, lastMsgId, matchLastSeq]);

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
    if (body.length > 500) {
      Alert.alert("Too long", "Please keep messages under 500 characters.");
      return;
    }

    try {
      setSending(true);

      // Best-effort pull from users/{uid}
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

      // ✅ after sending, you are definitely “caught up”
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
          <View style={{ marginTop: 12 }}>
            <TouchableOpacity style={styles.backBtn} onPress={handleBack}>
              <Text style={styles.backBtnText}>Back</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.container}>
          <Text>Loading chat...</Text>
          <View style={{ marginTop: 12 }}>
            <TouchableOpacity style={styles.backBtn} onPress={handleBack}>
              <Text style={styles.backBtnText}>Back</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (!matchTeamId) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.container}>
          <Text>Match not found.</Text>
          <View style={{ marginTop: 12 }}>
            <TouchableOpacity style={styles.backBtn} onPress={handleBack}>
              <Text style={styles.backBtnText}>Back</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  const CLUSTER_MINUTES = 5;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 64 : 0}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity
            onPress={handleBack}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={styles.backText}>‹ Back</Text>
          </TouchableOpacity>

          <Text style={styles.headerTitle}>Match Chat</Text>
          <View style={{ width: 60 }} />
        </View>

        <FlatList
          ref={listRef}
          style={{ flex: 1 }}
          contentContainerStyle={styles.messagesContainer}
          data={messages}
          inverted={false}
          keyExtractor={(m) => m.id}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          removeClippedSubviews={Platform.OS === "android"}
          initialNumToRender={24}
          maxToRenderPerBatch={24}
          windowSize={9}
          ListEmptyComponent={<Text style={styles.emptyText}>No messages yet. Say hi 👋</Text>}
          ListFooterComponent={<View style={{ height: 8 }} />}
          renderItem={({ item, index }) => {
            const mine = item.userId === user?.uid;
            const initials = initialsFromName(item.displayName);

            // messages are ASC (oldest -> newest)
            const prev = messages[index - 1]; // older
            const next = messages[index + 1]; // newer

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

            const isClusterStart = !joinsPrev; // first/oldest message in cluster
            const isClusterEnd = !joinsNext; // last/newest message in cluster

            const showMeta = META_ON_FIRST_MESSAGE_IN_CLUSTER ? isClusterStart : isClusterEnd;

            // date separator on first message of a day (compares with prev / older)
            const showDateSeparator = tCur > 0 && (!prev || !isSameDayMs(tCur, tPrev));

            const timeLabel = showMeta ? formatTimeMs(tCur) : "";

            // ✅ dynamic spacing so clustered messages visually “stick”
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
                  {/* Left avatar (others) */}
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

                  {/* Right avatar (mine) */}
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
  backText: {
    fontSize: 16,
    color: "#007AFF",
    fontWeight: "600",
    width: 60,
  },
  headerTitle: { fontSize: 18, fontWeight: "700" },

  messagesContainer: {
    padding: 16,
    paddingBottom: 8,
  },

  emptyText: { color: "#666" },

  row: {
    flexDirection: "row",
    alignItems: "flex-end",
  },
  rowMine: { justifyContent: "flex-end" },
  rowOther: { justifyContent: "flex-start" },

  avatarWrap: {
    width: AVATAR,
    height: AVATAR,
    borderRadius: AVATAR / 2,
    overflow: "hidden",
    marginHorizontal: 8,
  },
  avatarImg: {
    width: AVATAR,
    height: AVATAR,
    borderRadius: AVATAR / 2,
  },
  avatarFallback: {
    width: AVATAR,
    height: AVATAR,
    borderRadius: AVATAR / 2,
    backgroundColor: "#eef3ff",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontSize: 12,
    fontWeight: "800",
    color: "#2b4cff",
  },
  avatarSpacer: {
    width: AVATAR,
    height: AVATAR,
    marginHorizontal: 8,
    opacity: 0,
  },

  bubble: {
    maxWidth: "70%",
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 12,
  },
  bubbleMine: {
    backgroundColor: "#D7EBFF",
  },
  bubbleOther: {
    backgroundColor: "#F2F2F2",
  },
  bubbleName: {
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 4,
    color: "#333",
  },
  bubbleText: { color: "#111" },
  timeText: {
    marginTop: 6,
    fontSize: 11,
    color: "#666",
    alignSelf: "flex-end",
  },

  dateSepWrap: {
    alignItems: "center",
    marginBottom: 6,
    marginTop: 2,
  },
  dateSepPill: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: "#eee",
  },
  dateSepText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#666",
  },

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
  sendButtonDisabled: {
    backgroundColor: "#9cc7ff",
  },
  sendButtonText: {
    color: "#fff",
    fontWeight: "800",
  },

  backBtn: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: "#eee",
    alignSelf: "flex-start",
  },
  backBtnText: { fontWeight: "700" },
});
