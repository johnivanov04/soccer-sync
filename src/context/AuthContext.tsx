// src/context/AuthContext.tsx
import {
  createUserWithEmailAndPassword,
  signOut as fbSignOut,
  onAuthStateChanged,
  reload,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  updateProfile,
  User,
} from "firebase/auth";
import { arrayUnion, doc, serverTimestamp, setDoc } from "firebase/firestore";
import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { auth, db } from "../firebaseConfig";
import { registerForPushNotificationsAsync } from "../utils/pushNotifications";

interface AuthContextValue {
  user: User | null;
  initializing: boolean;
  signIn: (email: string, password: string) => Promise<User>;
  signUp: (email: string, password: string, displayName?: string) => Promise<User>;
  signOut: () => Promise<void>;
  sendVerificationEmail: () => Promise<void>;
  refreshUser: () => Promise<User | null>;
  resetPassword: (email: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [initializing, setInitializing] = useState(true);

  const pushSetupDoneForUidRef = useRef<string | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      setUser(fbUser);
      setInitializing(false);

      if (!fbUser?.uid) {
        pushSetupDoneForUidRef.current = null;
        return;
      }

      if (pushSetupDoneForUidRef.current === fbUser.uid) return;
      pushSetupDoneForUidRef.current = fbUser.uid;

      const userRef = doc(db, "users", fbUser.uid);
      const publicRef = doc(db, "publicUsers", fbUser.uid);

      // ✅ Ensure /users/{uid} exists (private)
      try {
        await setDoc(
          userRef,
          {
            email: fbUser.email ?? "",
            ...(fbUser.displayName ? { displayName: fbUser.displayName } : {}),
            ...(fbUser.photoURL ? { photoURL: fbUser.photoURL } : {}),
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      } catch (e) {
        console.warn("Could not upsert user profile doc", e);
      }

      // ✅ Ensure /publicUsers/{uid} exists (safe public profile)
      try {
        await setDoc(
          publicRef,
          {
            ...(fbUser.displayName ? { displayName: fbUser.displayName } : {}),
            ...(fbUser.photoURL ? { photoURL: fbUser.photoURL } : {}),
            photoUpdatedAtMs: Date.now(),
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      } catch (e) {
        console.warn("Could not upsert public user doc", e);
      }

      // ✅ Register push token + store it (multi-device safe)
      try {
        const expoPushToken = await registerForPushNotificationsAsync();
        if (!expoPushToken) return;

        await setDoc(
          userRef,
          {
            expoPushToken, // optional “latest”
            expoPushTokens: arrayUnion(expoPushToken),
            expoPushTokenPlatform: Platform.OS,
            expoPushTokenUpdatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      } catch (e) {
        console.warn("Push token registration/save failed", e);
      }
    });

    return unsub;
  }, []);

  const signIn = async (email: string, password: string) => {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    return cred.user;
  };

  const signUp = async (email: string, password: string, displayName?: string) => {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const fbUser = cred.user;

    if (displayName && displayName.trim()) {
      try {
        await updateProfile(fbUser, { displayName: displayName.trim() });
      } catch (err) {
        console.warn("Could not update auth displayName", err);
      }
    }

    try {
      await sendEmailVerification(fbUser);
    } catch (err) {
      console.warn("Could not send verification email", err);
    }

    const userRef = doc(db, "users", fbUser.uid);
    const publicRef = doc(db, "publicUsers", fbUser.uid);

    await setDoc(
      userRef,
      {
        email: fbUser.email ?? email,
        ...(displayName && displayName.trim() ? { displayName: displayName.trim() } : {}),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    await setDoc(
      publicRef,
      {
        ...(displayName && displayName.trim() ? { displayName: displayName.trim() } : {}),
        photoUpdatedAtMs: Date.now(),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    return fbUser;
  };

  const signOut = async () => {
    await fbSignOut(auth);
  };

  const sendVerificationEmailFn = async () => {
    const u = auth.currentUser;
    if (!u) throw new Error("Not signed in.");
    await sendEmailVerification(u);
  };

  const refreshUserFn = async () => {
    const u = auth.currentUser;
    if (!u) throw new Error("Not signed in.");
    await reload(u);
    setUser(auth.currentUser);
    return auth.currentUser;
  };

  const resetPasswordFn = async (email: string) => {
    const mail = email.trim();
    if (!mail) throw new Error("Please enter an email.");
    await sendPasswordResetEmail(auth, mail);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        initializing,
        signIn,
        signUp,
        signOut,
        sendVerificationEmail: sendVerificationEmailFn,
        refreshUser: refreshUserFn,
        resetPassword: resetPasswordFn,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
};
