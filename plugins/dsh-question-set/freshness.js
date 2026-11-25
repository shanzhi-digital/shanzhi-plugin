/** Pure freshness rules shared by detection and consumers; no driver or Node dependencies. */
export function temporalInfo(type) {
  const value = String(type ?? '').trim().toLowerCase();
  if (/^date$/.test(value)) return { temporalKind: 'date', dateOnly: true, hasTimezone: false };
  if (/^datetime(?:\(\d+\))?$/.test(value)) return { temporalKind: 'datetime', dateOnly: false, hasTimezone: false };
  if (/^(?:timestamp(?:\(\d+\))?(?: without time zone)?|timestamp(?:\(\d+\))? with time zone|timestamptz(?:\(\d+\))?)$/.test(value)) {
    return { temporalKind: 'timestamp', dateOnly: false, hasTimezone: /with time zone|timestamptz/.test(value) };
  }
  return null;
}

export function freshnessCandidates(fields = []) {
  const priority = name => /update|modify|modified/i.test(name) ? 0 : /create|add/i.test(name) ? 1 : /time/i.test(name) ? 2 : 3;
  return fields.map((field, index) => ({ field, index, info: temporalInfo(field.type) }))
    .filter(item => item.info)
    .sort((a, b) => priority(a.field.name) - priority(b.field.name) || a.index - b.index)
    .slice(0, 5).map(({ field }) => field);
}

export function undetectedFreshness() {
  return { status: 'UNDETECTED', empty: null, timeColumn: null, lastDataAt: null, temporalKind: null,
    dateOnly: false, hasTimezone: null, scannedAt: null, error: null };
}

/** Keep wall-clock strings wall-clock; only an explicit offset represents an instant. */
export function normalizeTemporalValue(value, type) {
  const info = temporalInfo(type);
  if (!info || typeof value !== 'string') throw new Error('Invalid temporal value');
  let lastDataAt = value.trim();
  if (info.dateOnly) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(lastDataAt)) throw new Error('Invalid date');
  } else {
    lastDataAt = lastDataAt.replace(' ', 'T');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/.test(lastDataAt)) throw new Error('Invalid timestamp');
    const explicitTimezone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(lastDataAt);
    if (info.hasTimezone && !explicitTimezone) throw new Error('Missing timezone');
    info.hasTimezone = explicitTimezone;
    // ISO offsets require minutes in browsers; PostgreSQL can return +08.
    lastDataAt = lastDataAt.replace(/([+-]\d{2})$/, '$1:00').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  }
  if (!Number.isFinite(temporalMilliseconds(lastDataAt, info.dateOnly, info.hasTimezone))) throw new Error('Invalid temporal value');
  return { ...info, lastDataAt };
}

function temporalMilliseconds(value, dateOnly, hasTimezone) {
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?)?/.exec(value);
  if (!match) return NaN;
  const [, year, month, day, hour = '00', minute = '00', second = '00', fraction = ''] = match;
  const calendar = new Date(0);
  calendar.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  calendar.setUTCHours(Number(hour), Number(minute), Number(second), Number(fraction.padEnd(3, '0').slice(0, 3)));
  if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() !== Number(month) - 1 || calendar.getUTCDate() !== Number(day)
      || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return NaN;
  if (hasTimezone) return Date.parse(value);
  const local = new Date(0);
  local.setFullYear(Number(year), Number(month) - 1, Number(day));
  local.setHours(dateOnly ? 0 : Number(hour), dateOnly ? 0 : Number(minute), dateOnly ? 0 : Number(second),
    dateOnly ? 0 : Number(fraction.padEnd(3, '0').slice(0, 3)));
  return local.getTime();
}

export function matchesFreshness(freshness, days, nowMs = Date.now()) {
  if (freshness?.status !== 'OK' || !Number.isFinite(days) || days < 0 || !Number.isFinite(nowMs)) return false;
  let normalized;
  try {
    const type = freshness.dateOnly ? 'date' : freshness.hasTimezone ? 'timestamp with time zone' : 'datetime';
    normalized = normalizeTemporalValue(freshness.lastDataAt, type);
  } catch { return false; }
  const value = temporalMilliseconds(normalized.lastDataAt, normalized.dateOnly, normalized.hasTimezone);
  const end = new Date(nowMs);
  if (normalized.dateOnly) end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  return value >= start.getTime() && value <= end.getTime();
}
