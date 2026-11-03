// Pure functions that turn raw PBXware 7.x API responses into the wallboard's
// own data model. They are deliberately tolerant: the API documentation's examples
// are not always consistent (e.g. "answared calls", booleans as strings), and real
// responses should be checked with `npm run probe` before relying on any field.

/** Iterate an object keyed by ID (PBXware's usual list shape), or an array. */
function entries(raw) {
  if (!raw || typeof raw !== 'object') return [];
  if (Array.isArray(raw)) return raw.map((v, i) => [String(i), v]);
  return Object.entries(raw).filter(([, v]) => v && typeof v === 'object');
}

export function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return ['true', 'yes', '1', 'on', 'online'].includes(v.trim().toLowerCase());
  return false;
}

export function toNum(v, fallback = 0) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v.replace(/[^0-9.\-]/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** "User1 (203)" -> { name: "User1", ext: "203" }; "07700900123" -> { name: "", ext: "07700900123" } */
export function splitParty(s) {
  const str = String(s ?? '').trim();
  const m = str.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (m) return { name: m[1].trim(), number: m[2].trim() };
  return { name: '', number: str };
}

/** pbxware.tenant.list */
export function normalizeTenants(raw) {
  return entries(raw).map(([id, t]) => ({
    id: String(id),
    name: String(t.name ?? `Tenant ${id}`),
    code: String(t.tenantcode ?? t.tenant_code ?? ''),
  }));
}

/** pbxware.monitor.list -> one entry per extension with a derived status */
export function normalizeMonitorList(raw) {
  return entries(raw)
    .map(([id, e]) => {
      const online = toBool(e.status);
      const onCall = toBool(e.on_call);
      const dnd = toBool(e.dnd);
      let status = 'offline';
      if (online) status = onCall ? 'on_call' : dnd ? 'dnd' : 'available';
      else if (onCall) status = 'on_call'; // defensive: trust on_call if set
      return {
        id: String(id),
        ext: String(e.ext ?? ''),
        name: String(e.name ?? ''),
        ip: String(e.ip ?? ''),
        ua: String(e.ua ?? ''),
        online,
        onCall,
        dnd,
        status,
      };
    })
    .sort((a, b) => a.ext.localeCompare(b.ext, 'en', { numeric: true }));
}

export function summariseExtensions(list) {
  const s = { total: list.length, online: 0, offline: 0, onCall: 0, available: 0, dnd: 0 };
  for (const e of list) {
    if (e.online) s.online++;
    else s.offline++;
    if (e.status === 'on_call') s.onCall++;
    if (e.status === 'available') s.available++;
    if (e.status === 'dnd') s.dnd++;
  }
  return s;
}

/**
 * pbxware.monitor.live_calls. The response is keyed by the Asterisk unique ID,
 * whose integer part is the call's start time (Unix seconds). The documented
 * "timestamp" field is ambiguous, so: use it if it looks like a Unix time,
 * otherwise fall back to the unique ID.
 */
export function normalizeLiveCalls(raw, nowSec = Date.now() / 1000) {
  return entries(raw)
    .map(([id, c]) => {
      const from = splitParty(c.from);
      const to = splitParty(c.to);
      const ts = toNum(c.timestamp, NaN);
      const idStart = toNum(String(id).split('.')[0], NaN);
      let startedAt = null;
      if (Number.isFinite(ts) && ts > 1e9) startedAt = ts;
      else if (Number.isFinite(idStart) && idStart > 1e9) startedAt = idStart;
      else if (Number.isFinite(ts) && ts >= 0 && ts < 86400 * 2) startedAt = nowSec - ts; // looks like elapsed seconds
      return {
        id: String(id),
        fromName: from.name,
        fromNumber: from.number,
        toName: to.name,
        toNumber: to.number,
        startedAt,
        durationSec: startedAt ? Math.max(0, Math.round(nowSec - startedAt)) : null,
      };
    })
    .sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity));
}

/** pbxware.dashboard.calls -> { now, lastHour, today, answered } */
export function normalizeDashboardCalls(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const pick = (...keys) => {
    for (const k of keys) if (k in r) return toNum(r[k]);
    return 0;
  };
  return {
    now: pick('now'),
    lastHour: pick('last hour', 'last_hour', 'lasthour'),
    today: pick('today'),
    answered: pick('answared calls', 'answered calls', 'answered_calls', 'answered'),
  };
}

