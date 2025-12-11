// src/firebaseConfig.js
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyD5utIUSoqdLnFJtvArA1Un5PZc1jlK4GE",
  authDomain: "soccersync-e2476.firebaseapp.com",
  projectId: "soccersync-e2476",
  storageBucket: "soccersync-e2476.firebasestorage.app",
  messagingSenderId: "983551077392",
  appId: "1:983551077392:web:e164637b755d918e9f2e95"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
