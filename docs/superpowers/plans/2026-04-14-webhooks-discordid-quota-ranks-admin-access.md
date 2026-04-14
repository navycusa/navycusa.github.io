# Webhooks (Option A + General), Discord ID Pings, QUOTA Authority, Rank Model, Admin Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement per-division split webhooks for Duty/Event/LOA/MDQRA (pending+approved) plus a General catch-all, add Discord ID storage and approval mentions, fix HQ QUOTA authority rules, correct MCPO vs MCPON and add ranks above SecNav, and allow MCPO+ to access Admin Panel for log review.

**Architecture:** Keep Firestore collections and existing flows, add additive fields to `divisions` and `users`, implement webhook routing as “post to General + category (with legacy fallback)”, and adjust permission helpers in `js/ranks.js` so UI/guards use one consistent source of truth.

**Tech Stack:** Static HTML/CSS/vanilla JS, Firebase Auth + Firestore compat SDK, Discord webhooks via `fetch`.

---

## File map (what changes where)

- Modify: `js/discord-webhooks.js` — webhook URL resolution, multi-posting, add optional `content` for mentions
- Modify: `js/admin.js` — division modal webhook fields; add Discord ID field in personnel modal; log approval mentions; broaden admin access behavior indirectly via auth helper
- Modify: `admin.html` — add form input for Discord ID; add division modal fields for new webhooks
- Modify: `js/ranks.js` — new ranks; fix MCPO vs MCPON; update `canAccessAdminPanel`; update `canManageDivisionQuota`
- Modify: `js/quota-command.js` — no logic rewrite expected; will pick up new `canManageDivisionQuota` behavior automatically
- Modify (optional): `DEVELOPER-GUIDE.md`, `USER-GUIDE.md` — document new webhook fields + Discord ID pings

---

## Task 1: Implement webhook routing (Option A + General) in `js/discord-webhooks.js`

**Files:**
- Modify: `js/discord-webhooks.js`

- [ ] **Step 1: Add an enum-like category mapping**

Add a small mapping for event categories and statuses:

```js
const WEBHOOK_KEYS = {
  general: 'webhookUrlGeneral',
  duty:   { pending: 'webhookDutyPending',   approved: 'webhookDutyApproved' },
  event:  { pending: 'webhookEventPending',  approved: 'webhookEventApproved' },
  loa:    { pending: 'webhookLoaPending',    approved: 'webhookLoaApproved' },
  mdqra:  { pending: 'webhookMdqraPending',  approved: 'webhookMdqraApproved' },
};
```

- [ ] **Step 2: Replace `divisionDiscordUrls()` with multi-target resolver**

Implement a resolver that returns an ordered list of URLs:

```js
function cleanUrl(v) {
  const s = String(v || '').trim();
  return s ? s : null;
}

function legacyFallbackUrl(divData, status) {
  const legacySingle = cleanUrl(divData.webhookUrl);
  if (status === 'approved') return cleanUrl(divData.webhookUrlApproved) || legacySingle;
  return cleanUrl(divData.webhookUrlPending) || legacySingle;
}

function webhookTargets(divData, category, status) {
  if (!divData) return [];
  const urls = [];

  // Always include General if set (archive channel).
  const general = cleanUrl(divData[WEBHOOK_KEYS.general]);
  if (general) urls.push(general);

  // Category-specific if present.
  const catKey = WEBHOOK_KEYS[category] && WEBHOOK_KEYS[category][status];
  const catUrl = catKey ? cleanUrl(divData[catKey]) : null;
  if (catUrl) urls.push(catUrl);
  else {
    const legacy = legacyFallbackUrl(divData, status);
    if (legacy) urls.push(legacy);
  }

  // De-dupe identical URLs while preserving order.
  return [...new Set(urls)];
}
```

- [ ] **Step 3: Extend `postEmbed` to accept category + status and optional content**

Change the signature from `(firestoreDb, divisionId, channel, embed)` to:

```js
/**
 * @param {firebase.firestore.Firestore} firestoreDb
 * @param {string} divisionId
 * @param {{ category: 'duty'|'event'|'loa'|'mdqra'|'general', status: 'pending'|'approved' }} route
 * @param {object} embed
 * @param {{ content?: string|null }} [opts]
 */
async function postEmbed(firestoreDb, divisionId, route, embed, opts) { ... }
```

Implementation details:

- Fetch division doc as currently done.
- Compute targets with `webhookTargets(divData, route.category, route.status)`.
- If no targets, return.
- Post payload to each URL:

```js
const payload = {
  ...(opts && opts.content ? { content: opts.content } : {}),
  embeds: [{ ...embed, footer: embed.footer || defaultFooter(), timestamp: embed.timestamp || new Date().toISOString() }],
};
await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
```

- Keep failures non-fatal (warn and continue).

