// Firebase configuration.
// These values are NOT secret — Firebase web config keys are meant to be public.
// Privacy/security is enforced by Firestore rules + Authentication (see README.md), not by hiding this file.
//
// Replace the placeholders below with the values from:
// Firebase Console → Project settings → General → "Your apps" → Web app → SDK setup and configuration

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getFirestore, enableIndexedDbPersistence } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

export const firebaseConfig = {
  apiKey: "AIzaSyBC6dclFauP5fy3x7mKrwztAEMTnJnQo8w",
  authDomain: "wedding-secretary-4f50e.firebaseapp.com",
  projectId: "wedding-secretary-4f50e",
  storageBucket: "wedding-secretary-4f50e.firebasestorage.app",
  messagingSenderId: "574794312457",
  appId: "1:574794312457:web:d980206c3f3bed0609c1d8"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

// Lets the app keep working offline and sync automatically when back online.
enableIndexedDbPersistence(db).catch(() => {
  // Fails silently if multiple tabs are open — app still works, just without offline cache in that tab.
});
