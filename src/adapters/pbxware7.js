// Data source for Bicom PBXware 7.x.
//
// Every data source (this one, the mock, and later MiRTA) exposes the same shape:
//   start(), stop(), getSnapshot(), and emits "update" with the latest snapshot.
// The snapshot format is documented in docs/ARCHITECTURE.md, and the web page only
// ever reads the snapshot, so swapping the PBX underneath does not touch the UI.

import { EventEmitter } from 'node:events';
import { createClient } from '../pbxware/client.js';
import * as N from '../pbxware/normalize.js';

const TENANT_LIST_REFRESH_MS = 15 * 60 * 1000;
const SYSTEM_EVERY_N_TICKS = 6; // cpu / memory / disk every ~30 s at the default 5 s tick
const CDR_OVERLAP_SEC = 300; // re-read the last 5 minutes on each CDR poll to catch late records
const CDR_PAGE_LIMIT = 1000;
const CDR_MAX_PAGES = 50;

export class Pbxware7Source extends EventEmitter {
  constructor(config, client = createClient(config.pbxware), { label = 'pbxware7' } = {}) {
    super();
    this.config = config;
    this.client = client;
    this.label = label;
    this.timers = [];
    this.stopped = false;

    this.tenants = new Map(); // id -> { id, name, code, calls, extensions, agents, updatedAt, error }
    this.tenantOrder = [];
    this.tenantCursor = 0;
    this.tenantsLoadedAt = 0;

    this.platform = {
      calls: { now: 0, lastHour: 0, today: 0, answered: 0 },
      sipRegistrations: null,
      services: [],
      trunks: [],
      system: { cpu: null, memory: null, disk: null },
      liveCalls: [],
      hourly: N.hourlyBuckets([], config.timezone),
    };
    this.featured = { tenantId: null, agents: [], liveCalls: [], updatedAt: null };
    this.featureIndex = 0;
    this.tick = 0;

    this.cdr = { day: null, byId: new Map(), lastFetchSec: null };
    this.health = { platformOkAt: null, tenantsOkAt: null, cdrOkAt: null, lastError: null };
  }

  // ---------- lifecycle ----------

