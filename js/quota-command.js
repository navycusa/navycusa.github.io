// ============================================================
// US NAVY CUSA PORTAL — QUOTA Management (division / HQ authority)
// ============================================================

'use strict';

(async function () {
  'use strict';

  const u = await requireAuth({ minPermission: PERM.QUOTA_DIV_COMMAND });
  renderHeader(u);
  applyPermissionUI(u);
  markActiveSidebarLink();
  document.querySelectorAll('.sidebar-link').forEach((a) => {
    const h = a.getAttribute('href');
    if (!h) return;
    const p = window.location.pathname;
    a.classList.toggle('active', p === h || p.endsWith(h));
  });
  setupLogoutBtn();

  const QF = window.QuotaFirestore;
  if (!QF) {
    console.error('QuotaFirestore missing — load js/quota-firestore.js before this script.');
    return;
  }

  const mainEl = document.getElementById('qc-main');
  const deniedEl = document.getElementById('qc-access-denied');
  const divSel = document.getElementById('qc-division');

  let divisions = [];
  let currentDivisionId = null;
  let currentIsHQ = false;

  async function loadDivisions() {
    const snap = await db.collection('divisions').orderBy('name').get();
    divisions = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  await loadDivisions();
  const userHomeDiv = divisions.find((d) => d.id === u.divisionId);
  const userDivisionIsHQ = !!(userHomeDiv && (userHomeDiv.isHeadquarters === true || userHomeDiv.id === HQ_DIVISION_ID));

  function mayManageDiv(div) {
    if (!div) return false;
    const isHQ = div.isHeadquarters === true || div.id === HQ_DIVISION_ID;
    return canManageDivisionQuota(u, div.id, isHQ, userDivisionIsHQ);
  }

  const manageable = divisions.filter(mayManageDiv);

  if (!manageable.length) {
    deniedEl.classList.remove('hidden');
    return;
  }

  deniedEl.classList.add('hidden');
  mainEl.classList.remove('hidden');

  const globalReqWrap = document.getElementById('qc-global-req-wrap');
  if (globalReqWrap && canViewCrossDivisionNonHQQuotaRequests(u)) {
    globalReqWrap.classList.remove('hidden');
  }

  manageable.forEach((d) => {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.name + (d.isHeadquarters ? ' (HQ)' : '');
    divSel.appendChild(opt);
  });

  currentDivisionId = manageable[0].id;
  currentIsHQ = manageable[0].isHeadquarters === true || manageable[0].id === HQ_DIVISION_ID;
  divSel.value = currentDivisionId;

  const typeSel = document.getElementById('qc-def-type');
  EVENT_TYPES.filter((t) => t !== 'Custom Event').forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    typeSel.appendChild(opt);
  });

  const rankSel = document.getElementById('qc-pol-rank');
  RANKS.forEach((r) => {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = `${r.name} (${r.short})`;
    rankSel.appendChild(opt);
  });

  document.getElementById('qc-pol-rules').value = JSON.stringify([
    {
      id: 'example_group',
      ruleType: 'group',
      label: 'Complete 2 from pool',
      requiredCount: 2,
      items: [
        { matchEventType: 'Training Exercise' },
        { matchEventType: 'Patrol' },
      ],
    },
    {
      id: 'example_duty',
      ruleType: 'duty_minutes',
      label: 'Duty minutes (approved activity logs)',
      requiredMinutes: 120,
    },
  ], null, 2);

  divSel.addEventListener('change', async () => {
    currentDivisionId = divSel.value;
    const div = divisions.find((x) => x.id === currentDivisionId);
    currentIsHQ = div && (div.isHeadquarters === true || div.id === HQ_DIVISION_ID);
    await refreshAll();
  });

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });

  function divisionLabel(divId) {
    const d = divisions.find((x) => x.id === divId);
    return d ? d.name + (d.isHeadquarters ? ' (HQ)' : '') : divId || '—';
  }

  function quotaRowDivisionIsHQ(divId) {
    const d = divisions.find((x) => x.id === divId);
    if (d) return d.isHeadquarters === true || d.id === HQ_DIVISION_ID;
    return divId === HQ_DIVISION_ID;
  }

  async function refreshGlobalPending() {
    if (!globalReqWrap || globalReqWrap.classList.contains('hidden')) return;
    clearAlert('qc-global-req-alert');
    try {
      const nonHqDivisionIds = divisions
        .filter((d) => d.id !== 'ndvl' && !(d.isHeadquarters === true || d.id === HQ_DIVISION_ID))
        .map((d) => d.id);
      const rows = await QF.listPendingQuotaRequestsForDivisions(nonHqDivisionIds);
      const sorted = rows.slice().sort((a, b) => {
        const da = (a.divisionId || '').localeCompare(b.divisionId || '');
        return da !== 0 ? da : (a.requesterUsername || '').localeCompare(b.requesterUsername || '');
      });
      renderGlobalRequests(sorted);
    } catch (e) {
      console.error(e);
      showAlert('qc-global-req-alert', 'danger', escHtml(e.message || String(e)));
    }
  }

  function renderGlobalRequests(rows) {
    const tbody = document.getElementById('qc-global-req-body');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-muted" style="padding:16px">No pending requests in divisions you may view.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((r) => {
      const isH = quotaRowDivisionIsHQ(r.divisionId);
      const canAct = canManageDivisionQuota(u, r.divisionId, isH, userDivisionIsHQ);
      const detail = r.requestType === 'MDQRA'
        ? `${r.reductionPercent}% reduction`
        : `LOA ${escHtml(r.loaStart || '')} → ${escHtml(r.loaEnd || '')}`;
      const actions = canAct
        ? `<button type="button" class="btn btn-sm btn-success qc-gappr" data-id="${escHtml(r.id)}">Approve</button>
           <button type="button" class="btn btn-sm btn-danger qc-grej" data-id="${escHtml(r.id)}">Reject</button>`
        : '<span class="text-muted">View only</span>';
      return `<tr>
        <td>${escHtml(divisionLabel(r.divisionId))}</td>
        <td>${escHtml(r.requesterUsername || '—')}</td>
        <td>${escHtml(r.requestType)}</td>
        <td>${detail}</td>
        <td>${escHtml(r.reason || '—')}</td>
        <td>${actions}</td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('.qc-gappr').forEach((b) => {
      b.addEventListener('click', () => decide(b.dataset.id, true));
    });
    tbody.querySelectorAll('.qc-grej').forEach((b) => {
      b.addEventListener('click', () => decide(b.dataset.id, false));
    });
  }

  async function refreshAll() {
    if (!currentDivisionId) return;
    try {
      const payload = await QF.listCommandData(currentDivisionId);
      renderRequests(payload.pendingRequests || []);
      renderDefs(payload.eventDefinitions || []);
      renderPolicies(payload.policies || []);
    } catch (e) {
      console.error(e);
      showAlert('qc-req-alert', 'danger', escHtml(e.message || String(e)));
    }
    await refreshReform();
    await refreshGlobalPending();
  }

  function renderRequests(rows) {
    const tbody = document.getElementById('qc-req-body');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-muted" style="padding:16px">No pending requests.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((r) => {
      const detail = r.requestType === 'MDQRA'
        ? `${r.reductionPercent}% reduction`
        : `LOA ${escHtml(r.loaStart || '')} → ${escHtml(r.loaEnd || '')}`;
      return `<tr>
        <td>${escHtml(r.requesterUsername || '—')}</td>
        <td>${escHtml(r.requestType)}</td>
        <td>${detail}</td>
        <td>${escHtml(r.reason || '—')}</td>
        <td>
          <button type="button" class="btn btn-sm btn-success qc-appr" data-id="${escHtml(r.id)}">Approve</button>
          <button type="button" class="btn btn-sm btn-danger qc-rej" data-id="${escHtml(r.id)}">Reject</button>
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('.qc-appr').forEach((b) => {
      b.addEventListener('click', () => decide(b.dataset.id, true));
    });
    tbody.querySelectorAll('.qc-rej').forEach((b) => {
      b.addEventListener('click', () => decide(b.dataset.id, false));
    });
  }

  async function decide(requestId, approve) {
    clearAlert('qc-req-alert');
    const notes = approve ? '' : (prompt('Rejection note (optional):') ?? '');
    try {
      await QF.decideQuotaRequest(requestId, u, approve, notes || null);
      await auditLog('quota.decide', 'quota_request', requestId, { approve, note: notes });
      showAlert('qc-req-alert', 'success', approve ? 'Request approved.' : 'Request rejected.');
      await refreshAll();
    } catch (e) {
      showAlert('qc-req-alert', 'danger', escHtml(e.message || String(e)));
    }
  }

  function renderDefs(rows) {
    const tbody = document.getElementById('qc-def-body');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-muted" style="padding:12px">None yet.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((d) => {
      const m = d.matchCustomName
        ? `custom: ${escHtml(d.matchCustomName)}`
        : escHtml(d.matchEventType || '—');
      return `<tr>
        <td>${escHtml(d.key)}</td>
        <td>${escHtml(d.label)}</td>
        <td>${m}</td>
        <td><button type="button" class="btn btn-sm btn-danger qc-def-del" data-id="${escHtml(d.id)}">Delete</button></td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('.qc-def-del').forEach((b) => {
      b.addEventListener('click', () => removeDef(b.dataset.id));
    });
  }

  document.getElementById('qc-def-save').addEventListener('click', async () => {
    clearAlert('qc-def-alert');
    const key = document.getElementById('qc-def-key').value.trim();
    const label = document.getElementById('qc-def-label').value.trim();
    const matchEventType = document.getElementById('qc-def-type').value || null;
    const matchCustomName = document.getElementById('qc-def-custom').value.trim() || null;
    if (!key || !label) {
      showAlert('qc-def-alert', 'danger', 'Key and label are required.');
      return;
    }
    if (!matchEventType && !matchCustomName) {
      showAlert('qc-def-alert', 'danger', 'Set either a standard event type or custom name.');
      return;
    }
    try {
      await QF.saveEventDefinition(u.uid, currentDivisionId, {
        divisionId: currentDivisionId,
        key,
        label,
        matchEventType,
        matchCustomName,
      });
      showAlert('qc-def-alert', 'success', 'Definition saved.');
      document.getElementById('qc-def-key').value = '';
      document.getElementById('qc-def-label').value = '';
      document.getElementById('qc-def-custom').value = '';
      await refreshAll();
    } catch (e) {
      showAlert('qc-def-alert', 'danger', escHtml(e.message || String(e)));
    }
  });

  async function removeDef(definitionId) {
    if (!confirm('Delete this event definition?')) return;
    clearAlert('qc-def-alert');
    try {
      await QF.deleteEventDefinition(definitionId, currentDivisionId);
      await refreshAll();
    } catch (e) {
      showAlert('qc-def-alert', 'danger', escHtml(e.message || String(e)));
    }
  }

  function renderPolicies(rows) {
    const tbody = document.getElementById('qc-pol-body');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-muted" style="padding:12px">No policies.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((p) => {
      const n = (p.rules && p.rules.length) || 0;
      return `<tr>
        <td>${escHtml(p.rankId)}</td>
        <td>${escHtml(p.periodKind)}</td>
        <td>${escHtml(p.effectiveFrom || '—')}</td>
        <td>${escHtml(p.effectiveTo || '—')}</td>
        <td>${n}</td>
      </tr>`;
    }).join('');
  }

  document.getElementById('qc-pol-save').addEventListener('click', async () => {
    clearAlert('qc-pol-alert');
    let rules;
    try {
      rules = JSON.parse(document.getElementById('qc-pol-rules').value || '[]');
      if (!Array.isArray(rules)) throw new Error('Rules must be a JSON array.');
    } catch (e) {
      showAlert('qc-pol-alert', 'danger', 'Invalid rules JSON: ' + escHtml(e.message));
      return;
    }
    const rankId = document.getElementById('qc-pol-rank').value;
    const periodKind = document.getElementById('qc-pol-period').value;
    const effectiveFrom = document.getElementById('qc-pol-from').value;
    const effectiveTo = document.getElementById('qc-pol-to').value || null;
    if (!effectiveFrom) {
      showAlert('qc-pol-alert', 'danger', 'Effective from date is required.');
      return;
    }
    try {
      await QF.saveQuotaPolicy(u.uid, currentDivisionId, {
        divisionId: currentDivisionId,
        rankId,
        periodKind,
        effectiveFrom,
        effectiveTo,
        rules,
      });
      showAlert('qc-pol-alert', 'success', 'Policy saved.');
      await refreshAll();
    } catch (e) {
      showAlert('qc-pol-alert', 'danger', escHtml(e.message || String(e)));
    }
  });

  async function refreshReform() {
    clearAlert('qc-ref-alert');
    const meta = document.getElementById('qc-reform-meta');
    const tbody = document.getElementById('qc-reform-body');
    try {
      const data = await QF.listReformSnapshot(currentDivisionId);
      if (!data.snapshot) {
        meta.textContent = 'No reform snapshot yet. Use “Compute for this division” or (SecNav+) “All divisions”.';
        tbody.innerHTML = '<tr><td colspan="6" class="text-muted" style="padding:12px">No data.</td></tr>';
        return;
      }
      const s = data.snapshot;
      meta.textContent = `Week ${s.weekKey} · ${s.periodStart} → ${s.periodEnd} · ${data.entries.length} personnel`;
      if (!data.entries.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-muted" style="padding:12px">No one on the reform list for this period.</td></tr>';
        return;
      }
      tbody.innerHTML = data.entries.map((e) => `<tr>
        <td>${escHtml(e.username || '—')}</td>
        <td>${escHtml(e.rankName || '—')}</td>
        <td>${escHtml(String(e.deficit))}</td>
        <td>${escHtml(String(e.completionPct))}%</td>
        <td>${escHtml(String(e.requiredTotal))}</td>
        <td>${escHtml(String(e.completedTotal))}</td>
      </tr>`).join('');
    } catch (e) {
      tbody.innerHTML = '';
      showAlert('qc-ref-alert', 'danger', escHtml(e.message || String(e)));
    }
  }

  document.getElementById('qc-reform-refresh').addEventListener('click', refreshReform);
  const qcReformDivBtn = document.getElementById('qc-reform-division');
  if (qcReformDivBtn) {
    qcReformDivBtn.addEventListener('click', async () => {
      if (!confirm(`Compute reform list for the selected division only?`)) return;
      try {
        qcReformDivBtn.disabled = true;
        await QF.runReformForDivision(currentDivisionId);
        await refreshReform();
      } catch (e) {
        alert(e.message || String(e));
      } finally {
        qcReformDivBtn.disabled = false;
      }
    });
  }
  document.getElementById('qc-reform-run').addEventListener('click', async () => {
    if (!confirm('Run reform assessment for ALL divisions now?')) return;
    try {
      if (u.permission_level < PERM.QUOTA_HQ_AUTHORITY && u.rankId !== 'secnav' && u.rankId !== 'administrator') {
        alert('SecNav+ only.');
        return;
      }
      const out = await QF.runReformAllDivisions(manageable.map((d) => d.id));
      alert('Done. Reform rows (total deficit entries): ' + (out.reformRows ?? '—'));
      await refreshReform();
    } catch (e) {
      alert(e.message || String(e));
    }
  });

  await refreshAll();
})();