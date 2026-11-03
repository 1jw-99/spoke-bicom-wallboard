// End-to-end test of the data source against the mock PBXware API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pbxware7Source } from '../src/adapters/pbxware7.js';
import { createMockClient } from '../src/adapters/mock-client.js';

const config = {
  timezone: 'Europe/London',
  tenants: 'all',
  tenantsExclude: ['15'],
  featuredTenants: [],
  poll: { platformSeconds: 5, tenantCycleSeconds: 120, cdrSeconds: 60 },
};

test('snapshot is built from platform, tenant and CDR polls', async () => {
  const source = new Pbxware7Source(config, createMockClient({ seed: 7 }), { label: 'mock' });
  await source.refreshTenantList();
  assert.equal(source.tenantOrder.includes('15'), false, 'excluded tenant is skipped');
  for (const id of source.tenantOrder) await source.refreshTenant(id);
  await source.pollPlatform();
  await source.pollCdrs();
  source.chooseDefault();
  await source.refreshDetail(source.defaultTenantId);

  const snap = source.getSnapshot();
  assert.equal(snap.source, 'mock');
  assert.equal(snap.tenants.length, 11);
  assert.ok(snap.platform.trunks.length > 0);
  assert.ok(snap.platform.services.every((s) => s.ok));
  assert.equal(snap.platform.hourly.length, 24);
  assert.ok(snap.featured, 'a tenant is featured');
  assert.ok(snap.featured.agents.length > 0);
  for (const t of snap.tenants) {
    assert.equal(t.extensions.total, t.extensions.online + t.extensions.offline);
    assert.equal('agents' in t, false, 'per-tenant agent lists are not sent to the browser');
  }
  source.stop();
});

test('a failing tenant poll is recorded without breaking the snapshot', async () => {
  const mock = createMockClient({ seed: 3 });
  const flaky = {
    stats: mock.stats,
    call: (action, params) => (action === 'pbxware.monitor.list' && params.server === '10' ? Promise.reject(new Error('boom')) : mock.call(action, params)),
  };
  const source = new Pbxware7Source(config, flaky);
  source.on('error', () => {});
  await source.refreshTenantList();
  await source.refreshTenant('10');
  const t = source.getSnapshot().tenants.find((x) => x.id === '10');
  assert.equal(t.error, 'boom');
  assert.match(source.health.lastError, /tenant 10: boom/);
  source.stop();
});

test('a viewer can pick any tenant; it is then kept fresh while watched', async () => {
  const source = new Pbxware7Source(config, createMockClient({ seed: 5 }), { label: 'mock' });
  await source.refreshTenantList();
  for (const id of source.tenantOrder) await source.refreshTenant(id);
  source.chooseDefault();
  const other = source.tenantOrder.find((id) => id !== source.defaultTenantId);
  const d = await source.getTenantDetail(other);
  assert.equal(d.tenantId, other);
  assert.ok(d.agents.length > 0);
  assert.ok(source.activeDetailIds().includes(other), 'picked tenant is refreshed each tick');
  assert.ok(source.activeDetailIds().includes(source.defaultTenantId));
  assert.equal(await source.getTenantDetail('99999'), null, 'unknown tenant');
  source.stop();
});
