// app/(app)/match/chat/[matchId].tsx
import { useLocalSearchParams, useRouter } from "expo-router";
import {
    addDoc,
    collection,
    doc,
    getDoc,
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
    KeyboardAvoidingView,
    Platform,
    ScrollView,
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
  createdAt?: any;
};

function paramToString(v: any): string | null {
  if (!v) return null;
  if (Array.isArray(v)) return v[0] ? String(v[0]) : null;
  return String(v);
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

  // Auto-scroll ref
  const scrollRef = useRef<ScrollView | null>(null);

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

  // Live subscribe to messages
  useEffect(() => {
    if (!matchIdStr) return;

    const colRef = collection(db, "matchMessages");
    const q = query(colRef, where("matchId", "==", matchIdStr), orderBy("createdAt", "asc"));

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
            createdAt: data.createdAt,
          };
        });

        setMessages(list);

        // scroll to bottom after messages arrive
        setTimeout(() => {
          scrollRef.current?.scrollToEnd({ animated: true });
        }, 50);
      },
      (err) => {
        console.error("Chat listener error:", err);
      }
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
    if (!user?.uid) {
      Alert.alert("Please sign in");
      return;
    }
    if (!matchIdStr) {
      Alert.alert("Missing match id");
      return;
    }
    if (!matchTeamId) {
      Alert.alert("Match not found");
      return;
    }

    const body = text.trim();
    if (!body) return;
    if (body.length > 500) {
      Alert.alert("Too long", "Please keep messages under 500 characters.");
      return;
    }

    try {
      setSending(true);

      // best-effort displayName from users/{uid}.displayName
      let displayName = user.email ?? "Player";
      try {
        const userRef = doc(db, "users", user.uid);
        const userSnap = await getDoc(userRef);
        if (userSnap.exists()) {
          const ud = userSnap.data() as any;
          if (ud?.displayName) displayName = String(ud.displayName);
        }
      } catch {
        // ignore
      }

      await addDoc(collection(db, "matchMessages"), {
        matchId: matchIdStr,
        teamId: matchTeamId,
        userId: user.uid,
        displayName,
        text: body,
        createdAt: serverTimestamp(),
      });

      setText("");
      setTimeout(() => {
        scrollRef.current?.scrollToEnd({ animated: true });
      }, 50);
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
        {/* Header with back */}
        <View style={styles.header}>
          <TouchableOpacity onPress={handleBack} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={styles.backText}>‹ Back</Text>
          </TouchableOpacity>

          <Text style={styles.headerTitle}>Match Chat</Text>

          {/* spacer so title stays centered */}
          <View style={{ width: 60 }} />
        </View>

        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.messagesContainer}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        >
          {messages.length === 0 ? (
            <Text style={styles.emptyText}>No messages yet. Say hi 👋</Text>
          ) : (
            messages.map((m) => {
              const mine = m.userId === user?.uid;
              return (
                <View
                  key={m.id}
                  style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleOther]}
                >
                  {!mine && <Text style={styles.bubbleName}>{m.displayName}</Text>}
                  <Text style={styles.bubbleText}>{m.text}</Text>
                </View>
              );
            })
          )}

          <View style={{ height: 12 }} />
        </ScrollView>

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
  },

  emptyText: { color: "#666" },

  bubble: {
    maxWidth: "85%",
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 12,
    marginBottom: 10,
  },
  bubbleMine: {
    alignSelf: "flex-end",
    backgroundColor: "#D7EBFF",
  },
  bubbleOther: {
    alignSelf: "flex-start",
    backgroundColor: "#F2F2F2",
  },
  bubbleName: {
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 4,
    color: "#333",
  },
  bubbleText: { color: "#111" },

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
  sendBtn: {
    width: 80,
  },
});
