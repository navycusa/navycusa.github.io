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

  // HQ = CNP+ or Divisionless — can see across all divisions
  const isHQ = u.permission_level >= 60 || !u.divisionId || u.divisionId === 'ndvl';

  // ── Tab routing ──────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === tabId));
  }

  if (window.location.hash === '#review') switchTab('tab-review');

  // ══════════════════════════════════════════════════════════
  // TAB: Personnel
  // ══════════════════════════════════════════════════════════
  let allUsers = [];
  await loadUsers();

  document.getElementById('add-user-btn').addEventListener('click', () => openUserModal(null));
  document.getElementById('user-search').addEventListener('input', filterUsers);

  async function loadUsers() {
    const tbody = document.getElementById('users-body');
    tbody.innerHTML = loadingRow(7);
    try {
      // Non-HQ users only see their own division
      let query = db.collection('users').orderBy('username');
      if (!isHQ && u.divisionId) {
        query = db.collection('users')
          .where('divisionId', '==', u.divisionId)
          .orderBy('username');
      }
      const snap = await query.get();
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
      const rankObj  = getRankById(usr.rankId);
      const cat      = rankObj ? catBadge(rankObj.cat) : 'badge-enlisted';
      const canEdit  = u.permission_level > (usr.permission_level || 0);
      const rankDisplay = usr.divRankName
        ? `${escHtml(usr.divRankName)} <small class="text-muted">(${escHtml(usr.divRankTier || '')})</small>`
        : escHtml(usr.rankName || '—');
      return `<tr>
        <td><strong>${escHtml(usr.username)}</strong></td>
        <td><span class="badge ${cat}">${rankDisplay}</span></td>
        <td>${escHtml(usr.divisionName || '—')}</td>
        <td><span class="badge ${usr.isActive !== false ? 'badge-approved' : 'badge-rejected'}">
          ${usr.isActive !== false ? 'Active' : 'Inactive'}</span></td>
        <td>${fmtDate(usr.createdAt)}</td>
        <td>${canEdit
          ? `<button class="btn btn-sm btn-secondary" onclick="openUserModal('${usr.id}')">Edit</button>`
          : '—'}</td>
      </tr>`;
    }).join('');
  }

  function filterUsers() {
    const q = document.getElementById('user-search').value.toLowerCase();
    renderUsers(allUsers.filter(usr =>
      usr.username.toLowerCase().includes(q) ||
      (usr.rankName || '').toLowerCase().includes(q) ||
      (usr.divRankName || '').toLowerCase().includes(q) ||
      (usr.divisionName || '').toLowerCase().includes(q)
    ));
  }

  // ── User Modal ────────────────────────────────────────────
  window.openUserModal = async function (userId) {
    const modal    = document.getElementById('user-modal');
    const title    = document.getElementById('user-modal-title');
    const rankSel  = document.getElementById('um-rank');
    const divSel   = document.getElementById('um-division');
    const divRankSel = document.getElementById('um-div-rank');

    // Populate division select
    let divisions = [];
    try {
      const divSnap = await db.collection('divisions').orderBy('name').get();
      divisions = divSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (_) {
      divisions = DEFAULT_DIVISIONS;
    }

    divSel.innerHTML = '<option value="">— Select Division —</option>' +
      divisions.map(d => `<option value="${d.id}">${escHtml(d.name)}</option>`).join('');

    // When division changes, refresh divisional rank options
    async function refreshDivRanks(divisionId) {
      const row = document.getElementById('um-div-rank-group');
      divRankSel.innerHTML = '<option value="">— None (use main rank) —</option>';
      if (!divisionId) { row.classList.add('hidden'); return; }

      const divObj = divisions.find(d => d.id === divisionId);
      const ranks  = (divObj && divObj.ranks) ? divObj.ranks : [];

      if (!ranks.length) { row.classList.add('hidden'); return; }

      row.classList.remove('hidden');
      // Group by tier
      const tiers = [...new Set(ranks.map(r => r.tier || 'General'))];
      tiers.forEach(tier => {
        const grp = document.createElement('optgroup');
        grp.label = tier;
        ranks.filter(r => (r.tier || 'General') === tier)
          .sort((a, b) => (a.order || 0) - (b.order || 0))
          .forEach(r => {
            const opt = document.createElement('option');
            opt.value = r.id;
            opt.dataset.name  = r.name;
            opt.dataset.short = r.shortName || '';
            opt.dataset.tier  = r.tier      || '';
            opt.dataset.mapped = r.mappedRankId || '';
            opt.textContent = `${r.name} (${r.shortName || r.tier})`;
            grp.appendChild(opt);
          });
        divRankSel.appendChild(grp);
      });
    }

    divSel.addEventListener('change', () => refreshDivRanks(divSel.value));

    // Populate main rank select (only ranks < own level)
    rankSel.innerHTML = '<option value="">— Select Main Rank —</option>' +
      getRanksUpTo(u.permission_level - 1).map(r =>
        `<option value="${r.id}">${r.name} (${r.short})</option>`
      ).join('');

    if (userId) {
      title.textContent = 'Edit Personnel';
      const usr = allUsers.find(x => x.id === userId);
      if (!usr) return;
      document.getElementById('um-username').value    = usr.username;
      document.getElementById('um-username').disabled = true;
      divSel.value  = usr.divisionId  || '';
      rankSel.value = usr.mappedRankId || usr.rankId || '';
      await refreshDivRanks(divSel.value);
      divRankSel.value = usr.divRankId || '';
      document.getElementById('um-active').checked = usr.isActive !== false;
      document.getElementById('user-modal-save').onclick = () => saveUser(userId, usr);
    } else {
      title.textContent = 'Add New Personnel';
      document.getElementById('um-username').value    = '';
      document.getElementById('um-username').disabled  = false;
      divSel.value  = '';
      rankSel.value = '';
      divRankSel.innerHTML = '<option value="">— None (use main rank) —</option>';
      document.getElementById('um-div-rank-group').classList.add('hidden');
      document.getElementById('um-active').checked = true;
      document.getElementById('user-modal-save').onclick = () => saveUser(null, null);
    }

    modal.classList.remove('hidden');
  };

  document.getElementById('user-modal-close').addEventListener('click',  closeUserModal);
  document.getElementById('user-modal-cancel').addEventListener('click', closeUserModal);

  function closeUserModal() {
    document.getElementById('user-modal').classList.add('hidden');
    document.getElementById('um-username').disabled = false;
    clearAlert('user-modal-alert');
  }

  async function saveUser(userId, existing) {
    const username   = document.getElementById('um-username').value.trim();
    const rankId     = document.getElementById('um-rank').value;
    const divisionId = document.getElementById('um-division').value;
    const divRankId  = document.getElementById('um-div-rank').value;
    const isActive   = document.getElementById('um-active').checked;
    const btn        = document.getElementById('user-modal-save');

    if (!username || !rankId || !divisionId) {
      showAlert('user-modal-alert', 'danger', 'Username, main rank, and division are required.');
      return;
    }

    const rankObj = getRankById(rankId);
    if (!rankObj) { showAlert('user-modal-alert', 'danger', 'Invalid rank.'); return; }
    if (rankObj.pl >= u.permission_level) {
      showAlert('user-modal-alert', 'danger', 'Cannot assign a rank equal to or higher than your own.');
      return;
    }

    // Resolve divisional rank (if any)
    let divRankData = {};
    if (divRankId) {
      const opt = document.querySelector(`#um-div-rank option[value="${divRankId}"]`);
      if (opt) {
        divRankData = {
          divRankId:   divRankId,
          divRankName: opt.dataset.name  || null,
          divRankShort:opt.dataset.short || null,
          divRankTier: opt.dataset.tier  || null,
          mappedRankId: rankId,
        };
      }
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';

    try {
      const divSnap = await db.collection('divisions').doc(divisionId).get();
      const divName = divSnap.exists ? divSnap.data().name : divisionId;

      const userData = {
        rankId:           divRankId ? divRankId  : rankId,
        rankName:         divRankId ? (divRankData.divRankName || rankObj.name) : rankObj.name,
        rankShort:        divRankId ? (divRankData.divRankShort || rankObj.short) : rankObj.short,
        permission_level: rankObj.pl,
        divisionId,
        divisionName: divName,
        isActive,
        ...divRankData,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedBy: u.uid,
      };

      if (!divRankId) {
        // Clear any previous divisional rank
        userData.divRankId   = null;
        userData.divRankName  = null;
        userData.divRankShort = null;
        userData.divRankTier  = null;
        userData.mappedRankId = null;
      }

      if (userId) {
        await db.collection('users').doc(userId).update(userData);
        await auditLog('user.update', 'user', userId, { rankId, divisionId, isActive });
        showAlert('user-modal-alert', 'success', 'User updated successfully.');
      } else {
        // Create via REST API
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
          throw new Error(msg === 'EMAIL_EXISTS' ? `Username "${username}" is already taken.` : msg);
        }

        const newUid = authData.localId;

        await db.collection('users').doc(newUid).set({
          username,
          email,
          ...userData,
          mustChangePassword: true,
          isActive: true,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          createdBy: u.uid,
        });

        await auditLog('user.create', 'user', newUid, { username, rankId, divisionId });
        showAlert('user-modal-alert', 'success',
          `User <strong>${escHtml(username)}</strong> created. Initial password: <code>${escHtml(username)}1234</code>`);
      }

      await loadUsers();
    } catch (err) {
      console.error('saveUser failed:', err);
      showAlert('user-modal-alert', 'danger', err.message);
    } finally {
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
  } else {
    // Non-SecNav still need divisions loaded for user modal dropdowns
    try {
      const snap = await db.collection('divisions').orderBy('name').get();
      allDivisions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (_) {}
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
      tbody.innerHTML = emptyRow(4, '🏛️', 'No divisions yet. Click "Seed Defaults" to add the standard 5.');
      return;
    }
    tbody.innerHTML = allDivisions.map(div => {
      const rankCount = (div.ranks || []).length;
      return `<tr>
        <td><strong>${escHtml(div.name)}</strong></td>
        <td><code>${escHtml(div.short || '—')}</code></td>
        <td>${div.webhookUrl
          ? `<span class="text-success">✓ Set</span>`
          : `<span class="text-muted">Not set</span>`}
        </td>
        <td><span class="badge badge-command">${rankCount} rank${rankCount !== 1 ? 's' : ''}</span>
          <button class="btn btn-sm btn-secondary" style="margin-left:6px"
            onclick="openDivModal('${div.id}')">Edit</button>
        </td>
      </tr>`;
    }).join('');
  }

  window.openDivModal = function (divId) {
    const modal = document.getElementById('div-modal');
    const title = document.getElementById('div-modal-title');

    // CNO+ can edit ranks
    const canEditRanks = hasPerm(u.permission_level, PERM.MANAGE_DIV_RANKS);
    document.getElementById('div-ranks-section').classList.toggle('hidden', !canEditRanks);

    if (divId) {
      const div = allDivisions.find(d => d.id === divId);
      if (!div) return;
      title.textContent = 'Edit Division';
      document.getElementById('dm-name').value    = div.name;
      document.getElementById('dm-short').value   = div.short || '';
      document.getElementById('dm-webhook').value = div.webhookUrl || '';
      renderDivRanksList(div.ranks || [], divId);
      document.getElementById('div-modal-save').onclick = () => saveDivision(divId);
    } else {
      title.textContent = 'Add Division';
      document.getElementById('dm-name').value    = '';
      document.getElementById('dm-short').value   = '';
      document.getElementById('dm-webhook').value = '';
      renderDivRanksList([], null);
      document.getElementById('div-modal-save').onclick = () => saveDivision(null);
    }

    modal.classList.remove('hidden');
  };

  // ── Division rank list in modal ───────────────────────────
  let _editingDivRanks = [];
  let _editingDivId    = null;

  function renderDivRanksList(ranks, divId) {
    _editingDivRanks = JSON.parse(JSON.stringify(ranks)); // deep copy
    _editingDivId    = divId;
    const tbody = document.getElementById('div-ranks-body');
    if (!_editingDivRanks.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-muted" style="padding:12px;text-align:center">
        No ranks defined. Add one below.</td></tr>`;
      return;
    }
    tbody.innerHTML = _editingDivRanks
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((r, i) => `<tr>
        <td>${escHtml(r.name)}</td>
        <td><code>${escHtml(r.shortName || '—')}</code></td>
        <td><span class="badge badge-rank">${escHtml(r.tier || '—')}</span></td>
        <td>${escHtml(getRankById(r.mappedRankId)?.name || r.mappedRankId || '—')}</td>
        <td>
          <button class="btn btn-sm btn-danger" onclick="removeDivRank(${i})">✕</button>
        </td>
      </tr>`).join('');
  }

  window.removeDivRank = function (index) {
    _editingDivRanks.splice(index, 1);
    renderDivRanksList(_editingDivRanks, _editingDivId);
  };

  document.getElementById('add-div-rank-btn').addEventListener('click', () => {
    const name      = document.getElementById('dr-name').value.trim();
    const shortName = document.getElementById('dr-short').value.trim();
    const tier      = document.getElementById('dr-tier').value.trim();
    const mapped    = document.getElementById('dr-mapped-rank').value;

    if (!name || !mapped) {
      showAlert('div-modal-alert', 'danger', 'Rank name and mapped main rank are required.');
      return;
    }

    const newRank = {
      id:          'rank_' + Date.now(),
      name,
      shortName:   shortName || name.split(' ').map(w => w[0]).join('').toUpperCase(),
      tier:        tier || 'General',
      mappedRankId: mapped,
      order:       _editingDivRanks.length + 1,
    };

    _editingDivRanks.push(newRank);
    renderDivRanksList(_editingDivRanks, _editingDivId);

    // Clear inputs
    document.getElementById('dr-name').value  = '';
    document.getElementById('dr-short').value = '';
    document.getElementById('dr-tier').value  = '';
    document.getElementById('dr-mapped-rank').value = '';
    clearAlert('div-modal-alert');
  });

  // Populate mapped rank select in division modal
  const drMappedSel = document.getElementById('dr-mapped-rank');
  RANKS.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = `${r.name} (${r.short}) — PL ${r.pl}`;
    drMappedSel.appendChild(opt);
  });

  document.getElementById('div-modal-close').addEventListener('click',  closeDivModal);
  document.getElementById('div-modal-cancel').addEventListener('click', closeDivModal);
  function closeDivModal() {
    document.getElementById('div-modal').classList.add('hidden');
    clearAlert('div-modal-alert');
  }

  async function saveDivision(divId) {
    const name    = document.getElementById('dm-name').value.trim();
    const short   = document.getElementById('dm-short').value.trim();
    const webhook = document.getElementById('dm-webhook').value.trim();
    const btn     = document.getElementById('div-modal-save');

    if (!name) { showAlert('div-modal-alert', 'danger', 'Division name is required.'); return; }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';

    const data = {
      name, short,
      webhookUrl: webhook,
      ranks: _editingDivRanks,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };

    try {
      if (divId) {
        await db.collection('divisions').doc(divId).update(data);
        await auditLog('division.update', 'division', divId, { name, rankCount: _editingDivRanks.length });
      } else {
        const ref = await db.collection('divisions').add({
          ...data, createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        await auditLog('division.create', 'division', ref.id, { name });
      }
      await loadDivisions();
      closeDivModal();
    } catch (err) {
      console.error('saveDivision failed:', err);
      showAlert('div-modal-alert', 'danger', err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save';
    }
  }

  document.getElementById('seed-divisions-btn').addEventListener('click', async () => {
    if (!confirm('Seed the 5 default divisions into Firestore?')) return;
    const btn = document.getElementById('seed-divisions-btn');
    btn.disabled = true;
    try {
      const batch = db.batch();
      DEFAULT_DIVISIONS.forEach(div => {
        const ref = db.collection('divisions').doc(div.id);
        batch.set(ref, {
          name: div.name, short: div.short,
          webhookUrl: '', ranks: [],
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
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
  // TAB: Log Review  (MCPO+ = pl ≥ 42, own division)
  // ══════════════════════════════════════════════════════════
  await loadPendingLogs();

  async function loadPendingLogs() {
    const tbody = document.getElementById('review-body');
    tbody.innerHTML = loadingRow(6);
    try {
      // HQ (CNP+) see all pending; others see own division only
      let query = db.collection('logs').where('status', '==', 'pending').orderBy('createdAt', 'asc');
      if (!isHQ && u.divisionId) {
        query = db.collection('logs')
          .where('divisionId', '==', u.divisionId)
          .where('status', '==', 'pending')
          .orderBy('createdAt', 'asc');
      }

      const snap = await query.limit(50).get();
      if (snap.empty) {
        tbody.innerHTML = emptyRow(6, '✅', 'No pending logs.');
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

        return `<tr id="row-${doc.id}">
          <td>${escHtml(d.authorUsername || '—')}</td>
          <td>${typeBadge(d.type)}</td>
          <td>${detail}</td>
          <td>${escHtml(d.divisionName || '—')}</td>
          <td>${proofLinks}</td>
          <td>
            <button class="btn btn-sm btn-success" onclick="reviewLog('${doc.id}','approved')">Approve</button>
            <button class="btn btn-sm btn-danger"  onclick="reviewLog('${doc.id}','rejected')" style="margin-left:4px">Reject</button>
          </td>
        </tr>`;
      }).join('');
    } catch (e) {
      console.error('loadPendingLogs failed:', e);
      tbody.innerHTML = errorRow(6, e.message);
    }
  }

  window.reviewLog = async function (logId, decision) {
    const note = decision === 'rejected' ? (prompt('Rejection reason (optional):') ?? '') : '';
    try {
      await db.collection('logs').doc(logId).update({
        status:           decision,
        reviewedBy:       u.uid,
        reviewerUsername: u.username,
        reviewedAt:       firebase.firestore.FieldValue.serverTimestamp(),
        reviewNotes:      note || null,
      });
      await auditLog(`log.${decision}`, 'log', logId, { reviewer: u.username, note });
      const row = document.getElementById(`row-${logId}`);
      if (row) row.remove();
      showAlert('review-alert', 'success', `Log ${decision}.`);
    } catch (e) {
      showAlert('review-alert', 'danger', 'Review failed: ' + e.message);
      console.error('reviewLog failed:', e);
    }
  };

  // ══════════════════════════════════════════════════════════
  // TAB: Archive  (UnderSecNav+)
  // ══════════════════════════════════════════════════════════
  if (hasPerm(u.permission_level, PERM.ARCHIVE_LOGS)) {
    // Populate archive division select
    try {
      const divSnap = await db.collection('divisions').orderBy('name').get();
      const sel = document.getElementById('archive-division');
      divSnap.docs.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.id; opt.textContent = d.data().name;
        sel.appendChild(opt);
      });
    } catch (_) {}

    document.getElementById('archive-btn').addEventListener('click', async () => {
      const divisionId = document.getElementById('archive-division').value || null;
      if (!confirm(divisionId
        ? 'Archive all approved logs for the selected division? This cannot be undone.'
        : 'Archive ALL approved logs across ALL divisions? This cannot be undone.'
      )) return;

      const btn = document.getElementById('archive-btn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Archiving…';

      try {
        let q = db.collection('logs').where('status', '==', 'approved');
        if (divisionId) q = q.where('divisionId', '==', divisionId);
        const snap = await q.get();

        if (snap.empty) {
          showAlert('archive-alert', 'info', 'No approved logs to archive.');
          return;
        }

        const archiveLogs = snap.docs.map(d => ({ logId: d.id, ...d.data() }));
        const archiveRef  = await db.collection('archives').add({
          logs: archiveLogs, count: archiveLogs.length,
          divisionId: divisionId || null,
          archivedBy: u.uid, archivedByUsername: u.username,
          archivedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });

        for (let i = 0; i < snap.docs.length; i += 500) {
          const batch = db.batch();
          snap.docs.slice(i, i + 500).forEach(d => batch.delete(d.ref));
          await batch.commit();
        }

        await auditLog('log.archive', 'archive', archiveRef.id,
          { count: archiveLogs.length, divisionId: divisionId || 'all' });
        showAlert('archive-alert', 'success',
          `&#10003; Archived ${archiveLogs.length} log(s). ID: <code>${archiveRef.id}</code>`);
      } catch (e) {
        showAlert('archive-alert', 'danger', 'Archive failed: ' + e.message);
        console.error('archiveLogs failed:', e);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Run Archive';
      }
    });
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
        .orderBy('timestamp', 'desc').limit(100).get();
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
    return `<tr><td colspan="${cols}" style="text-align:center;padding:24px">
      <span class="spinner"></span></td></tr>`;
  }
  function emptyRow(cols, icon, msg) {
    return `<tr><td colspan="${cols}">
      <div class="empty-state"><div class="empty-icon">${icon}</div><p>${msg}</p></div>
    </td></tr>`;
  }
  function errorRow(cols, msg) {
    return `<tr><td colspan="${cols}" class="text-danger" style="padding:16px">
      Error: ${escHtml(msg)}</td></tr>`;
  }
})();
