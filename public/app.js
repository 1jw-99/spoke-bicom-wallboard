// Wallboard front end. Reads snapshots from /api/stream (Server-Sent Events) and
// renders them. Everything is built with textContent, never innerHTML, so data from
// the PBX (names, numbers) can't inject markup.

const $ = (id) => document.getElementById(id);
let snap = null;
let clockOffsetMs = 0; // server time minus browser time
let lastMessageAt = 0;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

function serverNowSec() {
  return (Date.now() + clockOffsetMs) / 1000;
}

function fmtDuration(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function pct(part, whole) {
  return whole ? Math.round((part / whole) * 100) : 0;
}

// ---------- header ----------

function renderClock() {
  const tz = snap?.timezone || 'Europe/London';
  $('clock').textContent = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(Date.now() + clockOffsetMs));
}

function renderStatus() {
  const live = $('live');
  const text = $('live-text');
  const pollSec = 5;
  live.className = 'live';
  if (!snap || Date.now() - lastMessageAt > 60000) {
    live.classList.add('down');
    text.textContent = 'No connection to wallboard server';
    return;
  }
  if (snap.source === 'mock') {
    live.classList.add('stale');
    text.textContent = 'Demo data (mock mode)';
    return;
  }
  const ok = snap.health?.platformOkAt ? Date.parse(snap.health.platformOkAt) : 0;
  const age = (Date.now() + clockOffsetMs - ok) / 1000;
  if (!ok || age > pollSec * 6) {
    live.classList.add('down');
    text.textContent = ok ? `PBX data ${Math.round(age)} s old` : 'Waiting for PBX data';
  } else if (age > pollSec * 3) {
    live.classList.add('stale');
    text.textContent = `Updated ${Math.round(age)} s ago`;
  } else {
    live.classList.add('ok');
    text.textContent = 'Live';
  }
}

// ---------- KPI tiles ----------

function renderKpis() {
  const p = snap.platform;
  const tenants = snap.tenants || [];
  const ext = tenants.reduce(
    (a, t) => ({ total: a.total + t.extensions.total, online: a.online + t.extensions.online, onCall: a.onCall + t.extensions.onCall }),
    { total: 0, online: 0, onCall: 0 },
  );
  const regs = p.sipRegistrations;
  const trunksDown = (p.trunks || []).filter((t) => !t.online).length;
  const answeredPct = pct(p.calls.answered, p.calls.today);

  const tiles = [
    { label: 'Calls now', value: p.calls.now, detail: `${p.liveCalls.length} live call legs`, accent: 'var(--sky)' },
    { label: 'Calls last hour', value: p.calls.lastHour, detail: 'all tenants', accent: 'var(--blue)' },
    { label: 'Calls today', value: p.calls.today, detail: `${p.calls.answered} answered (${answeredPct}%)`, accent: 'var(--blue)' },
    { label: 'Extensions online', value: `${ext.online} / ${ext.total}`, detail: `${ext.onCall} on a call · ${tenants.length} tenants`, accent: 'var(--green)' },
    {
      label: 'SIP registrations',
      value: regs ? regs.registered : '–',
      detail: regs ? `${regs.failed} failed · ${regs.lagged} lagged` : 'waiting for data',
      accent: regs && regs.lagged + regs.failed > 0 ? 'var(--amber)' : 'var(--green)',
    },
    {
      label: 'Trunks',
      value: `${(p.trunks || []).length - trunksDown} / ${(p.trunks || []).length}`,
      detail: trunksDown ? `${trunksDown} not online` : 'all online',
      accent: trunksDown ? 'var(--red)' : 'var(--green)',
    },
  ];

  const box = $('kpis');
  box.replaceChildren(
    ...tiles.map((t) => {
      const n = el('div', 'kpi');
      n.style.setProperty('--accent', t.accent);
      n.append(el('div', 'label', t.label), el('div', 'value', t.value), el('div', 'detail', t.detail));
      return n;
    }),
  );
}

// ---------- tenants table ----------