/** pbxware.dashboard.sip_registrations */
export function normalizeSipRegistrations(raw) {
  const r = (raw && (raw['SIP Registrations'] || raw.sip_registrations || raw)) || {};
  return {
    registered: toNum(r.success ?? r.registered),
    failed: toNum(r.failed),
    lagged: toNum(r.lagged),
  };
}

/** pbxware.dashboard.services -> [{ name, status, ok }] */
export function normalizeServices(raw) {
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw)
    .filter(([, v]) => typeof v === 'string')
    .map(([name, status]) => ({ name, status, ok: status.trim().toLowerCase() === 'running' }));
}

/** pbxware.monitor.trunks */
export function normalizeTrunks(raw) {
  return entries(raw)
    .map(([id, t]) => ({
      id: String(id),
      name: String(t.name ?? `Trunk ${id}`),
      ip: String(t.ip ?? ''),
      status: String(t.status ?? 'unknown'),
      online: toBool(t.status) || /^(ok|reachable|registered)/i.test(String(t.status ?? '')),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** pbxware.dashboard.cpu / memory / disk_usage -> percentage number or null */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object' || !('inuse' in raw)) return null;
  const n = toNum(raw.inuse, NaN);
  return Number.isFinite(n) ? n : null;
}

/**
 * pbxware.cdr.download -> { records, nextPage }
 * The response carries a "header" array and a "csv" array of rows.
 */
export function normalizeCdrPage(raw) {
  const header = Array.isArray(raw?.header) ? raw.header.map((h) => String(h).toLowerCase()) : [];
  const rows = Array.isArray(raw?.csv) ? raw.csv : [];
  const col = (...names) => {
    for (const n of names) {
      const i = header.indexOf(n.toLowerCase());
      if (i !== -1) return i;
    }
    return -1;
  };
  // Fall back to the documented column order if the header is missing.
  const iFrom = col('from') !== -1 ? col('from') : 0;
  const iTo = col('to') !== -1 ? col('to') : 1;
  const iStart = col('date/time', 'start date', 'start') !== -1 ? col('date/time', 'start date', 'start') : 2;
  const iDur = col('total duration', 'duration') !== -1 ? col('total duration', 'duration') : 3;
  const iStatus = col('status') !== -1 ? col('status') : 6;
  const iUid = col('unique id', 'uniqueid') !== -1 ? col('unique id', 'uniqueid') : 7;

  const records = rows
    .filter(Array.isArray)
    .map((r) => ({
      uniqueId: String(r[iUid] ?? ''),
      from: String(r[iFrom] ?? ''),
      to: String(r[iTo] ?? ''),
      start: toNum(r[iStart], NaN),
      durationSec: toNum(r[iDur]),
      status: String(r[iStatus] ?? ''),
    }))
    .filter((r) => Number.isFinite(r.start));
  return { records, nextPage: toBool(raw?.next_page) };
}

/** Hour of day (0-23) for a Unix time in the given IANA time zone. */
export function localHour(unixSec, timeZone) {
  const h = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(new Date(unixSec * 1000));
  return Number.parseInt(h, 10) % 24;
}

/** Bucket CDRs into 24 hourly buckets of answered / not answered. */
export function hourlyBuckets(records, timeZone) {
  const buckets = Array.from({ length: 24 }, (_, h) => ({ hour: h, answered: 0, notAnswered: 0 }));
  for (const r of records) {
    const h = localHour(r.start, timeZone);
    if (/^answered$/i.test(r.status.trim())) buckets[h].answered++;
    else buckets[h].notAnswered++;
  }
  return buckets;
}

/** PBXware CDR date argument format: "Feb-01-2009" (mmm-dd-YYYY), in the given time zone. */
export function cdrDate(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, day: '2-digit', month: 'short', year: 'numeric' })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.month.slice(0, 3)}-${parts.day}-${parts.year}`;
}

/** "HH:MM:SS" in the given time zone. */
export function cdrTime(date, timeZone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(date);
}
