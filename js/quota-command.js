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

  // ── Quota policy rule builder (friendly UI; saves same JSON shape) ──
  const hiddenRulesJson = document.getElementById('qc-pol-rules');
  const rulesListEl = document.getElementById('qc-pol-rules-list');
  const ruleTypeEl = document.getElementById('qc-rule-type');
  const ruleLabelEl = document.getElementById('qc-rule-label');

  const groupSection = document.getElementById('qc-rule-group');
  const groupReqCountEl = document.getElementById('qc-rule-required-count');
  const groupItemSel = document.getElementById('qc-rule-group-item');
  const groupAddBtn = document.getElementById('qc-rule-group-add');
  const groupItemsEl = document.getElementById('qc-rule-group-items');

  const mandatorySection = document.getElementById('qc-rule-mandatory');
  const mandatoryTypeSel = document.getElementById('qc-rule-mandatory-type');
  const mandatoryMinEl = document.getElementById('qc-rule-mandatory-min');
  const mandatoryAddBtn = document.getElementById('qc-rule-mandatory-add');
  const mandatoryItemsEl = document.getElementById('qc-rule-mandatory-items');

  const dutySection = document.getElementById('qc-rule-duty');
  const dutyMinutesEl = document.getElementById('qc-rule-minutes');

  const addRuleBtn = document.getElementById('qc-rule-add');
  const clearDraftBtn = document.getElementById('qc-rule-clear');

  const EVENT_TYPES_SIMPLE = EVENT_TYPES.filter((t) => t !== 'Custom Event');
  function fillEventTypeSelect(sel) {
    if (!sel) return;
    sel.innerHTML = '<option value="">— Select —</option>' + EVENT_TYPES_SIMPLE
      .map((t) => `<option value="${escHtml(t)}">${escHtml(t)}</option>`).join('');
  }
  fillEventTypeSelect(groupItemSel);
  fillEventTypeSelect(mandatoryTypeSel);

  let draftRules = [];
  let groupPool = [];
  let mandatoryReqs = [];

  function newRuleId() {
    return 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function ruleSummary(r) {
    if (!r) return '—';
    if (r.ruleType === 'duty_minutes') {
      return `${r.requiredMinutes || 0} duty minutes`;
    }
    if (r.ruleType === 'group') {
      const items = Array.isArray(r.items) ? r.items.map((x) => x.matchEventType).filter(Boolean) : [];
      return `Complete ${r.requiredCount || 0} from: ${items.join(', ') || '—'}`;
    }
    if (r.ruleType === 'mandatory') {
      const items = Array.isArray(r.items) ? r.items : [];
      const s = items.map((x) => `${x.matchEventType || '—'} ×${x.minCount || 1}`).join(', ');
      return `Mandatory: ${s || '—'}`;
    }
    return r.ruleType;
  }

  function syncHiddenJson() {
    if (hiddenRulesJson) hiddenRulesJson.value = JSON.stringify(draftRules, null, 2);
  }

  function renderDraftRules() {
    if (!rulesListEl) return;
    if (!draftRules.length) {
      rulesListEl.innerHTML = '<div class="text-muted" style="font-size:0.85rem">No rules added yet.</div>';
      syncHiddenJson();
      return;
    }
    rulesListEl.innerHTML = draftRules.map((r, idx) => {
      const title = escHtml(r.label || (r.ruleType || 'Rule'));
      const sub = escHtml(ruleSummary(r));
      return `<div class="rule-card">
        <div>
          <div class="rule-card-title">${title}</div>
          <div class="rule-card-sub">${sub}</div>
        </div>
        <div class="rule-card-actions">
          <button type="button" class="btn btn-sm btn-danger qc-rule-remove" data-idx="${idx}">Remove</button>
        </div>
      </div>`;
    }).join('');
    rulesListEl.querySelectorAll('.qc-rule-remove').forEach((b) => {
      b.addEventListener('click', () => {
        const i = Number(b.dataset.idx);
        if (!Number.isFinite(i)) return;
        draftRules.splice(i, 1);
        renderDraftRules();
      });
    });
    syncHiddenJson();
  }

  function setTypeUi(t) {
    const type = t || (ruleTypeEl ? ruleTypeEl.value : 'group');
    if (groupSection) groupSection.classList.toggle('hidden', type !== 'group');
    if (mandatorySection) mandatorySection.classList.toggle('hidden', type !== 'mandatory');
    if (dutySection) dutySection.classList.toggle('hidden', type !== 'duty_minutes');
  }
  if (ruleTypeEl) ruleTypeEl.addEventListener('change', () => setTypeUi(ruleTypeEl.value));

  if (groupAddBtn) {
    groupAddBtn.addEventListener('click', () => {
      const t = groupItemSel ? groupItemSel.value : '';
      if (!t) return;
      if (!groupPool.includes(t)) groupPool.push(t);
      if (groupItemsEl) groupItemsEl.textContent = groupPool.join(', ');
    });
  }
  if (mandatoryAddBtn) {
    mandatoryAddBtn.addEventListener('click', () => {
      const t = mandatoryTypeSel ? mandatoryTypeSel.value : '';
      const n = Number(mandatoryMinEl ? mandatoryMinEl.value : 0);
      if (!t || !(n > 0)) return;
      mandatoryReqs.push({ matchEventType: t, minCount: n });
      if (mandatoryItemsEl) {
        mandatoryItemsEl.textContent = mandatoryReqs.map((x) => `${x.matchEventType} ×${x.minCount}`).join(', ');
      }
    });
  }

  function clearDraftInputs() {
    if (ruleLabelEl) ruleLabelEl.value = '';
    if (groupReqCountEl) groupReqCountEl.value = '';
    if (groupItemSel) groupItemSel.value = '';
    if (groupItemsEl) groupItemsEl.textContent = '';
    if (mandatoryTypeSel) mandatoryTypeSel.value = '';
    if (mandatoryMinEl) mandatoryMinEl.value = '';
    if (mandatoryItemsEl) mandatoryItemsEl.textContent = '';
    if (dutyMinutesEl) dutyMinutesEl.value = '';
    groupPool = [];
    mandatoryReqs = [];
  }

  if (addRuleBtn) {
    addRuleBtn.addEventListener('click', () => {
      clearAlert('qc-pol-alert');
      const type = ruleTypeEl ? ruleTypeEl.value : 'group';
      const label = (ruleLabelEl ? ruleLabelEl.value : '').trim();
      const id = newRuleId();

      if (type === 'duty_minutes') {
        const mins = Number(dutyMinutesEl ? dutyMinutesEl.value : 0);
        if (!(mins > 0)) { showAlert('qc-pol-alert', 'danger', 'Duty minutes rule requires a positive minute value.'); return; }
        draftRules.push({ id, ruleType: 'duty_minutes', label: label || 'Duty minutes', requiredMinutes: mins });
      } else if (type === 'group') {
        const req = Number(groupReqCountEl ? groupReqCountEl.value : 0);
        if (!(req > 0)) { showAlert('qc-pol-alert', 'danger', 'Group rule requires a positive required count.'); return; }
        if (!groupPool.length) { showAlert('qc-pol-alert', 'danger', 'Group rule requires at least one pool item.'); return; }
        draftRules.push({
          id,
          ruleType: 'group',
          label: label || 'Group rule',
          requiredCount: req,
          items: groupPool.map((t) => ({ matchEventType: t })),
        });
      } else if (type === 'mandatory') {
        if (!mandatoryReqs.length) { showAlert('qc-pol-alert', 'danger', 'Mandatory rule requires at least one requirement.'); return; }
        draftRules.push({
          id,
          ruleType: 'mandatory',
          label: label || 'Mandatory rule',
          items: mandatoryReqs.map((x) => ({ matchEventType: x.matchEventType, minCount: x.minCount })),
        });
      }

      clearDraftInputs();
      renderDraftRules();
    });
  }

  if (clearDraftBtn) {
    clearDraftBtn.addEventListener('click', () => {
      clearDraftInputs();
      draftRules = [];
      renderDraftRules();
    });
  }

  setTypeUi(ruleTypeEl ? ruleTypeEl.value : 'group');
  renderDraftRules();

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
    const rules = Array.isArray(draftRules) ? draftRules.slice() : [];
    if (!rules.length) {
      showAlert('qc-pol-alert', 'danger', 'Add at least one rule before saving.');
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
      // Keep JSON in hidden textarea for debugging/visibility (not user-edited).
      const txt = document.getElementById('qc-pol-rules');
      if (txt) txt.value = JSON.stringify(rules, null, 2);
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