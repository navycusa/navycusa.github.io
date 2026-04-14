## Overview

This spec covers five related changes to the US Navy CUSA Portal:

- Split Discord webhook configuration by **category + status** (Option A) while also supporting a **General** webhook that receives a copy of all posts for “always-on” recordkeeping.
- On **log approval**, ping relevant personnel using stored **Discord user IDs**.
- Fix QUOTA Management visibility/authority so **HQ can manage non-HQ divisions**, while **HQ division quotas remain SecNav+ only**.
- Correct rank model: **MCPO** vs **MCPON** are distinct; add ranks above **Secretary of the Navy**.
- Fix Admin Panel access: an **Admiral** (and any MCPO+ reviewer) must be able to access the Admin Panel (at least the review functions), not just CNP+.

The portal is a static frontend with Firebase Auth + Firestore, plus optional Cloud Functions. Discord webhooks are posted client-side via `fetch`.

## Goals

- **Discord reliability**: If the website goes down, Discord still provides a “physical” record via the **General** webhook copy.
- **Clear routing**: Separate channels for common workflows (Option A) without losing global visibility.
- **Correct authority model**: HQ staff (CNP+) can manage quotas for all non-HQ divisions; HQ division itself is managed by SecNav+.
- **Correct rank hierarchy**: MCPO is divisional high command; MCPON is an HQ rank below CNP; add ranks above SecNav.
- **Correct access**: Users with log-review authority (MCPO+) can access the Admin Panel to review logs.

## Non-goals

- No schema migration scripts; changes are additive and backward-compatible via fallbacks.
- No redesign of quota math or Firestore collections beyond adding fields.
- No new backend requirement; Discord posting remains client-side.

## Current system touchpoints (reference)

- Webhook posting utilities: `js/discord-webhooks.js`
- Division webhook configuration UI: `js/admin.js` (Division modal) and `admin.html`
- Log approval flow: `js/admin.js` (`reviewLog`)
- Auth gating for Admin Panel: `js/auth.js` uses `canAccessAdminPanel` from `js/ranks.js`
- Quota authority/visibility helpers: `js/ranks.js` (notably `canManageDivisionQuota`)
- QUOTA Management page: `js/quota-command.js`
- Rank definitions + permission thresholds: `js/ranks.js`

## 1) Webhooks: Option A split + General copy

### Categories to split (Option A)

Per division, configure:

- **Duty Logs**: Pending, Approved
- **Event Logs**: Pending, Approved
- **LOA Requests**: Pending, Approved
- **MDQRA Requests**: Pending, Approved

Additionally, configure:

- **General**: receives a copy of every post (regardless of category/status).

### Division Firestore fields (new)

In `divisions/{divisionId}`:

- `webhookUrlGeneral` (string)
- `webhookDutyPending` (string)
- `webhookDutyApproved` (string)
- `webhookEventPending` (string)
- `webhookEventApproved` (string)
- `webhookLoaPending` (string)
- `webhookLoaApproved` (string)
- `webhookMdqraPending` (string)
- `webhookMdqraApproved` (string)

### Backward compatibility (existing/legacy fields)

The existing fields remain supported as fallback:

- `webhookUrlPending`
- `webhookUrlApproved`
- `webhookUrl` (legacy single webhook)

### Routing rules

When posting an embed for a division:

- Determine the **category webhook** URL for the event (e.g., duty+pending, loa+approved).
- Also determine the **General** webhook URL.
- Build a list of target URLs:
  - Include **General** if set.
  - Include the **category webhook** if set.
  - If the category webhook is NOT set, fall back to:
    - pending posts: `webhookUrlPending` then `webhookUrl`
    - approved posts: `webhookUrlApproved` then `webhookUrl`
- **De-duplicate** identical URLs so the same webhook is not posted twice.
- Post the same embed payload to each target URL.

### Admin UI changes (division modal)

In the “Edit Division” modal:

- Add a “Webhooks” section with inputs for:
  - General
  - Duty Pending / Duty Approved
  - Event Pending / Event Approved
  - LOA Pending / LOA Approved
  - MDQRA Pending / MDQRA Approved
- Keep existing legacy fields available (either visible or collapsed under “Legacy (compat)”).

## 2) Discord pings on log approval (requires Discord IDs)

### User Firestore field (new)

In `users/{uid}`:

- `discordId` (string, Discord snowflake id; stored as digits without `<@...>`).

### Admin personnel UI changes

In the Add/Edit Personnel modal:

- Add input: **Discord ID** (optional).
- Validation:
  - Allow blank.
  - If present, must look like a Discord snowflake (digits only; roughly 15–25 digits).

### Who gets pinged when a log is approved

