// app/(app)/(tabs)/_layout.tsx
import { Tabs } from "expo-router";
import { collection, doc, onSnapshot, orderBy, query, where } from "firebase/firestore";
import React, { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../../src/context/AuthContext";
import { db } from "../../../src/firebaseConfig";

type MatchMini = {
  id: string;
  teamId?: string;
  lastMessageAt?: any;
  lastMessageSenderId?: string;
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
  const [lastReadByMatchId, setLastReadByMatchId] = useState<Record<string, any>>({});

  // teamId
  useEffect(() => {
    if (!user?.uid) {
      setTeamId(null);
      return;
    }

    const userRef = doc(db, "users", user.uid);
    const unsub = onSnapshot(userRef, (snap) => {
      if (!snap.exists()) {
        setTeamId(null);
        return;
      }
      const data = snap.data() as any;
      const tid = data.teamId ?? data.teamCode ?? data.team ?? data.team_id ?? null;
      setTeamId(tid ?? null);
    });

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

    const unsub = onSnapshot(q, (snap) => {
      const list: MatchMini[] = snap.docs.map((d) => {
        const data = d.data() as any;
        return {
          id: d.id,
          teamId: data.teamId,
          lastMessageAt: data.lastMessageAt,
          lastMessageSenderId: data.lastMessageSenderId,
        };
      });
      setMatches(list);
    });

    return () => unsub();
  }, [teamId]);

  // chatReads
  useEffect(() => {
    if (!user?.uid) {
      setLastReadByMatchId({});
      return;
    }

    const readsCol = collection(db, "users", user.uid, "chatReads");
    const unsub = onSnapshot(readsCol, (snap) => {
      const map: Record<string, any> = {};
      snap.docs.forEach((d) => {
        const data = d.data() as any;
        map[d.id] = data?.lastReadAt ?? null;
      });
      setLastReadByMatchId(map);
    });

    return () => unsub();
  }, [user?.uid]);

  const unreadCount = useMemo(() => {
    if (!user?.uid) return 0;

    let n = 0;
    for (const m of matches) {
      const lastMsgAt = toDateOrNull(m.lastMessageAt);
      if (!lastMsgAt) continue;

      // don't count your own last message as unread
      if (m.lastMessageSenderId === user.uid) continue;

      const lastReadAt = toDateOrNull(lastReadByMatchId[m.id]);
      const unread = !lastReadAt || lastReadAt.getTime() < lastMsgAt.getTime();
      if (unread) n++;
    }
    return n;
  }, [matches, lastReadByMatchId, user?.uid]);

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

      <Tabs.Screen
        name="teams"
        options={{
          title: "Teams",
          tabBarLabel: "Teams",
        }}
      />

      <Tabs.Screen
        name="stats"
        options={{
          title: "Fitness",
          tabBarLabel: "Fitness",
        }}
      />

      <Tabs.Screen
        name="myRsvps"
        options={{
          title: "My RSVPs",
          tabBarLabel: "My RSVPs",
        }}
      />

      <Tabs.Screen
        name="profile"
        options={{
          title: "Profile",
          tabBarLabel: "Profile",
        }}
      />
    </Tabs>
  );
}
