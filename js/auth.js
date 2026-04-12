// ============================================================
// US NAVY CUSA PORTAL — Auth Guard & Shared Utilities
// ============================================================

// Users log in with username; email is derived internally.
const EMAIL_DOMAIN = '@navycusa.mil';

function usernameToEmail(username) {
  return username.trim().toLowerCase().replace(/\s+/g, '') + EMAIL_DOMAIN;
}

// In-memory session data (populated after requireAuth resolves)
let _currentUser = null;

function currentUser() { return _currentUser; }

// ── Auth Guard ────────────────────────────────────────────────
/**
 * requireAuth(options)
 *
 * Options:
 *   allowChangePassword {bool}  – if true, don't redirect on mustChangePassword
 *   minPermission       {int}   – redirect to dashboard if user lacks this level
 *   adminPanelAccess    {bool}  – if true, allow CNP+ or OCNP/OCNO staff (see ranks.js)
 *
 * Returns a Promise that resolves with the Firestore user data object.
 * Redirects away on any auth failure.
 */
function requireAuth(options = {}) {
  return new Promise((resolve) => {
    const unsub = auth.onAuthStateChanged(async (firebaseUser) => {
      unsub();

      if (!firebaseUser) {
        window.location.href = '/index.html';
        return;
      }

      let userData;
      try {
        const snap = await db.collection('users').doc(firebaseUser.uid).get();
        if (!snap.exists) {
          await auth.signOut();
          window.location.href = '/index.html';
          return;
        }
        userData = { uid: firebaseUser.uid, ...snap.data() };
        _currentUser = userData;
      } catch (err) {
        console.error('requireAuth: Firestore read failed', err);
        window.location.href = '/index.html';
        return;
      }

      // First-login gate
      if (userData.mustChangePassword && !options.allowChangePassword) {
        window.location.href = '/change-password.html';
        return;
      }

      // Permission gate
      if (options.adminPanelAccess) {
        if (typeof canAccessAdminPanel === 'function' && !canAccessAdminPanel(userData)) {
          window.location.href = '/dashboard.html';
          return;
        }
      } else if (options.minPermission && userData.permission_level < options.minPermission) {
        window.location.href = '/dashboard.html';
        return;
      }

      resolve(userData);
    });
  });
}

// ── Sign Out ──────────────────────────────────────────────────
async function portalSignOut() {
  _currentUser = null;
  await auth.signOut();
  window.location.href = '/index.html';
}

// ── Audit Log ─────────────────────────────────────────────────
// Client-side audit writes for operations not covered by Cloud Functions.
async function auditLog(action, targetType, targetId, details = {}) {
  const u = _currentUser;
  if (!u) return;
  try {
    await db.collection('audit_logs').add({
      action,
      actorUid:      u.uid,
      actorUsername: u.username,
      actorRank:     u.rankName,
      targetType,
      targetId,
      details,
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.warn('auditLog write failed:', e.message);
  }
}

// ── Header / Layout ───────────────────────────────────────────
let _mobileNavInitialized = false;

function setupMobileNav() {
  if (_mobileNavInitialized) return;
  const appBody = document.querySelector('.app-body');
  const sidebar = appBody && appBody.querySelector('.sidebar');
  if (!appBody || !sidebar) return;
  _mobileNavInitialized = true;

  const header = document.querySelector('.site-header');
  const spacer = header && header.querySelector('.header-spacer');
  let btn = document.getElementById('nav-menu-btn');
  if (!btn && header && spacer) {
    btn = document.createElement('button');
    btn.id = 'nav-menu-btn';
    btn.type = 'button';
    btn.className = 'nav-menu-btn';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', 'Open navigation menu');
    btn.textContent = '☰';
    header.insertBefore(btn, spacer);
  }

  let overlay = appBody.querySelector('.nav-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'nav-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    appBody.insertBefore(overlay, sidebar);
  }

  function closeNav() {
    appBody.classList.remove('sidebar-open');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }
  function openNav() {
    appBody.classList.add('sidebar-open');
    if (btn) btn.setAttribute('aria-expanded', 'true');
  }

  if (btn) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (appBody.classList.contains('sidebar-open')) closeNav();
      else openNav();
    });
  }
  overlay.addEventListener('click', closeNav);
  sidebar.querySelectorAll('a.sidebar-link').forEach((a) => {
    a.addEventListener('click', () => {
      if (window.matchMedia('(max-width: 768px)').matches) closeNav();
    });
  });
  window.addEventListener('resize', () => {
    if (!window.matchMedia('(max-width: 768px)').matches) closeNav();
  });
}

function renderHeader(u) {
  const avatarEl   = document.getElementById('header-avatar');
  const nameEl     = document.getElementById('header-username');
  const rankEl     = document.getElementById('header-rank');
  if (avatarEl) avatarEl.textContent = (u.username || '?').charAt(0).toUpperCase();
  if (nameEl)   nameEl.textContent   = u.username  || '';
  if (rankEl)   rankEl.textContent   = u.rankName  || '';
  setupMobileNav();
}

function applyPermissionUI(u) {
  document.querySelectorAll('[data-min-perm]').forEach(el => {
    const min = parseInt(el.dataset.minPerm, 10);
    el.classList.toggle('hidden', u.permission_level < min);
  });
  document.querySelectorAll('[data-require-admin-panel]').forEach(el => {
    const ok = typeof canAccessAdminPanel === 'function' && canAccessAdminPanel(u);
    el.classList.toggle('hidden', !ok);
  });
}

function markActiveSidebarLink() {
  const path = window.location.pathname;
  document.querySelectorAll('.sidebar-link').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === path);
  });
}

function setupLogoutBtn() {
  const btn = document.getElementById('logout-btn');
  if (btn) btn.addEventListener('click', portalSignOut);
}

// ── Alert Helpers ─────────────────────────────────────────────
function showAlert(id, type, html) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `alert alert-${type}`;
  el.innerHTML = html;
  el.classList.remove('hidden');
  if (type === 'success') setTimeout(() => el.classList.add('hidden'), 4500);
}

function clearAlert(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}

// ── Date Helpers ──────────────────────────────────────────────
function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Misc ──────────────────────────────────────────────────────
function statusBadge(status) {
  const map = { pending: 'badge-pending', approved: 'badge-approved', rejected: 'badge-rejected' };
  return `<span class="badge ${map[status] || ''}">${status}</span>`;
}

function typeBadge(type) {
  return type === 'duty'
    ? `<span class="badge badge-duty">&#9719; Duty</span>`
    : `<span class="badge badge-event">&#9733; Event</span>`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
