// ============================================================
// US NAVY CUSA PORTAL — Firebase Configuration
// ============================================================
// 1. Go to console.firebase.google.com
// 2. Create a project (or open your existing one)
// 3. Project Settings → Your Apps → Add a web app
// 4. Copy the firebaseConfig object and paste below
// ============================================================

const firebaseConfig = {
  apiKey: "AIzaSyDvIV_F26vWVg-r_11atXpMZS2o5xxqrvc",
  authDomain: "navycusa-7b3cf.firebaseapp.com",
  projectId: "navycusa-7b3cf",
  storageBucket: "navycusa-7b3cf.firebasestorage.app",
  messagingSenderId: "1008229788951",
  appId: "1:1008229788951:web:97e0f849f32f8e74a29b52",
};

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db   = firebase.firestore();
const functions = typeof firebase.functions === 'function' ? firebase.functions() : null;

// QUOTA / reform use Firestore + client JS (works on Spark — no Cloud Functions).
// Optional: upgrade to Blaze and deploy functions/ for server-side automation.

// Local dev: Firebase Console → Authentication → Authorized domains → add localhost, 127.0.0.1

// auth.useEmulator('http://localhost:9099');
// db.useEmulator('localhost', 8080);
