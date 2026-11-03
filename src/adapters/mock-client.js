// A fake PBXware 7.x API that returns responses in the documented shapes, with
// made-up tenants and activity. Used for demos and development (WALLBOARD_SOURCE=mock),
// and it exercises exactly the same parsing code as the live source.

const FIRST = ['Sarah', 'Tom', 'Priya', 'James', 'Aisha', 'Dan', 'Emma', 'Liam', 'Grace', 'Owen', 'Hannah', 'Raj', 'Megan', 'Chris', 'Zoe', 'Ben', 'Nina', 'Sam', 'Ella', 'Josh'];
const LAST = ['K', 'R', 'M', 'L', 'B', 'W', 'C', 'H', 'P', 'T', 'J', 'S', 'F', 'D', 'A', 'G', 'N', 'V', 'E', 'O'];
const TENANTS = [
  ['Northgate Insurance', 14],
  ['Riverside Dental', 6],
  ['Oakfield Solicitors', 9],
  ['Brindley Engineering', 5],
  ['Harbour Vets', 7],
  ['Meadow Lane Lettings', 4],
  ['Canal Street Coffee', 3],
  ['Kingsway Motors', 8],
  ['Elm Tree Care Homes', 6],
  ['Foxglove Florists', 2],
  ['Summit Accountancy', 5],
  ['Lantern Media', 4],
];
const UAS = ['Yealink T54W', 'Yealink T46U', 'Yealink W73P', 'Poly VVX 450', 'Siperb Desktop', 'Groundwire'];

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function callerNumber(r) {
  const pick = r();
  if (pick < 0.5) return `07700 900${String(Math.floor(r() * 1000)).padStart(3, '0')}`;
  if (pick < 0.8) return `0121 496 0${String(Math.floor(r() * 1000)).padStart(3, '0')}`;
  return `0161 496 0${String(Math.floor(r() * 1000)).padStart(3, '0')}`;
}

