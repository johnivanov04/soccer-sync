// src/context/AuthContext.tsx
import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";

import {
  createUserWithEmailAndPassword,
  signOut as fbSignOut,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  updateProfile,
  User,
} from "firebase/auth";

import { arrayUnion, doc, serverTimestamp, setDoc } from "firebase/firestore";

import { auth, db } from "../firebaseConfig";
import { registerForPushNotificationsAsync } from "../utils/pushNotifications";

interface AuthContextValue {
  user: User | null;
  initializing: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, displayName?: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [initializing, setInitializing] = useState(true);

  // Avoid double-registering tokens if auth state flips quickly
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

      // Ensure /users/{uid} exists
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

      // Register push token + store it (multi-device safe)
      try {
        const expoPushToken = await registerForPushNotificationsAsync();
        if (!expoPushToken) return;

        await setDoc(
          userRef,
          {
            expoPushToken,
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
    await signInWithEmailAndPassword(auth, email, password);
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

    const userRef = doc(db, "users", fbUser.uid);

    await setDoc(
      userRef,
      {
        email: fbUser.email ?? email,
        ...(displayName && displayName.trim()
          ? { displayName: displayName.trim() }
          : {}),
        createdAt: serverTimestamp(),
      },
      { merge: true }
    );
  };

  const signOut = async () => {
    await fbSignOut(auth);
  };

  return (
    <AuthContext.Provider value={{ user, initializing, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
};
