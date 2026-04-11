// ============================================================
// US NAVY CUSA PORTAL — Login Page
// ============================================================

(function () {
  'use strict';

  const form       = document.getElementById('login-form');
  const usernameIn = document.getElementById('username');
  const passwordIn = document.getElementById('password');
  const submitBtn  = document.getElementById('login-btn');
  const alertBox   = document.getElementById('login-alert');

  // If already authenticated, redirect immediately
  auth.onAuthStateChanged(async (user) => {
    if (!user) return;
    try {
      const snap = await db.collection('users').doc(user.uid).get();
      if (snap.exists && snap.data().mustChangePassword) {
        window.location.href = '/change-password.html';
      } else if (snap.exists) {
        window.location.href = '/dashboard.html';
      }
    } catch (_) {
      // Let the user log in fresh
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const username = usernameIn.value.trim();
    const password = passwordIn.value;

    if (!username || !password) {
      showErr('Please enter your username and password.');
      return;
    }

    setBusy(true);
    clearErr();

    const email = usernameToEmail(username);

    try {
      await auth.signInWithEmailAndPassword(email, password);
      // onAuthStateChanged above handles redirect
    } catch (err) {
      setBusy(false);
      switch (err.code) {
        case 'auth/user-not-found':
        case 'auth/wrong-password':
        case 'auth/invalid-credential':
          showErr('Invalid username or password.');
          break;
        case 'auth/too-many-requests':
          showErr('Too many failed attempts. Please wait a moment and try again.');
          break;
        case 'auth/user-disabled':
          showErr('This account has been disabled. Contact your commanding officer.');
          break;
        default:
          showErr('Login failed: ' + err.message);
      }
    }
  });

  function setBusy(busy) {
    submitBtn.disabled = busy;
    submitBtn.innerHTML = busy
      ? '<span class="spinner"></span> Authenticating…'
      : 'Sign In';
    usernameIn.disabled = busy;
    passwordIn.disabled = busy;
  }

  function showErr(msg) {
    alertBox.className = 'alert alert-danger';
    alertBox.innerHTML = '&#9888; ' + escHtml(msg);
    alertBox.classList.remove('hidden');
  }

  function clearErr() {
    alertBox.classList.add('hidden');
  }
})();
