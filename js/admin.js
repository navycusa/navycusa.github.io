// ============================================================
// US NAVY CUSA PORTAL — Admin Panel
// ============================================================

(async function () {
  'use strict';

  const u = await requireAuth({ minPermission: PERM.ADMIN_PANEL });
  renderHeader(u);
  applyPermissionUI(u);
  markActiveSidebarLink();
  setupLogoutBtn();

  // ── Tab routing ──────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === tabId));
  }

  // Deep-link to #review tab
  if (window.location.hash === '#review') switchTab('tab-review');

  // ══════════════════════════════════════════════════════════
  // TAB: Users
  // ══════════════════════════════════════════════════════════
  let allUsers = [];

  await loadUsers();

  document.getElementById('add-user-btn').addEventListener('click', () => openUserModal(null));
  document.getElementById('user-search').addEventListener('input', filterUsers);

  async function loadUsers() {
    const tbody = document.getElementById('users-body');
    tbody.innerHTML = loadingRow(7);
    try {
      const snap = await db.collection('users').orderBy('username').get();
      allUsers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderUsers(allUsers);
    } catch (e) {
      console.error('loadUsers failed:', e);
      tbody.innerHTML = errorRow(7, e.message);
    }
  }

  function renderUsers(list) {
    const tbody = document.getElementById('users-body');
    if (!list.length) {
      tbody.innerHTML = emptyRow(7, '👤', 'No users found.');
      return;
    }
    tbody.innerHTML = list.map(usr => {
      const rankObj = getRankById(usr.rankId);
      const cat = rankObj ? catBadge(rankObj.cat) : '';
      const canEdit = u.permission_level > (usr.permission_level || 0) || u.uid === usr.uid;
      return `<tr>
        <td><strong>${escHtml(usr.username)}</strong></td>
        <td><span class="badge ${cat}">${escHtml(usr.rankName || '—')}</span></td>
        <td>${escHtml(usr.divisionName || '—')}</td>
        <td><span class="badge ${usr.isActive !== false ? 'badge-approved' : 'badge-rejected'}">
          ${usr.isActive !== false ? 'Active' : 'Inactive'}</span></td>
        <td>${fmtDate(usr.createdAt)}</td>
        <td>
          ${canEdit ? `<button class="btn btn-sm btn-secondary" onclick="openUserModal('${usr.id}')">Edit</button>` : '—'}
        </td>
      </tr>`;
    }).join('');
  }

  function filterUsers() {
    const q = document.getElementById('user-search').value.toLowerCase();
    renderUsers(allUsers.filter(u =>
      u.username.toLowerCase().includes(q) ||
      (u.rankName || '').toLowerCase().includes(q) ||
      (u.divisionName || '').toLowerCase().includes(q)
    ));
  }

  // User Modal
  window.openUserModal = async function (userId) {
    const modal    = document.getElementById('user-modal');
    const title    = document.getElementById('user-modal-title');
    const rankSel  = document.getElementById('um-rank');
    const divSel   = document.getElementById('um-division');
    const activeEl = document.getElementById('um-active');

    // Populate rank select (only ranks ≤ own level)
    rankSel.innerHTML = '<option value="">— Select Rank —</option>' +
      getRanksUpTo(u.permission_level - 1).map(r =>
        `<option value="${r.id}">${r.name} (${r.short})</option>`
      ).join('');

    // Populate division select from Firestore
    try {
      const divSnap = await db.collection('divisions').orderBy('name').get();
      divSel.innerHTML = '<option value="">— Select Division —</option>' +
        divSnap.docs.map(d => `<option value="${d.id}">${escHtml(d.data().name)}</option>`).join('');
    } catch (_) {
      divSel.innerHTML = DEFAULT_DIVISIONS.map(d =>
        `<option value="${d.id}">${d.name}</option>`
      ).join('');
    }

    if (userId) {
      // Editing existing user
      title.textContent = 'Edit User';
      const usr = allUsers.find(u => u.id === userId);
      if (!usr) return;
      document.getElementById('um-username').value   = usr.username;
      document.getElementById('um-username').disabled = true;
      rankSel.value  = usr.rankId    || '';
      divSel.value   = usr.divisionId || '';
      activeEl.checked = usr.isActive !== false;
      document.getElementById('user-modal-save').onclick = () => saveUser(userId, usr);
    } else {
      // Creating new user
      title.textContent = 'Add New Personnel';
      document.getElementById('um-username').value    = '';
      document.getElementById('um-username').disabled  = false;
      rankSel.value  = '';
      divSel.value   = '';
      activeEl.checked = true;
      document.getElementById('user-modal-save').onclick = () => saveUser(null, null);
    }

    modal.classList.remove('hidden');
  };

  document.getElementById('user-modal-close').addEventListener('click', closeUserModal);
  document.getElementById('user-modal-cancel').addEventListener('click', closeUserModal);

  function closeUserModal() {
    document.getElementById('user-modal').classList.add('hidden');
    clearAlert('user-modal-alert');
  }

  async function saveUser(userId, existing) {
    const username  = document.getElementById('um-username').value.trim();
    const rankId    = document.getElementById('um-rank').value;
    const divisionId= document.getElementById('um-division').value;
    const isActive  = document.getElementById('um-active').checked;
    const btn       = document.getElementById('user-modal-save');

    if (!username || !rankId || !divisionId) {
      showAlert('user-modal-alert', 'danger', 'Username, rank, and division are required.');
      return;
    }

    const rankObj = getRankById(rankId);
    if (!rankObj) { showAlert('user-modal-alert', 'danger', 'Invalid rank.'); return; }

    // Can't assign rank equal to or higher than own
    if (rankObj.pl >= u.permission_level) {
      showAlert('user-modal-alert', 'danger', 'You cannot assign a rank equal to or higher than your own.');
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';

    try {
      if (userId) {
        // Update existing user
        const divSnap  = await db.collection('divisions').doc(divisionId).get();
        const divName  = divSnap.exists ? divSnap.data().name : divisionId;

        await db.collection('users').doc(userId).update({
          rankId:           rankId,
          rankName:         rankObj.name,
          permission_level: rankObj.pl,
          divisionId:       divisionId,
          divisionName:     divName,
          isActive:         isActive,
          updatedAt:        firebase.firestore.FieldValue.serverTimestamp(),
          updatedBy:        u.uid,
        });
        await auditLog('user.update', 'user', userId, { rankId, divisionId, isActive });
        showAlert('user-modal-alert', 'success', 'User updated.');
      } else {
        // Create Firebase Auth account via REST API (doesn't sign out current admin)
        const email    = usernameToEmail(username);
        const password = username + '1234';

        const resp = await fetch(
          `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${firebaseConfig.apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, returnSecureToken: false }),
          }
        );
        const authData = await resp.json();

        if (authData.error) {
          const msg = authData.error.message;
          throw new Error(
            msg === 'EMAIL_EXISTS'   ? `Username "${username}" is already taken.` :
            msg === 'WEAK_PASSWORD : Password should be at least 6 characters' ? 'Password too weak.' :
            msg
          );
        }

        const newUid = authData.localId;

        // Write Firestore user document
        const divSnap2  = await db.collection('divisions').doc(divisionId).get();
        const divName2  = divSnap2.exists ? divSnap2.data().name : divisionId;

        await db.collection('users').doc(newUid).set({
          username,
          email,
          rankId:             rankObj.id,
          rankName:           rankObj.name,
          rankShort:          rankObj.short,
          permission_level:   rankObj.pl,
          divisionId,
          divisionName:       divName2,
          mustChangePassword: true,
          isActive:           true,
          createdAt:          firebase.firestore.FieldValue.serverTimestamp(),
          createdBy:          u.uid,
        });

        await auditLog('user.create', 'user', newUid, { username, rankId, divisionId });
        showAlert('user-modal-alert', 'success',
          `User <strong>${escHtml(username)}</strong> created. Initial password: <code>${escHtml(username)}1234</code>`);
      }

      await loadUsers();
      btn.disabled = false;
      btn.textContent = 'Save';
    } catch (err) {
      showAlert('user-modal-alert', 'danger', err.message);
      btn.disabled = false;
      btn.textContent = 'Save';
    }
  }

  // ══════════════════════════════════════════════════════════
  // TAB: Divisions  (SecNav+)
  // ══════════════════════════════════════════════════════════
  let allDivisions = [];

  if (hasPerm(u.permission_level, PERM.MANAGE_DIVISIONS)) {
    await loadDivisions();
    document.getElementById('add-div-btn').addEventListener('click', () => openDivModal(null));
  }

  async function loadDivisions() {
    const tbody = document.getElementById('divisions-body');
    tbody.innerHTML = loadingRow(4);
    try {
      const snap = await db.collection('divisions').orderBy('name').get();
      allDivisions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderDivisions();
    } catch (e) {
      console.error('loadDivisions failed:', e);
      tbody.innerHTML = errorRow(4, e.message);
    }
  }

  function renderDivisions() {
    const tbody = document.getElementById('divisions-body');
    if (!allDivisions.length) {
      tbody.innerHTML = emptyRow(4, '🏛️', 'No divisions configured. Seed default divisions below.');
      return;
    }
    tbody.innerHTML = allDivisions.map(div => `<tr>
      <td><strong>${escHtml(div.name)}</strong></td>
      <td><code>${escHtml(div.short || '—')}</code></td>
      <td>${div.webhookUrl
        ? `<span class="text-success">&#10003; Set</span>`
        : `<span class="text-muted">Not set</span>`}</td>
      <td>
        <button class="btn btn-sm btn-secondary" onclick="openDivModal('${div.id}')">Edit</button>
      </td>
    </tr>`).join('');
  }

  window.openDivModal = function (divId) {
    const modal = document.getElementById('div-modal');
    const title = document.getElementById('div-modal-title');

    if (divId) {
      const div = allDivisions.find(d => d.id === divId);
      if (!div) return;
      title.textContent = 'Edit Division';
      document.getElementById('dm-name').value    = div.name;
      document.getElementById('dm-short').value   = div.short || '';
      document.getElementById('dm-webhook').value = div.webhookUrl || '';
      document.getElementById('div-modal-save').onclick = () => saveDivision(divId);
    } else {
      title.textContent = 'Add Division';
      document.getElementById('dm-name').value    = '';
      document.getElementById('dm-short').value   = '';
      document.getElementById('dm-webhook').value = '';
      document.getElementById('div-modal-save').onclick = () => saveDivision(null);
    }

    modal.classList.remove('hidden');
  };

  document.getElementById('div-modal-close').addEventListener('click',  () => document.getElementById('div-modal').classList.add('hidden'));
  document.getElementById('div-modal-cancel').addEventListener('click', () => document.getElementById('div-modal').classList.add('hidden'));

  async function saveDivision(divId) {
    const name    = document.getElementById('dm-name').value.trim();
    const short   = document.getElementById('dm-short').value.trim();
    const webhook = document.getElementById('dm-webhook').value.trim();
    const btn     = document.getElementById('div-modal-save');

    if (!name) { showAlert('div-modal-alert', 'danger', 'Division name is required.'); return; }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';

    const data = {
      name, short, webhookUrl: webhook,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };

    try {
      if (divId) {
        await db.collection('divisions').doc(divId).update(data);
        await auditLog('division.update', 'division', divId, { name });
      } else {
        const ref = await db.collection('divisions').add({
          ...data, createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        await auditLog('division.create', 'division', ref.id, { name });
      }
      await loadDivisions();
      document.getElementById('div-modal').classList.add('hidden');
    } catch (err) {
      showAlert('div-modal-alert', 'danger', err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save';
    }
  }

  // Seed defaults button
  document.getElementById('seed-divisions-btn').addEventListener('click', async () => {
    if (!confirm('Seed the 5 default divisions into Firestore? This will add them if they do not exist.')) return;
    const btn = document.getElementById('seed-divisions-btn');
    btn.disabled = true;
    try {
      const batch = db.batch();
      DEFAULT_DIVISIONS.forEach(div => {
        const ref = db.collection('divisions').doc(div.id);
        batch.set(ref, { name: div.name, short: div.short, webhookUrl: '', createdAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
      });
      await batch.commit();
      await auditLog('division.seed', 'division', 'batch', {});
      showAlert('divisions-alert', 'success', 'Default divisions seeded.');
      await loadDivisions();
    } catch (e) {
      showAlert('divisions-alert', 'danger', e.message);
    } finally {
      btn.disabled = false;
    }
  });

  // ══════════════════════════════════════════════════════════
  // TAB: Log Review  (Lieutenant+, own division)
  // ══════════════════════════════════════════════════════════
  await loadPendingLogs();

  async function loadPendingLogs() {
    const tbody = document.getElementById('review-body');
    tbody.innerHTML = loadingRow(6);

    try {
      let query = db.collection('logs').where('status', '==', 'pending').orderBy('createdAt', 'asc');

      // Non-admin users see only their division's logs
      if (u.permission_level < 70 && u.divisionId) {
        query = query.where('divisionId', '==', u.divisionId);
      }

      const snap = await query.limit(50).get();

      if (snap.empty) {
        tbody.innerHTML = emptyRow(6, '✅', 'No pending logs.');
        return;
      }

      tbody.innerHTML = snap.docs.map(doc => {
        const d   = doc.data();
        const detail = d.type === 'duty'
          ? `${d.durationMinutes} min`
          : (d.eventType === 'Custom Event' ? escHtml(d.customEventName) : escHtml(d.eventType));
        return `<tr id="row-${doc.id}">
          <td>${escHtml(d.authorUsername)}</td>
          <td>${typeBadge(d.type)}</td>
          <td>${detail}</td>
          <td>${escHtml(d.divisionName || '—')}</td>
          <td>
            <a href="${escHtml(d.discordLink)}" target="_blank" rel="noopener" class="btn btn-sm btn-secondary">Proof ↗</a>
          </td>
          <td>
            <button class="btn btn-sm btn-success" onclick="reviewLog('${doc.id}','approved')">Approve</button>
            <button class="btn btn-sm btn-danger" onclick="reviewLog('${doc.id}','rejected')" style="margin-left:4px">Reject</button>
          </td>
        </tr>`;
      }).join('');
    } catch (e) {
      console.error('loadPendingLogs failed:', e);
      tbody.innerHTML = errorRow(6, e.message);
    }
  }

  window.reviewLog = async function (logId, decision) {
    const note = decision === 'rejected'
      ? prompt('Rejection reason (optional):') ?? ''
      : '';

    try {
      await db.collection('logs').doc(logId).update({
        status:     decision,
        reviewedBy: u.uid,
        reviewerUsername: u.username,
        reviewedAt: firebase.firestore.FieldValue.serverTimestamp(),
        reviewNotes: note,
      });
      await auditLog(`log.${decision}`, 'log', logId, { reviewer: u.username, note });

      // Remove row from table
      const row = document.getElementById(`row-${logId}`);
      if (row) row.remove();

      showAlert('review-alert', 'success', `Log ${decision}.`);
    } catch (e) {
      showAlert('review-alert', 'danger', 'Review failed: ' + e.message);
    }
  };

  // ══════════════════════════════════════════════════════════
  // TAB: Archive  (UnderSecNav+)
  // ══════════════════════════════════════════════════════════
  if (hasPerm(u.permission_level, PERM.ARCHIVE_LOGS)) {
    document.getElementById('archive-btn').addEventListener('click', async () => {
      const divisionId = document.getElementById('archive-division').value || null;

      if (!confirm(
        divisionId
          ? `Archive all approved logs for the selected division? This cannot be undone.`
          : `Archive ALL approved logs across ALL divisions? This cannot be undone.`
      )) return;

      const btn = document.getElementById('archive-btn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Archiving…';

      try {
        // Query approved logs
        let q = db.collection('logs').where('status', '==', 'approved');
        if (divisionId) q = q.where('divisionId', '==', divisionId);
        const snap = await q.get();

        if (snap.empty) {
          showAlert('archive-alert', 'info', 'No approved logs to archive.');
          btn.disabled = false;
          btn.textContent = 'Run Archive';
          return;
        }

        // Write archive document
        const archiveLogs = snap.docs.map(d => ({ logId: d.id, ...d.data() }));
        const archiveRef  = await db.collection('archives').add({
          logs:               archiveLogs,
          count:              archiveLogs.length,
          divisionId:         divisionId || null,
          archivedBy:         u.uid,
          archivedByUsername: u.username,
          archivedAt:         firebase.firestore.FieldValue.serverTimestamp(),
        });

        // Delete archived logs in batches of 500
        for (let i = 0; i < snap.docs.length; i += 500) {
          const batch = db.batch();
          snap.docs.slice(i, i + 500).forEach(d => batch.delete(d.ref));
          await batch.commit();
        }

        await auditLog('log.archive', 'archive', archiveRef.id,
          { count: archiveLogs.length, divisionId: divisionId || 'all' });

        showAlert('archive-alert', 'success',
          `&#10003; Archived ${archiveLogs.length} log(s). Archive ID: <code>${archiveRef.id}</code>.`);
      } catch (e) {
        showAlert('archive-alert', 'danger', 'Archive failed: ' + e.message);
        console.error('archiveLogs failed:', e);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Run Archive';
      }
    });

    // Populate archive division dropdown
    try {
      const divSnap = await db.collection('divisions').orderBy('name').get();
      const sel = document.getElementById('archive-division');
      divSnap.docs.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.id;
        opt.textContent = d.data().name;
        sel.appendChild(opt);
      });
    } catch (_) {}
  }

  // ══════════════════════════════════════════════════════════
  // TAB: Audit Log
  // ══════════════════════════════════════════════════════════
  await loadAuditLog();

  async function loadAuditLog() {
    const tbody = document.getElementById('audit-body');
    tbody.innerHTML = loadingRow(5);
    try {
      const snap = await db.collection('audit_logs')
        .orderBy('timestamp', 'desc')
        .limit(100)
        .get();

      if (snap.empty) {
        tbody.innerHTML = emptyRow(5, '📜', 'No audit entries yet.');
        return;
      }

      tbody.innerHTML = snap.docs.map(doc => {
        const d = doc.data();
        return `<tr>
          <td>${fmtDateTime(d.timestamp)}</td>
          <td><code>${escHtml(d.action)}</code></td>
          <td>${escHtml(d.actorUsername || d.actorUid || '—')}</td>
          <td>${escHtml(d.targetType || '—')}: <code>${escHtml(d.targetId || '—')}</code></td>
          <td><small class="text-muted">${escHtml(JSON.stringify(d.details || {}))}</small></td>
        </tr>`;
      }).join('');
    } catch (e) {
      console.error('loadAuditLog failed:', e);
      tbody.innerHTML = errorRow(5, e.message);
    }
  }

  document.getElementById('audit-refresh-btn').addEventListener('click', loadAuditLog);

  // ── Table helpers ──────────────────────────────────────────
  function loadingRow(cols) {
    return `<tr><td colspan="${cols}" class="text-muted" style="text-align:center;padding:24px">
      <span class="spinner"></span> Loading…</td></tr>`;
  }
  function emptyRow(cols, icon, msg) {
    return `<tr><td colspan="${cols}">
      <div class="empty-state"><div class="empty-icon">${icon}</div><p>${msg}</p></div></td></tr>`;
  }
  function errorRow(cols, msg) {
    return `<tr><td colspan="${cols}" class="text-danger" style="padding:16px">Error: ${escHtml(msg)}</td></tr>`;
  }
})();
