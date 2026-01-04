// app/(app)/(tabs)/_layout.tsx
import { Tabs } from "expo-router";
import { collection, doc, orderBy, query, where, type DocumentData, type QueryDocumentSnapshot } from "firebase/firestore";
import React, { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../../src/context/AuthContext";
import { db } from "../../../src/firebaseConfig";
import { onSnapshotSafe } from "../../../src/firestoreSafe";

type QDoc = QueryDocumentSnapshot<DocumentData>;
type MatchMini = {
  id: string;
  teamId?: string;
  lastMessageAt?: any;
  lastMessageSenderId?: string;

  // ✅ maintained by Cloud Function
  lastMessageSeq?: number;
};

type ChatReadMini = {
  lastReadAt?: any;
  lastReadSeq?: number | null;
};

type ChatPrefMini = {
  muted?: boolean;
  updatedAt?: any;
};

function toDateOrNull(raw: any): Date | null {
  if (!raw) return null;
  if (typeof raw?.toDate === "function") return raw.toDate();
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

export default function AppTabsLayout() {
  const { user } = useAuth();

  const [teamId, setTeamId] = useState<string | null>(null);
  const [matches, setMatches] = useState<MatchMini[]>([]);
  const [readByMatchId, setReadByMatchId] = useState<Record<string, ChatReadMini>>({});

  // ✅ NEW: mute prefs keyed by matchId
  const [prefByMatchId, setPrefByMatchId] = useState<Record<string, ChatPrefMini>>({});

  // teamId
  useEffect(() => {
    if (!user?.uid) {
      setTeamId(null);
      return;
    }

    const userRef = doc(db, "users", user.uid);

    const unsub = onSnapshotSafe(
      userRef,
      (snap) => {
        if (!snap.exists()) {
          setTeamId(null);
          return;
        }
        const data = snap.data() as any;
        const tid = data.teamId ?? data.teamCode ?? data.team ?? data.team_id ?? null;
        setTeamId(tid ?? null);
      },
      {
        label: "tabs:userDoc",
        onPermissionDenied: () => setTeamId(null),
        onError: () => setTeamId(null),
      }
    );

    return () => unsub();
  }, [user?.uid]);

  // matches (for badge count)
  useEffect(() => {
    if (!teamId) {
      setMatches([]);
      return;
    }

    const matchesCol = collection(db, "matches");
    const q = query(matchesCol, where("teamId", "==", teamId), orderBy("startDateTime", "asc"));

    const unsub = onSnapshotSafe(
      q,
      (snap) => {
        const list: MatchMini[] = snap.docs.map((d: QDoc) => {
          const data = d.data() as any;
          return {
            id: d.id,
            teamId: data.teamId,
            lastMessageAt: data.lastMessageAt,
            lastMessageSenderId: data.lastMessageSenderId,
            lastMessageSeq: typeof data.lastMessageSeq === "number" ? data.lastMessageSeq : undefined,
          };
        });
        setMatches(list);
      },
      {
        label: "tabs:matchesForBadge",
        onPermissionDenied: () => setMatches([]),
        onError: () => setMatches([]),
      }
    );

    return () => unsub();
  }, [teamId]);

  // chatReads
  useEffect(() => {
    if (!user?.uid) {
      setReadByMatchId({});
      return;
    }

    const readsCol = collection(db, "users", user.uid, "chatReads");
    const unsub = onSnapshotSafe(
      readsCol,
      (snap) => {
        const map: Record<string, ChatReadMini> = {};
        snap.docs.forEach((d: QDoc) => {
          const data = d.data() as any;
          map[d.id] = {
            lastReadAt: data?.lastReadAt ?? null,
            lastReadSeq: typeof data?.lastReadSeq === "number" ? data.lastReadSeq : null,
          };
        });
        setReadByMatchId(map);
      },
      {
        label: "tabs:chatReads",
        onError: () => setReadByMatchId({}),
        onPermissionDenied: () => setReadByMatchId({}),
      }
    );

    return () => unsub();
  }, [user?.uid]);

  // ✅ NEW: chatPrefs (mute)
  useEffect(() => {
    if (!user?.uid) {
      setPrefByMatchId({});
      return;
    }

    const prefsCol = collection(db, "users", user.uid, "chatPrefs");
    const unsub = onSnapshotSafe(
      prefsCol,
      (snap) => {
        const map: Record<string, ChatPrefMini> = {};
        snap.docs.forEach((d: QDoc) => {
          const data = d.data() as any;
          map[d.id] = {
            muted: data?.muted === true,
            updatedAt: data?.updatedAt ?? null,
          };
        });
        setPrefByMatchId(map);
      },
      {
        label: "tabs:chatPrefs",
        onError: () => setPrefByMatchId({}),
        onPermissionDenied: () => setPrefByMatchId({}),
      }
    );

    return () => unsub();
  }, [user?.uid]);

  const unreadCount = useMemo(() => {
    if (!user?.uid) return 0;

    let n = 0;

    for (const m of matches) {
      const matchId = m.id;

      // ✅ Skip muted chats entirely
      if (prefByMatchId?.[matchId]?.muted === true) continue;

      const lastSeq = typeof m.lastMessageSeq === "number" ? m.lastMessageSeq : null;
      const read = readByMatchId[matchId];
      const readSeq = typeof read?.lastReadSeq === "number" ? read.lastReadSeq : null;

      // don't count if YOUR latest message is the latest thing in the thread
      if (m.lastMessageSenderId === user.uid) continue;

      // ✅ Preferred: exact unread message count via seq
      if (lastSeq != null && lastSeq > 0 && readSeq != null) {
        const delta = Math.max(0, lastSeq - readSeq);
        if (delta > 0) n += delta;
        continue;
      }

      // ✅ Fallback (legacy threads without seq): counts 1 per unread thread
      const lastMsgAt = toDateOrNull(m.lastMessageAt);
      if (!lastMsgAt) continue;

      const lastReadAt = toDateOrNull(read?.lastReadAt);
      const unread = !lastReadAt || lastReadAt.getTime() < lastMsgAt.getTime();
      if (unread) n += 1;
    }

    return n;
  }, [matches, readByMatchId, prefByMatchId, user?.uid]);

  const badge = unreadCount > 0 ? (unreadCount > 99 ? "99+" : unreadCount) : undefined;

  return (
    <Tabs screenOptions={{ headerTitleAlign: "center" }}>
      <Tabs.Screen
        name="matches"
        options={{
          title: "Matches",
          tabBarLabel: "Matches",
          tabBarBadge: badge,
        }}
      />
      <Tabs.Screen name="teams" options={{ title: "Teams", tabBarLabel: "Teams" }} />
      <Tabs.Screen name="stats" options={{ title: "Fitness", tabBarLabel: "Fitness" }} />
      <Tabs.Screen name="myRsvps" options={{ title: "My RSVPs", tabBarLabel: "My RSVPs" }} />
      <Tabs.Screen name="profile" options={{ title: "Profile", tabBarLabel: "Profile" }} />
    </Tabs>
  );
}
