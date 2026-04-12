// ============================================================
// US NAVY CUSA PORTAL — Activity Logging
// ============================================================

(async function () {
  'use strict';

  const u = await requireAuth();
  renderHeader(u);
  applyPermissionUI(u);
  markActiveSidebarLink();
  setupLogoutBtn();

  const isHQPicker = u.permission_level >= PERM.ADMIN_PANEL;

  // ── Fetch Divisions ────────────────────────────────────────────
  async function fetchDivisions() {
    try {
      const snap = await db.collection('divisions').orderBy('name').get();
      return snap.docs.map(doc => ({
        id: doc.id,
        name: doc.data().name || '—',
      }));
    } catch (err) {
      console.error('Failed to fetch divisions:', err);
      showAlert('duty-alert', 'danger', 'Failed to load division list.');
      showAlert('event-alert', 'danger', 'Failed to load division list.');
      return [];
    }
  }

  const divisionSelector = document.getElementById('division-selector');
  const eventTypeSelect = document.getElementById('event-type');
  const divisions = await fetchDivisions();
  const tabBtnEvent = document.getElementById('tab-btn-event');

  divisions.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.name;
    divisionSelector.appendChild(opt);
  });

  // Default selection: HQ defaults to profile division if present, else first in list;
  // others use their assigned division.
  if (isHQPicker && divisions.length) {
    const hasProfile = u.divisionId && divisions.some(d => d.id === u.divisionId);
    divisionSelector.value = hasProfile ? u.divisionId : divisions[0].id;
  } else if (u.divisionId) {
    const match = divisions.find(d => d.id === u.divisionId);
    if (match) divisionSelector.value = u.divisionId;
  }

  /** Division id/name for the log being submitted (HQ picker vs profile). */
  function getActivityDivision() {
    const pickerGroup = divisionSelector.closest('[data-min-perm]');
    const pickerShown = pickerGroup && !pickerGroup.classList.contains('hidden');
    if (pickerShown && isHQPicker) {
      const id = divisionSelector.value;
      const row = divisions.find(d => d.id === id);
      return { divisionId: id || null, divisionName: row ? row.name : null };
    }
    return { divisionId: u.divisionId || null, divisionName: u.divisionName || null };
  }

  function setHostEventTabVisible(show) {
    if (!tabBtnEvent) return;
    tabBtnEvent.classList.toggle('hidden', !show);
    if (!show) {
      const eventPanel = document.getElementById('tab-event');
      const dutyBtn = document.querySelector('.tab-btn[data-tab="tab-duty"]');
      if (eventPanel && eventPanel.classList.contains('active')) {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        if (dutyBtn) dutyBtn.classList.add('active');
        document.getElementById('tab-duty').classList.add('active');
      }
    }
  }

  async function loadEventTypesForDivision(divisionId) {
    let typesToShow = EVENT_TYPES;
    if (divisionId && divisionId !== 'ndvl') {
      try {
        const divSnap = await db.collection('divisions').doc(divisionId).get();
        if (divSnap.exists) {
          const divTypes = divSnap.data().eventTypes;
          if (Array.isArray(divTypes) && divTypes.length) {
            const hasCustom = divTypes.includes('Custom Event');
            typesToShow = hasCustom ? [...divTypes] : [...divTypes, 'Custom Event'];
          }
        }
      } catch (_) {}
    }
    eventTypeSelect.innerHTML = '<option value="">— Select Type —</option>';
    typesToShow.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      eventTypeSelect.appendChild(opt);
    });
    document.getElementById('custom-event-row').classList.add('hidden');
  }

  function applyDivisionContextForActivity() {
    const { divisionId } = getActivityDivision();
    const canHost = divisionId && divisionId !== 'ndvl';
    setHostEventTabVisible(canHost);
    return loadEventTypesForDivision(divisionId);
  }

  divisionSelector.addEventListener('change', () => {
    applyDivisionContextForActivity();
  });

  // ── Tab Logic ────────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('hidden')) return;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });

  eventTypeSelect.addEventListener('change', () => {
    document.getElementById('custom-event-row')
      .classList.toggle('hidden', eventTypeSelect.value !== 'Custom Event');
  });

  await applyDivisionContextForActivity();

  async function resolveAttendeeUidsFromInput(raw, logDivisionId) {
    const parts = String(raw || '')
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.length) return { uids: [], unknown: [] };
    try {
      if (!window.QuotaFirestore) throw new Error('QuotaFirestore not loaded');
      const res = await window.QuotaFirestore.resolveEventAttendees(logDivisionId, parts);
      const uids = [];
      const unknown = [];
      (res.attendees || []).forEach((a) => {
        if (a.uid) uids.push(a.uid);
        else {
          const tag = a.reason === 'wrong_division' ? `${a.username} (other division)` : a.username;
          unknown.push(tag);
        }
      });
      return { uids: [...new Set(uids)], unknown };
    } catch (e) {
      return { uids: [], unknown: [e.message || 'resolve failed'] };
    }
  }

  // ── Shared: build log proof object from form inputs ───────
  async function collectProof(imageInputId, discordInputId, alertId) {
    const imageFile   = document.getElementById(imageInputId).files[0];
    const discordLink = document.getElementById(discordInputId).value.trim();

    if (!imageFile && !discordLink) {
      showAlert(alertId, 'danger', 'Please provide at least one proof: upload an image or enter a Discord link.');
      return null;
    }
    if (discordLink && !isValidUrl(discordLink)) {
      showAlert(alertId, 'danger', 'Discord link must be a valid URL.');
      return null;
    }

    let proofImageUrl = null;
    if (imageFile) {
      proofImageUrl = await uploadProofImage(imageFile, u.uid);
    }

    return { proofImageUrl, discordLink: discordLink || null };
  }

  // ── Duty Log Form ─────────────────────────────────────────
  document.getElementById('duty-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn     = document.getElementById('duty-submit');
    const minutes = parseInt(document.getElementById('duty-minutes').value, 10);
    const date    = document.getElementById('duty-date').value;
    const notes   = document.getElementById('duty-notes').value.trim();

    clearAlert('duty-alert');

    if (!date) { showAlert('duty-alert', 'danger', 'Date is required.'); return; }
    if (!minutes || minutes < 1) { showAlert('duty-alert', 'danger', 'Enter a valid number of duty minutes.'); return; }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Uploading proof…';

    let proof;
    try {
      proof = await collectProof('duty-proof-image', 'duty-discord', 'duty-alert');
      if (!proof) { btn.disabled = false; btn.textContent = 'Submit Duty Log'; return; }
    } catch (err) {
      showAlert('duty-alert', 'danger', err.message);
      btn.disabled = false; btn.textContent = 'Submit Duty Log';
      return;
    }

    btn.innerHTML = '<span class="spinner"></span> Submitting…';

    const { divisionId: logDivId, divisionName: logDivName } = getActivityDivision();

    try {
      const logRef = await db.collection('logs').add({
        type:            'duty',
        authorUid:       u.uid,
        authorUsername:  u.username          || null,
        authorRankId:    u.rankId            || null,
        authorRankName:  u.rankName          || null,
        authorDivRankId: u.divRankId         || null,
        authorDivRank:   u.divRankName       || null,
        divisionId:      logDivId,
        divisionName:    logDivName,
        status:          'pending',
        date:            firebase.firestore.Timestamp.fromDate(new Date(date)),
        durationMinutes: minutes,
        notes:           notes               || null,
        proofImageUrl:   proof.proofImageUrl,
        discordLink:     proof.discordLink,
        createdAt:       firebase.firestore.FieldValue.serverTimestamp(),
        reviewedBy:      null,
        reviewedAt:      null,
        reviewNotes:     null,
      });

      await auditLog('log.create', 'log', logRef.id, { type: 'duty', minutes, divisionId: logDivId });

      // Notify Discord directly (non-fatal)
      sendDiscordNotification(logDivId, {
        title:  '⏱️ Duty Log Submitted — Pending Approval',
        color:  0x3498db,
        fields: [
          { name: 'Personnel', value: u.username || '—',       inline: true },
          { name: 'Duration',  value: `${minutes} min`,        inline: true },
          { name: 'Division',  value: logDivName || '—',   inline: true },
          ...(proof.discordLink ? [{ name: 'Discord Proof', value: `[View](${proof.discordLink})`, inline: false }] : []),
        ],
      });

      showAlert('duty-alert', 'success', '&#10003; Duty log submitted and is pending approval.');
      e.target.reset();
      await loadMyLogs();
    } catch (err) {
      showAlert('duty-alert', 'danger', 'Submission failed: ' + err.message);
      console.error('Duty log submit failed:', err);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Submit Duty Log';
    }
  });

  // ── Event Form ────────────────────────────────────────────
  document.getElementById('event-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn          = document.getElementById('event-submit');
    const evtType      = document.getElementById('event-type').value;
    const customName   = document.getElementById('custom-event-name').value.trim();
    const date         = document.getElementById('event-date').value;
    const participants = parseInt(document.getElementById('event-participants').value, 10) || 0;
    const desc         = document.getElementById('event-desc').value.trim();
    const attendeesRaw = document.getElementById('event-attendees').value;

    clearAlert('event-alert');

    if (!evtType)  { showAlert('event-alert', 'danger', 'Event type is required.'); return; }
    if (!date)     { showAlert('event-alert', 'danger', 'Date is required.'); return; }
    if (evtType === 'Custom Event' && !customName) {
      showAlert('event-alert', 'danger', 'Please name your custom event.'); return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Uploading proof…';

    let proof;
    try {
      proof = await collectProof('event-proof-image', 'event-discord', 'event-alert');
      if (!proof) { btn.disabled = false; btn.textContent = 'Submit Event Log'; return; }
    } catch (err) {
      showAlert('event-alert', 'danger', err.message);
      btn.disabled = false; btn.textContent = 'Submit Event Log';
      return;
    }

    btn.innerHTML = '<span class="spinner"></span> Resolving attendees…';

    const { divisionId: logDivId, divisionName: logDivName } = getActivityDivision();
    if (!logDivId || logDivId === 'ndvl') {
      showAlert('event-alert', 'danger', 'Hosted events cannot be submitted for Navy Divisionless. Use duty minutes or select another division (HQ).');
      btn.disabled = false;
      btn.textContent = 'Submit Event Log';
      return;
    }

    const { uids: attendeeUids, unknown: unknownAttendees } =
      await resolveAttendeeUidsFromInput(attendeesRaw, logDivId);
    if (unknownAttendees.length) {
      showAlert('event-alert', 'danger', 'Unknown usernames (check spelling): ' + unknownAttendees.map(escHtml).join(', '));
      btn.disabled = false;
      btn.textContent = 'Submit Event Log';
      return;
    }

    btn.innerHTML = '<span class="spinner"></span> Submitting…';

    try {
      const displayName = evtType === 'Custom Event' ? customName : evtType;
      const logRef = await db.collection('logs').add({
        type:            'event',
        authorUid:       u.uid,
        authorUsername:  u.username          || null,
        authorRankId:    u.rankId            || null,
        authorRankName:  u.rankName          || null,
        authorDivRankId: u.divRankId         || null,
        authorDivRank:   u.divRankName       || null,
        divisionId:      logDivId,
        divisionName:    logDivName,
        status:          'pending',
        date:            firebase.firestore.Timestamp.fromDate(new Date(date)),
        eventType:       evtType,
        customEventName: evtType === 'Custom Event' ? customName : null,
        participants:    participants,
        attendeeUids:    attendeeUids.length ? attendeeUids : null,
        description:     desc                || null,
        proofImageUrl:   proof.proofImageUrl,
        discordLink:     proof.discordLink,
        createdAt:       firebase.firestore.FieldValue.serverTimestamp(),
        reviewedBy:      null,
        reviewedAt:      null,
        reviewNotes:     null,
      });

      await auditLog('log.create', 'log', logRef.id, { type: 'event', evtType, divisionId: logDivId });

      sendDiscordNotification(logDivId, {
        title:  `📋 Event Hosted — ${escHtml(displayName)}`,
        color:  0x9b59b6,
        fields: [
          { name: 'Personnel',   value: u.username || '—',      inline: true },
          { name: 'Participants',value: String(participants),    inline: true },
          { name: 'Division',    value: logDivName || '—',  inline: true },
          ...(proof.discordLink ? [{ name: 'Discord Proof', value: `[View](${proof.discordLink})`, inline: false }] : []),
        ],
      });

      showAlert('event-alert', 'success', '&#10003; Event log submitted and is pending approval.');
      e.target.reset();
      document.getElementById('event-attendees').value = '';
      document.getElementById('custom-event-row').classList.add('hidden');
      await loadMyLogs();
    } catch (err) {
      showAlert('event-alert', 'danger', 'Submission failed: ' + err.message);
      console.error('Event log submit failed:', err);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Submit Event Log';
    }
  });

  // ── My Logs List ──────────────────────────────────────────
  async function loadMyLogs() {
    const tbody = document.getElementById('my-logs-body');
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:20px">
      <span class="spinner"></span></td></tr>`;
    try {
      const snap = await db.collection('logs')
        .where('authorUid', '==', u.uid)
        .orderBy('createdAt', 'desc')
        .limit(50)
        .get();

      if (snap.empty) {
        tbody.innerHTML = `<tr><td colspan="6">
          <div class="empty-state"><div class="empty-icon">📋</div>
          <p>No logs submitted yet.</p></div></td></tr>`;
        return;
      }

      tbody.innerHTML = snap.docs.map(doc => {
        const d = doc.data();
        const detail = d.type === 'duty'
          ? `${d.durationMinutes} min`
          : (d.eventType === 'Custom Event' ? escHtml(d.customEventName || '') : escHtml(d.eventType || ''));

        const proofLinks = [
          d.proofImageUrl ? `<a href="${escHtml(d.proofImageUrl)}" target="_blank" rel="noopener">🖼 Image</a>` : '',
          d.discordLink   ? `<a href="${escHtml(d.discordLink)}"   target="_blank" rel="noopener">Discord ↗</a>` : '',
        ].filter(Boolean).join(' · ') || '—';

        const reviewNote = d.reviewNotes
          ? `<br><small class="text-muted">${escHtml(d.reviewNotes)}</small>` : '';

        return `<tr>
          <td>${typeBadge(d.type)}</td>
          <td>${detail}</td>
          <td>${fmtDate(d.date)}</td>
          <td>${proofLinks}</td>
          <td>${statusBadge(d.status)}${reviewNote}</td>
          <td>${fmtDate(d.createdAt)}</td>
        </tr>`;
      }).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-danger" style="padding:16px">Failed to load logs: ${escHtml(e.message)}</td></tr>`;
      console.error('loadMyLogs failed:', e);
    }
  }

  await loadMyLogs();

  // ── Helpers ───────────────────────────────────────────────
  function isValidUrl(str) {
    try { new URL(str); return true; } catch { return false; }
  }

  async function sendDiscordNotification(divisionId, embed) {
    if (!divisionId) return;
    try {
      const divSnap = await db.collection('divisions').doc(divisionId).get();
      if (!divSnap.exists || !divSnap.data().webhookUrl) return;
      await fetch(divSnap.data().webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [{ ...embed, footer: { text: 'US Navy CUSA Portal' }, timestamp: new Date().toISOString() }],
        }),
      });
    } catch (e) {
      console.warn('Discord notification failed (non-fatal):', e.message);
    }
  }
})();
