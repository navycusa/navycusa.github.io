// ============================================================
// US Navy CUSA Portal — Cloud Functions
// Deploy with:  firebase deploy --only functions
// ============================================================

'use strict';

const functions = require('firebase-functions');
const admin     = require('firebase-admin');
const https     = require('https');
const url       = require('url');
const quotaLogic = require('./quotaLogic');

admin.initializeApp();

const db   = admin.firestore();
const auth = admin.auth();

// ── Permission level constants (must match js/ranks.js) ─────
const PERM_ADMIN_PANEL      = 60;
const PERM_ARCHIVE_LOGS     = 85;
const PERM_QUOTA_DIV        = 44;
const PERM_QUOTA_HQ         = 90;
const EMAIL_DOMAIN          = '@navycusa.mil';

// ── Helper: get caller's Firestore user doc ──────────────────
async function getCallerDoc(context) {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in first.');
  const snap = await db.collection('users').doc(context.auth.uid).get();
  if (!snap.exists) throw new functions.https.HttpsError('not-found', 'User record missing.');
  return { uid: context.auth.uid, ...snap.data() };
}

// ── Helper: write an audit log entry ────────────────────────
async function writeAudit(action, targetType, targetId, actor, details = {}) {
  await db.collection('audit_logs').add({
    action,
    actorUid:      actor.uid,
    actorUsername: actor.username,
    actorRank:     actor.rankName || null,
    targetType,
    targetId,
    details,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ============================================================
// createUser
// Called by: Admin Panel (CNP+)
// Creates a Firebase Auth account + Firestore user document.
// Initial password: [Username]1234
// ============================================================
exports.createUser = functions.https.onCall(async (data, context) => {
  const caller = await getCallerDoc(context);

  if (caller.permission_level < PERM_ADMIN_PANEL) {
    throw new functions.https.HttpsError('permission-denied', 'Insufficient rank.');
  }

  const { username, rankId, divisionId } = data;

  if (!username || !rankId || !divisionId) {
    throw new functions.https.HttpsError('invalid-argument', 'username, rankId, and divisionId are required.');
  }

  // Validate username characters
  if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
    throw new functions.https.HttpsError('invalid-argument', 'Username must be 3-30 alphanumeric characters or underscores.');
  }

  // Fetch rank data from client-side reference (we re-validate on server)
  // Rank data is defined statically — import from a shared JSON in production.
  const RANKS = getRankList();
  const rankObj = RANKS.find(r => r.id === rankId);
  if (!rankObj) throw new functions.https.HttpsError('invalid-argument', 'Unknown rank ID.');
  if (rankObj.pl >= caller.permission_level) {
    throw new functions.https.HttpsError('permission-denied',
      'Cannot assign a rank equal to or higher than your own.');
  }

  // Fetch division
  const divSnap = await db.collection('divisions').doc(divisionId).get();
  if (!divSnap.exists) throw new functions.https.HttpsError('not-found', 'Division not found.');
  const divData = divSnap.data();

  const email    = username.toLowerCase() + EMAIL_DOMAIN;
  const password = username + '1234';

  // Create Firebase Auth user
  let newUser;
  try {
    newUser = await auth.createUser({
      email,
      password,
      displayName: username,
      emailVerified: true,
    });
  } catch (err) {
    if (err.code === 'auth/email-already-exists') {
      throw new functions.https.HttpsError('already-exists', `Username "${username}" is already taken.`);
    }
    throw new functions.https.HttpsError('internal', err.message);
  }

  // Create Firestore user document
  await db.collection('users').doc(newUser.uid).set({
    username,
    email,
    rankId:           rankObj.id,
    rankName:         rankObj.name,
    rankShort:        rankObj.short,
    permission_level: rankObj.pl,
    divisionId,
    divisionName:     divData.name,
    mustChangePassword: true,
    isActive:         true,
    createdAt:        admin.firestore.FieldValue.serverTimestamp(),
    createdBy:        caller.uid,
  });

  await writeAudit('user.create', 'user', newUser.uid, caller, { username, rankId, divisionId });

  return { uid: newUser.uid, username, email };
});

// ============================================================
// notifyDiscord
// Called by: Activity log page after log creation
// Posts an embed to the division's configured Discord webhook.
// ============================================================
exports.notifyDiscord = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in first.');

  const { logId } = data;
  if (!logId) throw new functions.https.HttpsError('invalid-argument', 'logId is required.');

  // Fetch log
  const logSnap = await db.collection('logs').doc(logId).get();
  if (!logSnap.exists) throw new functions.https.HttpsError('not-found', 'Log not found.');
  const log = logSnap.data();

  // Only notify for own logs (or if admin)
  if (log.authorUid !== context.auth.uid) {
    const callerSnap = await db.collection('users').doc(context.auth.uid).get();
    if (!callerSnap.exists || callerSnap.data().permission_level < 60) {
      throw new functions.https.HttpsError('permission-denied', 'Cannot notify for another user\'s log.');
    }
  }

  // Fetch division webhook
  if (!log.divisionId) return { sent: false, reason: 'No division assigned.' };
  const divSnap = await db.collection('divisions').doc(log.divisionId).get();
  if (!divSnap.exists || !divSnap.data().webhookUrl) {
    return { sent: false, reason: 'No webhook configured for this division.' };
  }

  const webhookUrl = divSnap.data().webhookUrl;

  // Build Discord embed
  const isEvent   = log.type === 'event';
  const eventName = isEvent
    ? (log.eventType === 'Custom Event' ? log.customEventName : log.eventType)
    : null;

  const embed = {
    title:       isEvent ? `📋 Event Log — ${eventName}` : `⏱️ Duty Log Submitted`,
    color:       isEvent ? 0x9b59b6 : 0x3498db,
    description: `A new ${log.type} log has been submitted and is pending approval.`,
    fields: [
      { name: 'Personnel',  value: log.authorUsername,           inline: true },
      { name: 'Rank',       value: log.authorRankName || '—',   inline: true },
      { name: 'Division',   value: log.divisionName  || '—',   inline: true },
    ],
    footer: { text: 'US Navy CUSA Portal' },
    timestamp: new Date().toISOString(),
  };

  if (isEvent) {
    embed.fields.push({ name: 'Event Type',    value: eventName,                       inline: true });
    embed.fields.push({ name: 'Participants',  value: String(log.participants || '—'), inline: true });
  } else {
    embed.fields.push({ name: 'Duration',      value: `${log.durationMinutes} minutes`, inline: true });
  }

  if (log.discordLink) {
    embed.fields.push({ name: 'Proof', value: `[View Message](${log.discordLink})`, inline: false });
  }

  await postToWebhook(webhookUrl, { embeds: [embed] });
  return { sent: true };
});

