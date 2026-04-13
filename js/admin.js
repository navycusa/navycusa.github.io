// ============================================================
// US NAVY CUSA PORTAL — Admin Panel
// ============================================================

(async function () {
  'use strict';

  const u = await requireAuth({ adminPanelAccess: true });
  renderHeader(u);
  applyPermissionUI(u);
  markActiveSidebarLink();
  setupLogoutBtn();

  const isFullAdmin = u.permission_level >= PERM.ADMIN_PANEL;
  const isPersonnelOfficeOnly = !isFullAdmin && hasPersonnelOfficeStaff(u);
  const showDivisionsTab = !isPersonnelOfficeOnly && (
    canAddOrRemoveDivisions(u)
    || isHQPersonnel(u)
    || (hasPerm(u.permission_level, PERM.ARCHIVE_OWN_DIVISION) && u.divisionId && u.divisionId !== NDVL_DIVISION_ID)
  );

  // ── Tab routing ──────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  function switchTab(tabId) {
    const btn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
    const panel = document.getElementById(tabId);
    if ((btn && btn.classList.contains('hidden')) || (panel && panel.classList.contains('hidden'))) return;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === tabId));
  }

  function configureAdminTabs() {
    const showReview = !isPersonnelOfficeOnly && hasPerm(u.permission_level, PERM.APPROVE_LOGS)
      && (isHQPersonnel(u) || (u.divisionId && u.divisionId !== NDVL_DIVISION_ID));
    const showMyDiv = hasPerm(u.permission_level, PERM.MANAGE_DIV_EVENTS)
      && u.divisionId && u.divisionId !== NDVL_DIVISION_ID
      && u.permission_level < PERM.ARCHIVE_OWN_DIVISION
      && !isHQPersonnel(u)
      && u.divisionId !== HQ_DIVISION_ID;
    const showArchive = !isPersonnelOfficeOnly && (
      (hasPerm(u.permission_level, PERM.ARCHIVE_OWN_DIVISION) && u.divisionId && u.divisionId !== NDVL_DIVISION_ID)
      || hasPerm(u.permission_level, PERM.ARCHIVE_LOGS)
    );
    const showAudit = isFullAdmin;

    const map = [
      ['tab-users', true],
      ['tab-review', showReview],
      ['tab-my-division', showMyDiv],
      ['tab-divisions', showDivisionsTab],
      ['tab-archive', showArchive],
      ['tab-audit', showAudit],
    ];
    map.forEach(([id, show]) => {
      const panel = document.getElementById(id);
      const b = document.querySelector(`.tab-btn[data-tab="${id}"]`);
      if (panel) panel.classList.toggle('hidden', !show);
      if (b) b.classList.toggle('hidden', !show);
    });

    if (isPersonnelOfficeOnly) switchTab('tab-users');
    else if (window.location.hash === '#review' && showReview) switchTab('tab-review');
    else if (!document.querySelector('.tab-btn.active:not(.hidden)')) {
      const first = document.querySelector('.tab-btn:not(.hidden)');
      if (first) switchTab(first.dataset.tab);
    }
  }

  configureAdminTabs();

  // ══════════════════════════════════════════════════════════
  // TAB: Personnel
  // ══════════════════════════════════════════════════════════
  let allUsers = [];
  await loadUsers();

  document.getElementById('add-user-btn').addEventListener('click', () => openUserModal(null));
  document.getElementById('user-search').addEventListener('input', filterUsers);

  async function loadUsers() {
    const tbody = document.getElementById('users-body');
    tbody.innerHTML = loadingRow(6);
    try {
      let query = db.collection('users').orderBy('username');
      if (isPersonnelOfficeOnly) {
        query = db.collection('users')
          .where('divisionId', '==', NDVL_DIVISION_ID)
          .orderBy('username');
      } else if (!isHQPersonnel(u) && u.divisionId) {
        query = db.collection('users')
          .where('divisionId', '==', u.divisionId)
          .orderBy('username');
      }
      const snap = await query.get();
      allUsers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderUsers(allUsers);
    } catch (e) {
      console.error('loadUsers failed:', e);
      tbody.innerHTML = errorRow(6, e.message);
    }
  }

  function renderUsers(list) {
    const tbody = document.getElementById('users-body');
    if (!list.length) { tbody.innerHTML = emptyRow(6, '👤', 'No users found.'); return; }
    tbody.innerHTML = list.map(usr => {
      const rankObj  = getRankById(usr.rankId);
      const cat      = rankObj ? catBadge(rankObj.cat) : 'badge-enlisted';
      const poTarget = hasPersonnelOfficeStaff(u) && usr.divisionId === NDVL_DIVISION_ID;
      const canEdit  = u.permission_level > (usr.permission_level || 0)
        && (isFullAdmin || poTarget);
      const rankDisplay = usr.divRankName
        ? `${escHtml(usr.divRankName)} <small class="text-muted">(${escHtml(usr.divRankTier || '')})</small>`
        : escHtml(usr.rankName || '—');
      const poAff = Array.isArray(usr.personnelOffices)
        ? usr.personnelOffices.filter((x) => PERSONNEL_OFFICE_IDS.includes(x))
        : [];
      const poLabel = poAff.length
        ? ` <span class="text-muted" style="font-size:0.72rem">(${poAff.map((x) => x === 'ocnp' ? 'OCNP' : (x === 'ocno' ? 'OCNO' : x)).join(', ')})</span>`
        : '';
      return `<tr>
        <td><strong>${escHtml(usr.username)}</strong></td>
        <td><span class="badge ${cat}">${rankDisplay}</span></td>
        <td>${escHtml(usr.divisionName || '—')}${poLabel}</td>
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
      (usr.rankName    || '').toLowerCase().includes(q) ||
      (usr.divRankName || '').toLowerCase().includes(q) ||
      (usr.divisionName || '').toLowerCase().includes(q)
    ));
  }

  // ── User Modal ────────────────────────────────────────────
  window.openUserModal = async function (userId) {
    const modal       = document.getElementById('user-modal');
    const title       = document.getElementById('user-modal-title');
    const rankSel     = document.getElementById('um-rank');
    const divSel      = document.getElementById('um-division');
    const divRankSel  = document.getElementById('um-div-rank');
    const divGroup    = document.getElementById('um-division-group');
    const ndvlNote    = document.getElementById('um-ndvl-note');
    const poGroup     = document.getElementById('um-personnel-offices-group');
    const cbOcnp      = document.getElementById('um-ocnp');
    const cbOcno      = document.getElementById('um-ocno');
    const activeCb    = document.getElementById('um-active');
    const toggleActiveBtn = document.getElementById('um-toggle-active');
    const deletePermBtn   = document.getElementById('um-delete-permanent');

    if (toggleActiveBtn && activeCb) {
      toggleActiveBtn.onclick = () => { activeCb.checked = !activeCb.checked; };
    }
    if (deletePermBtn) {
      deletePermBtn.classList.add('hidden');
      deletePermBtn.onclick = null;
    }

    let divisions = [];
    try {
      const divSnap = await db.collection('divisions').orderBy('name').get();
      divisions = divSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (_) { divisions = DEFAULT_DIVISIONS; }

    divSel.innerHTML = '<option value="">— Select Division —</option>' +
      divisions.map(d => `<option value="${d.id}">${escHtml(d.name)}</option>`).join('');

    async function refreshDivRanks(divisionId) {
      const row = document.getElementById('um-div-rank-group');
      divRankSel.innerHTML = '<option value="">— None (use main rank) —</option>';
      if (!divisionId) { row.classList.add('hidden'); return; }
      const divObj = divisions.find(d => d.id === divisionId);
      const ranks  = (divObj && divObj.ranks) ? divObj.ranks : [];
      if (!ranks.length) { row.classList.add('hidden'); return; }
      row.classList.remove('hidden');
      const tiers = [...new Set(ranks.map(r => r.tier || 'General'))];
      tiers.forEach(tier => {
        const grp = document.createElement('optgroup');
        grp.label = tier;
        ranks.filter(r => (r.tier || 'General') === tier)
          .sort((a, b) => (a.order || 0) - (b.order || 0))
          .forEach(r => {
            const opt = document.createElement('option');
            opt.value = r.id;
            opt.dataset.name   = r.name;
            opt.dataset.short  = r.shortName  || '';
            opt.dataset.tier   = r.tier       || '';
            opt.dataset.mapped = r.mappedRankId || '';
            opt.textContent = `${r.name} (${r.shortName || r.tier})`;
            grp.appendChild(opt);
          });
        divRankSel.appendChild(grp);
      });
    }

    divSel.onchange = () => refreshDivRanks(divSel.value);

    rankSel.innerHTML = '<option value="">— Select Main Rank —</option>' +
      getRanksUpTo(u.permission_level - 1).map(r =>
        `<option value="${r.id}">${r.name} (${r.short})</option>`
      ).join('');

    const showPoAffil = canAssignPersonnelOffices(u);
    poGroup.classList.toggle('hidden', !showPoAffil);
    if (showPoAffil) {
      cbOcnp.checked = false;
      cbOcno.checked = false;
    }

    if (isPersonnelOfficeOnly) {
      divGroup.classList.add('hidden');
      ndvlNote.classList.remove('hidden');
      divSel.value = NDVL_DIVISION_ID;
      await refreshDivRanks(divSel.value);
    } else {
      divGroup.classList.remove('hidden');
      ndvlNote.classList.add('hidden');
    }

    if (userId) {
      title.textContent = 'Edit Personnel';
      const usr = allUsers.find(x => x.id === userId);
      if (!usr) return;
      document.getElementById('um-username').value    = usr.username;
      document.getElementById('um-username').disabled = true;
      if (!isPersonnelOfficeOnly) {
        divSel.value = usr.divisionId || '';
      } else {
        divSel.value = NDVL_DIVISION_ID;
      }
      rankSel.value = usr.mappedRankId || usr.rankId || '';
      await refreshDivRanks(divSel.value);
      divRankSel.value = usr.divRankId || '';
      activeCb.checked = usr.isActive !== false;
      if (showPoAffil) {
        const poList = Array.isArray(usr.personnelOffices) ? usr.personnelOffices : [];
        cbOcnp.checked = poList.includes('ocnp');
        cbOcno.checked = poList.includes('ocno');
      }
      document.getElementById('user-modal-save').onclick = () => saveUser(userId, usr);

      // Permanent delete (Auth + Firestore) — requires Cloud Functions.
      if (deletePermBtn) {
        deletePermBtn.classList.remove('hidden');
        deletePermBtn.onclick = async () => {
          try {
            if (!confirm(`Remove account for ${usr.username}? This cannot be undone.`)) return;
            const typed = prompt(`Type DELETE to remove account for ${usr.username}:`);
            if ((typed || '').trim().toUpperCase() !== 'DELETE') return;

            if (!firebase.functions || typeof firebase.functions !== 'function') {
              throw new Error('Removing an account requires deployed Cloud Functions (functions SDK not loaded).');
            }

            deletePermBtn.disabled = true;
            deletePermBtn.innerHTML = '<span class="spinner"></span> Removing…';

            const call = firebase.functions().httpsCallable('deleteUserPermanently');
            await call({ uid: userId });
            await auditLog('user.delete_permanent', 'user', userId, { username: usr.username });
            closeUserModal();
            await loadUsers();
            showAlert('users-alert', 'success', `User <strong>${escHtml(usr.username)}</strong> was permanently removed.`);
          } catch (e) {
            showAlert('user-modal-alert', 'danger', escHtml(e.message || String(e)));
          } finally {
            deletePermBtn.disabled = false;
            deletePermBtn.textContent = 'Remove account permanently';
          }
        };
      }
    } else {
      title.textContent = isPersonnelOfficeOnly ? 'Add Navy Divisionless Personnel' : 'Add New Personnel';
      document.getElementById('um-username').value    = '';
      document.getElementById('um-username').disabled = false;
      if (!isPersonnelOfficeOnly) {
        divSel.value = '';
      } else {
        divSel.value = NDVL_DIVISION_ID;
        await refreshDivRanks(divSel.value);
      }
      rankSel.value = '';
      divRankSel.innerHTML = '<option value="">— None (use main rank) —</option>';
      document.getElementById('um-div-rank-group').classList.add('hidden');
      activeCb.checked = true;
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
    const divisionId = isPersonnelOfficeOnly
      ? NDVL_DIVISION_ID
      : document.getElementById('um-division').value;
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

    let divRankData = {};
    if (divRankId) {
      const opt = document.querySelector(`#um-div-rank option[value="${divRankId}"]`);
      if (opt) {
        divRankData = {
          divRankId:    divRankId,
          divRankName:  opt.dataset.name  || null,
          divRankShort: opt.dataset.short || null,
          divRankTier:  opt.dataset.tier  || null,
          mappedRankId: rankId,
        };
      }
    }

    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';

    try {
      const divSnap = await db.collection('divisions').doc(divisionId).get();
      const divName = divSnap.exists ? divSnap.data().name : divisionId;

      const userData = {
        rankId:           divRankId ? divRankId : rankId,
        rankName:         divRankId ? (divRankData.divRankName  || rankObj.name)  : rankObj.name,
        rankShort:        divRankId ? (divRankData.divRankShort || rankObj.short) : rankObj.short,
        permission_level: rankObj.pl,
        divisionId, divisionName: divName, isActive,
        ...divRankData,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedBy: u.uid,
      };
      if (!divRankId) {
        userData.divRankId = null; userData.divRankName  = null;
        userData.divRankShort = null; userData.divRankTier = null;
        userData.mappedRankId = null;
      }

      if (canAssignPersonnelOffices(u)) {
        const offices = [];
        if (document.getElementById('um-ocnp').checked) offices.push('ocnp');
        if (document.getElementById('um-ocno').checked) offices.push('ocno');
        userData.personnelOffices = offices;
      }

      if (userId) {
        await db.collection('users').doc(userId).update(userData);
        await auditLog('user.update', 'user', userId, { rankId, divisionId, isActive });
        showAlert('user-modal-alert', 'success', 'User updated successfully.');
      } else {
        const email    = usernameToEmail(username);
        const password = username + '1234';
        const resp = await fetch(
          `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${firebaseConfig.apiKey}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, returnSecureToken: false }) }
        );
        const authData = await resp.json();
        if (authData.error) {
          const msg = authData.error.message;
          throw new Error(msg === 'EMAIL_EXISTS' ? `Username "${username}" is already taken.` : msg);
        }
        const newUid = authData.localId;
        await db.collection('users').doc(newUid).set({
          username, email, ...userData,
          mustChangePassword: true, isActive: true,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          createdBy: u.uid,
        });
        await auditLog('user.create', 'user', newUid, { username, rankId, divisionId });
        if (window.DiscordWebhooks) {
          await window.DiscordWebhooks.postEmbed(db, divisionId, 'pending', {
            title:       '👤 Account Creation',
            color:       0x3498db,
            description: `**${username}** was created (temporary password on first login).`,
            fields: [
              { name: 'Rank',       value: rankObj.name,   inline: true },
              { name: 'Division',   value: divName,        inline: true },
              { name: 'Created by', value: u.username || '—', inline: true },
            ],
            footer:      { text: 'US Navy CUSA Portal • created by pPayday' },
            timestamp:   new Date().toISOString(),
          });
        }
        showAlert('user-modal-alert', 'success',
          `User <strong>${escHtml(username)}</strong> created. Initial password: <code>${escHtml(username)}1234</code>`);
      }
      await loadUsers();
    } catch (err) {
      console.error('saveUser failed:', err);
      showAlert('user-modal-alert', 'danger', err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Save';
    }
  }

  // ══════════════════════════════════════════════════════════
  // TAB: Log Review  (MCPO+)
  // ══════════════════════════════════════════════════════════
  await loadPendingLogs();

  async function loadPendingLogs() {
    const tbody = document.getElementById('review-body');
    tbody.innerHTML = loadingRow(6);
    try {
      let query = db.collection('logs').where('status', '==', 'pending').orderBy('createdAt', 'asc');
      if (!isHQPersonnel(u) && u.divisionId) {
        query = db.collection('logs')
          .where('divisionId', '==', u.divisionId)
          .where('status', '==', 'pending')
          .orderBy('createdAt', 'asc');
      }
      const snap = await query.limit(50).get();
      if (snap.empty) { tbody.innerHTML = emptyRow(6, '✅', 'No pending logs.'); return; }
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
      // Fetch log data before updating (needed for Discord notification + image deletion)
      const logSnap = await db.collection('logs').doc(logId).get();
      const logData = logSnap.exists ? logSnap.data() : null;

      await db.collection('logs').doc(logId).update({
        status:           decision,
        reviewedBy:       u.uid,
        reviewerUsername: u.username,
        reviewedAt:       firebase.firestore.FieldValue.serverTimestamp(),
        reviewNotes:      note || null,
      });

      if (decision === 'approved' && logData) {
        if (window.DiscordWebhooks && logData.divisionId) {
          await window.DiscordWebhooks.postEmbed(db, logData.divisionId, 'approved',
            window.DiscordWebhooks.buildLogApprovedEmbed(logData));
        }

        const proofUrl = logData.proofImageUrl || null;
        if (proofUrl) {
          await deleteProofImage(proofUrl);
          await db.collection('logs').doc(logId).update({
            proofImageUrl: null,
            proofOnDiscord: true,
          });
        }

        if (window.QuotaFirestore) {
          try {
            await window.QuotaFirestore.syncFromApprovedLog(logId, { ...logData, status: 'approved' });
          } catch (qe) {
            console.error('Quota attendance sync failed:', qe);
          }
        }
      } else if (decision === 'rejected' && logData && window.DiscordWebhooks && logData.divisionId) {
        await window.DiscordWebhooks.postEmbed(db, logData.divisionId, 'pending',
          window.DiscordWebhooks.buildLogRejectedEmbed(
            { ...logData, reviewerUsername: u.username },
            note || null,
          ));
      }

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
  // TAB: My Division  (MCPO+ — own division event types)
  // ══════════════════════════════════════════════════════════
  if (hasPerm(u.permission_level, PERM.MANAGE_DIV_EVENTS)
    && u.divisionId && u.divisionId !== NDVL_DIVISION_ID
    && u.permission_level < PERM.ARCHIVE_OWN_DIVISION
    && !isHQPersonnel(u)
    && u.divisionId !== HQ_DIVISION_ID) {
    let _myDivEventTypes = [];

    async function loadMyDivisionTab() {
      try {
        const divSnap = await db.collection('divisions').doc(u.divisionId).get();
        if (!divSnap.exists) return;
        const data = divSnap.data();
        document.getElementById('my-div-name').textContent = data.name || 'My Division';
        _myDivEventTypes = Array.isArray(data.eventTypes) ? [...data.eventTypes] : [];
        renderMyEventTypes();
      } catch (e) {
        showAlert('my-div-alert', 'danger', 'Failed to load division: ' + e.message);
      }
    }

    function renderMyEventTypes() {
      const el = document.getElementById('my-div-event-types-list');
      if (!_myDivEventTypes.length) {
        el.innerHTML = `<p class="text-muted" style="font-size:0.83rem;padding:4px 0">
          No custom types — global defaults are used.</p>`;
        return;
      }
      el.innerHTML = _myDivEventTypes.map((t, i) => `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="flex:1;padding:6px 12px;background:rgba(30,77,140,0.2);
            border:1px solid var(--border);border-radius:var(--radius);font-size:0.875rem">
            ${escHtml(t)}</span>
          <button class="btn btn-sm btn-danger" onclick="removeMyEventType(${i})">✕</button>
        </div>`).join('');
    }

    window.removeMyEventType = function (i) {
      _myDivEventTypes.splice(i, 1);
      renderMyEventTypes();
    };

    document.getElementById('add-event-type-btn').addEventListener('click', () => {
      const input = document.getElementById('new-event-type-input');
      const val   = input.value.trim();
      if (!val) return;
      if (_myDivEventTypes.includes(val)) {
        showAlert('my-div-alert', 'warning', 'That event type already exists.');
        return;
      }
      _myDivEventTypes.push(val);
      renderMyEventTypes();
      input.value = '';
      clearAlert('my-div-alert');
    });

    document.getElementById('new-event-type-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('add-event-type-btn').click();
    });

    document.getElementById('save-event-types-btn').addEventListener('click', async () => {
      const btn = document.getElementById('save-event-types-btn');
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
      try {
        await db.collection('divisions').doc(u.divisionId).update({
          eventTypes: _myDivEventTypes,
          updatedAt:  firebase.firestore.FieldValue.serverTimestamp(),
        });
        await auditLog('division.eventTypes.update', 'division', u.divisionId,
          { count: _myDivEventTypes.length });
        showAlert('my-div-alert', 'success', 'Event types saved.');
      } catch (e) {
        showAlert('my-div-alert', 'danger', 'Save failed: ' + e.message);
      } finally {
        btn.disabled = false; btn.textContent = 'Save Event Types';
      }
    });

    await loadMyDivisionTab();
  }

  // ══════════════════════════════════════════════════════════
  // TAB: Divisions
  // ══════════════════════════════════════════════════════════
  let allDivisions = [];

  async function loadDivisions() {
    const tbody = document.getElementById('divisions-body');
    tbody.innerHTML = loadingRow(5);
    try {
      const snap = await db.collection('divisions').orderBy('name').get();
      let list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (!isHQPersonnel(u) && !canAddOrRemoveDivisions(u) && u.divisionId) {
        list = list.filter(d => d.id === u.divisionId);
      }
      allDivisions = list;
      renderDivisions();
    } catch (e) {
      console.error('loadDivisions failed:', e);
      tbody.innerHTML = errorRow(5, e.message);
    }
  }

  if (showDivisionsTab) {
    await loadDivisions();

    if (canAddOrRemoveDivisions(u)) {
      document.getElementById('add-div-btn').addEventListener('click', () => openDivModal(null));
    } else {
      document.getElementById('add-div-btn').classList.add('hidden');
      document.getElementById('seed-divisions-btn').classList.add('hidden');
    }
  }

  function effectiveDivWebhookPending(div) {
    return (div.webhookUrlPending || div.webhookUrl || '').trim();
  }
  function effectiveDivWebhookApproved(div) {
    return (div.webhookUrlApproved || div.webhookUrl || '').trim();
  }

  function renderDivisions() {
    const tbody = document.getElementById('divisions-body');
    if (!allDivisions.length) {
      tbody.innerHTML = emptyRow(5, '🏛️', 'No divisions yet. Click "Seed Defaults" to add the standard 5.');
      return;
    }
    tbody.innerHTML = allDivisions.map(div => {
      const rankCount  = (div.ranks      || []).length;
      const eventCount = (div.eventTypes || []).length;
      const pUrl = effectiveDivWebhookPending(div);
      const aUrl = effectiveDivWebhookApproved(div);
      return `<tr>
        <td><strong>${escHtml(div.name)}</strong></td>
        <td><code>${escHtml(div.short || '—')}</code></td>
        <td>${pUrl
          ? `<span class="text-success">✓ Set</span>`
          : `<span class="text-muted">Not set</span>`}
        </td>
        <td>${aUrl
          ? `<span class="text-success">✓ Set</span>`
          : `<span class="text-muted">Not set</span>`}
        </td>
        <td>
          <span class="badge badge-command">${rankCount} rank${rankCount !== 1 ? 's' : ''}</span>
          <span class="badge badge-enlisted" style="margin-left:4px">${eventCount} event type${eventCount !== 1 ? 's' : ''}</span>
          ${canEditDivisionDocument(u, div.id, div)
          ? `<button class="btn btn-sm btn-secondary" style="margin-left:6px"
            onclick="openDivModal('${div.id}')">Edit</button>`
          : '<span class="text-muted" style="margin-left:6px">—</span>'}
        </td>
      </tr>`;
    }).join('');
  }

  // ── Division Modal ────────────────────────────────────────
  let _editingDivRanks      = [];
  let _editingDivEventTypes = [];
  let _editingDivId         = null;

  window.openDivModal = function (divId) {
    if (!showDivisionsTab) return;
    if (!divId && !canAddOrRemoveDivisions(u)) return;

    const modal = document.getElementById('div-modal');
    const title = document.getElementById('div-modal-title');
    clearAlert('div-modal-alert');

    let canEditRanks;
    let canEditEvents;
    if (!divId) {
      canEditRanks = canEditEvents = canAddOrRemoveDivisions(u);
    } else {
      const d = allDivisions.find(x => x.id === divId);
      if (!d || !canEditDivisionDocument(u, divId, d)) {
        showAlert('divisions-alert', 'danger', 'You cannot edit this division.');
        return;
      }
      canEditRanks  = canEditDivisionRanksInModal(u, divId, d);
      canEditEvents = canEditDivisionEventsInModal(u, divId, d);
    }
    document.getElementById('div-ranks-section').classList.toggle('hidden',  !canEditRanks);
    document.getElementById('div-events-section').classList.toggle('hidden', !canEditEvents);

    if (divId) {
      const div = allDivisions.find(d => d.id === divId);
      if (!div) return;
      title.textContent = 'Edit Division';
      document.getElementById('dm-name').value    = div.name;
      document.getElementById('dm-short').value   = div.short      || '';
      document.getElementById('dm-webhook-pending').value  = div.webhookUrlPending || '';
      document.getElementById('dm-webhook-approved').value = div.webhookUrlApproved || '';
      document.getElementById('dm-webhook-legacy').value   = div.webhookUrl || '';
      renderDivRanksList(div.ranks || [], divId);
      renderDivEventTypes(div.eventTypes || []);
      document.getElementById('div-modal-save').onclick = () => saveDivision(divId);
    } else {
      title.textContent = 'Add Division';
      document.getElementById('dm-name').value    = '';
      document.getElementById('dm-short').value   = '';
      document.getElementById('dm-webhook-pending').value  = '';
      document.getElementById('dm-webhook-approved').value = '';
      document.getElementById('dm-webhook-legacy').value   = '';
      renderDivRanksList([], null);
      renderDivEventTypes([]);
      document.getElementById('div-modal-save').onclick = () => saveDivision(null);
    }
    modal.classList.remove('hidden');
  };

  // ── Division Ranks in modal ───────────────────────────────
  function renderDivRanksList(ranks, divId) {
    _editingDivRanks = JSON.parse(JSON.stringify(ranks));
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
        <td><button class="btn btn-sm btn-danger" onclick="removeDivRank(${i})">✕</button></td>
      </tr>`).join('');
  }

  window.removeDivRank = function (i) {
    _editingDivRanks.splice(i, 1);
    renderDivRanksList(_editingDivRanks, _editingDivId);
  };

  document.getElementById('add-div-rank-btn').addEventListener('click', () => {
    const name   = document.getElementById('dr-name').value.trim();
    const short  = document.getElementById('dr-short').value.trim();
    const tier   = document.getElementById('dr-tier').value.trim();
    const mapped = document.getElementById('dr-mapped-rank').value;
    if (!name || !mapped) {
      showAlert('div-modal-alert', 'danger', 'Rank name and mapped main rank are required.');
      return;
    }
    _editingDivRanks.push({
      id:          'rank_' + Date.now(),
      name,
      shortName:   short || name.split(' ').map(w => w[0]).join('').toUpperCase(),
      tier:        tier  || 'General',
      mappedRankId: mapped,
      order:       _editingDivRanks.length + 1,
    });
    renderDivRanksList(_editingDivRanks, _editingDivId);
    document.getElementById('dr-name').value = '';
    document.getElementById('dr-short').value = '';
    document.getElementById('dr-tier').value = '';
    document.getElementById('dr-mapped-rank').value = '';
    clearAlert('div-modal-alert');
  });

  // Populate mapped rank select
  const drMappedSel = document.getElementById('dr-mapped-rank');
  RANKS.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = `${r.name} (${r.short}) — PL ${r.pl}`;
    drMappedSel.appendChild(opt);
  });

  // ── Division Event Types in modal ─────────────────────────
  function renderDivEventTypes(types) {
    _editingDivEventTypes = [...types];
    const el = document.getElementById('div-events-list');
    if (!_editingDivEventTypes.length) {
      el.innerHTML = `<p class="text-muted" style="font-size:0.8rem;margin-bottom:8px">
        No custom event types — global defaults used.</p>`;
      return;
    }
    el.innerHTML = _editingDivEventTypes.map((t, i) => `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="flex:1;padding:5px 10px;background:rgba(30,77,140,0.2);
          border:1px solid var(--border);border-radius:var(--radius);font-size:0.83rem">
          ${escHtml(t)}</span>
        <button class="btn btn-sm btn-danger" onclick="removeDivEventType(${i})">✕</button>
      </div>`).join('');
  }

  window.removeDivEventType = function (i) {
    _editingDivEventTypes.splice(i, 1);
    renderDivEventTypes(_editingDivEventTypes);
  };

  document.getElementById('add-div-event-btn').addEventListener('click', () => {
    const input = document.getElementById('de-new-type');
    const val   = input.value.trim();
    if (!val) return;
    if (_editingDivEventTypes.includes(val)) {
      showAlert('div-modal-alert', 'warning', 'That event type already exists.');
      return;
    }
    _editingDivEventTypes.push(val);
    renderDivEventTypes(_editingDivEventTypes);
    input.value = '';
    clearAlert('div-modal-alert');
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
    const whPend  = document.getElementById('dm-webhook-pending').value.trim();
    const whAppr  = document.getElementById('dm-webhook-approved').value.trim();
    const whLeg   = document.getElementById('dm-webhook-legacy').value.trim();
    const btn     = document.getElementById('div-modal-save');
    if (!name) { showAlert('div-modal-alert', 'danger', 'Division name is required.'); return; }
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    const existingDiv = divId ? allDivisions.find(d => d.id === divId) : null;
    if (divId) {
      if (!canEditDivisionDocument(u, divId, existingDiv)) {
        showAlert('div-modal-alert', 'danger', 'You cannot edit this division.');
        btn.disabled = false; btn.textContent = 'Save';
        return;
      }
    } else if (!canAddOrRemoveDivisions(u)) {
      showAlert('div-modal-alert', 'danger', 'Only Secretary of the Navy+ can add divisions.');
      btn.disabled = false; btn.textContent = 'Save';
      return;
    }

    const canSaveRanks  = divId
      ? canEditDivisionRanksInModal(u, divId, existingDiv)
      : canAddOrRemoveDivisions(u);
    const canSaveEvents = divId
      ? canEditDivisionEventsInModal(u, divId, existingDiv)
      : canAddOrRemoveDivisions(u);

    const data = {
      name,
      short,
      webhookUrl:          whLeg,
      webhookUrlPending:   whPend,
      webhookUrlApproved:  whAppr,
      updatedAt:  firebase.firestore.FieldValue.serverTimestamp(),
    };
    if (canSaveRanks) data.ranks = _editingDivRanks;
    if (canSaveEvents) data.eventTypes = _editingDivEventTypes;
    try {
      if (divId) {
        await db.collection('divisions').doc(divId).update(data);
        await auditLog('division.update', 'division', divId,
          { name, rankCount: _editingDivRanks.length, eventTypeCount: _editingDivEventTypes.length });
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
      btn.disabled = false; btn.textContent = 'Save';
    }
  }

  if (showDivisionsTab && canAddOrRemoveDivisions(u)) {
    document.getElementById('seed-divisions-btn').addEventListener('click', async () => {
      if (!confirm('Seed the 5 default divisions into Firestore?')) return;
      const btn = document.getElementById('seed-divisions-btn');
      btn.disabled = true;
      try {
        const batch = db.batch();
        DEFAULT_DIVISIONS.forEach(div => {
          const ref = db.collection('divisions').doc(div.id);
          const payload = {
            name: div.name,
            short: div.short,
            webhookUrl: '',
            ranks: [],
            eventTypes: [],
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          };
          if (div.isHeadquarters === true) payload.isHeadquarters = true;
          batch.set(ref, payload, { merge: true });
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
  }

  // ══════════════════════════════════════════════════════════
  // TAB: Archive
  //   Admiral+ (pl ≥ 50) — own division only
  //   UnderSecNav+ (pl ≥ 85) — any / all divisions
  // ══════════════════════════════════════════════════════════

  async function runArchive(divisionId, btnEl) {
    const confirmMsg = divisionId
      ? `Archive all approved logs for "${divisionId === u.divisionId ? 'your division' : divisionId}"? This cannot be undone.`
      : 'Archive ALL approved logs across ALL divisions? This cannot be undone.';
    if (!confirm(confirmMsg)) return;

    btnEl.disabled = true;
    btnEl.innerHTML = '<span class="spinner"></span> Archiving…';

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

      // Batch delete in chunks of 500
      for (let i = 0; i < snap.docs.length; i += 500) {
        const batch = db.batch();
        snap.docs.slice(i, i + 500).forEach(d => batch.delete(d.ref));
        await batch.commit();
      }

      await auditLog('log.archive', 'archive', archiveRef.id,
        { count: archiveLogs.length, divisionId: divisionId || 'all' });
      showAlert('archive-alert', 'success',
        `&#10003; Archived ${archiveLogs.length} log(s). Archive ID: <code>${archiveRef.id}</code>`);
    } catch (e) {
      showAlert('archive-alert', 'danger', 'Archive failed: ' + e.message);
      console.error('runArchive failed:', e);
    } finally {
      btnEl.disabled = false;
      btnEl.textContent = btnEl.id === 'archive-own-btn' ? 'Archive My Division' : 'Run Archive';
    }
  }

  // Admiral+ — archive own division
  if (hasPerm(u.permission_level, PERM.ARCHIVE_OWN_DIVISION) && u.divisionId && u.divisionId !== 'ndvl') {
    document.getElementById('archive-own-btn').addEventListener('click', function () {
      runArchive(u.divisionId, this);
    });
  }

  // UnderSecNav+ — archive any/all
  if (hasPerm(u.permission_level, PERM.ARCHIVE_LOGS)) {
    try {
      const divSnap = await db.collection('divisions').orderBy('name').get();
      const sel = document.getElementById('archive-division');
      divSnap.docs.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.id; opt.textContent = d.data().name;
        sel.appendChild(opt);
      });
    } catch (_) {}

    document.getElementById('archive-btn').addEventListener('click', function () {
      const divisionId = document.getElementById('archive-division').value || null;
      runArchive(divisionId, this);
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
      if (snap.empty) { tbody.innerHTML = emptyRow(5, '📜', 'No audit entries yet.'); return; }
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
