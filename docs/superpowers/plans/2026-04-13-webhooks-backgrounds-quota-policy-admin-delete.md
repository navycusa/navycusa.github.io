# Webhooks, Backgrounds, Quota Policy UX, and Admin Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix webhook titles/labels, add subtle configurable Navy backgrounds, replace QUOTA policy JSON editing with a friendly rule builder, add permanent account deletion (Firebase Auth + Firestore) plus an explicit Activate control, and update both guides to match.

**Architecture:** Keep Firestore document shapes and quota math unchanged. Improve presentation by centralizing webhook title/description mapping and introducing a client-side quota rule builder that still saves the existing JSON rule array. Implement permanent deletion via Cloud Functions (Admin SDK) and call it from the Admin Panel.

**Tech Stack:** Static HTML/CSS/vanilla JS, Firebase Auth + Firestore (client compat SDK), optional Firebase Cloud Functions (Node 18) for privileged actions, Discord webhooks via `fetch`.

---

## File map (what changes where)

**Webhook naming + “created by pPayday”:**
- Modify: `js/discord-webhooks.js` (quota request embeds titles/descriptions; embed footer attribution)
- Modify: `js/admin.js` (account creation embed to use shared naming/attribution)

**Permanent delete + explicit Activate control (Admin Panel):**
- Modify: `admin.html` (add Delete Permanently button + confirm UI; load Functions SDK)
- Modify: `js/admin.js` (wire Delete Permanently action; keep `isActive` toggle; expose explicit Activate/Deactivate button behavior)
- Modify: `js/firebase-config.js` (export/init `functions` handle when SDK is present)
- Modify: `functions/index.js` (new callable: `deleteUserPermanently`)
- Modify (docs): `DEVELOPER-GUIDE.md`, `USER-GUIDE.md`

**Background images (professional, subtle blur):**
- Modify: `css/main.css` (global background layer using `assets/navybackground.jpg` + overlay + slight blur; config via CSS var)
- Modify: `index.html`, `dashboard.html`, `admin.html`, `quota-command.html`, `activity.html`, `change-password.html` (optional: set per-page background var if desired; otherwise rely on global default)
- Modify (docs): `USER-GUIDE.md`, `DEVELOPER-GUIDE.md`

**QUOTA policy UX (rule builder instead of JSON):**
- Modify: `quota-command.html` (replace “Rules (JSON array)” textarea with builder UI; keep hidden textarea for backwards-compatible storage)
- Modify: `js/quota-command.js` (build/validate rules from form; render existing policies as readable sentences; still save same `rules[]` shape)
- Modify (optional): `js/quota-logic.js` (only if needed for “pretty printing”; avoid touching quota math)
- Modify (docs): `USER-GUIDE.md`, `DEVELOPER-GUIDE.md`

---

## Task 1: Webhook titles/info are correct for each webhook type

**Files:**
- Modify: `js/discord-webhooks.js`
- Modify: `js/admin.js`

- [ ] **Step 1: Centralize quota request naming**
  - In `js/discord-webhooks.js`, add a small helper:
    - `quotaRequestDisplay(reqType)` returning `{ title, descriptionLabel }` for:
      - `LOA` → title “📥 LOA Request — pending approval”
      - `MDQRA` → title “📥 Quota Reduction Request — pending approval”
    - Decided embeds similarly:
      - approved/rejected LOA request uses “LOA Request”
      - approved/rejected MDQRA uses “Quota Reduction Request”

- [ ] **Step 2: Fix quota request embed builders**
  - Update `buildQuotaRequestPendingEmbed` to:
    - Use the correct title per request type
    - Remove generic “Quota request — …” wording
    - Ensure `fields` still include requester/division/type and the right detail fields
  - Update `buildQuotaRequestDecidedEmbed` to match.

- [ ] **Step 3: Ensure Account Creation embed is clearly “Account Creation”**
  - In `js/admin.js` user-create path, change the embed title to “👤 Account Creation” and ensure fields include:
    - Username, rank, division, created by (existing), and uid/email if available

- [ ] **Step 4: Add “created by pPayday” attribution in webhook footers**
  - In `js/discord-webhooks.js` default footer: set text to `US Navy CUSA Portal • created by pPayday`
  - Ensure any embeds that override footer also use the same footer text.

- [ ] **Step 5: Quick smoke test checklist**
  - Trigger locally by reading code paths:
    - New user embed in admin create
    - Submit LOA and MDQRA requests (dashboard → quota request) should create pending embeds with correct titles
    - Approve/reject should create decided embeds with correct titles

---

## Task 2: Add permanent delete + explicit Activate control in Admin Panel

**Files:**
- Modify: `admin.html`
- Modify: `js/admin.js`
- Modify: `js/firebase-config.js`
- Modify: `functions/index.js`

- [ ] **Step 1: Add Cloud Functions SDK to `admin.html`**
  - Add `<script src="https://www.gstatic.com/firebasejs/9.23.0/firebase-functions-compat.js"></script>` after Firestore.

- [ ] **Step 2: Initialize functions handle**
  - In `js/firebase-config.js`, add:
    - `const functions = firebase.functions ? firebase.functions() : null;`
    - (keep existing exports `auth`, `db` globals)