function renderTenants() {
  const rows = [...(snap.tenants || [])]
    .sort((a, b) => b.calls.now - a.calls.now || b.extensions.onCall - a.extensions.onCall || b.calls.today - a.calls.today || a.name.localeCompare(b.name))
    .slice(0, 10);
  const tbody = $('tenant-table').querySelector('tbody');
  tbody.replaceChildren(
    ...rows.map((t) => {
      const tr = el('tr', snap.featured?.tenantId === t.id ? 'featured' : '');
      const name = el('td', 'name', t.name);
      if (t.error) name.title = `Last update failed: ${t.error}`;
      const online = el('td', 'num', `${t.extensions.online}/${t.extensions.total}`);
      if (t.extensions.total && t.extensions.offline > t.extensions.total / 2) online.classList.add('warn');
      tr.append(name, online, el('td', 'num', t.extensions.onCall), el('td', 'num', t.calls.now), el('td', 'num', t.calls.today));
      return tr;
    }),
  );
  const h = snap.health || {};
  $('tenant-hint').textContent = `${h.tenantCount ?? rows.length} tenants · each refreshed every ${h.tenantCycleSeconds ?? '–'} s`;
}

// ---------- featured tenant agent grid ----------

const STATUS_TEXT = { available: 'Available', on_call: 'On a call', dnd: 'Do not disturb', offline: 'Offline' };

function renderFeatured() {
  const f = snap.featured;
  const box = $('agents');
  if (!f) {
    $('featured-title').textContent = 'Extensions';
    box.replaceChildren(el('div', 'empty', 'Waiting for tenant data…'));
    $('featured-hint').textContent = '';
    return;
  }
  $('featured-title').textContent = `${f.name} · extensions`;
  const genSec = Date.parse(snap.generatedAt) / 1000;
  box.replaceChildren(
    ...f.agents.map((a) => {
      const n = el('div', `agent ${a.status}`);
      const row = el('div', 'row');
      row.append(el('span', 'name', a.name || `Ext ${a.ext}`));
      const timer = el('span', 'timer');
      if (a.call && Number.isFinite(a.call.durationSec)) timer.dataset.start = String(genSec - a.call.durationSec);
      row.append(timer);
      let detail = `${a.ext} · ${STATUS_TEXT[a.status] || a.status}`;
      if (a.call) detail = `${a.ext} · ${a.call.direction === 'out' ? 'to' : 'from'} ${a.call.otherName || a.call.otherNumber}`;
      n.append(row, el('div', 'detail', detail));
      n.title = a.ua ? `${a.ua}${a.ip ? ` · ${a.ip}` : ''}` : '';
      return n;
    }),
  );
  if (f.agents.length === 0) box.replaceChildren(el('div', 'empty', 'No extensions found for this tenant.'));
  $('featured-hint').textContent = `${f.extensions.online} of ${f.extensions.total} online · ${f.calls.now} calls now · ${f.calls.today} today · rotates between the busiest tenants`;
}

// ---------- live calls ----------

const ARROW_IN = 'M17 7L7 17M7 9v8h8';
const ARROW_OUT = 'M7 17L17 7M9 7h8v8';

function arrow(path, label) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path);
  svg.append(p);
  return svg;
}

function renderCalls() {
  const calls = [...(snap.platform.liveCalls || [])].sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity));
  $('calls-count').textContent = `(${calls.length})`;
  const box = $('calls');
  if (calls.length === 0) return box.replaceChildren(el('div', 'empty', 'No calls in progress.'));
  box.replaceChildren(
    ...calls.slice(0, 5).map((c) => {
      // A call is shown from the extension's point of view where we can tell which side is ours.
      const fromIsExt = !!c.fromName && /^\d{2,6}$/.test(c.fromNumber);
      const toIsExt = !!c.toName && /^\d{2,6}$/.test(c.toNumber);
      const outbound = fromIsExt && !toIsExt;
      const who = outbound || (fromIsExt && toIsExt) ? `${c.fromName} (${c.fromNumber})` : c.toName ? `${c.toName} (${c.toNumber})` : c.toNumber;
      const other = outbound || (fromIsExt && toIsExt) ? c.toName || c.toNumber : c.fromName || c.fromNumber;
      const row = el('div', 'call');
      const dur = el('span', 'dur');
      if (c.startedAt) dur.dataset.start = String(c.startedAt);
      row.append(arrow(outbound ? ARROW_OUT : ARROW_IN, outbound ? 'Outbound' : 'Inbound'), el('span', 'who', who), el('span', 'with', `${outbound ? 'to' : 'from'} ${other}`), dur);
      return row;
    }),
    ...(calls.length > 5 ? [el('div', 'empty', `+ ${calls.length - 5} more`)] : []),
  );
}

