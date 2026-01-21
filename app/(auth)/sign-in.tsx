// app/(auth)/sign-in.tsx
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
  TextInput,
  View,
} from "react-native";
import { useAuth } from "../../src/context/AuthContext";

const LOGO = require("../../assets/images/pickupsoccerlogo.png");

export default function SignInScreen() {
  const router = useRouter();
  const { signIn } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const canSubmit = useMemo(() => {
    return email.trim().length > 0 && password.length > 0 && !loading;
  }, [email, password, loading]);

  const handleSignIn = async () => {
    try {
      setError("");
      setLoading(true);

      const u = await signIn(email.trim(), password);

      // ✅ Route correctly based on verification (prevents flicker)
      if (!u.emailVerified) {
        router.replace("/(auth)/verify-email");
      } else {
        router.replace("/(app)/(tabs)/matches");
      }
    } catch (e: any) {
      console.error(e);
      setError(e?.message || "Could not sign in");
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

          <Text style={styles.title}>SoccerSync</Text>
          <Text style={styles.subtitle}>Organize matches. Sync your squad.</Text>
        </View>

        <View style={styles.card}>
          {!!error && <Text style={styles.error}>{error}</Text>}

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
              onChangeText={setEmail}
              editable={!loading}
              returnKeyType="next"
            />
          </View>

          <Text style={[styles.label, { marginTop: 14 }]}>Password</Text>
          <View style={styles.inputRow}>
            <Text style={styles.icon}>🔒</Text>
            <TextInput
              style={styles.input}
              placeholder="••••••••"
              placeholderTextColor="rgba(255,255,255,0.35)"
              secureTextEntry
              value={password}
              onChangeText={setPassword}
              editable={!loading}
              returnKeyType="done"
              onSubmitEditing={() => {
                if (canSubmit) void handleSignIn();
              }}
            />
          </View>

          <Pressable
            onPress={() => router.push("/(auth)/forgot-password")}
            disabled={loading}
            style={({ pressed }) => [
              { marginTop: 10, alignSelf: "flex-end" },
              pressed && { opacity: 0.85 },
            ]}
          >
            <Text style={styles.forgotLink}>Forgot password?</Text>
          </Pressable>

          <Pressable
            onPress={handleSignIn}
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
              <Text style={styles.primaryBtnText}>Sign In</Text>
            )}
          </Pressable>

          <Pressable onPress={() => router.push("/(auth)/sign-up")} disabled={loading}>
            <Text style={styles.link}>
              Don’t have an account? <Text style={styles.linkStrong}>Sign up</Text>
            </Text>
          </Pressable>
        </View>

        <Text style={styles.footer}>⚽ Built for pickup runs and real schedules.</Text>
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

  title: { fontSize: 44, fontWeight: "900", color: "white", letterSpacing: 0.2 },
  subtitle: {
    marginTop: 6,
    fontSize: 16,
    fontWeight: "700",
    color: "rgba(255,255,255,0.7)",
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

  forgotLink: {
    color: "rgba(255,255,255,0.75)",
    fontWeight: "800",
    fontSize: 14,
  },

  primaryBtn: {
    marginTop: 14,
    height: 54,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1b7f5a",
  },
  primaryBtnDisabled: { opacity: 0.55 },
  primaryBtnText: { color: "#04130f", fontSize: 18, fontWeight: "900" },

  error: {
    color: "#ffb4b4",
    marginBottom: 10,
    fontWeight: "800",
    textAlign: "center",
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
