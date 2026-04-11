// ============================================================
// US Navy CUSA Portal — Cloud Functions
// Deploy with:  firebase deploy --only functions
// ============================================================

'use strict';

const functions = require('firebase-functions');
const admin     = require('firebase-admin');
const https     = require('https');
const url       = require('url');

admin.initializeApp();

const db   = admin.firestore();
const auth = admin.auth();

// ── Permission level constants (must match js/ranks.js) ─────
const PERM_ADMIN_PANEL      = 60;
const PERM_ARCHIVE_LOGS     = 85;
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
