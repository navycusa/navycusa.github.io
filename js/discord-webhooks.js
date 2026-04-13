// ============================================================
// Client-side Discord webhooks (Spark / no Cloud Functions)
// Division fields: webhookUrlPending, webhookUrlApproved, legacy webhookUrl
// ============================================================

(function (global) {
  'use strict';

  const DEFAULT_FOOTER_TEXT = 'US Navy CUSA Portal • created by pPayday';

  function defaultFooter() {
    return { text: DEFAULT_FOOTER_TEXT };
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
        { name: 'Personnel', value: String(log.authorUsername || '—'), inline: true },
        { name: 'Rank',      value: String(log.authorRankName || '—'), inline: true },
        { name: 'Division',  value: String(log.divisionName  || '—'), inline: true },
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
        { name: 'Personnel', value: String(log.authorUsername || '—'), inline: true },
        { name: 'Division',  value: String(log.divisionName  || '—'), inline: true },
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
        { name: 'Personnel', value: String(log.authorUsername || '—'), inline: true },
        { name: 'Division',  value: String(log.divisionName  || '—'), inline: true },
        { name: 'Reviewer',  value: String(log.reviewerUsername || '—'), inline: true },
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
      { name: 'Requester', value: String(req.requesterUsername || '—'), inline: true },
      { name: 'Division',  value: String(div),                           inline: true },
      { name: 'Type',      value: disp.kindLabel,                        inline: true },
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
      { name: 'Requester', value: String(req.requesterUsername || '—'), inline: true },
      { name: 'Division',  value: String(div),                           inline: true },
      { name: 'Type',      value: disp.kindLabel,                        inline: true },
    ];
    if (req.requestType === 'MDQRA') fields.push({ name: disp.detailLabel, value: `${req.reductionPercent}%`, inline: true });
    if (req.requestType === 'LOA') {
      fields.push({ name: disp.detailLabel, value: `${req.loaStart || '—'} → ${req.loaEnd || '—'}`, inline: false });
    }
    fields.push({ name: 'Decided by', value: String(decider || '—'), inline: true });
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

  /**
   * @param {firebase.firestore.Firestore} firestoreDb
   * @param {'pending'|'approved'} channel
   */
  async function postEmbed(firestoreDb, divisionId, channel, embed) {
    if (!divisionId || !firestoreDb) return;
    try {
      const snap = await firestoreDb.collection('divisions').doc(divisionId).get();
      if (!snap.exists) return;
      const urls = divisionDiscordUrls(snap.data());
      const url = channel === 'approved' ? urls.approved : urls.pending;
      if (!url) return;
      const payload = {
        embeds: [{
          ...embed,
          footer: embed.footer || defaultFooter(),
          timestamp: embed.timestamp || new Date().toISOString(),
        }],
      };
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      console.warn('Discord webhook failed (non-fatal):', e.message || e);
    }
  }

  global.DiscordWebhooks = {
    divisionDiscordUrls,
    postEmbed,
    quotaRequestDisplay,
    buildLogPendingEmbed,
    buildLogApprovedEmbed,
    buildLogRejectedEmbed,
    buildQuotaRequestPendingEmbed,
    buildQuotaRequestDecidedEmbed,
  };
})(typeof window !== 'undefined' ? window : globalThis);
