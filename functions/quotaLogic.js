'use strict';

/**
 * Quota period bounds (UTC date at midnight).
 * @param {string} periodKind 'weekly' | 'monthly'
 * @param {Date} ref
 * @return {{ start: Date, end: Date }}
 */
function getPeriodBounds(periodKind, ref) {
  const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()));
  if (periodKind === 'monthly') {
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59, 999));
    return { start, end };
  }
  // ISO week: Monday start
  const day = d.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = new Date(d);
  start.setUTCDate(d.getUTCDate() + mondayOffset);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  end.setUTCHours(23, 59, 59, 999);
  return { start, end };
}

function parseYMD(s) {
  if (!s || typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)));
}

function dateInRange(date, start, end) {
  return date >= start && date <= end;
}

function scaleRequired(raw, reductionPercent) {
  if (raw <= 0) return 0;
  const r = Math.min(100, Math.max(0, Number(reductionPercent) || 0)) / 100;
  const adj = raw * (1 - r);
  return Math.max(0, Math.round(adj * 1000) / 1000);
}

/**
 * Pick active policy for division + rank in period.
 * @param {Array<object>} policies snapshot docs data + id
 */
function normalizeQuotaScope(scope) {
  return scope === 'external' ? 'external' : 'internal';
}

function selectPolicy(policies, divisionId, rankId, periodStart, periodEnd, quotaScope) {
  const scope = normalizeQuotaScope(quotaScope);
  const candidates = policies.filter((p) => {
    if (p.divisionId !== divisionId || p.rankId !== rankId) return false;
    if (normalizeQuotaScope(p.quotaScope) !== scope) return false;
    const from = parseYMD(p.effectiveFrom);
    if (!from || from > periodEnd) return false;
    if (!p.effectiveTo) return true;
    const to = parseYMD(p.effectiveTo);
    return to && to >= periodStart;
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const af = parseYMD(a.effectiveFrom).getTime();
    const bf = parseYMD(b.effectiveFrom).getTime();
    return bf - af;
  });
  return candidates[0];
}

function attendanceMatchesItem(att, item) {
  if (item.eventDefinitionId) {
    return att.eventDefinitionId === item.eventDefinitionId;
  }
  if (item.matchEventType) {
    return att.matchEventType === item.matchEventType && !att.isCustom;
  }
  if (item.matchCustomName) {
    const n = (att.matchCustomName || '').toLowerCase();
    return n === String(item.matchCustomName).toLowerCase();
  }
  return false;
}

/**
 * @param {Array<object>} attendances quota_attendance rows (kind 'event' | 'duty' | missing = event)
 * @param {object} policy
 * @param {number} mdqraPercent active MDQRA reduction 0-100
 * @param {boolean} loaExempt
 */
function computeNetQuota(attendances, policy, mdqraPercent, loaExempt) {
  if (loaExempt) {
    return {
      exempt: true,
      exemptReason: 'LOA',
      requiredTotal: 0,
      completedTotal: 0,
      deficit: 0,
      completionPct: 100,
      rules: [],
    };
  }

  const eventAttendances = attendances.filter((a) => a.kind !== 'duty');
  const dutyMinutesTotal = attendances
    .filter((a) => a.kind === 'duty')
    .reduce((s, a) => s + Math.max(0, Number(a.minutes) || 0), 0);

  const rules = Array.isArray(policy.rules) ? policy.rules : [];
  const ruleResults = [];

  for (const rule of rules) {
    const type = rule.ruleType || rule.type;
    const items = Array.isArray(rule.items) ? rule.items : [];

    if (type === 'group') {
      const rawReq = Math.max(0, Number(rule.requiredCount) || 0);
      const req = scaleRequired(rawReq, mdqraPercent);
      let pool = 0;
      for (const att of eventAttendances) {
        for (const item of items) {
          if (attendanceMatchesItem(att, item)) {
            pool += att.credits || 1;
            break;
          }
        }
      }
      const done = Math.min(pool, req);
      ruleResults.push({
        id: rule.id || null,
        label: rule.label || 'Group',
        type: 'group',
        unit: 'events',
        required: req,
        completed: done,
        deficit: Math.max(0, req - done),
      });
    } else if (type === 'mandatory') {
      for (const item of items) {
        const rawItemReq = Math.max(0, Number(item.minCount) || 1);
        const req = scaleRequired(rawItemReq, mdqraPercent);
        let count = 0;
        for (const att of eventAttendances) {
          if (attendanceMatchesItem(att, item)) count += att.credits || 1;
        }
        const done = Math.min(count, req);
        ruleResults.push({
          id: rule.id || null,
          label: item.label || item.matchEventType || item.matchCustomName || 'Mandatory',
          type: 'mandatory',
          unit: 'events',
          required: req,
          completed: done,
          deficit: Math.max(0, req - done),
        });
      }
    } else if (type === 'duty_minutes') {
      const rawReq = Math.max(0, Number(rule.requiredMinutes) || 0);
      const req = scaleRequired(rawReq, mdqraPercent);
      const done = Math.min(dutyMinutesTotal, req);
      ruleResults.push({
        id: rule.id || null,
        label: rule.label || 'Duty minutes',
        type: 'duty_minutes',
        unit: 'minutes',
        required: req,
        completed: done,
        deficit: Math.max(0, req - done),
      });
    }
  }

  let completionPct = 100;
  if (ruleResults.length) {
    const pcts = ruleResults.map((r) => {
      if (r.required <= 0) return 100;
      return Math.min(100, (r.completed / r.required) * 100);
    });
    completionPct = Math.round((pcts.reduce((a, b) => a + b, 0) / pcts.length) * 10) / 10;
  }

  const deficit = ruleResults.reduce((s, r) => s + r.deficit, 0);
  const requiredTotal = ruleResults.reduce((s, r) => s + r.required, 0);
  const completedTotal = ruleResults.reduce((s, r) => s + r.completed, 0);

  return {
    exempt: false,
    requiredTotal,
    completedTotal,
    deficit,
    completionPct,
    rules: ruleResults,
    mdqraPercent: mdqraPercent || 0,
    dutyMinutesLogged: dutyMinutesTotal,
  };
}

module.exports = {
  getPeriodBounds,
  parseYMD,
  normalizeQuotaScope,
  selectPolicy,
  computeNetQuota,
  scaleRequired,
  dateInRange,
};
