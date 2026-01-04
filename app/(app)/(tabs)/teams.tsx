// app/(app)/(tabs)/teams.tsx
import {
  collection,
  doc,
  onSnapshot,
  query,
  where
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import React, { useEffect, useMemo, useState } from "react";
import { Alert, Button, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../../src/context/AuthContext";
import { db, functions } from "../../../src/firebaseConfig";

type Team = {
  id: string;
  name?: string;
  homeCity?: string;
  defaultMaxPlayers?: number;
  inviteCode?: string; // ✅ new (rotatable)
  createdBy?: string;
};

type Membership = {
  id: string;
  teamId: string;
  teamName?: string;
  userId: string;
  userDisplayName?: string;
  userEmail?: string;
  role: "owner" | "admin" | "member";
  status: "pending" | "active" | "removed" | "left";
  createdAt?: any;
  updatedAt?: any;
};

function normalizeCode(raw: string) {
  return raw.trim().toLowerCase();
}

function isValidTeamCode(code: string) {
  return /^[a-z0-9-]{3,24}$/.test(code);
}

function isAdminRole(role?: string) {
  return role === "owner" || role === "admin";
}

function prettyFnError(e: any) {
  const msg = String(e?.message ?? e ?? "");
  const code = String(e?.code ?? "");

  // firebase functions errors often look like: "functions/failed-precondition"
  if (code.includes("failed-precondition") || msg.toLowerCase().includes("failed-precondition")) {
    return "That action isn’t allowed right now (likely already in a team / owner cannot leave).";
  }
  if (code.includes("permission-denied") || msg.toLowerCase().includes("permission")) {
    return "Permission denied.";
  }
  if (code.includes("not-found") || msg.toLowerCase().includes("not found")) {
    return "Not found.";
  }
  return msg || "Something went wrong.";
}

export default function TeamsScreen() {
  const { user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Join
  const [joinCode, setJoinCode] = useState("");

  // Create
  const [newTeamName, setNewTeamName] = useState("");
  const [newTeamCode, setNewTeamCode] = useState("");

  // Data
  const [myMemberships, setMyMemberships] = useState<Membership[]>([]);
  const [team, setTeam] = useState<Team | null>(null);
  const [members, setMembers] = useState<Membership[]>([]);
  const [pendingRequests, setPendingRequests] = useState<Membership[]>([]);

  const activeMembership = useMemo(
    () => myMemberships.find((m) => m.status === "active") ?? null,
    [myMemberships]
  );
  const pendingMembership = useMemo(() => {
    // if multiple pending, just pick first
    return myMemberships.find((m) => m.status === "pending") ?? null;
  }, [myMemberships]);

  const myRole = activeMembership?.role ?? null;
  const isAdmin = isAdminRole(myRole ?? undefined);

  // Callables
  const fnCreateTeam = useMemo(() => httpsCallable(functions, "createTeam"), []);
  const fnJoinTeamWithCode = useMemo(() => httpsCallable(functions, "joinTeamWithCode"), []);
  const fnLeaveTeam = useMemo(() => httpsCallable(functions, "leaveTeam"), []);
  const fnApproveMembership = useMemo(() => httpsCallable(functions, "approveMembership"), []);
  const fnDenyMembership = useMemo(() => httpsCallable(functions, "denyMembership"), []);
  const fnKickMember = useMemo(() => httpsCallable(functions, "kickMember"), []);
  const fnRotateInviteCode = useMemo(() => httpsCallable(functions, "rotateInviteCode"), []);
  const fnCancelMyPending = useMemo(() => httpsCallable(functions, "cancelMyPendingMembership"), []);

  // 1) Listen to my memberships
  useEffect(() => {
    if (!user?.uid) {
      setMyMemberships([]);
      setTeam(null);
      setMembers([]);
      setPendingRequests([]);
      setLoading(false);
      return;
    }

    const qMine = query(collection(db, "memberships"), where("userId", "==", user.uid));
    const unsub = onSnapshot(
      qMine,
      (snap) => {
        const list: Membership[] = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
        setMyMemberships(list);
        setLoading(false);
      },
      (err) => {
        console.warn("memberships(userId) listener failed:", err);
        setLoading(false);
      }
    );

    return () => unsub();
  }, [user?.uid]);

  // 2) Load team doc when I’m active in a team
  useEffect(() => {
    if (!activeMembership?.teamId) {
      setTeam(null);
      return;
    }

    const teamRef = doc(db, "teams", activeMembership.teamId);
    const unsub = onSnapshot(
      teamRef,
      (snap) => {
        if (!snap.exists()) {
          setTeam(null);
          return;
        }
        setTeam({ id: snap.id, ...(snap.data() as any) });
      },
      (err) => console.warn("team listener failed:", err)
    );

    return () => unsub();
  }, [activeMembership?.teamId]);

  // 3) Members list (active members) for this team
  useEffect(() => {
    const teamId = activeMembership?.teamId;
    if (!teamId) {
      setMembers([]);
      return;
    }

    const qMembers = query(
      collection(db, "memberships"),
      where("teamId", "==", teamId),
      where("status", "==", "active")
    );

    const unsub = onSnapshot(
      qMembers,
      (snap) => {
        const list: Membership[] = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
        setMembers(list);
      },
      (err) => console.warn("members list listener failed:", err)
    );

    return () => unsub();
  }, [activeMembership?.teamId]);

  // 4) Pending join requests (admins only)
  useEffect(() => {
    const teamId = activeMembership?.teamId;
    if (!teamId || !isAdmin) {
      setPendingRequests([]);
      return;
    }

    const qPending = query(
      collection(db, "memberships"),
      where("teamId", "==", teamId),
      where("status", "==", "pending")
    );

    const unsub = onSnapshot(
      qPending,
      (snap) => {
        const list: Membership[] = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
        setPendingRequests(list);
      },
      (err) => console.warn("pending list listener failed:", err)
    );

    return () => unsub();
  }, [activeMembership?.teamId, isAdmin]);

  const handleJoinTeam = async () => {
    if (!user?.uid) return;

    if (activeMembership) {
      Alert.alert("Already in a team", "Leave your current team before joining another.");
      return;
    }
    if (pendingMembership) {
      Alert.alert("Request pending", "You already have a pending request. Cancel it first if you want to join a different team.");
      return;
    }

    const code = normalizeCode(joinCode);
    if (!code) {
      Alert.alert("Invalid code", "Please enter a team code.");
      return;
    }
    if (!isValidTeamCode(code)) {
      Alert.alert("Invalid code", "Use 3–24 chars: lowercase letters/numbers/hyphens only.");
      return;
    }

    setSaving(true);
    try {
      const res: any = await fnJoinTeamWithCode({ code });
      const data = res?.data ?? {};
      setJoinCode("");

      if (data?.status === "pending") {
        Alert.alert("Request sent", `Waiting for approval to join ${data?.teamName ?? data?.teamId ?? "the team"}.`);
      } else {
        Alert.alert("Joined", "You’re in!");
      }
    } catch (e) {
      console.error("joinTeamWithCode failed:", e);
      Alert.alert("Error", prettyFnError(e));
    } finally {
      setSaving(false);
    }
  };

  const handleCreateTeam = async () => {
    if (!user?.uid) return;

    if (activeMembership) {
      Alert.alert("Already in a team", "Leave your current team before creating a new one.");
      return;
    }
    if (pendingMembership) {
      Alert.alert("Request pending", "Cancel your pending request before creating a team.");
      return;
    }

    const name = newTeamName.trim();
    const code = normalizeCode(newTeamCode);

    if (!name) {
      Alert.alert("Team name required", "Please enter a team name.");
      return;
    }
    if (!code) {
      Alert.alert("Team code required", "Please enter a team code.");
      return;
    }
    if (!isValidTeamCode(code)) {
      Alert.alert("Invalid team code", "Use 3–24 chars: lowercase letters/numbers/hyphens only.");
      return;
    }

    setSaving(true);
    try {
      const res: any = await fnCreateTeam({ name, code });
      const data = res?.data ?? {};
      setNewTeamName("");
      setNewTeamCode("");
      Alert.alert("Team created", `Created ${data?.teamName ?? name}.\nInvite code: ${data?.inviteCode ?? code}`);
    } catch (e) {
      console.error("createTeam failed:", e);
      Alert.alert("Error", prettyFnError(e));
    } finally {
      setSaving(false);
    }
  };

  const handleLeaveTeam = async () => {
    if (!activeMembership?.teamId) return;

    Alert.alert("Leave team?", "You’ll lose access to team matches/chats.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Leave",
        style: "destructive",
        onPress: async () => {
          setSaving(true);
          try {
            await fnLeaveTeam({});
          } catch (e) {
            console.error("leaveTeam failed:", e);
            Alert.alert("Error", prettyFnError(e));
          } finally {
            setSaving(false);
          }
        },
      },
    ]);
  };

  const handleCancelPending = async () => {
    if (!pendingMembership?.teamId) return;

    setSaving(true);
    try {
      await fnCancelMyPending({ teamId: pendingMembership.teamId });
    } catch (e) {
      console.error("cancelMyPendingMembership failed:", e);
      Alert.alert("Error", prettyFnError(e));
    } finally {
      setSaving(false);
    }
  };

  const handleApprove = async (uid: string) => {
    if (!activeMembership?.teamId) return;
    setSaving(true);
    try {
      await fnApproveMembership({ teamId: activeMembership.teamId, userId: uid });
    } catch (e) {
      console.error("approveMembership failed:", e);
      Alert.alert("Error", prettyFnError(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDeny = async (uid: string) => {
    if (!activeMembership?.teamId) return;
    setSaving(true);
    try {
      await fnDenyMembership({ teamId: activeMembership.teamId, userId: uid });
    } catch (e) {
      console.error("denyMembership failed:", e);
      Alert.alert("Error", prettyFnError(e));
    } finally {
      setSaving(false);
    }
  };

  const handleKick = async (uid: string) => {
    if (!activeMembership?.teamId) return;
    Alert.alert("Remove member?", "They’ll be removed from the team.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          setSaving(true);
          try {
            await fnKickMember({ teamId: activeMembership.teamId, userId: uid });
          } catch (e) {
            console.error("kickMember failed:", e);
            Alert.alert("Error", prettyFnError(e));
          } finally {
            setSaving(false);
          }
        },
      },
    ]);
  };

  const handleRotateInvite = async () => {
    if (!activeMembership?.teamId) return;
    setSaving(true);
    try {
      const res: any = await fnRotateInviteCode({ teamId: activeMembership.teamId });
      const data = res?.data ?? {};
      Alert.alert("Invite code rotated", `New invite code: ${data?.inviteCode ?? ""}`);
    } catch (e) {
      console.error("rotateInviteCode failed:", e);
      Alert.alert("Error", prettyFnError(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.container}>
          <Text>Loading…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!user) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.container}>
          <Text>Please sign in to manage your team.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const inviteCode = team?.inviteCode ?? team?.id ?? activeMembership?.teamId ?? "";

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Your Team</Text>

        {activeMembership && team ? (
          <View style={styles.card}>
            <Text style={styles.teamName}>{team.name ?? team.id}</Text>
            <Text style={styles.teamMeta}>Role: {activeMembership.role}</Text>
            <Text style={styles.teamMeta}>Invite code: {inviteCode}</Text>

            <View style={{ height: 10 }} />

            <Button
              title={saving ? "Working..." : "Leave team"}
              onPress={handleLeaveTeam}
              disabled={saving}
              color="#d11"
            />

            {isAdmin && (
              <>
                <View style={{ height: 10 }} />
                <Button
                  title={saving ? "Working..." : "Rotate invite code"}
                  onPress={handleRotateInvite}
                  disabled={saving}
                />
              </>
            )}
          </View>
        ) : pendingMembership ? (
          <View style={styles.card}>
            <Text style={styles.teamName}>Request pending</Text>
            <Text style={styles.teamMeta}>
              Team: {pendingMembership.teamName ?? pendingMembership.teamId}
            </Text>
            <View style={{ height: 10 }} />
            <Button
              title={saving ? "Working..." : "Cancel request"}
              onPress={handleCancelPending}
              disabled={saving}
              color="#d11"
            />
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.teamMeta}>
              You’re not in a team yet. Join using a code, or create a new team.
            </Text>
          </View>
        )}

        {/* Admin: pending requests */}
        {activeMembership && isAdmin && pendingRequests.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Pending requests</Text>

            {pendingRequests.map((r) => (
              <View key={r.id} style={styles.rowCard}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: "700" }}>
                    {r.userDisplayName ?? r.userEmail ?? r.userId}
                  </Text>
                  <Text style={{ color: "#666", marginTop: 2 }}>
                    {r.userEmail ?? r.userId}
                  </Text>
                </View>

                <View style={{ gap: 8 }}>
                  <Button title="Approve" onPress={() => handleApprove(r.userId)} disabled={saving} />
                  <Button title="Deny" onPress={() => handleDeny(r.userId)} disabled={saving} color="#d11" />
                </View>
              </View>
            ))}
          </View>
        )}

        {/* Members list */}
        {activeMembership && members.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Members</Text>

            {members.map((m) => {
              const isMe = m.userId === user.uid;
              const canKick = isAdmin && !isMe && m.role !== "owner"; // keep it simple
              return (
                <View key={m.id} style={styles.rowCard}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontWeight: "700" }}>
                      {m.userDisplayName ?? m.userEmail ?? m.userId} {isMe ? "(you)" : ""}
                    </Text>
                    <Text style={{ color: "#666", marginTop: 2 }}>
                      {m.role}
                    </Text>
                  </View>

                  {canKick ? (
                    <Button title="Remove" color="#d11" onPress={() => handleKick(m.userId)} disabled={saving} />
                  ) : null}
                </View>
              );
            })}
          </View>
        )}

        {/* Join (only if not active/pending) */}
        {!activeMembership && !pendingMembership && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Join by team code</Text>
            <TextInput
              style={styles.input}
              placeholder="Enter team code"
              value={joinCode}
              onChangeText={setJoinCode}
              autoCapitalize="none"
              editable={!saving}
            />
            <Button
              title={saving ? "Working..." : "Request to join"}
              onPress={handleJoinTeam}
              disabled={saving}
            />
          </View>
        )}

        {/* Create (only if not active/pending) */}
        {!activeMembership && !pendingMembership && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Create a new team</Text>

            <Text style={styles.label}>Team name</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. goatfc"
              value={newTeamName}
              onChangeText={setNewTeamName}
              editable={!saving}
            />

            <Text style={styles.label}>Team code</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. goatfc (letters/numbers/hyphens)"
              value={newTeamCode}
              onChangeText={setNewTeamCode}
              autoCapitalize="none"
              editable={!saving}
            />
            <Text style={styles.helper}>3–24 chars, lowercase letters/numbers/hyphens only.</Text>

            <Button
              title={saving ? "Working..." : "Create team"}
              onPress={handleCreateTeam}
              disabled={saving}
            />
          </View>
        )}

        <View style={{ height: 30 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { padding: 16 },
  title: { fontSize: 22, fontWeight: "700", marginBottom: 16 },
  card: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#ddd",
    marginBottom: 20,
    backgroundColor: "#fff",
  },
  teamName: { fontSize: 18, fontWeight: "800", marginBottom: 6 },
  teamMeta: { fontSize: 14, color: "#555", marginTop: 2 },
  section: { marginBottom: 22 },
  sectionTitle: { fontSize: 16, fontWeight: "700", marginBottom: 10 },
  rowCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#eee",
    backgroundColor: "#fff",
    marginBottom: 10,
  },
  label: { fontSize: 14, fontWeight: "600", marginBottom: 6, marginTop: 8 },
  helper: { fontSize: 12, color: "#666", marginBottom: 10 },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
  },
});
