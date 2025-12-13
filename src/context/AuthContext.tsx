// src/context/AuthContext.tsx
import {
  createUserWithEmailAndPassword,
  signOut as fbSignOut,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  User,
} from "firebase/auth";
import React, {
  createContext,
  useContext,
  useEffect,
  useState,
} from "react";

import { doc, setDoc } from "firebase/firestore";
import { auth, db } from "../firebaseConfig";

interface AuthContextValue {
  user: User | null;
  initializing: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (fbUser) => {
      setUser(fbUser);
      setInitializing(false);
    });
    return unsub;
  }, []);

  const signIn = async (email: string, password: string) => {
    await signInWithEmailAndPassword(auth, email, password);
  };

  const signUp = async (email: string, password: string) => {
    const cred = await createUserWithEmailAndPassword(auth, email, password);

    // 🔹 Create /users/{uid} doc with a default team
    try {
      await setDoc(
        doc(db, "users", cred.user.uid),
        {
          email: cred.user.email ?? email,
          teamId: "demo-team", // default team for now
        },
        { merge: true }
      );
    } catch (err) {
      console.error("Error creating user profile:", err);
      // we don't throw here so sign-up still succeeds
    }
  };

  const signOut = async () => {
    try {
      await fbSignOut(auth);
    } catch (err) {
      console.error("Error signing out:", err);
      throw err;
    }
  };

  return (
    <AuthContext.Provider
      value={{ user, initializing, signIn, signUp, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
};
