// ============================================================
// US NAVY CUSA PORTAL — Quota via Firestore only (Spark / no Cloud Functions)
// ============================================================

(function (global) {
  'use strict';

  const Q = () => global.QuotaLogic;
  const fv = () => firebase.firestore.FieldValue;

  async function resolveEventMatchFieldsClient(log) {
    const divisionId = log.divisionId || null;
    const isCustom = log.eventType === 'Custom Event';
    const matchCustomName = isCustom ? (log.customEventName || '').trim() : null;
    const matchEventType = !isCustom ? (log.eventType || null) : null;
    let eventDefinitionId = log.eventDefinitionId || null;

    if (!eventDefinitionId && divisionId) {
      let q = db.collection('event_definitions').where('divisionId', '==', divisionId);
      if (isCustom && matchCustomName) {
        const snap = await q.where('matchCustomName', '==', matchCustomName).limit(1).get();
        if (!snap.empty) eventDefinitionId = snap.docs[0].id;
      } else if (matchEventType) {
        const snap = await q.where('matchEventType', '==', matchEventType).limit(1).get();
        if (!snap.empty) eventDefinitionId = snap.docs[0].id;
      }
    }

    return {
      eventDefinitionId,
      matchEventType: matchEventType || null,
      matchCustomName: matchCustomName || null,
      isCustom: !!isCustom,
    };
  }

  

  async function loadActiveRelief(userId, divisionId, periodStart, periodEnd) {
    const Quota = Q();
    const ps = new Date(periodStart);
    const pe = new Date(periodEnd);
    let mdqraMax = 0;
    let loaExempt = false;

    const reqSnap = await db.collection('quota_requests')
      .where('requesterUid', '==', userId)
      .where('divisionId', '==', divisionId)
      .where('status', '==', 'approved')
      .get();

    reqSnap.forEach((doc) => {
      const m = doc.data();
      if (m.requestType === 'LOA' && m.loaStart && m.loaEnd) {
        const s = Quota.parseYMD(m.loaStart);
        const e = Quota.parseYMD(m.loaEnd);
        if (!s || !e) return;
        e.setUTCHours(23, 59, 59, 999);
        if (ps.getTime() <= e.getTime() && pe.getTime() >= s.getTime()) loaExempt = true;
      }
      if (m.requestType === 'MDQRA' && m.reductionPercent != null) {
        let decided = new Date();
        if (m.decidedAt) {
          decided = m.decidedAt.toDate ? m.decidedAt.toDate() : new Date(m.decidedAt);
        }
        const decDay = new Date(Date.UTC(decided.getUTCFullYear(), decided.getUTCMonth(), decided.getUTCDate()));
        if (pe.getTime() >= decDay.getTime()) {
          const p = Number(m.reductionPercent) || 0;
          if (p > mdqraMax) mdqraMax = p;
        }
      }
    });

    try {
      const modSnap = await db.collection('quota_modifiers')
        .where('userId', '==', userId)
        .where('divisionId', '==', divisionId)
        .where('active', '==', true)
        .get();
      modSnap.forEach((doc) => {
        const m = doc.data();
        const s = Quota.parseYMD(m.startDate);
        if (!s) return;
        let endBound = m.endDate ? Quota.parseYMD(m.endDate) : new Date(8640000000000000);
        if (!endBound) endBound = new Date(8640000000000000);
        endBound.setUTCHours(23, 59, 59, 999);
        if (!(ps.getTime() <= endBound.getTime() && pe.getTime() >= s.getTime())) return;
        if (m.type === 'LOA') loaExempt = true;
        if (m.type === 'MDQRA') {
          const p = Number(m.reductionPercent) || 0;
          if (p > mdqraMax) mdqraMax = p;
        }
      });
    } catch (_) { /* collection may be empty */ }

    return { mdqraPercent: mdqraMax, loaExempt };
  }

  async function fetchNetStatus(userData, uid) {
    const Quota = Q();
    const user = { uid, ...userData };
    const divisionId = user.divisionId;
    if (!divisionId || divisionId === 'ndvl') {
      return { ok: true, noPolicy: true, message: 'No quota division assigned.' };
    }

    const policiesSnap = await db.collection('quota_policies').where('divisionId', '==', divisionId).get();
    const policies = policiesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const rankId = user.mappedRankId || user.rankId || '';
    const refDate = new Date();
    const roughStart = new Date(Date.UTC(refDate.getUTCFullYear(), refDate.getUTCMonth(), 1));
    const roughEnd = new Date(Date.UTC(
      refDate.getUTCFullYear(),
      refDate.getUTCMonth() + 1,
      0, 23, 59, 59, 999,
    ));

    const policy = Quota.selectPolicy(policies, divisionId, rankId, roughStart, roughEnd);
    if (!policy) {
      return {
        ok: true,
        noPolicy: true,
        divisionId,
        rankId,
        periodStart: roughStart.toISOString().slice(0, 10),
        periodEnd: roughEnd.toISOString().slice(0, 10),
      };
    }

    const pk = policy.periodKind || 'weekly';
    const bounds = Quota.getPeriodBounds(pk, refDate);
    const mods = await loadActiveRelief(uid, divisionId, bounds.start, bounds.end);

    const attSnap = await db.collection('quota_attendance')
      .where('userId', '==', uid)
      .where('divisionId', '==', divisionId)
      .where('occurredAt', '>=', firebase.firestore.Timestamp.fromDate(bounds.start))
      .where('occurredAt', '<=', firebase.firestore.Timestamp.fromDate(bounds.end))
      .get();
    const attendances = attSnap.docs.map((d) => d.data());

    const net = Quota.computeNetQuota(attendances, policy, mods.mdqraPercent, mods.loaExempt);

    return {
      ok: true,
      noPolicy: false,
      divisionId,
      rankId,
      policyId: policy.id,
      periodKind: pk,
      periodStart: bounds.start.toISOString().slice(0, 10),
      periodEnd: bounds.end.toISOString().slice(0, 10),
      ...net,
    };
  }

  async function syncFromApprovedLog(logId, after) {
    if (after.type !== 'event' && after.type !== 'duty') return;
    if (after.status !== 'approved') return;

    const existing = await db.collection('quota_attendance').where('logId', '==', logId).get();
    const batch = db.batch();
    existing.docs.forEach((d) => batch.delete(d.ref));

    if (after.type === 'duty') {
      const ref = db.collection('quota_attendance').doc();
      batch.set(ref, {
        logId,
        userId: after.authorUid,
        divisionId: after.divisionId || null,
        occurredAt: after.date || fv().serverTimestamp(),
        kind: 'duty',
        minutes: Math.max(0, Number(after.durationMinutes) || 0),
        role: 'host',
      });
      await batch.commit();
      return;
    }

    const uids = new Set();
    if (after.authorUid) uids.add(after.authorUid);
    if (Array.isArray(after.attendeeUids)) {
      after.attendeeUids.forEach((x) => {
        if (typeof x === 'string' && x) uids.add(x);
      });
    }

    const resolved = await resolveEventMatchFieldsClient(after);
    const occurredAt = after.date || fv().serverTimestamp();

    for (const uid of uids) {
      const ref = db.collection('quota_attendance').doc();
      batch.set(ref, {
        logId,
        userId: uid,
        divisionId: after.divisionId || null,
        occurredAt,
        kind: 'event',
        credits: 1,
        role: uid === after.authorUid ? 'host' : 'attendee',
        ...resolved,
      });
    }
    await batch.commit();
  }

  async function removeQuotaRowsForLog(logId) {
    const q = await db.collection('quota_attendance').where('logId', '==', logId).get();
    if (q.empty) return;
    const batch = db.batch();
    q.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }

  async function resolveEventAttendees(divisionId, usernames) {
    const out = [];
    for (const raw of usernames) {
      const name = String(raw || '').trim();
      if (!name) continue;
      const snap = await db.collection('users').where('username', '==', name).limit(1).get();
      if (snap.empty) {
        out.push({ username: name, uid: null, reason: 'not_found' });
        continue;
      }
      const doc = snap.docs[0];
      const ud = doc.data();
      if (ud.divisionId !== divisionId) {
        out.push({ username: name, uid: null, reason: 'wrong_division' });
        continue;
      }
      out.push({ username: name, uid: doc.id, reason: null });
    }
    return { attendees: out };
  }

  async function listCommandData(divisionId) {
    const [defsSnap, polSnap, reqSnap] = await Promise.all([
      db.collection('event_definitions').where('divisionId', '==', divisionId).get(),
      db.collection('quota_policies').where('divisionId', '==', divisionId).get(),
      db.collection('quota_requests').where('divisionId', '==', divisionId).where('status', '==', 'pending').get(),
    ]);
    return {
      eventDefinitions: defsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      policies: polSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      pendingRequests: reqSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    };
  }

  /**
   * Pending requests for given divisions only (one query per division).
   * Required so Firestore rules can validate queries: a blanket `where('status','==','pending')`
   * fails for CNP–Under SecNav because HQ pending docs would also match but are denied.
   */
  async function listPendingQuotaRequestsForDivisions(divisionIds) {
    if (!divisionIds || !divisionIds.length) return [];
    const ids = divisionIds.filter((id) => id && id !== 'ndvl');
    const snaps = await Promise.all(
      ids.map((divisionId) => db.collection('quota_requests')
        .where('divisionId', '==', divisionId)
        .where('status', '==', 'pending')
        .get()),
    );
    const out = [];
    snaps.forEach((snap) => {
      snap.docs.forEach((d) => out.push({ id: d.id, ...d.data() }));
    });
    return out;
  }

  async function notifyQuotaDiscordSubmit(divisionId, reqLike) {
    const DW = global.DiscordWebhooks;
    if (!DW) return;
    try {
      const divSnap = await db.collection('divisions').doc(divisionId).get();
      const divName = divSnap.exists ? divSnap.data().name : null;
      const t = String(reqLike && reqLike.requestType || '').toUpperCase();
      const category = t === 'LOA' ? 'loa' : (t === 'MDQRA' ? 'mdqra' : 'general');
      await DW.postEmbed(db, divisionId, { category, status: 'pending' },
        DW.buildQuotaRequestPendingEmbed(reqLike, divName));
    } catch (e) {
      console.warn('Quota request Discord notify failed (non-fatal):', e.message || e);
    }
  }

  async function notifyQuotaDiscordDecide(req, approve, decisionNotes, caller) {
    const DW = global.DiscordWebhooks;
    if (!DW) return;
    try {
      const divSnap = await db.collection('divisions').doc(req.divisionId).get();
      const divName = divSnap.exists ? divSnap.data().name : null;
      const merged = {
        ...req,
        status: approve ? 'approved' : 'rejected',
        decisionNotes: decisionNotes || null,
        decidedByUsername: caller.username,
      };
      const t = String(req && req.requestType || '').toUpperCase();
      const category = t === 'LOA' ? 'loa' : (t === 'MDQRA' ? 'mdqra' : 'general');
      // Route all "decided" notifications to the decided/approved bucket.
      await DW.postEmbed(db, req.divisionId, { category, status: 'approved' },
        DW.buildQuotaRequestDecidedEmbed(merged, divName, approve, decisionNotes || null, caller.username));
    } catch (e) {
      console.warn('Quota decision Discord notify failed (non-fatal):', e.message || e);
    }
  }

  async function notifyQuotaDiscordRelief(action, relief, divisionId, caller) {
    const DW = global.DiscordWebhooks;
    if (!DW) return;
    try {
      const divSnap = await db.collection('divisions').doc(divisionId).get();
      const divName = divSnap.exists ? divSnap.data().name : null;
      const embed = action === 'revoked'
        ? DW.buildQuotaReliefRevokedEmbed(relief, divName, caller && caller.username)
        : DW.buildQuotaReliefDeletedEmbed(relief, divName, caller && caller.username);
      await DW.postEmbed(db, divisionId, { category: 'general', status: 'approved' }, embed);
    } catch (e) {
      console.warn('Quota relief Discord notify failed (non-fatal):', e.message || e);
    }
  }

  async function submitQuotaRequest(caller, payload) {
    const divisionId = caller.divisionId;
    if (!divisionId || divisionId === 'ndvl') {
      throw new Error('You must belong to a quota division.');
    }
    if (payload.requestType === 'MDQRA') {
      const p = Number(payload.reductionPercent);
      if (!(p > 0 && p <= 100)) throw new Error('MDQRA requires reduction percent 1–100.');
      await db.collection('quota_requests').add({
        requestType: 'MDQRA',
        requesterUid: caller.uid,
        requesterUsername: caller.username,
        divisionId,
        status: 'pending',
        reductionPercent: p,
        reason: payload.reason || null,
        createdAt: fv().serverTimestamp(),
      });
      await notifyQuotaDiscordSubmit(divisionId, {
        requestType: 'MDQRA',
        requesterUid: caller.uid,
        requesterUsername: caller.username,
        divisionId,
        reductionPercent: p,
        reason: payload.reason || null,
      });
      return;
    }
    if (payload.requestType === 'LOA') {
      if (!payload.loaStart || !payload.loaEnd) throw new Error('LOA requires start and end dates.');
      await db.collection('quota_requests').add({
        requestType: 'LOA',
        requesterUid: caller.uid,
        requesterUsername: caller.username,
        divisionId,
        status: 'pending',
        loaStart: payload.loaStart,
        loaEnd: payload.loaEnd,
        reason: payload.reason || null,
        createdAt: fv().serverTimestamp(),
      });
      await notifyQuotaDiscordSubmit(divisionId, {
        requestType: 'LOA',
        requesterUid: caller.uid,
        requesterUsername: caller.username,
        divisionId,
        loaStart: payload.loaStart,
        loaEnd: payload.loaEnd,
        reason: payload.reason || null,
      });
      return;
    }
    throw new Error('Invalid request type.');
  }

  async function decideQuotaRequest(requestId, caller, approve, decisionNotes) {
    const ref = db.collection('quota_requests').doc(requestId);
    const snap = await ref.get();
    if (!snap.exists) throw new Error('Request not found.');
    const req = snap.data();
    if (req.status !== 'pending') throw new Error('Request is not pending.');

    const status = approve ? 'approved' : 'rejected';
    await ref.update({
      status,
      decidedAt: fv().serverTimestamp(),
      decidedByUid: caller.uid,
      decidedByUsername: caller.username,
      decisionNotes: decisionNotes || null,
    });
    await notifyQuotaDiscordDecide(req, approve, decisionNotes, caller);
  }

  async function listApprovedQuotaRequestsForDivision(divisionId) {
    if (!divisionId || divisionId === 'ndvl') return [];
    const snap = await db.collection('quota_requests')
      .where('divisionId', '==', divisionId)
      .where('status', '==', 'approved')
      .get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  async function listActiveQuotaModifiersForDivision(divisionId) {
    if (!divisionId || divisionId === 'ndvl') return [];
    try {
      const snap = await db.collection('quota_modifiers')
        .where('divisionId', '==', divisionId)
        .where('active', '==', true)
        .get();
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    } catch (_) {
      return [];
    }
  }

  async function revokeQuotaRequest(requestId, caller, revokeReason) {
    const ref = db.collection('quota_requests').doc(requestId);
    const snap = await ref.get();
    if (!snap.exists) throw new Error('Request not found.');
    const req = snap.data();
    if (req.status !== 'approved') throw new Error('Only approved requests can be revoked.');
    const batch = db.batch();
    batch.update(ref, {
      status: 'revoked',
      revokedAt: fv().serverTimestamp(),
      revokedByUid: caller.uid,
      revokedByUsername: caller.username,
      revokeReason: revokeReason || null,
    });

    // Best-effort: if this request spawned quota_modifiers, revoke those too so relief stops applying.
    try {
      const modsSnap = await db.collection('quota_modifiers')
        .where('sourceRequestId', '==', requestId)
        .where('active', '==', true)
        .get();
      modsSnap.docs.forEach((d) => {
        batch.update(d.ref, {
          active: false,
          revokedAt: fv().serverTimestamp(),
          revokedByUid: caller.uid,
          revokedByUsername: caller.username,
          revokeReason: revokeReason || null,
        });
      });
    } catch (_) { /* ignore if not permitted / missing index */ }

    await batch.commit();
    await notifyQuotaDiscordRelief('revoked', { ...req, kind: 'request', revokeReason: revokeReason || null }, req.divisionId, caller);
  }

  async function deleteQuotaRequest(requestId, caller) {
    const ref = db.collection('quota_requests').doc(requestId);
    const snap = await ref.get();
    if (!snap.exists) throw new Error('Request not found.');
    const req = snap.data();
    const batch = db.batch();

    // Best-effort: also delete linked modifiers.
    try {
      const modsSnap = await db.collection('quota_modifiers')
        .where('sourceRequestId', '==', requestId)
        .get();
      modsSnap.docs.forEach((d) => batch.delete(d.ref));
    } catch (_) { /* ignore */ }

    batch.delete(ref);
    await batch.commit();
    await notifyQuotaDiscordRelief('deleted', { ...req, kind: 'request' }, req.divisionId, caller);
  }

  async function revokeQuotaModifier(modifierId, caller, revokeReason) {
    const ref = db.collection('quota_modifiers').doc(modifierId);
    const snap = await ref.get();
    if (!snap.exists) throw new Error('Modifier not found.');
    const m = snap.data();
    if (m.active !== true) throw new Error('Modifier is not active.');
    await ref.update({
      active: false,
      revokedAt: fv().serverTimestamp(),
      revokedByUid: caller.uid,
      revokedByUsername: caller.username,
      revokeReason: revokeReason || null,
    });
    await notifyQuotaDiscordRelief('revoked', { ...m, kind: 'modifier', revokeReason: revokeReason || null }, m.divisionId, caller);
  }

  async function deleteQuotaModifier(modifierId, caller) {
    const ref = db.collection('quota_modifiers').doc(modifierId);
    const snap = await ref.get();
    if (!snap.exists) throw new Error('Modifier not found.');
    const m = snap.data();
    await ref.delete();
    await notifyQuotaDiscordRelief('deleted', { ...m, kind: 'modifier' }, m.divisionId, caller);
  }

  async function saveQuotaPolicy(callerUid, divisionId, data) {
    const {
      policyId, rankId, periodKind, effectiveFrom, effectiveTo, rules,
    } = data;
    const payload = {
      divisionId,
      rankId,
      periodKind,
      effectiveFrom,
      effectiveTo: effectiveTo || null,
      rules: Array.isArray(rules) ? rules : [],
      updatedAt: fv().serverTimestamp(),
      updatedByUid: callerUid,
    };

    if (policyId) {
      const ref = db.collection('quota_policies').doc(policyId);
      const ex = await ref.get();
      if (!ex.exists) throw new Error('Policy not found.');
      if (ex.data().divisionId !== divisionId) throw new Error('Division mismatch.');
      await ref.set({ ...ex.data(), ...payload }, { merge: true });
      return { policyId };
    }

    payload.createdAt = fv().serverTimestamp();
    payload.createdByUid = callerUid;
    const docRef = await db.collection('quota_policies').add(payload);
    return { policyId: docRef.id };
  }

  async function saveEventDefinition(callerUid, divisionId, data) {
    const {
      definitionId, key, label, matchEventType, matchCustomName,
    } = data;
    const payload = {
      divisionId,
      key: String(key).trim(),
      label: String(label).trim(),
      matchEventType: matchEventType || null,
      matchCustomName: matchCustomName || null,
      updatedAt: fv().serverTimestamp(),
    };

    if (definitionId) {
      const ref = db.collection('event_definitions').doc(definitionId);
      const ex = await ref.get();
      if (!ex.exists) throw new Error('Definition not found.');
      if (ex.data().divisionId !== divisionId) throw new Error('Division mismatch.');
      await ref.set({ ...ex.data(), ...payload }, { merge: true });
      return { definitionId };
    }

    payload.createdAt = fv().serverTimestamp();
    const docRef = await db.collection('event_definitions').add(payload);
    return { definitionId: docRef.id };
  }

  async function deleteEventDefinition(definitionId, divisionId) {
    const ref = db.collection('event_definitions').doc(definitionId);
    const ex = await ref.get();
    if (!ex.exists || ex.data().divisionId !== divisionId) throw new Error('Definition not found.');
    await ref.delete();
  }

  async function listReformSnapshot(divisionId, weekKey) {
    let snap;
    if (weekKey) {
      snap = await db.collection('reform_snapshots')
        .where('divisionId', '==', divisionId)
        .where('weekKey', '==', weekKey)
        .limit(10)
        .get();
      if (snap.empty) return { snapshot: null, entries: [] };
      const sorted = snap.docs.slice().sort((a, b) => {
        const ta = a.data().computedAt && a.data().computedAt.toMillis ? a.data().computedAt.toMillis() : 0;
        const tb = b.data().computedAt && b.data().computedAt.toMillis ? b.data().computedAt.toMillis() : 0;
        return tb - ta;
      });
      const doc = sorted[0];
      const entriesSnap = await doc.ref.collection('entries').get();
      return {
        snapshot: { id: doc.id, ...doc.data() },
        entries: entriesSnap.docs.map((e) => ({ id: e.id, ...e.data() })),
      };
    }

    snap = await db.collection('reform_snapshots')
      .where('divisionId', '==', divisionId)
      .orderBy('computedAt', 'desc')
      .limit(1)
      .get();

    if (snap.empty) return { snapshot: null, entries: [] };
    const doc = snap.docs[0];
    const entriesSnap = await doc.ref.collection('entries').get();
    return {
      snapshot: { id: doc.id, ...doc.data() },
      entries: entriesSnap.docs.map((e) => ({ id: e.id, ...e.data() })),
    };
  }

  async function computeStatusForUserDoc(userSnap, refDate) {
    const u = { uid: userSnap.id, ...userSnap.data() };
    return fetchNetStatus(u, userSnap.id);
  }

  async function runReformForDivision(divisionId, refDate = new Date()) {
    const Quota = Q();
    const policiesSnap = await db.collection('quota_policies').where('divisionId', '==', divisionId).limit(1).get();
    if (policiesSnap.empty) return { entryCount: 0 };

    const periodKind = policiesSnap.docs[0].data().periodKind || 'weekly';
    const bounds = Quota.getPeriodBounds(periodKind, refDate);
    const weekKey = bounds.start.toISOString().slice(0, 10);

    const usersSnap = await db.collection('users').where('divisionId', '==', divisionId).get();
    const batchEntries = [];

    for (const uDoc of usersSnap.docs) {
      const st = await computeStatusForUserDoc(uDoc, refDate);
      if (st.noPolicy || st.exempt) continue;
      if ((st.deficit || 0) <= 0) continue;
      const u = uDoc.data();
      batchEntries.push({
        userId: uDoc.id,
        username: u.username,
        rankName: u.rankName,
        requiredTotal: st.requiredTotal,
        completedTotal: st.completedTotal,
        deficit: st.deficit,
        completionPct: st.completionPct,
        detail: { rules: st.rules || [] },
      });
    }

    const snapRef = db.collection('reform_snapshots').doc();
    await snapRef.set({
      divisionId,
      weekKey,
      periodKind,
      periodStart: bounds.start.toISOString().slice(0, 10),
      periodEnd: bounds.end.toISOString().slice(0, 10),
      computedAt: fv().serverTimestamp(),
      entryCount: batchEntries.length,
    });

    for (const ent of batchEntries) {
      await snapRef.collection('entries').doc(ent.userId).set(ent);
    }

    return { entryCount: batchEntries.length, snapshotId: snapRef.id };
  }

  /** @param {string[]} [divisionIds] divisions the caller may manage; required from UI so HQ-only rules are respected */
  async function runReformAllDivisions(divisionIds) {
    let ids = divisionIds;
    if (!ids || !ids.length) {
      const divSnap = await db.collection('divisions').get();
      ids = divSnap.docs.map((d) => d.id);
    }
    let total = 0;
    for (const id of ids) {
      if (id === 'ndvl') continue;
      const r = await runReformForDivision(id);
      total += r.entryCount || 0;
    }
    return { reformRows: total };
  }

  global.QuotaFirestore = {
    fetchNetStatus,
    syncFromApprovedLog,
    removeQuotaRowsForLog,
    resolveEventAttendees,
    listCommandData,
    listPendingQuotaRequestsForDivisions,
    listApprovedQuotaRequestsForDivision,
    listActiveQuotaModifiersForDivision,
    submitQuotaRequest,
    decideQuotaRequest,
    revokeQuotaRequest,
    deleteQuotaRequest,
    revokeQuotaModifier,
    deleteQuotaModifier,
    saveQuotaPolicy,
    saveEventDefinition,
    deleteEventDefinition,
    listReformSnapshot,
    runReformForDivision,
    runReformAllDivisions,
  };
})(typeof window !== 'undefined' ? window : globalThis);