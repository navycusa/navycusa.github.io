// ============================================================
// US NAVY CUSA PORTAL — Dashboard
// ============================================================

(async function () {
  'use strict';

  const u = await requireAuth();
  renderHeader(u);
  applyPermissionUI(u);
  markActiveSidebarLink();
  setupLogoutBtn();

  // Profile banner
  document.getElementById('profile-avatar').textContent = u.username.charAt(0).toUpperCase();
  document.getElementById('profile-username').textContent = u.username;
  document.getElementById('profile-rank').textContent     = u.rankName;
  document.getElementById('profile-division').textContent = u.divisionName || 'Unassigned';

  const rankObj = getRankById(u.rankId);
  if (rankObj) {
    document.getElementById('profile-cat').textContent = rankObj.cat;
    document.getElementById('profile-cat-badge').className = `badge ${catBadge(rankObj.cat)}`;
  }

  // ── Stats ────────────────────────────────────────────────
  try {
    const logsSnap = await db.collection('logs')
      .where('authorUid', '==', u.uid)
      .get();

    let totalMinutes  = 0;
    let totalEvents   = 0;
    let totalApproved = 0;
    let totalPending  = 0;

    logsSnap.forEach(doc => {
      const d = doc.data();
      if (d.status === 'approved') totalApproved++;
      if (d.status === 'pending')  totalPending++;
      if (d.type === 'duty' && d.status === 'approved') totalMinutes += (d.durationMinutes || 0);
      if (d.type === 'event' && d.status === 'approved') totalEvents++;
    });

    document.getElementById('stat-minutes').textContent  = totalMinutes;
    document.getElementById('stat-events').textContent   = totalEvents;
    document.getElementById('stat-approved').textContent = totalApproved;
    document.getElementById('stat-pending').textContent  = totalPending;
  } catch (e) {
    console.error('Stats load failed:', e);
  }

  // ── Recent Logs (own, last 8) ─────────────────────────────
  try {
    const recentSnap = await db.collection('logs')
      .where('authorUid', '==', u.uid)
      .orderBy('createdAt', 'desc')
      .limit(8)
      .get();

    const tbody = document.getElementById('recent-logs-body');
    if (recentSnap.empty) {
      tbody.innerHTML = `<tr><td colspan="5">
        <div class="empty-state"><div class="empty-icon">📋</div>
        <p>No logs submitted yet.</p></div></td></tr>`;
    } else {
      tbody.innerHTML = recentSnap.docs.map(doc => {
        const d   = doc.data();
        const lbl = d.type === 'duty'
          ? `${d.durationMinutes} min duty`
          : (d.eventType === 'Custom Event' ? d.customEventName : d.eventType);
        return `<tr>
          <td>${typeBadge(d.type)}</td>
          <td>${escHtml(lbl || '—')}</td>
          <td>${fmtDate(d.date)}</td>
          <td>${statusBadge(d.status)}</td>
          <td>${fmtDate(d.createdAt)}</td>
        </tr>`;
      }).join('');
    }
  } catch (e) {
    console.error('Recent logs load failed:', e);
  }

  // ── Pending Approvals (for divisional command) ────────────
  const pendingSection = document.getElementById('pending-section');
  if (hasPerm(u.permission_level, PERM.APPROVE_LOGS) && u.divisionId) {
    pendingSection.classList.remove('hidden');
    try {
      const pendSnap = await db.collection('logs')
        .where('divisionId', '==', u.divisionId)
        .where('status', '==', 'pending')
        .orderBy('createdAt', 'desc')
        .limit(5)
        .get();

      const tbody = document.getElementById('pending-logs-body');
      if (pendSnap.empty) {
        tbody.innerHTML = `<tr><td colspan="4">
          <div class="empty-state"><div class="empty-icon">✅</div>
          <p>No pending logs for your division.</p></div></td></tr>`;
      } else {
        tbody.innerHTML = pendSnap.docs.map(doc => {
          const d = doc.data();
          return `<tr>
            <td>${escHtml(d.authorUsername)}</td>
            <td>${typeBadge(d.type)}</td>
            <td>${fmtDate(d.createdAt)}</td>
            <td>
              <a href="/admin.html#review" class="btn btn-sm btn-primary">Review</a>
            </td>
          </tr>`;
        }).join('');
      }

      // Count badge
      const countEl = document.getElementById('pending-count');
      if (countEl && !pendSnap.empty) {
        countEl.textContent = pendSnap.size;
        countEl.classList.remove('hidden');
      }
    } catch (e) {
      console.error('Pending approvals load failed:', e);
    }
  }
})();
