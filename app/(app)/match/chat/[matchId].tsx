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
  where,
} from "firebase/firestore";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
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
};

function paramToString(v: any): string | null {
  if (!v) return null;
  if (Array.isArray(v)) return v[0] ? String(v[0]) : null;
  return String(v);
}

function toDate(raw: any): Date | null {
  if (!raw) return null;
  if (typeof raw?.toDate === "function") return raw.toDate();
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

function initialsFromName(name: string) {
  const base = (name || "").trim();
  if (!base) return "U";
  const parts = base.split(" ").filter(Boolean);
  const first = parts[0]?.[0] ?? "U";
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] : "";
  return (first + last).toUpperCase();
}

function formatTime(raw: any) {
  const d = toDate(raw);
  if (!d) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function MatchChatScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const matchIdStr = paramToString(params?.matchId);
  const { user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [matchTeamId, setMatchTeamId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  // FlatList ref (for occasional scroll control)
  const listRef = useRef<FlatList<ChatMessage> | null>(null);

  // Load teamId from match doc (needed for writing + rules)
  useEffect(() => {
    let alive = true;

    async function loadMatchTeam() {
      if (!matchIdStr) {
        setLoading(false);
        setMatchTeamId(null);
        return;
      }

      try {
        const matchRef = doc(db, "matches", matchIdStr);
        const snap = await getDoc(matchRef);

        if (!alive) return;

        if (!snap.exists()) {
          setMatchTeamId(null);
          setLoading(false);
          return;
        }

        const data = snap.data() as any;
        const tid = data?.teamId ? String(data.teamId) : null;
        setMatchTeamId(tid);
        setLoading(false);
      } catch (e) {
        console.error("Error loading match for chat:", e);
        if (!alive) return;
        setMatchTeamId(null);
        setLoading(false);
      }
    }

    loadMatchTeam();
    return () => {
      alive = false;
    };
  }, [matchIdStr]);

  // Live subscribe to messages (newest first for FlatList + inverted)
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
        const list: ChatMessage[] = snap.docs.map((d) => {
          const data = d.data() as any;
          return {
            id: d.id,
            matchId: String(data.matchId ?? ""),
            teamId: String(data.teamId ?? ""),
            userId: String(data.userId ?? ""),
            displayName: String(data.displayName ?? "Someone"),
            text: String(data.text ?? ""),
            photoURL: (data.photoURL as string) ?? null,
            createdAt: data.createdAt,
          };
        });

        setMessages(list);
      },
      (err) => console.error("Chat listener error:", err)
    );

    return () => unsub();
  }, [matchIdStr]);

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

      // Best-effort pull from users/{uid} (you can read your own doc)
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

      // optional: nudge list to bottom (inverted list => offset 0 is bottom)
      requestAnimationFrame(() => {
        listRef.current?.scrollToOffset({ offset: 0, animated: true });
      });
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
            <Button title="Back" onPress={handleBack} />
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
            <Button title="Back" onPress={handleBack} />
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
            <Button title="Back" onPress={handleBack} />
          </View>
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
          ref={(r) => {
            listRef.current = r;
          }}
          style={{ flex: 1 }}
          contentContainerStyle={styles.messagesContainer}
          data={messages}
          inverted
          keyExtractor={(m) => m.id}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <Text style={styles.emptyText}>No messages yet. Say hi 👋</Text>
          }
          renderItem={({ item }) => {
            const mine = item.userId === user?.uid;
            const initials = initialsFromName(item.displayName);
            const t = formatTime(item.createdAt);

            return (
              <View style={[styles.row, mine ? styles.rowMine : styles.rowOther]}>
                {!mine && (
                  <View style={styles.avatarWrap}>
                    {item.photoURL ? (
                      <Image source={{ uri: item.photoURL }} style={styles.avatarImg} />
                    ) : (
                      <View style={styles.avatarFallback}>
                        <Text style={styles.avatarText}>{initials}</Text>
                      </View>
                    )}
                  </View>
                )}

                <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleOther]}>
                  {!mine && <Text style={styles.bubbleName}>{item.displayName}</Text>}
                  <Text style={styles.bubbleText}>{item.text}</Text>
                  {!!t && <Text style={styles.timeText}>{t}</Text>}
                </View>

                {mine && (
                  <View style={styles.avatarWrap}>
                    {/* show my avatar too for symmetry (optional) */}
                    {item.photoURL ? (
                      <Image source={{ uri: item.photoURL }} style={styles.avatarImg} />
                    ) : (
                      <View style={styles.avatarFallback}>
                        <Text style={styles.avatarText}>{initials}</Text>
                      </View>
                    )}
                  </View>
                )}
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
          <View style={styles.sendBtn}>
            <Button title={sending ? "…" : "Send"} onPress={handleSend} disabled={!canSend} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

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
    gap: 10,
  },

  emptyText: { color: "#666" },

  row: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
  },
  rowMine: {
    justifyContent: "flex-end",
  },
  rowOther: {
    justifyContent: "flex-start",
  },

  avatarWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    overflow: "hidden",
  },
  avatarImg: {
    width: 32,
    height: 32,
    borderRadius: 16,
  },
  avatarFallback: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#eef3ff",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontSize: 12,
    fontWeight: "800",
    color: "#2b4cff",
  },

  bubble: {
    maxWidth: "78%",
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
  sendBtn: { width: 80 },
});