  async start() {
    await this.refreshTenantList().catch((err) => this.fail('tenants', err));
    this.loop(() => this.pollPlatform(), this.config.poll.platformSeconds * 1000);
    this.loop(() => this.pollNextTenant(), () => this.tenantIntervalMs());
    this.loop(() => this.pollCdrs(), this.config.poll.cdrSeconds * 1000);
    this.loop(() => this.rotateFeatured(), (this.config.poll.featureRotateSeconds ?? 20) * 1000, false);
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /** Run fn now (optionally) and then every ms (a number or a function returning one), never overlapping with itself. */
  loop(fn, ms, runNow = true) {
    const delay = () => (typeof ms === 'function' ? ms() : ms);
    const run = async () => {
      if (this.stopped) return;
      try {
        await fn();
      } catch (err) {
        this.fail('loop', err);
      }
      if (!this.stopped) this.timers.push(setTimeout(run, delay()));
    };
    if (runNow) run();
    else this.timers.push(setTimeout(run, delay()));
  }

  tenantIntervalMs() {
    // Spread one full cycle of all tenants evenly over POLL_TENANT_CYCLE_SECONDS.
    const count = Math.max(1, this.tenantOrder.length || 1);
    return Math.max(500, Math.floor((this.config.poll.tenantCycleSeconds * 1000) / count));
  }

  fail(where, err) {
    this.health.lastError = `${new Date().toISOString()} ${where}: ${err.message}`;
    this.emit('error', err);
  }

  // ---------- tenants ----------

  includeTenant(id) {
    const { tenants, tenantsExclude } = this.config;
    if (tenantsExclude.includes(id)) return false;
    if (id === '1') return false; // ID 1 is the master tenant in multi-tenant PBXware
    return tenants === 'all' || tenants.includes(id);
  }

  async refreshTenantList() {
    const list = N.normalizeTenants(await this.client.call('pbxware.tenant.list')).filter((t) => this.includeTenant(t.id));
    for (const t of list) {
      const existing = this.tenants.get(t.id);
      this.tenants.set(t.id, { ...(existing || emptyTenant()), ...t });
    }
    for (const id of [...this.tenants.keys()]) if (!list.find((t) => t.id === id)) this.tenants.delete(id);
    this.tenantOrder = list.map((t) => t.id);
    this.tenantsLoadedAt = Date.now();
  }

  async pollNextTenant() {
    if (Date.now() - this.tenantsLoadedAt > TENANT_LIST_REFRESH_MS) {
      await this.refreshTenantList().catch((err) => this.fail('tenants', err));
    }
    if (this.tenantOrder.length === 0) return;
    const id = this.tenantOrder[this.tenantCursor % this.tenantOrder.length];
    this.tenantCursor = (this.tenantCursor + 1) % this.tenantOrder.length;
    await this.refreshTenant(id);
    // Feature a tenant as soon as we have data for one, rather than waiting for the first rotation.
    if (!this.featured.tenantId) await this.rotateFeatured();
    this.publish();
  }

  async refreshTenant(id) {
    const t = this.tenants.get(id);
    if (!t) return;
    try {
      const [monitor, calls] = await Promise.all([
        this.client.call('pbxware.monitor.list', { server: id }),
        this.client.call('pbxware.dashboard.calls', { server: id }),
      ]);
      const agents = N.normalizeMonitorList(monitor);
      t.agents = agents;
      t.extensions = N.summariseExtensions(agents);
      t.calls = N.normalizeDashboardCalls(calls);
      t.updatedAt = new Date().toISOString();
      t.error = null;
      this.health.tenantsOkAt = t.updatedAt;
    } catch (err) {
      t.error = err.message;
      this.fail(`tenant ${id}`, err);
    }
  }

  // ---------- platform ----------

  async pollPlatform() {
    this.tick++;
    const c = this.client;
    const calls = [
      c.call('pbxware.monitor.live_calls').then((r) => (this.platform.liveCalls = N.normalizeLiveCalls(r))),
      c.call('pbxware.dashboard.calls').then((r) => (this.platform.calls = N.normalizeDashboardCalls(r))),
      c.call('pbxware.monitor.trunks').then((r) => (this.platform.trunks = N.normalizeTrunks(r))),
      c.call('pbxware.dashboard.sip_registrations').then((r) => (this.platform.sipRegistrations = N.normalizeSipRegistrations(r))),
      c.call('pbxware.dashboard.services').then((r) => (this.platform.services = N.normalizeServices(r))),
    ];
    if (this.tick % SYSTEM_EVERY_N_TICKS === 1) {
      calls.push(
        c.call('pbxware.dashboard.cpu').then((r) => (this.platform.system.cpu = N.normalizeUsage(r))),
        c.call('pbxware.dashboard.memory').then((r) => (this.platform.system.memory = N.normalizeUsage(r))),
        c.call('pbxware.dashboard.disk_usage').then((r) => (this.platform.system.disk = N.normalizeUsage(r))),
      );
    }
    if (this.featured.tenantId) calls.push(this.refreshFeatured());

    const results = await Promise.allSettled(calls);
    const failed = results.filter((r) => r.status === 'rejected');
    for (const f of failed) this.fail('platform', f.reason);
    if (failed.length < results.length) this.health.platformOkAt = new Date().toISOString();
    this.publish();
  }

  // ---------- featured tenant (agent grid) ----------

  /** Busiest tenants first: live calls, then extensions on calls, then calls today. */
  featureCandidates() {
    const pinned = this.config.featuredTenants || [];
    if (pinned.length) return pinned.filter((id) => this.tenants.has(id));
    return [...this.tenants.values()]
      .filter((t) => t.extensions.total > 0)
      .sort((a, b) => b.calls.now - a.calls.now || b.extensions.onCall - a.extensions.onCall || b.calls.today - a.calls.today)
      .slice(0, 8)
      .map((t) => t.id);
  }

  async rotateFeatured() {
    const candidates = this.featureCandidates();
    if (candidates.length === 0) return;
    this.featureIndex = (this.featureIndex + 1) % candidates.length;
    const id = candidates[this.featureIndex];
    if (id !== this.featured.tenantId) {
      this.featured = { tenantId: id, agents: this.tenants.get(id)?.agents || [], liveCalls: [], updatedAt: null };
      await this.refreshFeatured().catch((err) => this.fail('featured', err));
      this.publish();
    }
  }

  async refreshFeatured() {
    const id = this.featured.tenantId;
    if (!id) return;
    const [monitor, live] = await Promise.all([
      this.client.call('pbxware.monitor.list', { server: id }),
      this.client.call('pbxware.monitor.live_calls', { server: id }),
    ]);
    const agents = N.normalizeMonitorList(monitor);
    const liveCalls = N.normalizeLiveCalls(live);
    // Attach each agent's current call (other party + duration) where we can match it.
    for (const a of agents) {
      const call = liveCalls.find((c) => c.fromNumber === a.ext || c.toNumber === a.ext);
      if (call) {
        const otherIsTo = call.fromNumber === a.ext;
        a.call = {
          otherName: otherIsTo ? call.toName : call.fromName,
          otherNumber: otherIsTo ? call.toNumber : call.fromNumber,
          direction: otherIsTo ? 'out' : 'in',
          durationSec: call.durationSec,
        };
      }
    }
    if (this.featured.tenantId !== id) return; // rotated while we were waiting
    this.featured = { tenantId: id, agents, liveCalls, updatedAt: new Date().toISOString() };
    const t = this.tenants.get(id);
    if (t) {
      t.agents = agents;
      t.extensions = N.summariseExtensions(agents);
    }
  }

  // ---------- call records (hourly chart) ----------

  async pollCdrs() {
    const tz = this.config.timezone;
    const now = new Date();
    const day = N.cdrDate(now, tz);
    if (this.cdr.day !== day) this.cdr = { day, byId: new Map(), lastFetchSec: null };

    const fromSec = this.cdr.lastFetchSec ? this.cdr.lastFetchSec - CDR_OVERLAP_SEC : null;
    const starttime = fromSec && N.cdrDate(new Date(fromSec * 1000), tz) === day ? N.cdrTime(new Date(fromSec * 1000), tz) : '00:00:00';

    for (let page = 1; page <= CDR_MAX_PAGES; page++) {
      const raw = await this.client.call('pbxware.cdr.download', {
        start: day,
        starttime,
        end: day,
        endtime: '23:59:59',
        limit: CDR_PAGE_LIMIT,
        page,
        timezone: tz,
      });
      const { records, nextPage } = N.normalizeCdrPage(raw);
      for (const r of records) this.cdr.byId.set(r.uniqueId || `${r.start}-${r.from}-${r.to}`, r);
      if (!nextPage) break;
    }
    this.cdr.lastFetchSec = Math.floor(now.getTime() / 1000);
    this.platform.hourly = N.hourlyBuckets([...this.cdr.byId.values()], tz);
    this.health.cdrOkAt = now.toISOString();
    this.publish();
  }

  // ---------- snapshot ----------

  publish() {
    this.emit('update', this.getSnapshot());
  }

  getSnapshot() {
    const tenants = [...this.tenants.values()].map(({ agents, ...rest }) => rest);
    const featuredTenant = this.featured.tenantId ? this.tenants.get(this.featured.tenantId) : null;
    return {
      source: this.label,
      generatedAt: new Date().toISOString(),
      timezone: this.config.timezone,
      health: {
        ...this.health,
        requests: this.client.stats?.requests ?? 0,
        errors: this.client.stats?.errors ?? 0,
        tenantCount: this.tenantOrder.length,
        tenantCycleSeconds: this.config.poll.tenantCycleSeconds,
      },
      platform: this.platform,
      tenants,
      featured: featuredTenant
        ? {
            tenantId: featuredTenant.id,
            name: featuredTenant.name,
            code: featuredTenant.code,
            calls: featuredTenant.calls,
            extensions: featuredTenant.extensions,
            agents: this.featured.agents,
            liveCalls: this.featured.liveCalls,
            updatedAt: this.featured.updatedAt,
          }
        : null,
    };
  }
}

function emptyTenant() {
  return {
    calls: { now: 0, lastHour: 0, today: 0, answered: 0 },
    extensions: { total: 0, online: 0, offline: 0, onCall: 0, available: 0, dnd: 0 },
    agents: [],
    updatedAt: null,
    error: null,
  };
}
