// ============================================================
// US NAVY CUSA PORTAL — Change Password (First Login)
// ============================================================

(async function () {
  'use strict';

  // Guard: must be authenticated with mustChangePassword = true
  const userData = await requireAuth({ allowChangePassword: true });

  // If they've already changed it, send to dashboard
  if (!userData.mustChangePassword) {
    window.location.href = '/dashboard.html';
    return;
  }

  // Populate welcome name
  const nameEl = document.getElementById('welcome-name');
  if (nameEl) nameEl.textContent = userData.username;

  // Wire up form
  const form    = document.getElementById('cp-form');
  const newPass = document.getElementById('new-password');
  const confirm = document.getElementById('confirm-password');
  const btn     = document.getElementById('cp-btn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const np = newPass.value;
    const cp = confirm.value;

    if (np.length < 8) {
      showAlert('cp-alert', 'danger', 'Password must be at least 8 characters.');
      return;
    }
    if (np !== cp) {
      showAlert('cp-alert', 'danger', 'Passwords do not match.');
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Updating…';
    clearAlert('cp-alert');

    try {
      // Update Firebase Auth password
      await auth.currentUser.updatePassword(np);

      // Clear the first-login flag in Firestore
      await db.collection('users').doc(userData.uid).update({
        mustChangePassword: false,
        passwordChangedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });

      showAlert('cp-alert', 'success', 'Password updated. Redirecting to dashboard…');
      setTimeout(() => { window.location.href = '/dashboard.html'; }, 1800);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Update Password';

      if (err.code === 'auth/requires-recent-login') {
        showAlert('cp-alert', 'danger',
          'Session expired. Please <a href="/index.html">sign in again</a> and try immediately.');
      } else {
        showAlert('cp-alert', 'danger', 'Error: ' + err.message);
      }
    }
  });
})();
