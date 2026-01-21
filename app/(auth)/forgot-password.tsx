// app/(auth)/forgot-password.tsx
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useAuth } from "../../src/context/AuthContext";

const LOGO = require("../../assets/images/pickupsoccerlogo.png");

function friendlyResetError(e: any) {
  const code = String(e?.code ?? "");
  const msg = String(e?.message ?? "");

  // Firebase common codes:
  if (code.includes("auth/invalid-email")) return "That email address looks invalid.";
  if (code.includes("auth/too-many-requests"))
    return "Too many attempts. Please wait a bit and try again.";

  // Security-friendly: treat “user not found” as success
  if (code.includes("auth/user-not-found")) return null;

  // fallback
  return msg || "Could not send reset email.";
}

export default function ForgotPasswordScreen() {
  const router = useRouter();
  const { resetPassword } = useAuth();

  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);

  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  const canSubmit = useMemo(() => {
    return email.trim().length > 0 && !loading;
  }, [email, loading]);

  // ✅ if they edit email after success, hide the success banner
  useEffect(() => {
    if (sent) setSent(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email]);

  const handleSend = async () => {
    const mail = email.trim();
    if (!mail || loading) return;

    try {
      Keyboard.dismiss();
      setError("");
      setSent(false);
      setLoading(true);

      await resetPassword(mail);

      // ✅ security-friendly UX: show success regardless
      setSent(true);
    } catch (e: any) {
      console.error(e);

      const friendly = friendlyResetError(e);
      if (friendly == null) {
        // ✅ treat user-not-found as success to avoid account enumeration
        setSent(true);
      } else {
        setError(friendly);
      }
    } finally {
      setLoading(false);
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

          <Text style={styles.title}>Reset password</Text>
          <Text style={styles.subtitle}>We’ll email you a link to set a new password.</Text>
        </View>

        <View style={styles.card}>
          {!!error && <Text style={styles.error}>{error}</Text>}
          {sent && (
            <Text style={styles.success}>
              If an account exists for that email, we sent a reset link. Check your inbox (and
              spam).
            </Text>
          )}

          <Text style={styles.label}>Email</Text>
          <View style={styles.inputRow}>
            <Text style={styles.icon}>✉️</Text>
            <TextInput
              style={styles.input}
              placeholder="you@example.com"
              placeholderTextColor="rgba(255,255,255,0.35)"
              autoCapitalize="none"
              keyboardType="email-address"
              value={email}
              onChangeText={(v) => {
                setError("");
                setEmail(v);
              }}
              editable={!loading}
              returnKeyType="send"
              onSubmitEditing={() => {
                if (canSubmit) void handleSend();
              }}
            />
          </View>

          <Pressable
            onPress={handleSend}
            disabled={!canSubmit}
            style={({ pressed }) => [
              styles.primaryBtn,
              !canSubmit && styles.primaryBtnDisabled,
              pressed && canSubmit && { transform: [{ scale: 0.99 }] },
            ]}
          >
            {loading ? (
              <ActivityIndicator color="#04130f" />
            ) : (
              <Text style={styles.primaryBtnText}>Send reset link</Text>
            )}
          </Pressable>

          <Pressable onPress={() => router.back()} disabled={loading}>
            <Text style={styles.link}>
              Back to <Text style={styles.linkStrong}>Sign in</Text>
            </Text>
          </Pressable>
        </View>

        <Text style={styles.footer}>⚽ Get back on the pitch.</Text>
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

  title: { fontSize: 32, fontWeight: "900", color: "white", letterSpacing: 0.2 },
  subtitle: {
    marginTop: 6,
    fontSize: 15,
    fontWeight: "700",
    color: "rgba(255,255,255,0.7)",
    textAlign: "center",
  },

  card: {
    marginTop: 14,
    borderRadius: 22,
    padding: 18,
    backgroundColor: "rgba(10, 16, 25, 0.78)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },

  label: {
    fontSize: 16,
    fontWeight: "800",
    color: "rgba(255,255,255,0.78)",
    marginBottom: 8,
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
  icon: { fontSize: 18, marginRight: 10, opacity: 0.85 },
  input: { flex: 1, color: "white", fontSize: 16, fontWeight: "700" },

  primaryBtn: {
    marginTop: 18,
    height: 54,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1b7f5a",
  },
  primaryBtnDisabled: { opacity: 0.55 },
  primaryBtnText: { color: "#04130f", fontSize: 18, fontWeight: "900" },

  error: { color: "#ffb4b4", marginBottom: 10, fontWeight: "800", textAlign: "center" },
  success: {
    color: "rgba(180,255,205,0.9)",
    marginBottom: 10,
    fontWeight: "800",
    textAlign: "center",
    lineHeight: 18,
  },

  link: {
    marginTop: 16,
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
