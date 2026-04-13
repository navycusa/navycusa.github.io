# US Navy CUSA Portal — Developer Guide

This document explains how the portal is built, how data flows, and how the main modules interact. It is aimed at developers maintaining or extending the codebase.

---

## 1. High-level architecture

The site is a **static front end** (HTML, CSS, vanilla JavaScript) hosted on **GitHub Pages** (or any static host). There is **no traditional backend server** in the browser path for day-to-day use.

| Layer | Technology | Role |
|--------|------------|------|
| Authentication | Firebase Auth (email/password) | Users sign in; “username” is mapped to a synthetic email. |
| Primary database | Cloud Firestore | Users, divisions, activity logs, quotas, archives, audit trail. |
| File storage (proof images) | Supabase Storage | Public bucket for log proof images; URLs stored on log documents. |
| Optional automation | Firebase Cloud Functions (`functions/`) | Callable functions, Firestore triggers, server-side quota logic when deployed on Blaze. |

Comments in `js/firebase-config.js` state that **quota and reform work on the Spark (free) plan** using client-side Firestore writes; Cloud Functions are **optional** for extra automation.

---

## 2. Repository layout

| Path | Purpose |
|------|---------|
| `index.html` | Login. |
| `dashboard.html` | Main home after login; stats, recent logs, quota summary, reform list. |
| `activity.html` | Submit duty minutes or hosted events; list own submissions. |
| `admin.html` | Personnel, log review, divisions, archive, audit (tabbed). |
| `change-password.html` | Forced password change when `mustChangePassword` is true. |
| `quota-command.html` | QUOTA management for authorized command ranks. |
| `css/main.css` | Global styling. |
| `js/firebase-config.js` | Firebase init; exposes global `auth` and `db`. |
| `js/supabase-config.js` | Supabase client; `uploadProofImage`, `deleteProofImage`. |
| `js/ranks.js` | Rank list, permission constants (`PERM`), division defaults, permission helpers. |
| `js/auth.js` | `requireAuth`, session, header, mobile nav, alerts, formatting, `auditLog`. |
| `js/login.js`, `js/dashboard.js`, `js/activity.js`, `js/admin.js`, etc. | Page controllers (IIFEs). |
| `js/discord-webhooks.js` | `fetch`-based Discord embed posts from division webhook URLs. |
| `js/quota-logic.js` | Pure quota math (`QuotaLogic` on `window`). |
| `js/quota-firestore.js` | Firestore I/O for quotas (`QuotaFirestore` on `window`). |
| `js/quota-command.js` | QUOTA Management page logic. |
| `firestore.rules` | Security rules; must stay aligned with `js/ranks.js` thresholds. |
| `firestore.indexes.json` | Composite indexes for queries. |
| `firebase.json` | Firebase project config (rules, functions, emulators). |
| `functions/index.js` | Optional Cloud Functions (create user, triggers, quota helpers, etc.). |
| `functions/quotaLogic.js` | Server-side mirror of client quota math. |
| `schema/quota_reference.sql` | **Documentation only** — relational sketch of quota concepts; production is Firestore. |

Background imagery is configured via CSS only:

- Default is `assets/navybackground.jpg` using `--app-bg-image` in `css/main.css`
- Override per page by setting `:root { --app-bg-image: url('/assets/your-image.jpg'); }` in a page `<style>` block (keep it subtle; the CSS applies blur + overlay)

---

## 3. Authentication model

### 3.1 Username → email

Users type a **portal username**. The client converts it to a Firebase Auth email:

- Domain: `@navycusa.mil` (constant `EMAIL_DOMAIN` in `js/auth.js`).
- Normalization: trim, lowercase, remove internal spaces.

So login is `signInWithEmailAndPassword(usernameToEmail(username), password)`.

### 3.2 User profile document

After Auth succeeds, the app loads `users/{uid}` in Firestore. If missing, the user is signed out and sent to login.

Important fields (typical):

- `username`, `email`, `rankId`, `rankName`, `permission_level`, `divisionId`, `divisionName`
- Optional divisional rank: `divRankId`, `divRankName`, `mappedRankId` (maps division rank to main rank for permissions)
- `mustChangePassword`, `isActive`
- Optional `personnelOffices`: e.g. `ocnp`, `ocno` for staff roles

### 3.3 `requireAuth(options)` (`js/auth.js`)

Resolves when the user is valid; otherwise **redirects**:

