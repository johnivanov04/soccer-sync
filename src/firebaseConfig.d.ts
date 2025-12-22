// src/firebaseConfig.d.ts
import type { Auth } from "firebase/auth";
import type { Firestore } from "firebase/firestore";
import type { FirebaseStorage } from "firebase/storage";

export const auth: Auth;
export const db: Firestore;
export const storage: FirebaseStorage;
