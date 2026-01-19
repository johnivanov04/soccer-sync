// app/(app)/(tabs)/teams.tsx
import {
  collection,
  doc,
  query,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../../src/context/AuthContext";
import { db, functions } from "../../../src/firebaseConfig";
import { onSnapshotSafe } from "../../../src/firestoreSafe";

type QDoc = QueryDocumentSnapshot<DocumentData>;

type Team = {
  id: string;
  name?: string;
  homeCity?: string;
  defaultMaxPlayers?: number;
  inviteCode?: string; // rotatable
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

function initialsFromName(name?: string | null) {
  const base = (name ?? "").trim();
  if (!base) return "U";
  const parts = base.split(" ").filter(Boolean);
  const first = parts[0]?.[0] ?? "U";
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] : "";
  return (first + last).toUpperCase();
}

function Pill({ text }: { text: string }) {
  return (
    <View style={styles.pill}>
      <Text style={styles.pillText}>{text}</Text>
    </View>
  );
}

function GlassCard({ children }: { children: React.ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

function SectionTitle({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {!!subtitle && <Text style={styles.sectionSubtitle}>{subtitle}</Text>}
    </View>
  );
}

function ActionButton({
  title,
  onPress,
  disabled,
  variant = "primary",
  rightSlot,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "danger";
  rightSlot?: React.ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!!disabled}
      style={({ pressed }) => [
        styles.btnBase,
        variant === "primary" && styles.btnPrimary,
        variant === "secondary" && styles.btnSecondary,
        variant === "danger" && styles.btnDanger,
        disabled && styles.btnDisabled,
        pressed && !disabled ? { transform: [{ scale: 0.99 }] } : null,
      ]}
    >
      <Text
        style={[
          styles.btnText,
          variant === "secondary" ? styles.btnTextSecondary : styles.btnTextPrimary,
        ]}
      >
        {title}
      </Text>
      {!!rightSlot && <View style={{ marginLeft: 10 }}>{rightSlot}</View>}
    </Pressable>
  );
}

function SmallButton({
  title,
  onPress,
  disabled,
  variant = "primary",
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: "primary" | "danger" | "secondary";
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!!disabled}
      style={({ pressed }) => [
        styles.smallBtn,
        variant === "primary" && styles.smallBtnPrimary,
        variant === "secondary" && styles.smallBtnSecondary,
        variant === "danger" && styles.smallBtnDanger,
        disabled && { opacity: 0.6 },
        pressed && !disabled ? { transform: [{ scale: 0.98 }] } : null,
      ]}
    >
      <Text
        style={[
          styles.smallBtnText,
          variant === "secondary" ? styles.smallBtnTextSecondary : styles.smallBtnTextPrimary,
        ]}
      >
        {title}
      </Text>
    </Pressable>
  );
}

function InputRow({
  label,
  icon,
  placeholder,
  value,
  onChangeText,
  editable,
  autoCapitalize,
  keyboardType,
  helper,
}: {
  label: string;
  icon: string;
  placeholder: string;
  value: string;
  onChangeText: (v: string) => void;
  editable?: boolean;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  keyboardType?: "default" | "email-address";
  helper?: string;
}) {
  return (
    <View style={{ marginTop: 12 }}>
      <Text style={styles.label}>{label}</Text>
      <View style={[styles.inputRow, !editable && { opacity: 0.75 }]}>
        <Text style={styles.inputIcon}>{icon}</Text>
        <TextInput
          style={styles.input}
          placeholder={placeholder}
          placeholderTextColor="rgba(255,255,255,0.35)"
          value={value}
          onChangeText={onChangeText}
          editable={editable}
          autoCapitalize={autoCapitalize}
          keyboardType={keyboardType}
        />
      </View>
      {!!helper && <Text style={styles.helper}>{helper}</Text>}
    </View>
  );
}

function PersonRow({
  name,
  subtitle,
  right,
}: {
  name: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  const initials = initialsFromName(name);
  return (
    <View style={styles.rowCard}>
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{initials}</Text>
      </View>

      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle}>{name}</Text>
        {!!subtitle && <Text style={styles.rowSub}>{subtitle}</Text>}
      </View>

      {!!right && <View style={{ marginLeft: 10 }}>{right}</View>}
    </View>
  );
}
//cheating

export default function TeamsScreen() {
  const { user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // ✅ suppress team/members/pending listeners immediately when leaving
  const [suppressTeamListeners, setSuppressTeamListeners] = useState(false);

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

  const activeMembershipRaw = useMemo(
    () => myMemberships.find((m) => m.status === "active") ?? null,
    [myMemberships]
  );

  // ✅ If suppressed, pretend we have no active membership
  const activeMembership = suppressTeamListeners ? null : activeMembershipRaw;

  const pendingMembership = useMemo(() => {
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
    const unsub = onSnapshotSafe(
      qMine,
      (snap) => {
        const list: Membership[] = snap.docs.map((d: QDoc) => ({ id: d.id, ...(d.data() as any) }));
        setMyMemberships(list);
        setLoading(false);

        // ✅ once there is no active membership, let listeners run normally again
        const stillActive = list.some((m) => m.status === "active");
        if (!stillActive) setSuppressTeamListeners(false);
      },
      {
        label: "teams:memberships(userId)",
        onError: (err) => {
          console.warn("memberships(userId) listener failed:", err);
          setLoading(false);
        },
      }
    );

    return () => unsub();
  }, [user?.uid]);

  // 2) Load team doc when I’m active in a team
  useEffect(() => {
    const teamId = activeMembership?.teamId ?? null;

    if (!teamId) {
      setTeam(null);
      return;
    }

    const teamRef = doc(db, "teams", teamId);
    const unsub = onSnapshotSafe(
      teamRef,
      (snap) => {
        if (!snap.exists()) {
          setTeam(null);
          return;
        }
        setTeam({ id: snap.id, ...(snap.data() as any) });
      },
      {
        label: "teams:teamDoc",
        onPermissionDenied: () => setTeam(null),
        onError: (err) => {
          console.warn("team listener failed:", err);
          setTeam(null);
        },
      }
    );

    return () => unsub();
  }, [activeMembership?.teamId]);

  // 3) Members list (active members) for this team
  useEffect(() => {
    const teamId = activeMembership?.teamId ?? null;

    if (!teamId) {
      setMembers([]);
      return;
    }

    const qMembers = query(
      collection(db, "memberships"),
      where("teamId", "==", teamId),
      where("status", "==", "active")
    );

    const unsub = onSnapshotSafe(
      qMembers,
      (snap) => {
        const list: Membership[] = snap.docs.map((d: QDoc) => ({ id: d.id, ...(d.data() as any) }));
        setMembers(list);
      },
      {
        label: "teams:members(active)",
        onPermissionDenied: () => setMembers([]),
        onError: (err) => {
          console.warn("members list listener failed:", err);
          setMembers([]);
        },
      }
    );

    return () => unsub();
  }, [activeMembership?.teamId]);

  // 4) Pending join requests (admins only)
  useEffect(() => {
    const teamId = activeMembership?.teamId ?? null;

    if (!teamId || !isAdmin) {
      setPendingRequests([]);
      return;
    }

    const qPending = query(
      collection(db, "memberships"),
      where("teamId", "==", teamId),
      where("status", "==", "pending")
    );

    const unsub = onSnapshotSafe(
      qPending,
      (snap) => {
        const list: Membership[] = snap.docs.map((d: QDoc) => ({ id: d.id, ...(d.data() as any) }));
        setPendingRequests(list);
      },
      {
        label: "teams:pending",
        onPermissionDenied: () => setPendingRequests([]),
        onError: (err) => {
          console.warn("pending list listener failed:", err);
          setPendingRequests([]);
        },
      }
    );

    return () => unsub();
  }, [activeMembership?.teamId, isAdmin]);

  const handleJoinTeam = async () => {
    if (!user?.uid) return;

    if (activeMembershipRaw) {
      Alert.alert("Already in a team", "Leave your current team before joining another.");
      return;
    }
    if (pendingMembership) {
      Alert.alert(
        "Request pending",
        "You already have a pending request. Cancel it first if you want to join a different team."
      );
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
        Alert.alert(
          "Request sent",
          `Waiting for approval to join ${data?.teamName ?? data?.teamId ?? "the team"}.`
        );
      } else {
        Alert.alert("Joined", "You’re in!");
      }
    } catch (e) {
      console.warn("joinTeamWithCode failed:", e);
      Alert.alert("Error", prettyFnError(e));
    } finally {
      setSaving(false);
    }
  };

  const handleCreateTeam = async () => {
    if (!user?.uid) return;

    if (activeMembershipRaw) {
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
      Alert.alert(
        "Team created",
        `Created ${data?.teamName ?? name}.\nInvite code: ${data?.inviteCode ?? code}`
      );
    } catch (e) {
      console.warn("createTeam failed:", e);
      Alert.alert("Error", prettyFnError(e));
    } finally {
      setSaving(false);
    }
  };

  const handleLeaveTeam = async () => {
    const teamId = activeMembershipRaw?.teamId;
    if (!teamId) return;

    Alert.alert("Leave team?", "You’ll lose access to team matches/chats.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Leave",
        style: "destructive",
        onPress: async () => {
          setSaving(true);

          // ✅ stop listeners *before* permissions flip
          setSuppressTeamListeners(true);
          setTeam(null);
          setMembers([]);
          setPendingRequests([]);

          try {
            await fnLeaveTeam({});
          } catch (e) {
            // if leave fails (e.g. owner), re-enable
            setSuppressTeamListeners(false);
            console.warn("leaveTeam failed:", e);
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
      console.warn("cancelMyPendingMembership failed:", e);
      Alert.alert("Error", prettyFnError(e));
    } finally {
      setSaving(false);
    }
  };

  const handleApprove = async (uid: string) => {
    if (!activeMembershipRaw?.teamId) return;
    setSaving(true);
    try {
      await fnApproveMembership({ teamId: activeMembershipRaw.teamId, userId: uid });
    } catch (e) {
      console.warn("approveMembership failed:", e);
      Alert.alert("Error", prettyFnError(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDeny = async (uid: string) => {
    if (!activeMembershipRaw?.teamId) return;
    setSaving(true);
    try {
      await fnDenyMembership({ teamId: activeMembershipRaw.teamId, userId: uid });
    } catch (e) {
      console.warn("denyMembership failed:", e);
      Alert.alert("Error", prettyFnError(e));
    } finally {
      setSaving(false);
    }
  };

  const handleKick = async (uid: string) => {
    if (!activeMembershipRaw?.teamId) return;
    Alert.alert("Remove member?", "They’ll be removed from the team.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          setSaving(true);
          try {
            await fnKickMember({ teamId: activeMembershipRaw.teamId, userId: uid });
          } catch (e) {
            console.warn("kickMember failed:", e);
            Alert.alert("Error", prettyFnError(e));
          } finally {
            setSaving(false);
          }
        },
      },
    ]);
  };

  const handleRotateInvite = async () => {
    if (!activeMembershipRaw?.teamId) return;
    setSaving(true);
    try {
      const res: any = await fnRotateInviteCode({ teamId: activeMembershipRaw.teamId });
      const data = res?.data ?? {};
      Alert.alert("Invite code rotated", `New invite code: ${data?.inviteCode ?? ""}`);
    } catch (e) {
      console.warn("rotateInviteCode failed:", e);
      Alert.alert("Error", prettyFnError(e));
    } finally {
      setSaving(false);
    }
  };

  const header = (
    <View style={styles.header}>
      <Text style={styles.title}>Teams</Text>
      <Text style={styles.subtitle}>Create a squad, approve requests, and manage members.</Text>
    </View>
  );

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={["left", "right", "bottom"]}>
        <View style={styles.screen}>
          <View style={styles.bg} />
          <View style={styles.bgGlowTop} />
          <View style={styles.bgGlowBottom} />

          <View style={[styles.container, { justifyContent: "center" }]}>
            {header}
            <View style={{ marginTop: 20, alignItems: "center" }}>
              <ActivityIndicator />
              <Text style={styles.muted}>(Loading team…)</Text>
            </View>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (!user) {
    return (
      <SafeAreaView style={styles.safe} edges={["left", "right", "bottom"]}>
        <View style={styles.screen}>
          <View style={styles.bg} />
          <View style={styles.bgGlowTop} />
          <View style={styles.bgGlowBottom} />

          <View style={styles.container}>
            {header}
            <GlassCard>
              <Text style={styles.cardText}>Please sign in to manage your team.</Text>
            </GlassCard>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  const inviteCode = team?.inviteCode ?? "";

  return (
    <SafeAreaView style={styles.safe} edges={["left", "right", "bottom"]}>
      <View style={styles.screen}>
        {/* Background */}
        <View style={styles.bg} />
        <View style={styles.bgGlowTop} />
        <View style={styles.bgGlowBottom} />

        <ScrollView contentContainerStyle={styles.container}>
          {header}

          {/* Status card */}
          {activeMembership && team ? (
            <GlassCard>
              <View style={styles.cardHeaderRow}>
                <Text style={styles.teamName}>{team.name ?? team.id}</Text>
                <Pill text={activeMembership.role.toUpperCase()} />
              </View>

              <Text style={styles.cardText}>
                Invite code{" "}
                <Text style={styles.cardTextStrong}>{inviteCode || "(none)"}</Text>
              </Text>

              <View style={{ height: 14 }} />

              <ActionButton
                title={saving ? "Working…" : "Leave team"}
                onPress={handleLeaveTeam}
                disabled={saving}
                variant="danger"
                rightSlot={saving ? <ActivityIndicator /> : null}
              />

              {isAdmin && (
                <View style={{ marginTop: 10 }}>
                  <ActionButton
                    title={saving ? "Working…" : "Rotate invite code"}
                    onPress={handleRotateInvite}
                    disabled={saving}
                    variant="secondary"
                    rightSlot={saving ? <ActivityIndicator /> : null}
                  />
                </View>
              )}
            </GlassCard>
          ) : pendingMembership ? (
            <GlassCard>
              <View style={styles.cardHeaderRow}>
                <Text style={styles.teamName}>Request pending</Text>
                <Pill text="PENDING" />
              </View>

              <Text style={styles.cardText}>
                Team{" "}
                <Text style={styles.cardTextStrong}>
                  {pendingMembership.teamName ?? pendingMembership.teamId}
                </Text>
              </Text>

              <View style={{ height: 14 }} />

              <ActionButton
                title={saving ? "Working…" : "Cancel request"}
                onPress={handleCancelPending}
                disabled={saving}
                variant="danger"
                rightSlot={saving ? <ActivityIndicator /> : null}
              />
            </GlassCard>
          ) : (
            <GlassCard>
              <Text style={styles.cardText}>
                You’re not in a team yet. Join using an invite code, or create a new team.
              </Text>
            </GlassCard>
          )}

          {/* Admin: pending requests */}
          {activeMembership && isAdmin && pendingRequests.length > 0 && (
            <View style={styles.section}>
              <SectionTitle
                title="Pending requests"
                subtitle="Approve players to join your team."
              />

              <GlassCard>
                {pendingRequests.map((r, idx) => {
                  const name = String(r.userDisplayName ?? r.userEmail ?? r.userId);
                  const sub = String(r.userEmail ?? r.userId);

                  return (
                    <View key={r.id}>
                      <PersonRow
                        name={name}
                        subtitle={sub}
                        right={
                          <View style={{ flexDirection: "row", gap: 8 }}>
                            <SmallButton
                              title="Approve"
                              onPress={() => handleApprove(r.userId)}
                              disabled={saving}
                              variant="primary"
                            />
                            <SmallButton
                              title="Deny"
                              onPress={() => handleDeny(r.userId)}
                              disabled={saving}
                              variant="danger"
                            />
                          </View>
                        }
                      />
                      {idx !== pendingRequests.length - 1 && <View style={styles.divider} />}
                    </View>
                  );
                })}
              </GlassCard>
            </View>
          )}

          {/* Members list */}
          {activeMembership && members.length > 0 && (
            <View style={styles.section}>
              <SectionTitle
                title="Members"
                subtitle="Active players in your team."
              />

              <GlassCard>
                {members.map((m, idx) => {
                  const isMe = m.userId === user.uid;
                  const canKick = isAdmin && !isMe && m.role !== "owner";

                  const name = String(m.userDisplayName ?? m.userEmail ?? m.userId);
                  const sub = `${m.role}${isMe ? " • you" : ""}`;

                  return (
                    <View key={m.id}>
                      <PersonRow
                        name={name}
                        subtitle={sub}
                        right={
                          canKick ? (
                            <SmallButton
                              title="Remove"
                              onPress={() => handleKick(m.userId)}
                              disabled={saving}
                              variant="danger"
                            />
                          ) : null
                        }
                      />
                      {idx !== members.length - 1 && <View style={styles.divider} />}
                    </View>
                  );
                })}
              </GlassCard>
            </View>
          )}

          {/* Join (only if not active/pending) */}
          {!activeMembershipRaw && !pendingMembership && (
            <View style={styles.section}>
              <SectionTitle
                title="Join a team"
                subtitle="Enter an invite code to request access."
              />

              <GlassCard>
                <InputRow
                  label="Invite code"
                  icon="🔑"
                  placeholder="e.g. goatfc"
                  value={joinCode}
                  onChangeText={setJoinCode}
                  editable={!saving}
                  autoCapitalize="none"
                  helper="3–24 chars: lowercase letters/numbers/hyphens only."
                />

                <View style={{ marginTop: 14 }}>
                  <ActionButton
                    title={saving ? "Working…" : "Request to join"}
                    onPress={handleJoinTeam}
                    disabled={saving}
                    variant="primary"
                    rightSlot={saving ? <ActivityIndicator /> : null}
                  />
                </View>
              </GlassCard>
            </View>
          )}

          {/* Create (only if not active/pending) */}
          {!activeMembershipRaw && !pendingMembership && (
            <View style={styles.section}>
              <SectionTitle
                title="Create a team"
                subtitle="Make a new squad and share the invite code."
              />

              <GlassCard>
                <InputRow
                  label="Team name"
                  icon="🏷️"
                  placeholder="e.g. Goat FC"
                  value={newTeamName}
                  onChangeText={setNewTeamName}
                  editable={!saving}
                  autoCapitalize="words"
                />

                <InputRow
                  label="Team code"
                  icon="⚙️"
                  placeholder="e.g. goatfc"
                  value={newTeamCode}
                  onChangeText={setNewTeamCode}
                  editable={!saving}
                  autoCapitalize="none"
                  helper="3–24 chars: lowercase letters/numbers/hyphens only."
                />

                <View style={{ marginTop: 14 }}>
                  <ActionButton
                    title={saving ? "Working…" : "Create team"}
                    onPress={handleCreateTeam}
                    disabled={saving}
                    variant="primary"
                    rightSlot={saving ? <ActivityIndicator /> : null}
                  />
                </View>
              </GlassCard>
            </View>
          )}

          <View style={{ height: 26 }} />
          <Text style={styles.footer}>⚽ Teams keep matches organized and private.</Text>
          <View style={{ height: 18 }} />
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#052b22" },

  // Screen + background
  screen: { flex: 1, backgroundColor: "#052b22" },
  bg: { ...StyleSheet.absoluteFillObject, backgroundColor: "#052b22" },

  // Subtle glow (no field outlines)
  bgGlowTop: {
    position: "absolute",
    top: -120,
    left: -80,
    width: 260,
    height: 260,
    borderRadius: 130,
    backgroundColor: "rgba(27, 127, 90, 0.25)",
  },
  bgGlowBottom: {
    position: "absolute",
    bottom: -140,
    right: -100,
    width: 320,
    height: 320,
    borderRadius: 160,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
  },

  container: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 28,
  },

  header: {
    marginBottom: 14,
  },
  title: {
    fontSize: 30,
    fontWeight: "900",
    color: "white",
    letterSpacing: 0.2,
  },
  subtitle: {
    marginTop: 6,
    fontSize: 14,
    fontWeight: "700",
    color: "rgba(255,255,255,0.7)",
  },

  // Cards
  card: {
    borderRadius: 22,
    padding: 16,
    backgroundColor: "rgba(10, 16, 25, 0.78)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  cardHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 10,
  },
  teamName: {
    flex: 1,
    fontSize: 18,
    fontWeight: "900",
    color: "white",
  },
  cardText: {
    color: "rgba(255,255,255,0.75)",
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 18,
  },
  cardTextStrong: {
    color: "white",
    fontWeight: "900",
  },

  section: {
    marginTop: 16,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "900",
    color: "white",
  },
  sectionSubtitle: {
    marginTop: 4,
    fontSize: 13,
    fontWeight: "700",
    color: "rgba(255,255,255,0.65)",
  },

  // Pills
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },
  pillText: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 0.4,
  },

  // Inputs
  label: {
    fontSize: 14,
    fontWeight: "900",
    color: "rgba(255,255,255,0.80)",
    marginBottom: 8,
  },
  helper: {
    marginTop: 8,
    fontSize: 12,
    fontWeight: "700",
    color: "rgba(255,255,255,0.55)",
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 16,
    paddingHorizontal: 14,
    height: 54,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  inputIcon: { fontSize: 18, marginRight: 10, opacity: 0.9 },
  input: {
    flex: 1,
    color: "white",
    fontSize: 16,
    fontWeight: "700",
  },

  // Buttons
  btnBase: {
    height: 54,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
  },
  btnPrimary: {
    backgroundColor: "#1b7f5a",
  },
  btnSecondary: {
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
  },
  btnDanger: {
    backgroundColor: "rgba(216, 74, 74, 0.95)",
  },
  btnDisabled: {
    opacity: 0.6,
  },
  btnText: {
    fontSize: 16,
    fontWeight: "900",
  },
  btnTextPrimary: { color: "#04130f" },
  btnTextSecondary: { color: "white" },

  smallBtn: {
    height: 34,
    paddingHorizontal: 12,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  smallBtnPrimary: { backgroundColor: "#1b7f5a" },
  smallBtnSecondary: {
    backgroundColor: "rgba(255,255,255,0.10)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
  },
  smallBtnDanger: { backgroundColor: "rgba(216, 74, 74, 0.95)" },
  smallBtnText: { fontSize: 12, fontWeight: "900" },
  smallBtnTextPrimary: { color: "#04130f" },
  smallBtnTextSecondary: { color: "white" },

  // Rows
  rowCard: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    gap: 12,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: "rgba(255,255,255,0.10)",
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.10)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    color: "white",
    fontWeight: "900",
  },
  rowTitle: {
    color: "white",
    fontSize: 15,
    fontWeight: "900",
  },
  rowSub: {
    marginTop: 2,
    color: "rgba(255,255,255,0.65)",
    fontSize: 12,
    fontWeight: "700",
  },

  muted: {
    marginTop: 10,
    textAlign: "center",
    color: "rgba(255,255,255,0.6)",
    fontWeight: "700",
  },

  footer: {
    marginTop: 12,
    textAlign: "center",
    color: "rgba(255,255,255,0.55)",
    fontSize: 13,
    fontWeight: "700",
  },
});