| Option | Behavior |
|--------|----------|
| `allowChangePassword: true` | Allows access to change-password page even if `mustChangePassword` is true. |
| `minPermission: N` | Redirects to dashboard if `permission_level < N`. |
| `adminPanelAccess: true` | Uses `canAccessAdminPanel()` — CNP+ **or** OCNP/OCNO staff with MCPO+ level. |

Sets global `_currentUser` used by `currentUser()`, `auditLog()`, etc.

### 3.4 Creating Auth users without Cloud Functions

`js/admin.js` **new user** flow calls the Identity Toolkit REST API `signUp` with `firebaseConfig.apiKey` to create the Firebase Auth user, then writes `users/{uid}` in Firestore. Initial password is **`[Username]1234`**, with `mustChangePassword: true`.

If you deploy `createUser` as a callable function instead, that path is an alternative (see `functions/index.js`).

---

## 4. Permission system (`js/ranks.js`)

Ranks are a static array with numeric **`pl` (permission level)**. Higher `pl` means more authority.

Key `PERM` thresholds (must match `firestore.rules`):

| Constant | Level | Typical meaning |
|----------|-------|------------------|
| `APPROVE_LOGS` | 42 | MCPO+ — review logs for own division; HQ sees all. |
| `MANAGE_DIV_EVENTS` | 42 | Configure event types (own division / modal rules). |
| `QUOTA_DIV_COMMAND` | 44 | RDML+ style — division quota management (non-HQ rules apply). |
| `ARCHIVE_OWN_DIVISION` | 50 | Admiral+ — archive approved logs for own division. |
| `ADMIN_PANEL` / `CREATE_USERS` | 60 | CNP+ — full admin panel, cross-division reads, HQ stats. |
| `QUOTA_READ_CROSS_DIV_NON_HQ_MIN` | 60 | CNP through Under SecNav — cross-division quota **request** visibility (non-HQ). |
| `MANAGE_DIV_RANKS` | 70 | CNO+ — division rank tables in division modal (with edit rights). |
| `ARCHIVE_LOGS` | 85 | UnderSecNav+ — archive any/all divisions. |
| `MANAGE_DIVISIONS` | 90 | SecNav+ — add/remove divisions, full division doc control. |
| `QUOTA_HQ_AUTHORITY` | 90 | HQ division quota + global reform run (with rank exceptions). |

Helpers include `canAccessAdminPanel`, `canManageDivisionQuota`, `canEditDivisionDocument`, `divisionDocumentIsHeadquarters`, etc. **Firestore rules duplicate the same ideas** in `firestore.rules` functions like `canManageQuotaForDivision`, `isHQ()`, `pl()`.

---

## 5. Firestore data model (collections)

### 5.1 `users/{uid}`

Profile + authorization. Read/write rules enforce hierarchy (cannot assign rank ≥ own, OCNP/OCNO limited to NDVL, etc.).

### 5.2 `divisions/{divisionId}`

- `name`, `short`, optional `isHeadquarters` (HQ division — special quota rules).
- `webhookUrl`, `webhookUrlPending`, `webhookUrlApproved` — Discord integration.
- `ranks[]` — division-specific rank objects (id, name, shortName, tier, mappedRankId, order).
- `eventTypes[]` — optional override list for Activity Log event dropdown; empty = global `EVENT_TYPES` from `ranks.js`.

Default division IDs include `hq`, `ndvl`, etc. (`DEFAULT_DIVISIONS`).

### 5.3 `logs/{logId}`

Activity submissions:

- `type`: `duty` | `event`
- `status`: `pending` | `approved` | `rejected`
- `authorUid`, `authorUsername`, rank fields, `divisionId`, `divisionName`
- Duty: `durationMinutes`, `date`, `notes`
- Event: `eventType`, `customEventName`, `participants`, `description`, `attendeeUids` (for quota)
- Proof: `proofImageUrl`, `discordLink`; after approval with image, admin may set `proofImageUrl: null`, `proofOnDiscord: true`
- Review: `reviewedBy`, `reviewerUsername`, `reviewedAt`, `reviewNotes`
- `createdAt` server timestamp

### 5.4 `archives/{archiveId}`

Bulk snapshots: `logs` array (copies of archived log payloads), `divisionId` or null for all, metadata. Original `logs` documents are **deleted** in batches (client-side archive in `admin.js`).

### 5.5 `audit_logs/{id}`

Append-only style: `action`, `actorUid`, `actorUsername`, `actorRank`, `targetType`, `targetId`, `details`, `timestamp`. Client writes via `auditLog()` in `auth.js`; optional Functions also write.