// ---------- hourly chart ----------

function renderBars() {
  const tz = snap.timezone || 'Europe/London';
  const nowHour = Number.parseInt(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).format(new Date()), 10);
  const data = snap.platform.hourly || [];
  const busy = data.filter((b) => b.answered + b.notAnswered > 0).map((b) => b.hour);
  const first = Math.min(8, ...busy);
  const last = Math.max(18, nowHour, ...busy);
  const shown = data.filter((b) => b.hour >= first && b.hour <= last);
  const max = Math.max(1, ...shown.map((b) => b.answered + b.notAnswered));
  const box = $('bars');
  box.style.setProperty('--n', String(shown.length));
  box.replaceChildren(
    ...shown.map((b) => {
      const total = b.answered + b.notAnswered;
      const n = el('div', `bar${b.hour === nowHour ? ' now' : ''}`);
      const stack = el('div', 'stack');
      const missed = el('div', 'missed');
      missed.style.height = `${(b.notAnswered / max) * 100}%`;
      const ans = el('div', 'answered');
      ans.style.height = `${(b.answered / max) * 100}%`;
      stack.append(missed, ans);
      stack.title = `${b.answered} answered, ${b.notAnswered} not answered`;
      n.append(el('span', 'count', total || ''), stack, el('span', 'hour', `${String(b.hour).padStart(2, '0')}:00`));
      return n;
    }),
  );
}

// ---------- health ----------

function renderHealth() {
  const p = snap.platform;
  const trunks = $('trunks');
  trunks.replaceChildren(
    ...(p.trunks.length ? p.trunks : [{ name: 'Trunks', status: 'waiting for data', online: null }]).map((t) => {
      const item = el('div', 'item');
      const state = el('span', `state ${t.online === null ? '' : t.online ? 'ok' : 'bad'}`, t.online === null ? t.status : t.online ? 'Online' : t.status || 'Down');
      item.append(el('span', '', t.name), state);
      return item;
    }),
  );

  const services = $('services');
  const bad = p.services.filter((s) => !s.ok);
  services.replaceChildren(
    ...(p.services.length === 0
      ? [el('span', '', 'Services: waiting for data')]
      : bad.length
        ? bad.map((s) => el('span', 'bad', `${s.name}: ${s.status}`))
        : [el('span', '', `All ${p.services.length} PBXware services running`)]),
  );

  const meters = [
    ['CPU', p.system.cpu],
    ['Memory', p.system.memory],
    ['Disk', p.system.disk],
  ];
  $('system').replaceChildren(
    ...meters.map(([label, v]) => {
      const m = el('div', `meter${v !== null && v >= 80 ? ' high' : ''}`);
      const track = el('div', 'm-track');
      const fill = el('div', 'm-fill');
      fill.style.width = `${v ?? 0}%`;
      track.append(fill);
      m.append(el('div', 'm-label', label), el('div', 'm-value', v === null ? '–' : `${Math.round(v)}%`), track);
      return m;
    }),
  );
}

// ---------- tickers ----------

function tick() {
  const now = serverNowSec();
  for (const n of document.querySelectorAll('[data-start]')) n.textContent = fmtDuration(now - Number(n.dataset.start));
  renderClock();
  renderStatus();
}

function render() {
  const tenants = snap.tenants?.length ?? 0;
  $('subtitle').textContent = `Bicom PBXware · ${tenants} tenants${snap.source === 'mock' ? ' · demo data' : ''}`;
  renderKpis();
  renderTenants();
  renderFeatured();
  renderCalls();
  renderBars();
  renderHealth();
  tick();
}

function accept(data) {
  snap = data;
  lastMessageAt = Date.now();
  if (snap.generatedAt) clockOffsetMs = Date.parse(snap.generatedAt) - Date.now();
  render();
}

function connect() {
  if ('EventSource' in window) {
    const es = new EventSource('api/stream');
    es.onmessage = (e) => accept(JSON.parse(e.data));
    es.onerror = () => renderStatus();
  } else {
    const poll = async () => {
      try {
        const res = await fetch('api/snapshot', { cache: 'no-store' });
        if (res.ok) accept(await res.json());
      } finally {
        setTimeout(poll, 5000);
      }
    };
    poll();
  }
}

setInterval(tick, 1000);
connect();