On log approval:

- **Duty logs**: ping the **author**.
- **Event logs**: ping the **author** and any **attendees** referenced by `attendeeUids` (if present).

### How pings are emitted

Discord webhook posts will include a `content` field containing mention strings:

- `<@DISCORD_ID>` for each user that has a `discordId`
- If a user has no `discordId`, they are not mentioned (no placeholder).

Mentions are attached to the **approved** post(s) (category webhook and General copy).

## 3) QUOTA Management authority fixes

### Requirements

- HQ (as staff, i.e. CNP+) can manage **QUOTAs for all divisions except Headquarters**.
- Headquarters division quotas can be managed by **SecNav+**.
- “SecNav+” includes the new ranks above SecNav.

### Authorization rules (target division)

Define `divisionIsHQ` based on `div.isHeadquarters === true` or `div.id === 'hq'`.

If `divisionIsHQ` (target is HQ division):

- Allow only `permission_level >= PERM.QUOTA_HQ_AUTHORITY` (SecNav+) or equivalent rank check.

If NOT HQ (target is non-HQ division):

- Allow RDML+ (`permission_level >= PERM.QUOTA_DIV_COMMAND`) for **own division**
- Allow HQ staff (CNP+) cross-division for **all non-HQ divisions**
- Allow SecNav+ for **all divisions**

This replaces any behavior where HQ could only see HQ, and ensures HQ staff can manage non-HQ quotas as intended.

## 4) Rank model changes

### MCPO vs MCPON

- **MCPO** (Master Chief Petty Officer): divisional high command rank (Command category)
  - Sits **under RDML** and **above Captain**
  - Carries the permission threshold currently associated with MCPO+ workflows (e.g. log approvals), i.e. \(pl = 42\).

- **MCPON** (Master Chief Petty Officer of the Navy): HQ rank (HQ category)
  - Lowest HQ rank, sits **under Chief of Naval Personnel (CNP)**.
  - Permission level set below CNP but above senior enlisted command ranks as needed.

### Add ranks above Secretary of the Navy

Add these ranks above SecNav in ascending authority order:

- Secretary of Defense
- Vice President of the United States
- President of the United States
- Ownership Team
- Chairman
- Administrator

Implementation notes:

- Permission levels (`pl`) must remain strictly ordered so existing `PERM.*` gates continue to work.
- Existing thresholds in `PERM` remain as the source of truth for feature access; ranks above SecNav naturally qualify where checks are `>= PERM.MANAGE_DIVISIONS` / `>= PERM.QUOTA_HQ_AUTHORITY`, etc.

## 5) Admin Panel access fix (Admiral should access)

### Current issue

`requireAuth({ adminPanelAccess: true })` currently permits:

- CNP+ (permission_level >= 60), OR
- certain Personnel Office staff exceptions

This blocks an Admiral (pl 50) from loading `admin.html`, even though Admirals can approve logs and should have access to the Admin Panel (at least review).

### New access rule

Update `canAccessAdminPanel(user)` to allow:

- Full Admin Panel access: `permission_level >= PERM.ADMIN_PANEL` (CNP+), OR
- Reviewer access: `permission_level >= PERM.APPROVE_LOGS` (MCPO+), OR
- Personnel Office staff exception (existing behavior; remains)

### UI behavior

When a reviewer (MCPO+) opens Admin Panel:

- Tabs should be configured so they only see panels they are allowed to use (existing `configureAdminTabs` logic already hides most tabs based on permissions).
- This resolves the “Admiral in NETC with divisional Director rank cannot see admin panel” issue, because their `permission_level` (mapped rank) is sufficient for reviewer access.

## Data compatibility and safety

- All new Firestore fields are optional and additive.
- Webhook routing continues to work with existing divisions using the legacy `webhookUrlPending` / `webhookUrlApproved` / `webhookUrl` fields.
- Discord ID is optional; missing IDs do not break approval posts.

## Rollout / verification checklist

- Configure a division with:
  - General webhook set
  - One category webhook set (e.g., LOA Pending)
  - Legacy pending/approved unset
  - Verify LOA pending posts to both category + general.
- Configure a division with only legacy pending/approved:
  - Verify posts still work (fallback).
- Approve a duty log where the author has `discordId`:
  - Verify the approved post includes `<@id>` mention and embed content is correct.
- Approve an event log with attendees:
  - Verify author + attendees are mentioned if they have `discordId`.
- QUOTA management:
  - HQ user (CNP+) can select and manage any non-HQ division quotas.
  - HQ division quotas only manageable by SecNav+.
- Admin panel:
  - Admiral (pl 50) can access `admin.html` and see Review tab as expected.
