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

  const isHQ = u.permission_level >= 60 || !u.divisionId || u.divisionId === 'ndvl';

  // ── Profile banner ────────────────────────────────────────
  document.getElementById('profile-avatar').textContent   = u.username.charAt(0).toUpperCase();
  document.getElementById('profile-username').textContent = u.username;
  document.getElementById('profile-rank').textContent     = u.rankName;
  document.getElementById('profile-division').textContent = u.divisionName || 'Unassigned';

  const rankObj = getRankById(u.rankId);
  if (rankObj) {
    document.getElementById('profile-cat').textContent    = rankObj.cat;
    document.getElementById('profile-cat-badge').className = `badge ${catBadge(rankObj.cat)}`;
  }

  // ── Personal stats (own logs) ─────────────────────────────
  try {
    const snap = await db.collection('logs').where('authorUid', '==', u.uid).get();
    let approved = 0, pending = 0;
    snap.forEach(d => {
      const data = d.data();
      if (data.status === 'approved') approved++;
      if (data.status === 'pending')  pending++;
    });
    document.getElementById('stat-approved').textContent = approved;
    document.getElementById('stat-pending').textContent  = pending;
  } catch (e) { console.error('Personal stats failed:', e); }

  // ── Division stats ────────────────────────────────────────
  if (isHQ) {
    // HQ: populate division selector, default to first
    const sel = document.getElementById('div-selector');
    sel.classList.remove('hidden');
    try {
      const divSnap = await db.collection('divisions').orderBy('name').get();
      divSnap.docs.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.id; opt.textContent = d.data().name;
        sel.appendChild(opt);
      });
      if (divSnap.docs.length) {
        sel.value = divSnap.docs[0].id;
        await loadDivStats(divSnap.docs[0].id, divSnap.docs[0].data().name);
      }
    } catch (e) { console.error('Div selector load failed:', e); }

    sel.addEventListener('change', async () => {
      if (!sel.value) return;
      await loadDivStats(sel.value, sel.options[sel.selectedIndex].textContent);
    });

  } else if (u.divisionId && u.divisionId !== 'ndvl') {
    await loadDivStats(u.divisionId, u.divisionName || 'My Division');
  } else {
    // Divisionless / HQ without division — hide the stats card
    document.getElementById('div-stats-loading').innerHTML =
      '<p class="text-muted" style="font-size:0.85rem">No division assigned.</p>';
  }

  async function loadDivStats(divisionId, divisionName) {
    document.getElementById('div-stats-heading').textContent = `${divisionName} — Activity`;
    document.getElementById('div-stats-loading').style.display = 'block';
    document.getElementById('div-stats-content').classList.add('hidden');

    try {
      const now      = new Date();
      const weekAgo  = new Date(now - 7  * 24 * 3600 * 1000);
      const monthAgo = new Date(now - 30 * 24 * 3600 * 1000);

      // Live approved logs for this division
      const logsSnap = await db.collection('logs')
        .where('divisionId', '==', divisionId)
        .where('status', '==', 'approved')
        .get();
      const liveLogs = logsSnap.docs.map(d => d.data());

      // Archived log bundles for this division
      const archivesSnap = await db.collection('archives')
        .where('divisionId', '==', divisionId)
        .get();
      const archivedLogs = [];
      archivesSnap.forEach(doc => {
        const data = doc.data();
        if (Array.isArray(data.logs)) archivedLogs.push(...data.logs);
      });

      const allLogs = [...liveLogs, ...archivedLogs];

      function tsToDate(ts) {
        if (!ts) return null;
        if (typeof ts.toDate === 'function') return ts.toDate();
        if (ts.seconds !== undefined) return new Date(ts.seconds * 1000);
        return new Date(ts);
      }

      function aggregate(logs, afterDate) {
        let minutes = 0, events = 0;
        for (const d of logs) {
          if (afterDate) {
            const dt = tsToDate(d.date);
            if (!dt || dt < afterDate) continue;
          }
          if (d.type === 'duty')  minutes += (d.durationMinutes || 0);
          if (d.type === 'event') events++;
        }
        return { minutes, events };
      }

      // Weekly: live approved only (per spec — archived don't count for weekly)
      const weekly    = aggregate(liveLogs, weekAgo);
      // Monthly + Permanent: live + archived
      const monthly   = aggregate(allLogs, monthAgo);
      const permanent = aggregate(allLogs);

      document.getElementById('stat-week-minutes').textContent  = weekly.minutes;
      document.getElementById('stat-week-events').textContent   = weekly.events;
      document.getElementById('stat-month-minutes').textContent = monthly.minutes;
      document.getElementById('stat-month-events').textContent  = monthly.events;
      document.getElementById('stat-perm-minutes').textContent  = permanent.minutes;
      document.getElementById('stat-perm-events').textContent   = permanent.events;

      document.getElementById('div-stats-loading').style.display = 'none';
      document.getElementById('div-stats-content').classList.remove('hidden');
    } catch (e) {
      console.error('loadDivStats failed:', e);
      document.getElementById('div-stats-loading').innerHTML =
        `<span class="text-danger" style="padding:20px;display:block">Failed to load stats: ${escHtml(e.message)}</span>`;
    }
  }

  // ── Recent Submissions (own, last 8) ──────────────────────
  try {
    const snap = await db.collection('logs')
      .where('authorUid', '==', u.uid)
      .orderBy('createdAt', 'desc')
      .limit(8)
      .get();

    const tbody = document.getElementById('recent-logs-body');
    if (snap.empty) {
      tbody.innerHTML = `<tr><td colspan="5">
        <div class="empty-state"><div class="empty-icon">📋</div>
        <p>No logs submitted yet.</p></div></td></tr>`;
    } else {
      tbody.innerHTML = snap.docs.map(doc => {
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
  } catch (e) { console.error('Recent logs failed:', e); }

  // ── Pending Approvals (MCPO+) ─────────────────────────────
  const pendingSection = document.getElementById('pending-section');
  if (hasPerm(u.permission_level, PERM.APPROVE_LOGS)) {
    pendingSection.classList.remove('hidden');
    try {
      const pendQuery = isHQ
        ? db.collection('logs').where('status', '==', 'pending')
            .orderBy('createdAt', 'desc').limit(5)
        : db.collection('logs')
            .where('divisionId', '==', u.divisionId)
            .where('status', '==', 'pending')
            .orderBy('createdAt', 'desc').limit(5);

      const snap = await pendQuery.get();
      const tbody = document.getElementById('pending-logs-body');

      if (snap.empty) {
        tbody.innerHTML = `<tr><td colspan="5">
          <div class="empty-state"><div class="empty-icon">✅</div>
          <p>No pending logs.</p></div></td></tr>`;
      } else {
        tbody.innerHTML = snap.docs.map(doc => {
          const d = doc.data();
          return `<tr>
            <td>${escHtml(d.authorUsername || '—')}</td>
            <td>${typeBadge(d.type)}</td>
            <td>${escHtml(d.divisionName || '—')}</td>
            <td>${fmtDate(d.createdAt)}</td>
            <td><a href="/admin.html#review" class="btn btn-sm btn-primary">Review</a></td>
          </tr>`;
        }).join('');
        const countEl = document.getElementById('pending-count');
        if (countEl) { countEl.textContent = snap.size; countEl.classList.remove('hidden'); }
      }
    } catch (e) { console.error('Pending approvals failed:', e); }
  }
})();