- [ ] **Step 3: Add callable function `deleteUserPermanently`**
  - In `functions/index.js`, implement `exports.deleteUserPermanently = functions.https.onCall(...)`:
    - Validate caller via `getCallerDoc`
    - Require `caller.permission_level >= PERM_ADMIN_PANEL`
    - Accept `{ uid }` (target user UID)
    - Block self-delete (if `uid === caller.uid`)
    - Load target `users/{uid}`; if missing, still attempt Auth delete
    - Enforce hierarchy: caller must outrank target permission level (match client rule: `caller.permission_level > target.permission_level`)
    - Delete in order:
      - `auth.deleteUser(uid)`
      - `db.collection('users').doc(uid).delete()` (if exists)
    - Write audit entry `user.delete_permanent` with details
    - Return `{ ok: true }`

- [ ] **Step 4: Add “Delete permanently” UI control in user modal**
  - In `admin.html` user modal footer area:
    - Add a danger button visible only when editing an existing user:
      - “Remove account permanently”
    - Include a strong confirm prompt explaining: removes Auth account + Firestore profile; cannot be undone.

- [ ] **Step 5: Wire delete button in `js/admin.js`**
  - In `openUserModal(userId)` edit path:
    - Show the delete button and attach click handler:
      - Confirm twice (typed confirmation with username or “DELETE”)
      - Call callable: `firebase.functions().httpsCallable('deleteUserPermanently')({ uid: userId })`
      - On success: close modal, reload users, show success alert
  - If Functions SDK is not present, show a clear error: “Permanent delete requires deployed Cloud Functions.”

- [ ] **Step 6: Make Activate behavior explicit**
  - Keep the existing `um-active` checkbox (stored to Firestore).
  - Add a small “Activate / Deactivate” button beside it that toggles the checkbox for clarity (optional) while keeping storage identical.
  - Ensure login gating respects `isActive === false` (verify in `js/auth.js` / login flow; update if missing).

---

## Task 3: Background images configuration (subtle, professional, blurred)

**Files:**
- Modify: `css/main.css`
- Modify (optional): main HTML pages to override var
- Modify docs

- [ ] **Step 1: Add global background layer**
  - In `css/main.css`:
    - Define `--app-bg-image: url('/assets/navybackground.jpg')` in `:root`
    - Add `body::before` fixed full-screen background:
      - `background-image: var(--app-bg-image)`
      - `background-size: cover; background-position: center;`
      - `filter: blur(6px) saturate(0.9); opacity: 0.18;`
      - `pointer-events: none; z-index: -2;`
    - Add `body::after` overlay gradient for readability (z-index -1)

- [ ] **Step 2: Document how to switch backgrounds**
  - In docs: “Set `--app-bg-image` in a page `<style>` block or in future config JS.”

---

## Task 4: QUOTA policy becomes user-friendly (rule builder)

**Files:**
- Modify: `quota-command.html`
- Modify: `js/quota-command.js`
- Modify docs

- [ ] **Step 1: Replace JSON textarea with builder UI**
  - In `quota-command.html` policy tab:
    - Add rule list display (cards)
    - Add “Add rule” controls:
      - Rule type: `group`, `mandatory`, `duty_minutes`
      - Common: label/id (auto-generate id)
      - Group: required count + list of match items (event type / event definition key / custom name)
      - Mandatory: list of required items with minCount
      - Duty minutes: requiredMinutes
    - Keep a hidden `textarea#qc-pol-rules` for storage/compat (not user-edited)

- [ ] **Step 2: Implement builder state in `js/quota-command.js`**
  - Maintain `policyDraftRules = []`
  - “Add rule” pushes a normalized rule object matching existing schema
  - Provide edit/remove per rule
  - On save:
    - Validate shapes and required numeric fields
    - Serialize to hidden textarea for debugging
    - Call `QF.saveQuotaPolicy` with `rules: policyDraftRules`

- [ ] **Step 3: Render rules as readable sentences**
  - Add helper `formatQuotaRule(rule, defs)` returning short strings, e.g.:
    - “Complete 2 from: Training Exercise, Patrol”
    - “Mandatory: Inspection ×3”
    - “Duty minutes: 120 minutes”
  - Use in:
    - Quota policy tab preview
    - Policies table (show first 1–2 rules + “+N more”)
    - Dashboard `quota-rules` list (if it currently renders raw JSON-ish lines)

- [ ] **Step 4: Preserve backward compatibility**
  - When loading existing policies, hydrate builder state from `policy.rules`.
  - If encountering unknown rule shape, show it read-only with a warning and still allow saving without modification only if unchanged (or block save with message).

---

## Task 5: Docs updates

**Files:**
- Modify: `USER-GUIDE.md`
- Modify: `DEVELOPER-GUIDE.md`

- [ ] **Step 1: Update QUOTA policy section**
  - Replace “Rules: JSON array” instructions with rule builder instructions + examples.

- [ ] **Step 2: Update webhook wording**
  - Document correct webhook types: Account Creation, LOA Request, Quota Reduction Request, Log pending/approved/rejected.

- [ ] **Step 3: Update personnel management**
  - Explain:
    - **Active** toggle prevents login (stored in Firestore)
    - **Remove account permanently** removes Auth + Firestore and is irreversible (requires Functions deployed)

- [ ] **Step 4: Document backgrounds**
  - Mention `assets/navybackground.jpg` default and how to configure additional backgrounds.

---

## Verification (before calling it done)

- [ ] Run a quick static check: search for “Quota request —” and confirm it’s replaced with LOA/Quota Reduction wording.
- [ ] Ensure Admin page loads without JS errors after adding Functions SDK.
- [ ] Confirm Cloud Function deploy list includes `deleteUserPermanently`.
- [ ] Manually verify QUOTA policy save works using builder (creates same `rules[]` array shape in Firestore).