// ============================================================
// Firestore Triggers — Audit Log (immutable server-side record)
// ============================================================

// On every new log document → write authoritative audit entry
exports.onLogCreated = functions.firestore
  .document('logs/{logId}')
  .onCreate(async (snap, context) => {
    const log = snap.data();
    try {
      await db.collection('audit_logs').add({
        action:        'log.create',
        actorUid:      log.authorUid,
        actorUsername: log.authorUsername,
        actorRank:     log.authorRankName || null,
        targetType:    'log',
        targetId:      context.params.logId,
        details: {
          type:          log.type,
          divisionId:    log.divisionId,
          durationMinutes: log.durationMinutes || null,
          eventType:     log.eventType || null,
        },
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.error('onLogCreated audit write failed:', e);
    }
  });

// On log status change → write audit entry
exports.onLogUpdated = functions.firestore
  .document('logs/{logId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after  = change.after.data();

    // Only audit status changes
    if (before.status === after.status) return;

    const action = `log.${after.status}`; // log.approved / log.rejected

    try {
      await db.collection('audit_logs').add({
        action,
        actorUid:      after.reviewedBy || 'system',
        actorUsername: after.reviewerUsername || 'system',
        targetType:    'log',
        targetId:      context.params.logId,
        details: {
          previousStatus: before.status,
          newStatus:      after.status,
          reviewNotes:    after.reviewNotes || null,
          authorUsername: after.authorUsername,
        },
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.error('onLogUpdated audit write failed:', e);
    }

    try {
      await syncQuotaFromLog(context.params.logId, before, after);
    } catch (e) {
      console.error('syncQuotaFromLog failed:', e);
    }
  });

// ============================================================
// archiveLogs
// Called by: Admin Panel (UnderSecNav+, pl ≥ 85)
// Moves all approved logs (optionally filtered by division)
// into the /archives/ collection, then deletes them from /logs/.
// ============================================================
exports.archiveLogs = functions
  .runWith({ timeoutSeconds: 300, memory: '512MB' })
  .https.onCall(async (data, context) => {

  const caller = await getCallerDoc(context);
  if (caller.permission_level < PERM_ARCHIVE_LOGS) {
    throw new functions.https.HttpsError('permission-denied',
      'Archive requires Undersecretary of the Navy or higher.');
  }

  const { divisionId } = data; // null = all divisions

  // Query approved logs
  let query = db.collection('logs').where('status', '==', 'approved');
  if (divisionId) query = query.where('divisionId', '==', divisionId);

  const snap = await query.get();
  if (snap.empty) return { count: 0, archiveId: null };

  // Write archive document
  const archiveRef = db.collection('archives').doc();
  const archiveLogs = snap.docs.map(d => ({ logId: d.id, ...d.data() }));

  await archiveRef.set({
    logs:               archiveLogs,
    count:              archiveLogs.length,
    divisionId:         divisionId || null,
    archivedBy:         caller.uid,
    archivedByUsername: caller.username,
    archivedAt:         admin.firestore.FieldValue.serverTimestamp(),
  });

  // Delete live logs in batches of 500
  const chunks = [];
  for (let i = 0; i < snap.docs.length; i += 500) {
    chunks.push(snap.docs.slice(i, i + 500));
  }
  for (const chunk of chunks) {
    const batch = db.batch();
    chunk.forEach(d => batch.delete(d.ref));
    await batch.commit();
  }

  await writeAudit('log.archive', 'archive', archiveRef.id, caller, {
    count: archiveLogs.length, divisionId: divisionId || 'all',
  });

  return { count: archiveLogs.length, archiveId: archiveRef.id };
});

// ═══════════════════════════════════════════════════════════════
// QUOTA — attendance sync, callables, reform job
// ═══════════════════════════════════════════════════════════════

async function divisionIsHeadquarters(divisionId) {
  if (!divisionId) return false;
  const snap = await db.collection('divisions').doc(divisionId).get();
  return snap.exists && snap.data().isHeadquarters === true;
}

async function canManageDivisionQuota(caller, divisionId) {
  if (!divisionId) return false;
  const hq = await divisionIsHeadquarters(divisionId);
  if (hq) {
    return caller.permission_level >= PERM_QUOTA_HQ || caller.rankId === 'secnav';
  }
  return caller.permission_level >= PERM_QUOTA_DIV && caller.divisionId === divisionId;
}

function effectiveQuotaRankId(user) {
  return user.mappedRankId || user.rankId || '';
}

async function resolveEventMatchFields(log) {
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

async function syncQuotaFromLog(logId, before, after) {
  if (after.type !== 'event' && after.type !== 'duty') return;

  const wasApproved = before.status === 'approved';
  const isApproved = after.status === 'approved';

  if (wasApproved && !isApproved) {
    const q = await db.collection('quota_attendance').where('logId', '==', logId).get();
    if (q.empty) return;
    const batch = db.batch();
    q.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    return;
  }

  if (!isApproved) return;

  const existing = await db.collection('quota_attendance').where('logId', '==', logId).get();
  const batch = db.batch();
  existing.docs.forEach((d) => batch.delete(d.ref));

  if (after.type === 'duty') {
    const ref = db.collection('quota_attendance').doc();
    batch.set(ref, {
      logId,
      userId: after.authorUid,
      divisionId: after.divisionId || null,
      occurredAt: after.date || admin.firestore.FieldValue.serverTimestamp(),
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
    after.attendeeUids.forEach((u) => {
      if (typeof u === 'string' && u) uids.add(u);
    });
  }

  const resolved = await resolveEventMatchFields(after);
  const occurredAt = after.date || admin.firestore.FieldValue.serverTimestamp();

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

async function loadPoliciesForDivision(divisionId) {
  const snap = await db.collection('quota_policies').where('divisionId', '==', divisionId).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function loadActiveModifiers(userId, divisionId, periodStart, periodEnd) {
  const snap = await db.collection('quota_modifiers')
    .where('userId', '==', userId)
    .where('divisionId', '==', divisionId)
    .where('active', '==', true)
    .get();

  let mdqraMax = 0;
  let loaExempt = false;

  const ps = new Date(periodStart);
  const pe = new Date(periodEnd);

  snap.forEach((doc) => {
    const m = doc.data();
    const s = quotaLogic.parseYMD(m.startDate);
    if (!s) return;
    let endBound = m.endDate ? quotaLogic.parseYMD(m.endDate) : new Date(8640000000000000);
    if (!endBound) endBound = new Date(8640000000000000);
    endBound.setUTCHours(23, 59, 59, 999);
    const overlap = ps.getTime() <= endBound.getTime() && pe.getTime() >= s.getTime();
    if (!overlap) return;

    if (m.type === 'LOA') loaExempt = true;
    if (m.type === 'MDQRA') {
      const p = Number(m.reductionPercent) || 0;
      if (p > mdqraMax) mdqraMax = p;
    }
  });

  return { mdqraPercent: mdqraMax, loaExempt };
}

async function loadUserAttendances(userId, divisionId, start, end) {
  const snap = await db.collection('quota_attendance')
    .where('userId', '==', userId)
    .where('divisionId', '==', divisionId)
    .where('occurredAt', '>=', admin.firestore.Timestamp.fromDate(start))
    .where('occurredAt', '<=', admin.firestore.Timestamp.fromDate(end))
    .get();

  return snap.docs.map((d) => d.data());
}

async function computeQuotaStatusForUser(userSnap, referenceDate = new Date()) {
  const user = { uid: userSnap.id, ...userSnap.data() };
  const divisionId = user.divisionId;
  if (!divisionId || divisionId === 'ndvl') {
    return { ok: true, noPolicy: true, message: 'No quota division assigned.' };
  }

  const policies = await loadPoliciesForDivision(divisionId);
  const rankId = effectiveQuotaRankId(user);
  const roughStart = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), 1));
  const roughEnd = new Date(Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth() + 1,
    0, 23, 59, 59, 999,
  ));

  const policy = quotaLogic.selectPolicy(policies, divisionId, rankId, roughStart, roughEnd);
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
  const bounds = quotaLogic.getPeriodBounds(pk, referenceDate);
  const mods = await loadActiveModifiers(user.uid, divisionId, bounds.start, bounds.end);
  const attendances = await loadUserAttendances(user.uid, divisionId, bounds.start, bounds.end);

  const net = quotaLogic.computeNetQuota(
    attendances,
    policy,
    mods.mdqraPercent,
    mods.loaExempt,
  );

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

exports.resolveEventAttendees = functions.https.onCall(async (data, context) => {
  const caller = await getCallerDoc(context);
  const { divisionId, usernames } = data;
  if (!divisionId || !Array.isArray(usernames)) {
    throw new functions.https.HttpsError('invalid-argument', 'divisionId and usernames[] required.');
  }
  const hqPicker = caller.permission_level >= PERM_ADMIN_PANEL;
  if (!hqPicker && caller.divisionId !== divisionId) {
    throw new functions.https.HttpsError('permission-denied', 'Cannot resolve attendees for another division.');
  }

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
});

exports.getQuotaNetStatus = functions.https.onCall(async (data, context) => {
  const caller = await getCallerDoc(context);
  let targetUid = caller.uid;
  if (data.targetUid && data.targetUid !== caller.uid) {
    const tSnap = await db.collection('users').doc(data.targetUid).get();
    if (!tSnap.exists) throw new functions.https.HttpsError('not-found', 'User not found.');
    const t = tSnap.data();
    if (!(await canManageDivisionQuota(caller, t.divisionId))) {
      throw new functions.https.HttpsError('permission-denied', 'Cannot view quota for this member.');
    }
    targetUid = data.targetUid;
  }

  const refDate = data.referenceDate ? new Date(data.referenceDate + 'T12:00:00Z') : new Date();
  const userSnap = await db.collection('users').doc(targetUid).get();
  if (!userSnap.exists) throw new functions.https.HttpsError('not-found', 'User not found.');

  return computeQuotaStatusForUser(userSnap, refDate);
});

exports.submitQuotaRequest = functions.https.onCall(async (data, context) => {
  const caller = await getCallerDoc(context);
  const { requestType, reductionPercent, loaStart, loaEnd, reason } = data;
  const divisionId = caller.divisionId;
  if (!divisionId || divisionId === 'ndvl') {
    throw new functions.https.HttpsError('failed-precondition', 'You must belong to a quota division.');
  }

  if (requestType === 'MDQRA') {
    const p = Number(reductionPercent);
    if (!(p > 0 && p <= 100)) {
      throw new functions.https.HttpsError('invalid-argument', 'MDQRA requires reductionPercent between 1 and 100.');
    }
    const ref = await db.collection('quota_requests').add({
      requestType: 'MDQRA',
      requesterUid: caller.uid,
      requesterUsername: caller.username,
      divisionId,
      status: 'pending',
      reductionPercent: p,
      reason: reason || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await writeAudit('quota.request', 'quota_request', ref.id, caller, { type: 'MDQRA', p });
    return { requestId: ref.id };
  }

  if (requestType === 'LOA') {
    if (!loaStart || !loaEnd) {
      throw new functions.https.HttpsError('invalid-argument', 'LOA requires loaStart and loaEnd (YYYY-MM-DD).');
    }
    const ref = await db.collection('quota_requests').add({
      requestType: 'LOA',
      requesterUid: caller.uid,
      requesterUsername: caller.username,
      divisionId,
      status: 'pending',
      loaStart,
      loaEnd,
      reason: reason || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await writeAudit('quota.request', 'quota_request', ref.id, caller, { type: 'LOA', loaStart, loaEnd });
    return { requestId: ref.id };
  }

  throw new functions.https.HttpsError('invalid-argument', 'requestType must be MDQRA or LOA.');
});

exports.decideQuotaRequest = functions.https.onCall(async (data, context) => {
  const caller = await getCallerDoc(context);
  const { requestId, approve, decisionNotes } = data;
  if (!requestId) throw new functions.https.HttpsError('invalid-argument', 'requestId required.');

  const reqRef = db.collection('quota_requests').doc(requestId);
  const reqSnap = await reqRef.get();
  if (!reqSnap.exists) throw new functions.https.HttpsError('not-found', 'Request not found.');
  const req = reqSnap.data();
  if (req.status !== 'pending') {
    throw new functions.https.HttpsError('failed-precondition', 'Request is not pending.');
  }

  if (!(await canManageDivisionQuota(caller, req.divisionId))) {
    throw new functions.https.HttpsError('permission-denied', 'Not authorized to decide this request.');
  }

  const status = approve ? 'approved' : 'rejected';
  await reqRef.update({
    status,
    decidedAt: admin.firestore.FieldValue.serverTimestamp(),
    decidedByUid: caller.uid,
    decidedByUsername: caller.username,
    decisionNotes: decisionNotes || null,
  });

  if (approve && req.requestType === 'MDQRA') {
    await db.collection('quota_modifiers').add({
      userId: req.requesterUid,
      divisionId: req.divisionId,
      type: 'MDQRA',
      reductionPercent: req.reductionPercent,
      startDate: new Date().toISOString().slice(0, 10),
      endDate: null,
      sourceRequestId: requestId,
      active: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  if (approve && req.requestType === 'LOA') {
    await db.collection('quota_modifiers').add({
      userId: req.requesterUid,
      divisionId: req.divisionId,
      type: 'LOA',
      startDate: req.loaStart,
      endDate: req.loaEnd,
      sourceRequestId: requestId,
      active: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  await writeAudit('quota.decide', 'quota_request', requestId, caller, { status, approve });
  return { ok: true, status };
});

exports.saveQuotaPolicy = functions.https.onCall(async (data, context) => {
  const caller = await getCallerDoc(context);
  const {
    policyId, divisionId, rankId, periodKind, effectiveFrom, effectiveTo, rules,
  } = data;
  if (!divisionId || !rankId || !effectiveFrom || !periodKind) {
    throw new functions.https.HttpsError('invalid-argument', 'divisionId, rankId, periodKind, effectiveFrom required.');
  }
  if (!(await canManageDivisionQuota(caller, divisionId))) {
    throw new functions.https.HttpsError('permission-denied', 'Not authorized to edit quotas for this division.');
  }
  if (!['weekly', 'monthly'].includes(periodKind)) {
    throw new functions.https.HttpsError('invalid-argument', 'periodKind must be weekly or monthly.');
  }

  const payload = {
    divisionId,
    rankId,
    periodKind,
    effectiveFrom,
    effectiveTo: effectiveTo || null,
    rules: Array.isArray(rules) ? rules : [],
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedByUid: caller.uid,
  };

  if (policyId) {
    const ref = db.collection('quota_policies').doc(policyId);
    const ex = await ref.get();
    if (!ex.exists) throw new functions.https.HttpsError('not-found', 'Policy not found.');
    if (ex.data().divisionId !== divisionId) {
      throw new functions.https.HttpsError('permission-denied', 'Cannot move policy between divisions.');
    }
    await ref.set({ ...ex.data(), ...payload }, { merge: true });
    await writeAudit('quota.policy.update', 'quota_policy', policyId, caller, { divisionId, rankId });
    return { policyId };
  }

  payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
  payload.createdByUid = caller.uid;
  const ref = await db.collection('quota_policies').add(payload);
  await writeAudit('quota.policy.create', 'quota_policy', ref.id, caller, { divisionId, rankId });
  return { policyId: ref.id };
});

exports.saveEventDefinition = functions.https.onCall(async (data, context) => {
  const caller = await getCallerDoc(context);
  const {
    definitionId, divisionId, key, label, matchEventType, matchCustomName,
  } = data;
  if (!divisionId || !key || !label) {
    throw new functions.https.HttpsError('invalid-argument', 'divisionId, key, and label are required.');
  }
  if (!(await canManageDivisionQuota(caller, divisionId))) {
    throw new functions.https.HttpsError('permission-denied', 'Not authorized.');
  }
  const payload = {
    divisionId,
    key: String(key).trim(),
    label: String(label).trim(),
    matchEventType: matchEventType || null,
    matchCustomName: matchCustomName || null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (definitionId) {
    const ref = db.collection('event_definitions').doc(definitionId);
    const ex = await ref.get();
    if (!ex.exists) throw new functions.https.HttpsError('not-found', 'Definition not found.');
    if (ex.data().divisionId !== divisionId) {
      throw new functions.https.HttpsError('permission-denied', 'Division mismatch.');
    }
    await ref.set({ ...ex.data(), ...payload }, { merge: true });
    return { definitionId };
  }

  payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
  const ref = await db.collection('event_definitions').add(payload);
  await writeAudit('quota.event_def.create', 'event_definition', ref.id, caller, { divisionId, key });
  return { definitionId: ref.id };
});

exports.deleteEventDefinition = functions.https.onCall(async (data, context) => {
  const caller = await getCallerDoc(context);
  const { definitionId, divisionId } = data;
  if (!definitionId || !divisionId) {
    throw new functions.https.HttpsError('invalid-argument', 'definitionId and divisionId required.');
  }
  if (!(await canManageDivisionQuota(caller, divisionId))) {
    throw new functions.https.HttpsError('permission-denied', 'Not authorized.');
  }
  const ref = db.collection('event_definitions').doc(definitionId);
  const ex = await ref.get();
  if (!ex.exists || ex.data().divisionId !== divisionId) {
    throw new functions.https.HttpsError('not-found', 'Definition not found.');
  }
  await ref.delete();
  await writeAudit('quota.event_def.delete', 'event_definition', definitionId, caller, {});
  return { ok: true };
});

exports.listQuotaCommandData = functions.https.onCall(async (data, context) => {
  const caller = await getCallerDoc(context);
  const { divisionId } = data;
  if (!divisionId) throw new functions.https.HttpsError('invalid-argument', 'divisionId required.');
  if (!(await canManageDivisionQuota(caller, divisionId))) {
    throw new functions.https.HttpsError('permission-denied', 'Not authorized.');
  }

  const [defsSnap, polSnap, reqSnap] = await Promise.all([
    db.collection('event_definitions').where('divisionId', '==', divisionId).get(),
    db.collection('quota_policies').where('divisionId', '==', divisionId).get(),
    db.collection('quota_requests')
      .where('divisionId', '==', divisionId)
      .where('status', '==', 'pending')
      .get(),
  ]);

  return {
    eventDefinitions: defsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    policies: polSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    pendingRequests: reqSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
  };
});

exports.listReformSnapshot = functions.https.onCall(async (data, context) => {
  const caller = await getCallerDoc(context);
  const { divisionId, weekKey } = data;
  if (!divisionId) throw new functions.https.HttpsError('invalid-argument', 'divisionId required.');

  const divOk =
    caller.permission_level >= PERM_ADMIN_PANEL ||
    (caller.divisionId === divisionId && caller.permission_level >= 42) ||
    (await canManageDivisionQuota(caller, divisionId));
  if (!divOk) throw new functions.https.HttpsError('permission-denied', 'Not authorized.');

  let chosen = null;
  if (weekKey) {
    const snap = await db.collection('reform_snapshots')
      .where('divisionId', '==', divisionId)
      .where('weekKey', '==', weekKey)
      .limit(10)
      .get();
    if (!snap.empty) {
      const sorted = snap.docs.slice().sort((a, b) => {
        const ta = a.data().computedAt && a.data().computedAt.toMillis
          ? a.data().computedAt.toMillis() : 0;
        const tb = b.data().computedAt && b.data().computedAt.toMillis
          ? b.data().computedAt.toMillis() : 0;
        return tb - ta;
      });
      chosen = sorted[0];
    }
  } else {
    const snap = await db.collection('reform_snapshots')
      .where('divisionId', '==', divisionId)
      .orderBy('computedAt', 'desc')
      .limit(1)
      .get();
    if (!snap.empty) chosen = snap.docs[0];
  }

  if (!chosen) return { snapshot: null, entries: [] };

  const entriesSnap = await chosen.ref.collection('entries').get();
  return {
    snapshot: { id: chosen.id, ...chosen.data() },
    entries: entriesSnap.docs.map((e) => ({ id: e.id, ...e.data() })),
  };
});

async function runReformForAllDivisions() {
  const divSnap = await db.collection('divisions').get();
  const refDate = new Date();
  let totalEntries = 0;

  for (const divDoc of divSnap.docs) {
    const divisionId = divDoc.id;
    if (divisionId === 'ndvl') continue;

    const policies = await loadPoliciesForDivision(divisionId);
    if (!policies.length) continue;

    const periodKind = policies[0].periodKind || 'weekly';
    const bounds = quotaLogic.getPeriodBounds(periodKind, refDate);
    const weekKey = bounds.start.toISOString().slice(0, 10);

    const usersSnap = await db.collection('users').where('divisionId', '==', divisionId).get();
    const batchEntries = [];

    for (const uDoc of usersSnap.docs) {
      const st = await computeQuotaStatusForUser(uDoc, refDate);
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
      computedAt: admin.firestore.FieldValue.serverTimestamp(),
      entryCount: batchEntries.length,
    });

    for (const ent of batchEntries) {
      await snapRef.collection('entries').doc(ent.userId).set(ent);
      totalEntries++;
    }
  }

  return { divisions: divSnap.size, reformRows: totalEntries };
}

exports.runReformAssessment = functions
  .runWith({ timeoutSeconds: 300, memory: '512MB' })
  .pubsub.schedule('0 5 * * 1')
  .timeZone('Etc/UTC')
  .onRun(async () => {
    const out = await runReformForAllDivisions();
    console.log('runReformAssessment', out);
    return out;
  });

exports.runReformAssessmentManual = functions
  .runWith({ timeoutSeconds: 300, memory: '512MB' })
  .https.onCall(async (data, context) => {
    const caller = await getCallerDoc(context);
    if (caller.permission_level < PERM_QUOTA_HQ && caller.rankId !== 'secnav') {
      throw new functions.https.HttpsError('permission-denied', 'SecNav+ only for manual reform run.');
    }
    return runReformForAllDivisions();
  });

// ── Helpers ──────────────────────────────────────────────────
function postToWebhook(webhookUrl, payload) {
  return new Promise((resolve, reject) => {
    const body   = JSON.stringify(payload);
    const parsed = url.parse(webhookUrl);
    const opts   = {
      hostname: parsed.hostname,
      path:     parsed.path,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(opts, res => {
      res.on('data', () => {});
      res.on('end', () => resolve());
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Static rank list (mirrored from js/ranks.js — keep in sync)
function getRankList() {
  return [
    { id: 'administrator',    name: 'Administrator',                  short: 'ADMIN',       pl: 100 },
    { id: 'secnav',           name: 'Secretary of the Navy',          short: 'SecNav',      pl: 90  },
    { id: 'undersecnav',      name: 'Undersecretary of the Navy',     short: 'UnderSecNav', pl: 85  },
    { id: 'asst_secnav',      name: 'Assistant to the Secretary',     short: 'Asst SecNav', pl: 80  },
    { id: 'ncis_dir',         name: 'NCIS Director',                  short: 'NCIS Dir',    pl: 75  },
    { id: 'ncis_hicom',       name: 'NCIS HICOM',                     short: 'NCIS HICOM',  pl: 72  },
    { id: 'cno',              name: 'Chief of Naval Operations',      short: 'CNO',         pl: 70  },
    { id: 'vcno',             name: 'Vice Chief of Naval Operations', short: 'VCNO',        pl: 65  },
    { id: 'cnp',              name: 'Chief of Naval Personnel',       short: 'CNP',         pl: 60  },
    { id: 'ncis_midcom',      name: 'NCIS MIDCOM',                    short: 'NCIS MIDCOM', pl: 55  },
    { id: 'admiral',          name: 'Admiral',                        short: 'ADM',         pl: 50  },
    { id: 'vice_admiral',     name: 'Vice Admiral',                   short: 'VADM',        pl: 48  },
    { id: 'rear_admiral_u',   name: 'Rear Admiral (Upper Half)',      short: 'RADM',        pl: 46  },
    { id: 'rear_admiral_l',   name: 'Rear Admiral (Lower Half)',      short: 'RDML',        pl: 44  },
    { id: 'mcpo',             name: 'Master Chief Petty Officer',     short: 'MCPO',        pl: 42  },
    { id: 'ncis_agent',       name: 'NCIS',                           short: 'NCIS',        pl: 40  },
    { id: 'captain',          name: 'Captain',                        short: 'CAPT',        pl: 38  },
    { id: 'commander',        name: 'Commander',                      short: 'CDR',         pl: 36  },
    { id: 'lt_commander',     name: 'Lieutenant Commander',           short: 'LCDR',        pl: 34  },
    { id: 'lieutenant',       name: 'Lieutenant',                     short: 'LT',          pl: 32  },
    { id: 'ltjg',             name: 'Lieutenant Junior Grade',        short: 'LTJG',        pl: 30  },
    { id: 'ensign',           name: 'Ensign',                         short: 'ENS',         pl: 28  },
    { id: 'senior_chief',     name: 'Senior Chief Petty Officer',     short: 'SCPO',        pl: 20  },
    { id: 'chief',            name: 'Chief Petty Officer',            short: 'CPO',         pl: 18  },
    { id: 'po1',              name: 'Petty Officer First Class',      short: 'PO1',         pl: 16  },
    { id: 'po2',              name: 'Petty Officer Second Class',     short: 'PO2',         pl: 14  },
    { id: 'po3',              name: 'Petty Officer Third Class',      short: 'PO3',         pl: 12  },
    { id: 'seaman',           name: 'Seaman',                         short: 'SN',          pl: 10  },
    { id: 'seaman_apprentice',name: 'Seaman Apprentice',              short: 'SA',          pl: 8   },
    { id: 'seaman_recruit',   name: 'Seaman Recruit',                 short: 'SR',          pl: 5   },
  ];
}
