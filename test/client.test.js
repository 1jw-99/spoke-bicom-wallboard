import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUrl, createClient, createLimiter, PbxwareError } from '../src/pbxware/client.js';

test('buildUrl puts the key, action and arguments on the query string', () => {
  const url = buildUrl('https://pbx.example.com/', 'secret', 'pbxware.monitor.list', { server: 12, empty: '' });
  assert.equal(url.origin + url.pathname, 'https://pbx.example.com/');
  assert.equal(url.searchParams.get('apikey'), 'secret');
  assert.equal(url.searchParams.get('action'), 'pbxware.monitor.list');
  assert.equal(url.searchParams.get('server'), '12');
  assert.equal(url.searchParams.has('empty'), false);
});

test('only read-only actions are allowed', async () => {
  const client = createClient({ url: 'https://pbx', apiKey: 'k' }, async () => ({ status: 200, body: '{}' }));
  await assert.rejects(() => client.call('pbxware.ext.delete', { id: 1 }), /not on the read-only allowlist/);
  await assert.rejects(() => client.call('pbxware.ext.add'), PbxwareError);
});

test('an "error" key in the response is raised as an error', async () => {
  const client = createClient({ url: 'https://pbx', apiKey: 'k' }, async () => ({ status: 200, body: '{"error":"Invalid API key."}' }));
  await assert.rejects(() => client.call('pbxware.tenant.list'), /Invalid API key/);
  assert.equal(client.stats.errors, 1);
});

test('HTTP errors and non-JSON responses are raised', async () => {
  const c1 = createClient({ url: 'https://pbx', apiKey: 'k' }, async () => ({ status: 500, body: 'oops' }));
  await assert.rejects(() => c1.call('pbxware.tenant.list'), /HTTP 500/);
  const c2 = createClient({ url: 'https://pbx', apiKey: 'k' }, async () => ({ status: 200, body: '<html>' }));
  await assert.rejects(() => c2.call('pbxware.tenant.list'), /non-JSON/);
});

test('successful responses are parsed', async () => {
  let seen;
  const client = createClient({ url: 'https://pbx', apiKey: 'k' }, async (url) => {
    seen = url;
    return { status: 200, body: '{"2":{"name":"t1"}}' };
  });
  assert.deepEqual(await client.call('pbxware.tenant.list'), { 2: { name: 't1' } });
  assert.equal(seen.searchParams.get('action'), 'pbxware.tenant.list');
});

test('the limiter never runs more than max tasks at once', async () => {
  const limit = createLimiter(2);
  let active = 0;
  let peak = 0;
  const task = () =>
    limit(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
  await Promise.all(Array.from({ length: 8 }, task));
  assert.equal(peak, 2);
});
