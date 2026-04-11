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

  // ── Tab Logic ────────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });

  // ── Populate Event Type Select ────────────────────────────
  const eventTypeSelect = document.getElementById('event-type');
  EVENT_TYPES.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    eventTypeSelect.appendChild(opt);
  });

  eventTypeSelect.addEventListener('change', () => {
    const customRow = document.getElementById('custom-event-row');
    customRow.classList.toggle('hidden', eventTypeSelect.value !== 'Custom Event');
  });

  // ── Duty Log Form ─────────────────────────────────────────
  document.getElementById('duty-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('duty-submit');
    const minutes     = parseInt(document.getElementById('duty-minutes').value, 10);
    const date        = document.getElementById('duty-date').value;
    const notes       = document.getElementById('duty-notes').value.trim();
    const discordLink = document.getElementById('duty-discord').value.trim();

    if (!date || !discordLink) {
      showAlert('duty-alert', 'danger', 'Date and Discord proof link are required.');
      return;
    }
    if (!minutes || minutes < 1) {
      showAlert('duty-alert', 'danger', 'Enter a valid number of duty minutes.');
      return;
    }
    if (!isValidUrl(discordLink)) {
      showAlert('duty-alert', 'danger', 'Please enter a valid Discord message URL as proof.');
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Submitting…';
    clearAlert('duty-alert');

    try {
      const logRef = await db.collection('logs').add({
        type:            'duty',
        authorUid:       u.uid,
        authorUsername:  u.username,
        authorRankId:    u.rankId,
        authorRankName:  u.rankName,
        divisionId:      u.divisionId   || null,
        divisionName:    u.divisionName || null,
        status:          'pending',
        date:            firebase.firestore.Timestamp.fromDate(new Date(date)),
        durationMinutes: minutes,
        notes:           notes,
        discordLink:     discordLink,
        createdAt:       firebase.firestore.FieldValue.serverTimestamp(),
        reviewedBy:      null,
        reviewedAt:      null,
        reviewNotes:     null,
      });

      await auditLog('log.create', 'log', logRef.id, { type: 'duty', minutes });

      // Notify Discord directly from browser (non-fatal if it fails)
      sendDiscordNotification(u.divisionId, {
        title: '⏱️ Duty Log Submitted',
        color: 0x3498db,
        fields: [
          { name: 'Personnel', value: u.username,            inline: true },
          { name: 'Duration',  value: `${minutes} minutes`,  inline: true },
          { name: 'Proof',     value: `[View](${discordLink})`, inline: false },
        ],
      });

      showAlert('duty-alert', 'success', '&#10003; Duty log submitted and is pending approval.');
      e.target.reset();
      await loadMyLogs();
    } catch (err) {
      showAlert('duty-alert', 'danger', 'Submission failed: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Submit Duty Log';
    }
  });

  // ── Event Form ────────────────────────────────────────────
  document.getElementById('event-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('event-submit');
    const evtType     = document.getElementById('event-type').value;
    const customName  = document.getElementById('custom-event-name').value.trim();
    const date        = document.getElementById('event-date').value;
    const participants= parseInt(document.getElementById('event-participants').value, 10) || 0;
    const desc        = document.getElementById('event-desc').value.trim();
    const discordLink = document.getElementById('event-discord').value.trim();

    if (!evtType || !date || !discordLink) {
      showAlert('event-alert', 'danger', 'Event type, date, and Discord proof link are required.');
      return;
    }
    if (evtType === 'Custom Event' && !customName) {
      showAlert('event-alert', 'danger', 'Please name your custom event.');
      return;
    }
    if (!isValidUrl(discordLink)) {
      showAlert('event-alert', 'danger', 'Please enter a valid Discord message URL as proof.');
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Submitting…';
    clearAlert('event-alert');

    try {
      const logRef = await db.collection('logs').add({
        type:            'event',
        authorUid:       u.uid,
        authorUsername:  u.username,
        authorRankId:    u.rankId,
        authorRankName:  u.rankName,
        divisionId:      u.divisionId   || null,
        divisionName:    u.divisionName || null,
        status:          'pending',
        date:            firebase.firestore.Timestamp.fromDate(new Date(date)),
        eventType:       evtType,
        customEventName: evtType === 'Custom Event' ? customName : null,
        participants:    participants,
        description:     desc,
        discordLink:     discordLink,
        createdAt:       firebase.firestore.FieldValue.serverTimestamp(),
        reviewedBy:      null,
        reviewedAt:      null,
        reviewNotes:     null,
      });

      await auditLog('log.create', 'log', logRef.id, { type: 'event', evtType });

      sendDiscordNotification(u.divisionId, {
        title: `📋 Event Log — ${evtType === 'Custom Event' ? customName : evtType}`,
        color: 0x9b59b6,
        fields: [
          { name: 'Personnel',   value: u.username,                           inline: true },
          { name: 'Participants',value: String(participants || '—'),           inline: true },
          { name: 'Proof',       value: `[View](${discordLink})`,             inline: false },
        ],
      });

      showAlert('event-alert', 'success', '&#10003; Event log submitted and is pending approval.');
      e.target.reset();
      document.getElementById('custom-event-row').classList.add('hidden');
      await loadMyLogs();
    } catch (err) {
      showAlert('event-alert', 'danger', 'Submission failed: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Submit Event Log';
    }
  });

  // ── My Logs List ──────────────────────────────────────────
  async function loadMyLogs() {
    const tbody = document.getElementById('my-logs-body');
    tbody.innerHTML = `<tr><td colspan="6" class="text-muted" style="text-align:center;padding:20px">
      <span class="spinner"></span> Loading…</td></tr>`;

    try {
      const snap = await db.collection('logs')
        .where('authorUid', '==', u.uid)
        .orderBy('createdAt', 'desc')
        .limit(50)
        .get();

      if (snap.empty) {
        tbody.innerHTML = `<tr><td colspan="6">
          <div class="empty-state"><div class="empty-icon">📋</div>
          <p>You haven't submitted any logs yet.</p></div></td></tr>`;
        return;
      }

      tbody.innerHTML = snap.docs.map(doc => {
        const d = doc.data();
        const detail = d.type === 'duty'
          ? `${d.durationMinutes} min`
          : (d.eventType === 'Custom Event' ? escHtml(d.customEventName) : escHtml(d.eventType));
        const proof = d.discordLink
          ? `<a href="${escHtml(d.discordLink)}" target="_blank" rel="noopener">View ↗</a>`
          : '—';
        const reviewNote = d.reviewNotes
          ? `<br><small class="text-muted">${escHtml(d.reviewNotes)}</small>`
          : '';
        return `<tr>
          <td>${typeBadge(d.type)}</td>
          <td>${detail}</td>
          <td>${fmtDate(d.date)}</td>
          <td>${proof}</td>
          <td>${statusBadge(d.status)}${reviewNote}</td>
          <td>${fmtDate(d.createdAt)}</td>
        </tr>`;
      }).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-danger">Failed to load logs.</td></tr>`;
      console.error(e);
    }
  }

  await loadMyLogs();

  // ── Helpers ───────────────────────────────────────────────
  function isValidUrl(str) {
    try { new URL(str); return true; } catch { return false; }
  }

  // Send a Discord embed directly from the browser.
  // Reads the division's webhookUrl from Firestore. Non-fatal — never throws.
  async function sendDiscordNotification(divisionId, embed) {
    if (!divisionId) return;
    try {
      const divSnap = await db.collection('divisions').doc(divisionId).get();
      if (!divSnap.exists || !divSnap.data().webhookUrl) return;
      await fetch(divSnap.data().webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [{
            ...embed,
            footer:    { text: 'US Navy CUSA Portal' },
            timestamp: new Date().toISOString(),
          }],
        }),
      });
    } catch (e) {
      console.warn('Discord notification failed (non-fatal):', e.message);
    }
  }
})();