### 5.6 Quota-related

- **`quota_policies`**: per division + `rankId`, `periodKind` (`weekly` | `monthly`), `effectiveFrom`/`effectiveTo`, `rules` (JSON array).
- **`event_definitions`**: maps `key`/`label` to `matchEventType` or `matchCustomName` for matching approved events to quota rules.
- **`quota_requests`**: MDQRA / LOA requests; `status` pending → approved/rejected.
- **`quota_attendance`**: rows synced when logs are approved — duty minutes and event “credits” per user; used by `QuotaLogic.computeNetQuota`.
- **`quota_modifiers`**: rules allow read for eligible users; **client cannot write** — intended for server/admin tooling.
- **`reform_snapshots/{id}`** + subcollection **`entries`**: snapshots of who is “behind” quota for a division/period.

---

## 6. Page bootstraps (script order)

Typical authenticated page:

1. Firebase App + Auth + Firestore (CDN compat builds).
2. `firebase-config.js` → `auth`, `db`.
3. `ranks.js` — ranks and permission helpers.
4. `auth.js` — guards and UI helpers.
5. Optional: `supabase` UMD + `supabase-config.js` (Activity, Admin for image delete).
6. Optional: `discord-webhooks.js`, `quota-logic.js`, `quota-firestore.js`.
7. Page script (`dashboard.js`, `admin.js`, …).

Each page script usually starts with `requireAuth(...)` then wires DOM and Firestore listeners/queries.

---

## 7. Activity log pipeline (`js/activity.js`)

1. **Division context**: CNP+ (`permission_level >= 60`) see `division-selector`; others use profile `divisionId`.
2. **Host Event tab**: Hidden if division is missing or `ndvl` (Navy Divisionless).
3. **Event types**: Loaded from `divisions/{id}.eventTypes` if non-empty; always ensures **Custom Event** is available when custom list is used.
4. **Proof**: `collectProof` requires image **or** Discord URL; images go through `uploadProofImage` (Supabase), max 5 MB, JPEG/PNG/GIF/WebP.
5. **Attendees** (events): `QuotaFirestore.resolveEventAttendees` resolves usernames to UIDs; all must exist in `users` and match **same division** as the log.
6. **Write**: `logs.add({...})` with `status: 'pending'`, `createdAt: serverTimestamp()`.
7. **Side effects**: `auditLog('log.create', ...)`, Discord pending webhook via `DiscordWebhooks.postEmbed`.

---

## 8. Log review and quota sync (`js/admin.js`)

`reviewLog(logId, decision)`:

1. Optional rejection note.
2. Updates log with status, reviewer fields.
3. If **approved**: posts approved Discord embed; if proof was image URL, **`deleteProofImage`** then clears `proofImageUrl` and sets `proofOnDiscord: true`.
4. If **approved** and `QuotaFirestore` exists: **`syncFromApprovedLog(logId, mergedData)`** — rewrites `quota_attendance` rows for that log (duty = one row; event = host + each attendee).
5. If **rejected**: pending-channel Discord embed with reason.
6. `auditLog('log.approved' | 'log.rejected', ...)`.

Firestore rules allow MCPO+ to patch `attendeeUids` / `eventDefinitionId` on **pending** event logs for quota corrections (separate update path from approve/reject).

---

## 9. Quota subsystem

### 9.1 Logic (`js/quota-logic.js` / `functions/quotaLogic.js`)

Exported as `QuotaLogic`:

- **`getPeriodBounds(periodKind, refDate)`** — ISO week (Mon–Sun) or calendar month in UTC.
- **`selectPolicy`** — picks best matching policy for division + rank + period overlap.
- **`computeNetQuota(attendances, policy, mdqraPercent, loaExempt)`** — evaluates `group`, `mandatory`, and `duty_minutes` rules; applies MDQRA scaling to required counts/minutes; LOA exempt short-circuits to 100% complete.

### 9.2 Firestore client (`js/quota-firestore.js`)

`QuotaFirestore` methods include:

- `fetchNetStatus(userData, uid)` — load policies, period bounds, approved relief (requests + modifiers), attendance query, then compute net status.
- `submitQuotaRequest`, `decideQuotaRequest` — MDQRA/LOA workflow + Discord notifications.
- `saveQuotaPolicy`, `saveEventDefinition`, `deleteEventDefinition`
- `listReformSnapshot`, `runReformForDivision`, `runReformAllDivisions`
- `listPendingQuotaRequestsForDivisions` — **per-division queries** so rules can permit CNP-tier users without leaking HQ pending docs.