export function createMockClient({ seed = 42, now = () => Date.now() } = {}) {
  const r = rng(seed);
  const tenants = TENANTS.map(([name, size], i) => {
    const id = String(10 + i);
    const exts = Array.from({ length: size }, (_, j) => {
      const n = (i * 7 + j) % FIRST.length;
      return {
        id: `${id}${j}`,
        ext: String(200 + j),
        name: `${FIRST[n]} ${LAST[(n + i) % LAST.length]}`,
        ua: UAS[(i + j) % UAS.length],
        ip: `10.${i}.0.${20 + j}`,
        online: r() > 0.08,
        dnd: r() < 0.08,
      };
    });
    return { id, name, code: String(240 + i), exts, weight: size };
  });

  /** live calls: uniqueid -> { tenantId, ext, other, dir, start } */
  const calls = new Map();
  let lastStep = now();
  let uid = 1;

  function step() {
    const t = now();
    const elapsed = Math.min(60, (t - lastStep) / 1000);
    lastStep = t;
    // End some calls (mean length ~4 minutes).
    for (const [id, c] of calls) if (r() < elapsed / 240) calls.delete(id);
    // Start some calls on idle, online extensions, weighted by tenant size.
    for (const ten of tenants) {
      for (const e of ten.exts) {
        if (!e.online || e.dnd) continue;
        const busy = [...calls.values()].some((c) => c.tenantId === ten.id && c.ext === e.ext);
        if (!busy && r() < elapsed / 600) {
          const sec = Math.floor(t / 1000);
          calls.set(`${sec}.${uid++}`, { tenantId: ten.id, ext: e.ext, name: e.name, other: callerNumber(r), dir: r() < 0.7 ? 'in' : 'out', start: sec });
        }
      }
    }
  }

  // Seed with a handful of calls already in progress.
  for (const ten of tenants)
    for (const e of ten.exts)
      if (e.online && !e.dnd && r() < 0.35) {
        const sec = Math.floor(now() / 1000) - Math.floor(r() * 900);
        calls.set(`${sec}.${uid++}`, { tenantId: ten.id, ext: e.ext, name: e.name, other: callerNumber(r), dir: r() < 0.7 ? 'in' : 'out', start: sec });
      }

  // A day of call records, from 08:00 local (server time) until now.
  function cdrsToday() {
    const out = [];
    const d = new Date(now());
    const start = new Date(d);
    start.setHours(8, 0, 0, 0);
    const rr = rng(seed + d.getDate());
    const shape = [20, 46, 58, 52, 41, 60, 48, 44, 38, 22]; // calls per hour, 08:00-17:00
    for (let h = 0; h < shape.length; h++) {
      const hourStart = start.getTime() / 1000 + h * 3600;
      for (let k = 0; k < shape[h]; k++) {
        const s = Math.floor(hourStart + rr() * 3600);
        if (s * 1000 > now()) continue;
        const answered = rr() > 0.06;
        out.push(['Customer', `Ext (${200 + Math.floor(rr() * 10)})`, String(s), String(Math.floor(rr() * 400)), '', '', answered ? 'Answered' : rr() < 0.5 ? 'Unanswered' : 'Busy', `${s}.${k}`, '', 'False', 'Remote', 'Customer <07700900000>', 4.3]);
      }
    }
    return out;
  }

  function monitorFor(ten) {
    const out = {};
    for (const e of ten.exts) {
      const onCall = [...calls.values()].some((c) => c.tenantId === ten.id && c.ext === e.ext);
      out[e.id] = { name: e.name, ext: e.ext, ip: e.ip, status: e.online ? 'online' : 'offline', ua: e.ua, dnd: e.dnd ? 'true' : 'false', on_call: onCall ? 'true' : 'false' };
    }
    return out;
  }

  function liveFor(tenantId) {
    const out = {};
    for (const [id, c] of calls) {
      if (tenantId && c.tenantId !== tenantId) continue;
      const me = `${c.name} (${c.ext})`;
      out[id] = c.dir === 'in' ? { from: c.other, to: me, timestamp: String(c.start) } : { from: me, to: c.other, timestamp: String(c.start) };
    }
    return out;
  }

  function dashboardCalls(tenantId) {
    const live = [...calls.values()].filter((c) => !tenantId || c.tenantId === tenantId).length;
    const weight = tenantId ? tenants.find((t) => t.id === tenantId)?.weight ?? 1 : tenants.reduce((a, t) => a + t.weight, 0);
    const hour = new Date(now()).getHours();
    const todayFactor = Math.max(0, Math.min(10, hour - 8 + new Date(now()).getMinutes() / 60));
    const today = Math.round(weight * 4.2 * todayFactor);
    return { now: live, 'last hour': Math.round(weight * 4.5), today, 'answared calls': Math.round(today * 0.94) };
  }

  const stats = { requests: 0, errors: 0, lastError: null };

  async function call(action, params = {}) {
    stats.requests++;
    step();
    const server = params.server ? String(params.server) : null;
    const ten = server ? tenants.find((t) => t.id === server) : null;
    switch (action) {
      case 'pbxware.tenant.list':
        return Object.fromEntries(tenants.map((t) => [t.id, { name: t.name, tenantcode: t.code, package: 'Standard', ext_length: 3 }]));
      case 'pbxware.monitor.list':
        if (!ten) return Object.assign({}, ...tenants.map(monitorFor));
        return monitorFor(ten);
      case 'pbxware.monitor.live_calls':
        return liveFor(server);
      case 'pbxware.dashboard.calls':
        return dashboardCalls(server);
      case 'pbxware.monitor.trunks':
        return {
          82: { name: 'Simwood Primary', ip: '178.22.139.2:5060', status: 'online' },
          83: { name: 'Simwood Secondary', ip: '178.22.140.2:5060', status: 'online' },
        };
      case 'pbxware.dashboard.sip_registrations': {
        const all = tenants.flatMap((t) => t.exts);
        return { 'SIP Registrations': { success: all.filter((e) => e.online).length, failed: all.filter((e) => !e.online).length, lagged: 1 } };
      }
      case 'pbxware.dashboard.services':
        return { PBXware: 'running', 'PBXware service': 'running', 'PBXware proxy': 'running', 'Push notification': 'running', 'Chat server': 'running', Memcached: 'running' };
      case 'pbxware.dashboard.cpu':
        return { inuse: `${12 + Math.round(r() * 10)}%` };
      case 'pbxware.dashboard.memory':
        return { inuse: '41%' };
      case 'pbxware.dashboard.disk_usage':
        return { inuse: '38%' };
      case 'pbxware.cdr.download': {
        const rows = cdrsToday();
        const limit = Number(params.limit || 16);
        const page = Number(params.page || 1);
        const slice = rows.slice((page - 1) * limit, page * limit);
        return {
          success: 'Success.',
          next_page: page * limit < rows.length,
          limit,
          records: slice.length,
          header: ['From', 'To', 'Date/Time', 'Total Duration', 'Rating Duration', 'Rating Cost', 'Status', 'Unique ID', 'Recording Path', 'Recording Available', 'Location Type', 'Caller ID', 'MOS'],
          csv: slice,
        };
      }
      default:
        throw new Error(`mock: unsupported action ${action}`);
    }
  }

  return { call, stats };
}
