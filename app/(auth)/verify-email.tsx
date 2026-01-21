// app/(auth)/verify-email.tsx
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useAuth } from "../../src/context/AuthContext";
import { auth } from "../../src/firebaseConfig";

const LOGO = require("../../assets/images/pickupsoccerlogo.png");

export default function VerifyEmailScreen() {
  const router = useRouter();
  const { user, signOut, sendVerificationEmail, refreshUser } = useAuth();

  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);

  const email = user?.email ?? "";
  const verified = !!user?.emailVerified;

  // ✅ Don't offer resend if already verified
  const canResend = useMemo(
    () => !!user && !verified && !sending && !checking,
    [user, verified, sending, checking]
  );

  const handleResend = async () => {
    try {
      setError("");
      setSending(true);
      await sendVerificationEmail();
    } catch (e: any) {
      console.error(e);
      setError(e?.message || "Could not resend verification email.");
    } finally {
      setSending(false);
    }
  };

  const handleIVerified = async () => {
    try {
      setError("");
      setChecking(true);

      await refreshUser();

      // ✅ FIX: check the fresh auth.currentUser, not stale `user` from closure
      const fresh = auth.currentUser;

      if (fresh?.emailVerified) {
        router.replace("/(app)/(tabs)/matches");
        return;
      }

      // Optional friendly nudge (no hard error)
      setError("Still not verified yet — open the email and tap the verification link.");
    } catch (e: any) {
      console.error(e);
      setError(e?.message || "Could not refresh status.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.bg} />

      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.hero}>
          <View style={styles.logoWrap}>
            <Image source={LOGO} style={styles.logo} contentFit="contain" />
          </View>

          <Text style={styles.title}>Verify your email</Text>
          <Text style={styles.subtitle}>
            We sent a verification link to{" "}
            <Text style={styles.subtitleStrong}>{email || "your email"}</Text>.
          </Text>
        </View>

        <View style={styles.card}>
          {!!error && <Text style={styles.error}>{error}</Text>}

          <Text style={styles.bodyText}>
            Open the email, tap the verification link, then come back and press{" "}
            <Text style={styles.bodyStrong}>I verified</Text>.
          </Text>

          <Pressable
            onPress={handleIVerified}
            disabled={!user || checking}
            style={({ pressed }) => [
              styles.primaryBtn,
              pressed && user && !checking && { transform: [{ scale: 0.99 }] },
              (!user || checking) && { opacity: 0.75 },
            ]}
          >
            {checking ? (
              <ActivityIndicator color="#04130f" />
            ) : (
              <Text style={styles.primaryBtnText}>
                {verified ? "Verified ✅ Continue" : "I verified"}
              </Text>
            )}
          </Pressable>

          <Pressable
            onPress={handleResend}
            disabled={!canResend}
            style={({ pressed }) => [
              styles.secondaryBtn,
              !canResend && { opacity: 0.65 },
              pressed && canResend && { transform: [{ scale: 0.99 }] },
            ]}
          >
            {sending ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text style={styles.secondaryBtnText}>Resend email</Text>
            )}
          </Pressable>

          <Pressable onPress={() => signOut()} disabled={sending || checking}>
            <Text style={styles.link}>
              Not your email? <Text style={styles.linkStrong}>Sign out</Text>
            </Text>
          </Pressable>
        </View>

        <Text style={styles.footer}>⚽ Quick verification = smoother squad invites.</Text>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#052b22" },
  bg: { ...StyleSheet.absoluteFillObject, backgroundColor: "#052b22" },

  container: { flex: 1, paddingHorizontal: 18, justifyContent: "center" },

  hero: { alignItems: "center", marginBottom: 16 },

  logoWrap: { width: 180, height: 120, marginBottom: 10 },
  logo: { width: "100%", height: "100%" },

  title: { fontSize: 34, fontWeight: "900", color: "white" },
  subtitle: {
    marginTop: 8,
    fontSize: 15,
    fontWeight: "700",
    color: "rgba(255,255,255,0.7)",
    textAlign: "center",
    lineHeight: 20,
  },
  subtitleStrong: { color: "white", fontWeight: "900" },

  card: {
    marginTop: 14,
    borderRadius: 22,
    padding: 18,
    backgroundColor: "rgba(10, 16, 25, 0.78)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },

  bodyText: {
    color: "rgba(255,255,255,0.82)",
    fontSize: 15,
    fontWeight: "700",
    lineHeight: 20,
    textAlign: "center",
  },
  bodyStrong: { color: "white", fontWeight: "900" },

  primaryBtn: {
    marginTop: 16,
    height: 54,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1b7f5a",
  },
  primaryBtnText: { color: "#04130f", fontSize: 18, fontWeight: "900" },

  secondaryBtn: {
    marginTop: 12,
    height: 50,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.10)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
  },
  secondaryBtnText: { color: "white", fontSize: 16, fontWeight: "900" },

  error: {
    color: "#ffb4b4",
    marginBottom: 10,
    fontWeight: "800",
    textAlign: "center",
  },

  link: {
    marginTop: 14,
    textAlign: "center",
    color: "rgba(255,255,255,0.75)",
    fontSize: 16,
    fontWeight: "700",
  },
  linkStrong: { color: "white", fontWeight: "900" },

  footer: {
    marginTop: 14,
    textAlign: "center",
    color: "rgba(255,255,255,0.55)",
    fontSize: 14,
    fontWeight: "700",
  },
});