- [ ] **Step 4: Keep old call sites working (compat shim)**

Because existing pages call `postEmbed(db, divId, 'pending', embed)`, temporarily support both forms:

```js
async function postEmbed(firestoreDb, divisionId, routeOrStatus, embed, opts) {
  const route = typeof routeOrStatus === 'string'
    ? { category: 'general', status: routeOrStatus } // legacy behavior: treat as pending/approved to legacy + general
    : routeOrStatus;
  ...
}
```

Then gradually update call sites in Tasks 2–4 to pass `{category, status}`.

- [ ] **Step 5: Quick verification**

Manual (no deploy required):

- Confirm `js/discord-webhooks.js` exports `DiscordWebhooks.postEmbed` and loads without syntax errors.

---

## Task 2: Update Division modal to configure new webhooks

**Files:**
- Modify: `admin.html`
- Modify: `js/admin.js`

- [ ] **Step 1: Add new inputs to Division modal (`admin.html`)**

In the Division modal form, add labeled inputs:

- `dm-webhook-general`
- `dm-webhook-duty-pending`, `dm-webhook-duty-approved`
- `dm-webhook-event-pending`, `dm-webhook-event-approved`
- `dm-webhook-loa-pending`, `dm-webhook-loa-approved`
- `dm-webhook-mdqra-pending`, `dm-webhook-mdqra-approved`

Keep existing legacy inputs:

- `dm-webhook-pending`
- `dm-webhook-approved`
- `dm-webhook-legacy`

- [ ] **Step 2: Populate fields on edit (`openDivModal`)**

In `js/admin.js`, inside `openDivModal(divId)` (edit path), set:

```js
document.getElementById('dm-webhook-general').value = div.webhookUrlGeneral || '';
document.getElementById('dm-webhook-duty-pending').value = div.webhookDutyPending || '';
document.getElementById('dm-webhook-duty-approved').value = div.webhookDutyApproved || '';
// repeat for event/loa/mdqra...
```

- [ ] **Step 3: Clear fields on add (new division)**

In the add path, set all new fields to empty strings.

- [ ] **Step 4: Save fields to Firestore (`saveDivision`)**

In `saveDivision(divId)`, read all fields and include them in `data`:

```js
const whGeneral = document.getElementById('dm-webhook-general').value.trim();
const whDutyPend = document.getElementById('dm-webhook-duty-pending').value.trim();
// ...

const data = {
  name, short,
  webhookUrlGeneral: whGeneral,
  webhookDutyPending: whDutyPend,
  webhookDutyApproved: whDutyAppr,
  webhookEventPending: whEventPend,
  webhookEventApproved: whEventAppr,
  webhookLoaPending: whLoaPend,
  webhookLoaApproved: whLoaAppr,
  webhookMdqraPending: whMdqraPend,
  webhookMdqraApproved: whMdqraAppr,
  // legacy (keep)
  webhookUrl: whLeg,
  webhookUrlPending: whPend,
  webhookUrlApproved: whAppr,
  updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
};
```

- [ ] **Step 5: Table indicators**

Update `effectiveDivWebhookPending/Approved` display logic if needed. Minimum acceptable:

- Show “Set” for pending if ANY of:
  - `webhookUrlGeneral` OR any `*Pending` OR legacy pending
- Show “Set” for approved if ANY of:
  - `webhookUrlGeneral` OR any `*Approved` OR legacy approved

---

## Task 3: Add Discord ID field to Personnel modal and store it

**Files:**
- Modify: `admin.html`
- Modify: `js/admin.js`

- [ ] **Step 1: Add Discord ID input to user modal (`admin.html`)**

Add input with id `um-discord-id`:

- Label: “Discord ID (for approval pings)”
- Placeholder: “e.g. 123456789012345678”

- [ ] **Step 2: Populate on edit**

In `openUserModal(userId)` edit path:

```js
document.getElementById('um-discord-id').value = usr.discordId || '';
```

- [ ] **Step 3: Clear on add**

In add path, set it to empty.

- [ ] **Step 4: Validate and save**

In `saveUser(userId, existing)`:

```js
const discordIdRaw = document.getElementById('um-discord-id').value.trim();
const discordId = discordIdRaw ? discordIdRaw.replace(/[<@!>]/g, '').trim() : '';
if (discordId && !/^\d{15,25}$/.test(discordId)) {
  showAlert('user-modal-alert', 'danger', 'Discord ID must be 15–25 digits (a Discord snowflake).');
  return;
}
userData.discordId = discordId || null;
```

Ensure updates and creates both store `discordId`.

---

## Task 4: Add approval mentions on log approval webhook posts

**Files:**
- Modify: `js/admin.js`

- [ ] **Step 1: Add helper to build mention content**

Implement near the review logic:

