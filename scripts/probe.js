// Read-only probe: calls each API action the wallboard uses, once, and saves the raw
// responses to ./probe-output/ so we can check the real field names and shapes
// against the documentation before trusting the parsers.
//
//   npm run probe              -> platform-wide calls + the first tenant
//   npm run probe -- 12        -> platform-wide calls + tenant ID 12
//
// probe-output/ contains customer names and numbers: it is git-ignored, don't share it.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createClient } from '../src/pbxware/client.js';
import { cdrDate } from '../src/pbxware/normalize.js';

const config = loadConfig();
if (config.source !== 'pbxware7') {
  console.error('Set WALLBOARD_SOURCE=pbxware7 (and PBXWARE_URL / PBXWARE_API_KEY) in .env to probe a real PBX.');
  process.exit(1);
}
const client = createClient(config.pbxware);
const outDir = path.join(config.root, 'probe-output');
await mkdir(outDir, { recursive: true });

function shape(v, depth = 0) {
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1)] : [];
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    // ID-keyed maps: describe one entry
    if (keys.length && keys.every((k) => /^[\d.]+$/.test(k))) return { '<id>': shape(v[keys[0]], depth + 1), '#entries': keys.length };
    if (depth > 3) return '{…}';
    return Object.fromEntries(keys.map((k) => [k, shape(v[k], depth + 1)]));
  }
  return typeof v;
}

async function probe(name, action, params = {}) {
  try {
    const data = await client.call(action, params);
    await writeFile(path.join(outDir, `${name}.json`), JSON.stringify(data, null, 2));
    console.log(`✓ ${name.padEnd(28)} ${JSON.stringify(shape(data)).slice(0, 160)}`);
    return data;
  } catch (err) {
    console.log(`✗ ${name.padEnd(28)} ${err.message}`);
    return null;
  }
}

const tenants = await probe('tenant.list', 'pbxware.tenant.list');
const tenantId = process.argv[2] || (tenants ? Object.keys(tenants).find((id) => id !== '1') : null);

await probe('dashboard.calls', 'pbxware.dashboard.calls');
await probe('dashboard.sip_registrations', 'pbxware.dashboard.sip_registrations');
await probe('dashboard.services', 'pbxware.dashboard.services');
await probe('dashboard.cpu', 'pbxware.dashboard.cpu');
await probe('dashboard.memory', 'pbxware.dashboard.memory');
await probe('dashboard.disk_usage', 'pbxware.dashboard.disk_usage');
await probe('monitor.trunks', 'pbxware.monitor.trunks');
await probe('monitor.live_calls', 'pbxware.monitor.live_calls');

const today = cdrDate(new Date(), config.timezone);
await probe('cdr.download.today', 'pbxware.cdr.download', { start: today, end: today, limit: 20, page: 1, timezone: config.timezone });

if (tenantId) {
  console.log(`\nTenant ${tenantId}:`);
  await probe(`tenant-${tenantId}.monitor.list`, 'pbxware.monitor.list', { server: tenantId });
  await probe(`tenant-${tenantId}.monitor.live_calls`, 'pbxware.monitor.live_calls', { server: tenantId });
  await probe(`tenant-${tenantId}.dashboard.calls`, 'pbxware.dashboard.calls', { server: tenantId });
  await probe(`tenant-${tenantId}.dashboard.ext_online`, 'pbxware.dashboard.ext_online', { server: tenantId });
}

console.log(`\nRaw responses saved in ${outDir} (${client.stats.requests} requests, ${client.stats.errors} errors).`);
