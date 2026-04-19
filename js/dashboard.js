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

  const isHQStats = isHQPersonnel(u);

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
  if (isHQStats) {
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
      const pendQuery = isHQStats
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

  // ── Quota (personnel) + reform list ───────────────────────
  const quotaCard = document.getElementById('quota-card');
  const reformCard = document.getElementById('reform-card');
  if (quotaCard && u.divisionId && u.divisionId !== 'ndvl') {
    quotaCard.classList.remove('hidden');
    const QF = window.QuotaFirestore;
    if (!QF) {
      console.error('QuotaFirestore missing; quota UI disabled.');
    } else {

    async function loadQuotaUi() {
      const loading = document.getElementById('quota-loading');
      const body = document.getElementById('quota-body');
      try {
        const q = await QF.fetchNetStatus(u, u.uid);
        loading.classList.add('hidden');
        body.classList.remove('hidden');
        const badge = document.getElementById('quota-badge');
        const summary = document.getElementById('quota-summary');
        const bar = document.getElementById('quota-bar');
        const rulesEl = document.getElementById('quota-rules');

        const scopeLabel = q.activeQuotaScope === 'external' ? 'External' : 'Internal';

        if (q.noPolicy) {
          summary.innerHTML = `<span class="text-muted">No active <strong>${escHtml(scopeLabel)}</strong> quota policy is published for your rank in this division yet.</span>`;
          bar.style.width = '0%';
          rulesEl.innerHTML = '';
          badge.classList.add('hidden');
          return;
        }

        if (q.exempt) {
          badge.textContent = 'LOA exempt';
          badge.classList.remove('hidden');
          summary.innerHTML = `You are <strong>exempt</strong> from quota requirements for this period (${escHtml(q.periodStart)} – ${escHtml(q.periodEnd)}). <span class="text-muted">(${escHtml(scopeLabel)} quota)</span>`;
          bar.style.width = '100%';
          rulesEl.innerHTML = '';
          return;
        }

        badge.classList.add('hidden');
        if (q.mdqraPercent > 0) {
          badge.textContent = `MDQRA −${q.mdqraPercent}%`;
          badge.classList.remove('hidden');
        }
        const dutyNote =
          q.dutyMinutesLogged != null && Number(q.dutyMinutesLogged) > 0
            ? ` Approved duty time counted toward quota: <strong>${escHtml(String(q.dutyMinutesLogged))}</strong> min.`
            : '';
        summary.innerHTML = `<span class="text-muted" style="font-size:0.85em">Quota mode: <strong>${escHtml(scopeLabel)}</strong>.</span><br>
          Period: <strong>${escHtml(q.periodStart)}</strong> → <strong>${escHtml(q.periodEnd)}</strong> (${escHtml(q.periodKind)}).
          Average rule completion: <strong>${escHtml(String(q.completionPct))}%</strong>.
          Combined deficit (events + minutes): <strong>${escHtml(String(q.deficit))}</strong>.${dutyNote}
          <span class="text-muted" style="font-size:0.8em">Use the rule list for units (events vs minutes).</span>`;
        bar.style.width = `${Math.min(100, q.completionPct || 0)}%`;

        function ruleUnits(r) {
          if (r.unit === 'minutes' || r.type === 'duty_minutes') return 'min';
          return 'events';
        }
        const rules = q.rules || [];
        rulesEl.innerHTML = rules.length
          ? rules.map((r) => `<li>${escHtml(r.label || r.type)}: ${escHtml(String(r.completed))}/${escHtml(String(r.required))} ${escHtml(ruleUnits(r))}</li>`).join('')
          : '<li class="text-muted">No rule breakdown.</li>';
      } catch (e) {
        console.error('Quota load failed:', e);
        loading.innerHTML = `<span class="text-danger">${escHtml(e.message || String(e))}</span>`;
      }
    }

    async function loadReformUi() {
      if (!reformCard || !u.divisionId) return;
      reformCard.classList.remove('hidden');
      const selfEl = document.getElementById('reform-self');
      const tbody = document.getElementById('reform-table-body');
      try {
        const data = await QF.listReformSnapshot(u.divisionId);
        if (!data.snapshot || !data.entries || !data.entries.length) {
          selfEl.textContent = 'No reform list published for the latest assessment, or everyone met quota.';
          tbody.innerHTML = '<tr><td colspan="3" class="text-muted">No entries.</td></tr>';
          return;
        }
        const mine = data.entries.find((e) => (e.userId || e.id) === u.uid);
        selfEl.innerHTML = mine
          ? `<strong>You are on the reform list</strong> — deficit ${escHtml(String(mine.deficit))}, ${escHtml(String(mine.completionPct))}% complete.`
          : '<span class="text-muted">You are not on the current reform list.</span>';
        tbody.innerHTML = data.entries.map((e) => `<tr>
          <td>${escHtml(e.username || '—')}</td>
          <td>${escHtml(String(e.deficit))}</td>
          <td>${escHtml(String(e.completionPct))}%</td>
        </tr>`).join('');
      } catch (e) {
        console.error('Reform list failed:', e);
        reformCard.classList.add('hidden');
      }
    }

    function showReqMsg(type, html) {
      const el = document.getElementById('quota-req-msg');
      el.className = `alert alert-${type}`;
      el.innerHTML = html;
      el.classList.remove('hidden');
      if (type === 'success') setTimeout(() => el.classList.add('hidden'), 5000);
    }

    async function optionalQuotaProof(fileInputId) {
      const inp = document.getElementById(fileInputId);
      if (!inp || !inp.files || !inp.files[0]) return null;
      if (typeof uploadProofImage !== 'function') {
        throw new Error('Proof upload is not configured (Supabase).');
      }
      return uploadProofImage(inp.files[0], u.uid);
    }

    document.getElementById('quota-submit-mdqra').addEventListener('click', async () => {
      const pct = parseInt(document.getElementById('quota-mdqra-pct').value, 10);
      const reason = document.getElementById('quota-reason-mdqra').value.trim();
      const btn = document.getElementById('quota-submit-mdqra');
      try {
        btn.disabled = true;
        let proofImageUrl = null;
        try {
          proofImageUrl = await optionalQuotaProof('quota-proof-mdqra');
        } catch (pe) {
          showReqMsg('danger', escHtml(pe.message || String(pe)));
          return;
        }
        await QF.submitQuotaRequest(u, { requestType: 'MDQRA', reductionPercent: pct, reason, proofImageUrl });
        showReqMsg('success', 'MDQRA request submitted for division command approval.');
        const fi = document.getElementById('quota-proof-mdqra');
        if (fi) fi.value = '';
      } catch (e) {
        showReqMsg('danger', escHtml(e.message || String(e)));
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById('quota-submit-loa').addEventListener('click', async () => {
      const loaStart = document.getElementById('quota-loa-start').value;
      const loaEnd = document.getElementById('quota-loa-end').value;
      const reason = document.getElementById('quota-reason-loa').value.trim();
      const btn = document.getElementById('quota-submit-loa');
      try {
        btn.disabled = true;
        let proofImageUrl = null;
        try {
          proofImageUrl = await optionalQuotaProof('quota-proof-loa');
        } catch (pe) {
          showReqMsg('danger', escHtml(pe.message || String(pe)));
          return;
        }
        await QF.submitQuotaRequest(u, { requestType: 'LOA', loaStart, loaEnd, reason, proofImageUrl });
        showReqMsg('success', 'LOA request submitted for division command approval.');
        const fi = document.getElementById('quota-proof-loa');
        if (fi) fi.value = '';
      } catch (e) {
        showReqMsg('danger', escHtml(e.message || String(e)));
      } finally {
        btn.disabled = false;
      }
    });

    await loadQuotaUi();
    await loadReformUi();
    }
  }
})();