```js
async function discordMentionsForUids(uids) {
  const clean = [...new Set((uids || []).filter(Boolean))];
  if (!clean.length) return '';
  const snaps = await Promise.all(clean.map((id) => db.collection('users').doc(id).get()));
  const ids = snaps
    .filter((s) => s.exists)
    .map((s) => s.data().discordId)
    .map((x) => String(x || '').trim())
    .filter((x) => /^\d{15,25}$/.test(x));
  const uniq = [...new Set(ids)];
  return uniq.length ? uniq.map((id) => `<@${id}>`).join(' ') : '';
}
```

- [ ] **Step 2: Update approved log post to use category route + mentions**

In `reviewLog`, for approved logs:

- Determine category:
  - duty log → `category: 'duty'`
  - event log → `category: 'event'`
- Determine ping targets:
  - Always include `logData.authorUid`
  - If event: include `logData.attendeeUids` if present
- Build mentions:

```js
const mentionUids = [logData.authorUid, ...(Array.isArray(logData.attendeeUids) ? logData.attendeeUids : [])];
const content = await discordMentionsForUids(mentionUids);
```

- Post embed:

```js
await window.DiscordWebhooks.postEmbed(
  db,
  logData.divisionId,
  { category, status: 'approved' },
  window.DiscordWebhooks.buildLogApprovedEmbed(logData),
  content ? { content } : undefined
);
```

- [ ] **Step 3: Update pending submission posts to use category routing**

In `activity.js`, update:

- Duty submission pending: route `{ category: 'duty', status: 'pending' }`
- Event submission pending: route `{ category: 'event', status: 'pending' }`

Keep behavior same otherwise.

---

## Task 5: Route LOA/MDQRA quota request webhooks to category + General

**Files:**
- Modify: `js/quota-firestore.js` (or wherever quota requests are posted)
- Modify: `js/discord-webhooks.js` (if request embed builders need tweaks)

- [ ] **Step 1: Locate quota request webhook post call sites**

Search targets:

- `buildQuotaRequestPendingEmbed`
- `buildQuotaRequestDecidedEmbed`
- `.postEmbed(` calls related to quota requests

Expected categories:

- LOA pending/approved → `{ category: 'loa', status: ... }`
- MDQRA pending/approved → `{ category: 'mdqra', status: ... }`

- [ ] **Step 2: Update call sites**

When a request is created (pending):

```js
await DiscordWebhooks.postEmbed(db, divisionId, { category: isLoa ? 'loa' : 'mdqra', status: 'pending' }, embed);
```

When decided (approved/rejected):

```js
await DiscordWebhooks.postEmbed(db, divisionId, { category: isLoa ? 'loa' : 'mdqra', status: 'approved' }, embed);
```

Note: if rejected uses “pending” legacy channel today, keep the post but use the same category with status `'pending'` OR introduce `'approved'` for decided. For this plan, treat “decided” as status `'approved'` routing bucket (it is the post-decision channel).

---

## Task 6: Fix QUOTA authority rules so HQ can manage all non-HQ divisions

**Files:**
- Modify: `js/ranks.js`

- [ ] **Step 1: Replace `canManageDivisionQuota` logic**

Implement rules:

- If target division is HQ → allow only SecNav+ (`permission_level >= PERM.QUOTA_HQ_AUTHORITY`), and Administrator always.
- If target division is non-HQ:
  - Allow SecNav+ (same threshold) and Administrator.
  - Allow HQ staff (CNP+ i.e. `permission_level >= PERM.ADMIN_PANEL`) cross-division.
  - Allow RDML+ (`PERM.QUOTA_DIV_COMMAND`) for their own division.

Concrete code shape:

```js
function canManageDivisionQuota(user, divisionId, divisionIsHQ, userDivisionIsHQ) {
  if (!divisionId || !user) return false;
  if (user.rankId === 'administrator') return true;

  const isSecNavPlus = user.permission_level >= PERM.QUOTA_HQ_AUTHORITY;

  if (divisionIsHQ) {
    return isSecNavPlus;
  }

  // Non-HQ division:
  if (isSecNavPlus) return true;
  if (user.permission_level >= PERM.ADMIN_PANEL) return true; // HQ staff (CNP+) manage all non-HQ
  if (user.permission_level < PERM.QUOTA_DIV_COMMAND) return false;
  return user.divisionId === divisionId;
}
```

- [ ] **Step 2: Verify `quota-command.js` now shows all non-HQ divisions for HQ**

Manual test:

- Login as HQ user with `permission_level >= 60` but `< 90`
- Visit `quota-command.html`
- Division selector should include all non-HQ divisions
- HQ division should not appear unless SecNav+.

---

## Task 7: Rank model updates (MCPO vs MCPON + ranks above SecNav)

**Files:**
- Modify: `js/ranks.js`

- [ ] **Step 1: Update ranks list**

Changes:

- Move **MCPO** to Command category at `pl: 42`.
- Add **MCPON** as HQ category below CNP.
- Add ranks above SecNav: Secretary of Defense, Vice President, President, Ownership Team, Chairman, Administrator (top).

Example (final PLs can be adjusted, but ordering must be strict and preserve existing `PERM` thresholds):

```js
// HQ (top-down)
{ id:'administrator', name:'Administrator', short:'ADMIN', cat:'HQ', pl: 100 },
{ id:'chairman', name:'Chairman', short:'CHMN', cat:'HQ', pl: 99 },
{ id:'ownership_team', name:'Ownership Team', short:'OWN', cat:'HQ', pl: 98 },
{ id:'president_us', name:'President of the United States', short:'POTUS', cat:'HQ', pl: 97 },
{ id:'vice_president_us', name:'Vice President of the United States', short:'VPOTUS', cat:'HQ', pl: 96 },
{ id:'secdef', name:'Secretary of Defense', short:'SecDef', cat:'HQ', pl: 95 },
{ id:'secnav', name:'Secretary of the Navy', short:'SecNav', cat:'HQ', pl: 90 },
// ... existing HQ roles ...
{ id:'cnp', name:'Chief of Naval Personnel', short:'CNP', cat:'HQ', pl: 60 },
{ id:'mcpon', name:'Master Chief Petty Officer of the Navy', short:'MCPON', cat:'HQ', pl: 58 },

// Command
{ id:'rear_admiral_l', name:'Rear Admiral (Lower Half)', short:'RDML', cat:'Command', pl: 44 },
{ id:'mcpo', name:'Master Chief Petty Officer', short:'MCPO', cat:'Command', pl: 42 },
{ id:'captain', name:'Captain', short:'CAPT', cat:'Command', pl: 38 },
```

- [ ] **Step 2: Confirm gates still align**

Check constants:

- `PERM.APPROVE_LOGS` remains 42 (MCPO+)
- `PERM.QUOTA_DIV_COMMAND` remains 44 (RDML+)
- `PERM.ADMIN_PANEL` remains 60 (CNP+)
- `PERM.QUOTA_HQ_AUTHORITY` remains 90 (SecNav+)

---

## Task 8: Fix Admin Panel access for Admirals / MCPO+

**Files:**
- Modify: `js/ranks.js`

- [ ] **Step 1: Expand `canAccessAdminPanel`**

Update to:

```js
function canAccessAdminPanel(user) {
  if (!user) return false;
  if (user.permission_level >= PERM.ADMIN_PANEL) return true; // CNP+
  if (user.permission_level >= PERM.APPROVE_LOGS) return true; // MCPO+ reviewers
  return hasPersonnelOfficeStaff(user) && user.permission_level >= PERM.APPROVE_LOGS;
}
```

Note: the personnel office condition becomes redundant with MCPO+ access; keep it if you want to preserve explicit intent, but it is no longer needed.

- [ ] **Step 2: Verify tabs remain restricted**

Manual:

- Login as Admiral (pl ~50) in a non-HQ division.
- Navigate to `/admin.html`.
- Page should load.
- Visible tabs should be those already controlled by `configureAdminTabs()` (Review + My Division if applicable), not full Personnel/Divisions management unless they meet those internal rules.

---

## Task 9: Docs updates (optional but recommended)

**Files:**
- Modify: `USER-GUIDE.md`
- Modify: `DEVELOPER-GUIDE.md`

- [ ] **Step 1: Add “Discord ID” field description**
- [ ] **Step 2: Document new division webhook fields**
  - Option A categories + General
  - Legacy fallback behavior
- [ ] **Step 3: Document QUOTA authority behavior**
  - HQ manages non-HQ; SecNav+ manages HQ

---

## Verification (before calling it done)

- [ ] **Static sanity check**
  - Load `admin.html`, `activity.html`, `quota-command.html` in browser and watch console for errors.
- [ ] **Webhook routing**
  - Configure only General webhook → verify posts still go to Discord.
  - Configure a category webhook (e.g., Duty Pending) + General → verify both receive post (deduped if same URL).
  - Configure only legacy pending/approved → verify still posts (fallback).
- [ ] **Discord ID pings**
  - Set `discordId` on a user; approve their duty log → `<@id>` mention appears in approved message.
  - Approve event log with attendees → mention author + attendees who have Discord IDs.
- [ ] **QUOTA authority**
  - HQ (CNP+) sees all non-HQ divisions in QUOTA Management.
  - HQ division is only manageable by SecNav+.
- [ ] **Admin access**
  - Admiral can load Admin Panel and see Review tab.

---

## Execution handoff

Plan saved to `docs/superpowers/plans/2026-04-14-webhooks-discordid-quota-ranks-admin-access.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh focused worker per task, review between tasks.
2. **Inline Execution** — I execute tasks in this session with checkpoints.

Which approach do you want?