### 9.3 Dashboard quota UI (`js/dashboard.js`)

Shown if user has `divisionId` and not `ndvl`: loads `fetchNetStatus`, renders summary, progress bar, rule list, MDQRA/LOA submit buttons, reform table via `listReformSnapshot`.

### 9.4 QUOTA Management page (`js/quota-command.js`)

- Gate: `requireAuth({ minPermission: PERM.QUOTA_DIV_COMMAND })` then **additional** filter: user must manage **at least one** division per `canManageDivisionQuota` (HQ vs SecNav vs RDML own division, etc.).
- **Global pending table** (CNP–Under SecNav): all non-HQ divisions’ pending requests; approve/reject only if `canManageDivisionQuota` for that row’s division.
- Tabs: Requests, Event definitions, Quota policy (rule builder; saves rules array), Reform list (compute division / SecNav+ all divisions).

---

## 10. Discord webhooks (`js/discord-webhooks.js`)

Reads division document, chooses `webhookUrlPending` or `webhookUrlApproved`, falling back to legacy `webhookUrl`. Posts JSON `{ embeds: [...] }` via `fetch`. Failures are logged but non-fatal.

Embed builders cover: pending/approved/rejected logs, quota request pending/decided, and admin uses a custom embed for **Account Creation**.

Quota request naming is intentional and should stay user-facing:

- **LOA Request** (`requestType: 'LOA'`)
- **Quota Reduction Request** (`requestType: 'MDQRA'`)

Embed footers include the attribution text: **created by pPayday**.

---

## 11. Division statistics (`js/dashboard.js`)

For a selected division:

- **Live** approved logs: query `logs` where `divisionId` + `status == approved`.
- **Archived**: `archives` where `divisionId` matches; flatten `logs` arrays from each archive doc.
- **Weekly**: only **live** approved (archived excluded from weekly rollups by design).
- **Monthly / all-time**: live + archived combined.
- Aggregates duty minutes and event counts by comparing log `date` to rolling windows.

HQ users (`isHQPersonnel`) get a division dropdown; others use their own division unless NDVL/unassigned (card shows message).

---

## 12. Security rules (`firestore.rules`) — design notes

- **`pl()`** reads permission level from own user doc (with int coercion for string/number).
- **Logs**: create allows self as author, pending only; attendee list max 40; update splits HQ vs division reviewer vs attendee patch.
- **Quota**: `canManageQuotaForDivision` mirrors JS; HQ division restricted to SecNav tier / high PL.
- **Archives**: create allowed for UnderSecNav+ or Admiral+ own division; reads for CNP+ or same-division members (for stats).
- **Default deny**: `match /{document=**}` denies unknown paths.

After changing rules or queries, deploy rules and ensure **`firestore.indexes.json`** is deployed if new composite queries are added.

---

## 13. Optional Cloud Functions (`functions/index.js`)

Includes (non-exhaustive; read file for full list):

- **`createUser`** — server-side user creation with validation.
- **`deleteUserPermanently`** — permanently deletes a Firebase Auth user and `users/{uid}` profile (admin-only).
- **Firestore triggers** — e.g. `onLogCreated` for audit, possible quota automation.
- Quota-related callables/triggers may sync attendance or modifiers when Functions are deployed.

Client code paths are written to work **without** these triggers for Spark hosting.

---

## 14. Local development

- `firebase-config.js` comments: add `localhost` to Firebase Auth authorized domains.
- Optional emulator lines (commented): `auth.useEmulator`, `db.useEmulator`.
- `firebase.json` defines emulator ports for auth, Firestore, functions, UI.

---

## 15. Alignment checklist for changes

1. If you change a permission number in `js/ranks.js`, update **`firestore.rules`** and any UI `data-min-perm` attributes in HTML.
2. If you add Firestore queries with multiple `where` + `orderBy`, add **`firestore.indexes.json`** entries and deploy indexes.
3. If quota rule shapes change, update **`quota-logic.js`** and **`functions/quotaLogic.js`** together.
4. Keep **synthetic email domain** consistent across Auth user creation and `usernameToEmail`.

---

This guide reflects the structure of the repository as a static Firebase + Supabase application with optional Cloud Functions. For relational documentation of quota entities only, see `schema/quota_reference.sql`.
