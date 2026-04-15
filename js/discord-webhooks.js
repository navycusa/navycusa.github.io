// ============================================================
// Client-side Discord webhooks (Spark / no Cloud Functions)
// Division fields:
// - New: webhookUrlGeneral, webhookDutyPending/Approved, webhookEventPending/Approved,
//        webhookLoaPending/Approved, webhookMdqraPending/Approved
// - Legacy: webhookUrlPending, webhookUrlApproved, webhookUrl
// ============================================================

(function (global) {
  'use strict';

  const DEFAULT_FOOTER_TEXT = 'US Navy CUSA Portal • created by pPayday';
  const DISCORD_ID_RE = /^\d{15,25}$/;
  const _discordIdCacheByUid = new Map();

  const WEBHOOK_KEYS = {
    general: 'webhookUrlGeneral',
    duty:   { pending: 'webhookDutyPending',   approved: 'webhookDutyApproved' },
    event:  { pending: 'webhookEventPending',  approved: 'webhookEventApproved' },
    loa:    { pending: 'webhookLoaPending',    approved: 'webhookLoaApproved' },
    mdqra:  { pending: 'webhookMdqraPending',  approved: 'webhookMdqraApproved' },
  };

  function defaultFooter() {
    return { text: DEFAULT_FOOTER_TEXT };
  }

  function cleanUrl(v) {
    const s = String(v || '').trim();
    return s ? s : null;
  }

  function legacyFallbackUrl(divData, status) {
    if (!divData) return null;
    const legacySingle = cleanUrl(divData.webhookUrl);
    if (status === 'approved') return cleanUrl(divData.webhookUrlApproved) || legacySingle;
    return cleanUrl(divData.webhookUrlPending) || legacySingle;
  }

  /**
   * Resolve webhook targets for an event: include General (archive) + category.
   * If category isn't set, fall back to legacy pending/approved/single.
   * @param {object} divData
   * @param {'duty'|'event'|'loa'|'mdqra'|'general'} category
   * @param {'pending'|'approved'} status
   * @returns {string[]} urls (deduped, ordered)
   */
  function webhookTargets(divData, category, status) {
    if (!divData) return [];
    const urls = [];

    const catKeys = WEBHOOK_KEYS[category] || null;
    const catKey = catKeys && typeof catKeys === 'object' ? catKeys[status] : null;
    const catUrl = catKey ? cleanUrl(divData[catKey]) : null;

    // "General" should be a catch-all ONLY for categories that do not have a specific webhook configured.
    // For duty/event/LOA/MDQRA: if a specific webhook exists, do NOT also send to General.
    const general = cleanUrl(divData[WEBHOOK_KEYS.general]);
    const isSpecificCategory = category === 'duty' || category === 'event' || category === 'loa' || category === 'mdqra';
    const includeGeneral = category === 'general' || !isSpecificCategory || !catUrl;
    if (general && includeGeneral) urls.push(general);

    if (catUrl) {
      urls.push(catUrl);
    } else {
      const legacy = legacyFallbackUrl(divData, status);
      if (legacy) urls.push(legacy);
    }

    return [...new Set(urls)];
  }

  function divisionDiscordUrls(divData) {
    if (!divData) return { pending: null, approved: null };
    const legacy = divData.webhookUrl || null;
    return {
      pending:  divData.webhookUrlPending || legacy || null,
      approved: divData.webhookUrlApproved || legacy || null,
    };
  }

  function quotaRequestDisplay(requestType) {
    const t = String(requestType || '').toUpperCase();
    if (t === 'LOA') {
      return {
        kindLabel: 'LOA Request',
        pendingTitle: '📥 LOA Request — pending approval',
        detailLabel: 'LOA window',
      };
    }
    if (t === 'MDQRA') {
      return {
        kindLabel: 'Quota Reduction Request',
        pendingTitle: '📥 Quota Reduction Request — pending approval',
        detailLabel: 'Reduction',
      };
    }
    return {
      kindLabel: 'Quota Request',
      pendingTitle: '📥 Quota Request — pending approval',
      detailLabel: 'Details',
    };
  }

  function formatLogDate(ts) {
    if (!ts) return '—';
    const d = typeof ts.toDate === 'function' ? ts.toDate() : new Date((ts.seconds || 0) * 1000);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  async function fetchDiscordIdForUid(firestoreDb, uid) {
    const k = String(uid || '').trim();
    if (!k) return null;
    if (_discordIdCacheByUid.has(k)) return _discordIdCacheByUid.get(k);
    try {
      const snap = await firestoreDb.collection('users').doc(k).get();
      if (!snap.exists) {
        _discordIdCacheByUid.set(k, null);
        return null;
      }
      const raw = String((snap.data() || {}).discordId || '').trim();
      const cleaned = raw ? raw.replace(/[<@!>]/g, '').trim() : '';
      const out = DISCORD_ID_RE.test(cleaned) ? cleaned : null;
      _discordIdCacheByUid.set(k, out);
      return out;
    } catch (_) {
      _discordIdCacheByUid.set(k, null);
      return null;
    }
  }

  function renderMention(discordId, fallbackLabel) {
    if (discordId && DISCORD_ID_RE.test(discordId)) return `<@${discordId}>`;
    const fb = String(fallbackLabel || '').trim();
    return fb || '—';
  }

  async function buildRequesterApproverContent(firestoreDb, mentions) {
    const m = mentions || {};
    const requesterUid = m.requesterUid || null;
    const approverUid = m.approverUid || null;

    const [requesterDiscordId, approverDiscordId] = await Promise.all([
      requesterUid ? fetchDiscordIdForUid(firestoreDb, requesterUid) : Promise.resolve(null),
      approverUid ? fetchDiscordIdForUid(firestoreDb, approverUid) : Promise.resolve(null),
    ]);

    const requesterText = renderMention(requesterDiscordId, m.requesterUsername || m.requesterLabel);
    const approverPending = m.approverPending === true || m.status === 'pending';
    const approverText = approverPending
      ? 'Pending approval'
      : renderMention(approverDiscordId, m.approverUsername || m.approverLabel);

    const content = `Requester: ${requesterText} | Approver: ${approverText}`;
    const allowedUserIds = [requesterDiscordId, approverDiscordId].filter((x) => DISCORD_ID_RE.test(String(x || '')));
    return { content, allowedUserIds: [...new Set(allowedUserIds)] };
  }

  function buildLogPendingEmbed(log) {
    const isEvent = log.type === 'event';
    const eventName = isEvent
      ? (log.eventType === 'Custom Event' ? log.customEventName : log.eventType)
      : null;
    const embed = {
      title:       isEvent ? `📋 Event Log — ${eventName || 'Event'}` : '⏱️ Duty Log Submitted',
      color:       isEvent ? 0x9b59b6 : 0x3498db,
      description: `A new ${log.type} log has been submitted and is **pending approval**.`,
      fields:      [
        { name: 'Submitted by', value: String(log.authorUsername || '—'), inline: true },
        { name: 'Approved by',  value: 'Pending approval', inline: true },
        { name: 'Rank',         value: String(log.authorRankName || '—'), inline: true },
        { name: 'Division',     value: String(log.divisionName  || '—'), inline: true },
      ],
      footer: defaultFooter(),
      timestamp: new Date().toISOString(),
    };
    if (isEvent) {
      embed.fields.push({ name: 'Event Type',   value: String(eventName || '—'),         inline: true });
      embed.fields.push({ name: 'Participants', value: String(log.participants || '—'), inline: true });
    } else {
      embed.fields.push({ name: 'Duration', value: `${log.durationMinutes || '—'} minutes`, inline: true });
    }
    if (log.discordLink) {
      embed.fields.push({ name: 'Proof', value: `[View Message](${log.discordLink})`, inline: false });
    }
    return embed;
  }

  function buildLogApprovedEmbed(log) {
    const isDuty = log.type === 'duty';
    const detail = isDuty
      ? `${log.durationMinutes} minutes`
      : (log.eventType === 'Custom Event' ? log.customEventName : log.eventType);
    const dateStr = formatLogDate(log.date);
    const embed = {
      title:  isDuty ? '✅ Duty Log Approved' : '✅ Event Log Approved',
      color:  0x2ecc71,
      fields: [
        { name: 'Submitted by', value: String(log.authorUsername || '—'), inline: true },
        { name: 'Approved by',  value: String(log.reviewerUsername || '—'), inline: true },
        { name: 'Division',     value: String(log.divisionName  || '—'), inline: true },
        { name: 'Details', value: isDuty
          ? `${log.durationMinutes || '—'} min duty on ${dateStr}`
          : `${detail || '—'} on ${dateStr}`,
        inline: false },
      ],
      footer:    defaultFooter(),
      timestamp: new Date().toISOString(),
    };
    if (log.discordLink) {
      embed.fields.push({ name: 'Discord Proof', value: `[View](${log.discordLink})`, inline: false });
    }
    const proofUrl = log.proofImageUrl || null;
    if (proofUrl) embed.image = { url: proofUrl };
    return embed;
  }

  function buildLogRejectedEmbed(log, reviewNotes) {
    const isDuty = log.type === 'duty';
    const embed = {
      title:  isDuty ? '❌ Duty Log Rejected' : '❌ Event Log Rejected',
      color:  0xe74c3c,
      description: 'A pending log was **rejected**.',
      fields: [
        { name: 'Submitted by', value: String(log.authorUsername || '—'), inline: true },
        { name: 'Approved by',  value: '—', inline: true },
        { name: 'Rejected by',  value: String(log.reviewerUsername || '—'), inline: true },
        { name: 'Division',     value: String(log.divisionName  || '—'), inline: true },
      ],
      footer:    defaultFooter(),
      timestamp: new Date().toISOString(),
    };
    if (reviewNotes) embed.fields.push({ name: 'Reason', value: String(reviewNotes).slice(0, 1024), inline: false });
    return embed;
  }

  function buildQuotaRequestPendingEmbed(req, divisionName) {
    const div = divisionName || req.divisionId || '—';
    const disp = quotaRequestDisplay(req.requestType);
    const fields = [
      { name: 'Submitted by', value: String(req.requesterUsername || '—'), inline: true },
      { name: 'Approved by',  value: 'Pending approval', inline: true },
      { name: 'Division',     value: String(div),                           inline: true },
      { name: 'Type',         value: disp.kindLabel,                        inline: true },
    ];
    if (req.requestType === 'MDQRA') {
      fields.push({ name: disp.detailLabel, value: `${req.reductionPercent}%`, inline: true });
    }
    if (req.requestType === 'LOA') {
      fields.push({ name: disp.detailLabel, value: `${req.loaStart || '—'} → ${req.loaEnd || '—'}`, inline: false });
    }
    if (req.reason) fields.push({ name: 'Reason', value: String(req.reason).slice(0, 1024), inline: false });
    return {
      title:       disp.pendingTitle,
      color:       0xf39c12,
      description: `A new **${disp.kindLabel}** was submitted and is **pending approval**.`,
      fields,
      footer:      defaultFooter(),
      timestamp:   new Date().toISOString(),
    };
  }

  function buildQuotaRequestDecidedEmbed(req, divisionName, approved, decisionNotes, decider) {
    const div = divisionName || req.divisionId || '—';
    const ok = approved;
    const disp = quotaRequestDisplay(req.requestType);
    const fields = [
      { name: 'Submitted by', value: String(req.requesterUsername || '—'), inline: true },
      { name: 'Approved by',  value: ok ? String(decider || '—') : '—', inline: true },
      { name: 'Division',     value: String(div),                           inline: true },
      { name: 'Type',         value: disp.kindLabel,                        inline: true },
    ];
    if (req.requestType === 'MDQRA') fields.push({ name: disp.detailLabel, value: `${req.reductionPercent}%`, inline: true });
    if (req.requestType === 'LOA') {
      fields.push({ name: disp.detailLabel, value: `${req.loaStart || '—'} → ${req.loaEnd || '—'}`, inline: false });
    }
    if (!ok) fields.push({ name: 'Rejected by', value: String(decider || '—'), inline: true });
    if (decisionNotes) fields.push({ name: 'Notes', value: String(decisionNotes).slice(0, 1024), inline: false });
    return {
      title:       ok ? `✅ ${disp.kindLabel} approved` : `❌ ${disp.kindLabel} rejected`,
      color:       ok ? 0x2ecc71 : 0xe74c3c,
      description: ok ? 'The request was **approved** and applied.' : 'The request was **rejected**.',
      fields,
      footer:      defaultFooter(),
      timestamp:   new Date().toISOString(),
    };
  }

  function buildQuotaReliefRevokedEmbed(relief, divisionName, actorUsername) {
    const div = divisionName || relief.divisionId || '—';
    const kind = relief.kind === 'modifier' ? 'Quota Modifier' : 'Quota Request';
    const t = String(relief.type || relief.requestType || '').toUpperCase();
    const fields = [
      { name: 'Division', value: String(div), inline: true },
      { name: 'Source', value: String(kind), inline: true },
      { name: 'Type', value: t || '—', inline: true },
    ];
    const who = relief.requesterUsername || relief.requesterUid || relief.userId || '—';
    const approverRelief = relief.decidedByUsername || relief.decidedBy || null;
    fields.push(
      { name: 'Submitted by', value: String(who), inline: true },
      { name: 'Approved by', value: approverRelief ? String(approverRelief) : '— (not stored on this record)', inline: true },
    );

    if (t === 'LOA') {
      const s = relief.loaStart || relief.startDate || '—';
      const e = relief.loaEnd || relief.endDate || '—';
      fields.push({ name: 'Window', value: `${s} → ${e}`, inline: false });
    }
    if (t === 'MDQRA') {
      const p = relief.reductionPercent != null ? `${relief.reductionPercent}%` : '—';
      fields.push({ name: 'Reduction', value: String(p), inline: true });
    }

    fields.push({ name: 'Revoked by', value: String(actorUsername || '—'), inline: true });
    if (relief.revokeReason) fields.push({ name: 'Reason', value: String(relief.revokeReason).slice(0, 1024), inline: false });

    return {
      title: '🛑 Quota relief revoked',
      color: 0xe67e22,
      description: 'An active quota relief item was **revoked** and should no longer apply.',
      fields,
      footer: defaultFooter(),
      timestamp: new Date().toISOString(),
    };
  }

  function buildQuotaReliefDeletedEmbed(relief, divisionName, actorUsername) {
    const div = divisionName || relief.divisionId || '—';
    const kind = relief.kind === 'modifier' ? 'Quota Modifier' : 'Quota Request';
    const t = String(relief.type || relief.requestType || '').toUpperCase();
    const fields = [
      { name: 'Division', value: String(div), inline: true },
      { name: 'Source', value: String(kind), inline: true },
      { name: 'Type', value: t || '—', inline: true },
    ];
    const who = relief.requesterUsername || relief.requesterUid || relief.userId || '—';
    const approverReliefDel = relief.decidedByUsername || relief.decidedBy || null;
    fields.push(
      { name: 'Submitted by', value: String(who), inline: true },
      { name: 'Approved by', value: approverReliefDel ? String(approverReliefDel) : '— (not stored on this record)', inline: true },
    );

    if (t === 'LOA') {
      const s = relief.loaStart || relief.startDate || '—';
      const e = relief.loaEnd || relief.endDate || '—';
      fields.push({ name: 'Window', value: `${s} → ${e}`, inline: false });
    }
    if (t === 'MDQRA') {
      const p = relief.reductionPercent != null ? `${relief.reductionPercent}%` : '—';
      fields.push({ name: 'Reduction', value: String(p), inline: true });
    }

    fields.push({ name: 'Deleted by', value: String(actorUsername || '—'), inline: true });

    return {
      title: '🗑️ Quota relief deleted',
      color: 0x95a5a6,
      description: 'A quota relief record was **deleted** (hard removal).',
      fields,
      footer: defaultFooter(),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * @param {firebase.firestore.Firestore} firestoreDb
   * @param {'pending'|'approved'|{category:'duty'|'event'|'loa'|'mdqra'|'general',status:'pending'|'approved'}} routeOrStatus
   */
  async function postEmbed(firestoreDb, divisionId, routeOrStatus, embed, opts) {
    if (!divisionId || !firestoreDb) return;
    try {
      const snap = await firestoreDb.collection('divisions').doc(divisionId).get();
      if (!snap.exists) return;
      const divData = snap.data();

      // Back-compat: old calls pass 'pending'|'approved'.
      // Route legacy posts through the "general" category so new general+legacy fallback still work.
      const route = (typeof routeOrStatus === 'string')
        ? { category: 'general', status: routeOrStatus }
        : routeOrStatus;

      const status = route && route.status === 'approved' ? 'approved' : 'pending';
      const category = (route && route.category) ? route.category : 'general';
      const targets = webhookTargets(divData, category, status);
      if (!targets.length) return;

      let content = opts && opts.content ? String(opts.content) : '';
      let allowedMentionUserIds = [];
      if (!content && opts && opts.mentions) {
        const built = await buildRequesterApproverContent(firestoreDb, { status, ...(opts.mentions || {}) });
        content = built.content || '';
        allowedMentionUserIds = built.allowedUserIds || [];
      }

      const payload = {
        ...(content ? { content } : {}),
        embeds: [{
          ...embed,
          footer: embed.footer || defaultFooter(),
          timestamp: embed.timestamp || new Date().toISOString(),
        }],
      };

      if (allowedMentionUserIds.length) {
        payload.allowed_mentions = { parse: [], users: allowedMentionUserIds };
      }

      for (const url of targets) {
        try {
          await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
        } catch (inner) {
          console.warn('Discord webhook failed (non-fatal):', inner.message || inner);
        }
      }
    } catch (e) {
      console.warn('Discord webhook failed (non-fatal):', e.message || e);
    }
  }

  global.DiscordWebhooks = {
    divisionDiscordUrls,
    webhookTargets,
    postEmbed,
    quotaRequestDisplay,
    buildLogPendingEmbed,
    buildLogApprovedEmbed,
    buildLogRejectedEmbed,
    buildQuotaRequestPendingEmbed,
    buildQuotaRequestDecidedEmbed,
    buildQuotaReliefRevokedEmbed,
    buildQuotaReliefDeletedEmbed,
  };
})(typeof window !== 'undefined' ? window : globalThis);
