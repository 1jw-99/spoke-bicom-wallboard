// Parser tests. Fixtures are the example responses from the PBXware 7.6 API
// documentation (Admin Settings -> API Keys -> Documentation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as N from '../src/pbxware/normalize.js';

test('tenant list', () => {
  const raw = {
    2: { name: 't1.dot.com', tenantcode: '344', package_id: '1', package: 'Package 1', ext_length: 3 },
    7: { name: 't2.dot.com', tenantcode: '454', package_id: '2', package: 'Package 2', ext_length: 3 },
  };
  assert.deepEqual(N.normalizeTenants(raw), [
    { id: '2', name: 't1.dot.com', code: '344' },
    { id: '7', name: 't2.dot.com', code: '454' },
  ]);
});

test('monitor list derives a status per extension', () => {
  const raw = {
    123: { name: 'User 530', ext: '530', ip: '192.168.1.2', status: 'online', ua: 'Yealink T41', dnd: 'false', on_call: 'true' },
    124: { name: 'User 531', ext: '531', ip: '192.168.1.3', status: 'online', ua: 'Yealink T41', dnd: 'false', on_call: 'false' },
    125: { name: 'User 532', ext: '532', ip: '', status: 'offline', ua: '', dnd: 'false', on_call: 'false' },
    126: { name: 'User 533', ext: '533', ip: '', status: 'online', ua: '', dnd: 'true', on_call: 'false' },
  };
  const list = N.normalizeMonitorList(raw);
  assert.deepEqual(
    list.map((e) => [e.ext, e.status]),
    [
      ['530', 'on_call'],
      ['531', 'available'],
      ['532', 'offline'],
      ['533', 'dnd'],
    ],
  );
  assert.deepEqual(N.summariseExtensions(list), { total: 4, online: 3, offline: 1, onCall: 1, available: 1, dnd: 1 });
});

test('live calls: parties are split and start time comes from the unique ID when timestamp is not a Unix time', () => {
  const now = 1675645000;
  const raw = { '1675644925.2': { from: 'User1 (203)', to: 'User2 (210)', timestamp: '12334' } };
  const [c] = N.normalizeLiveCalls(raw, now);
  assert.equal(c.fromName, 'User1');
  assert.equal(c.fromNumber, '203');
  assert.equal(c.toNumber, '210');
  assert.equal(c.startedAt, 1675644925);
  assert.equal(c.durationSec, 75);
});

test('live calls: Unix timestamp field is preferred when present', () => {
  const [c] = N.normalizeLiveCalls({ 'abc': { from: '07700900123', to: 'Sarah K (201)', timestamp: '1700000000' } }, 1700000060);
  assert.equal(c.startedAt, 1700000000);
  assert.equal(c.fromName, '');
  assert.equal(c.fromNumber, '07700900123');
  assert.equal(c.durationSec, 60);
});

test('dashboard calls copes with the documented "answared" typo', () => {
  assert.deepEqual(N.normalizeDashboardCalls({ now: 0, 'last hour': 6, today: 6, 'answared calls': 6 }), { now: 0, lastHour: 6, today: 6, answered: 6 });
  assert.deepEqual(N.normalizeDashboardCalls({ now: '2', today: '10', 'answered calls': '9' }), { now: 2, lastHour: 0, today: 10, answered: 9 });
});

test('sip registrations, services, trunks, usage', () => {
  assert.deepEqual(N.normalizeSipRegistrations({ 'SIP Registrations': { success: 4, failed: 0, lagged: 0 } }), { registered: 4, failed: 0, lagged: 0 });
  const services = N.normalizeServices({ PBXware: 'running', Memcached: 'stopped' });
  assert.deepEqual(services, [
    { name: 'PBXware', status: 'running', ok: true },
    { name: 'Memcached', status: 'stopped', ok: false },
  ]);
  const [t] = N.normalizeTrunks({ 82: { name: 'Trunk', ip: '192.168.60.4:5060', status: 'online' } });
  assert.equal(t.online, true);
  assert.equal(N.normalizeUsage({ inuse: '45%' }), 45);
  assert.equal(N.normalizeUsage({}), null);
});

test('CDR page uses the header to find columns', () => {
  const raw = {
    success: 'Success.',
    next_page: false,
    limit: 16,
    records: 2,
    header: ['From', 'To', 'Date/Time', 'Total Duration', 'Rating Duration', 'Rating Cost', 'Status', 'Unique ID', 'Recording Path', 'Recording Available', 'Location Type', 'Caller ID', 'MOS'],
    csv: [
      ['Test (1000)', 'Test (1002)', '1246462678', '6', '6', '1.00000', 'Answered', '1368458822.12', 'path.mp3', 'True', 'Remote', 'Test <1000>', 4.4],
      ['107', 'Test (1000)', '1246439020', '6', '1', '1.00000', 'Unanswered', '1368458765.9', 'path.mp3', 'True', 'Remote', 'Admin <107>', 4.4],
    ],
  };
  const { records, nextPage } = N.normalizeCdrPage(raw);
  assert.equal(nextPage, false);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], { uniqueId: '1368458822.12', from: 'Test (1000)', to: 'Test (1002)', start: 1246462678, durationSec: 6, status: 'Answered' });
});

test('hourly buckets use the local time zone', () => {
  // 2026-07-01 08:30 UTC is 09:30 in London (BST)
  const start = Date.UTC(2026, 6, 1, 8, 30) / 1000;
  const buckets = N.hourlyBuckets(
    [
      { start, status: 'Answered' },
      { start, status: 'Busy' },
      { start: start + 3600, status: 'Answered' },
    ],
    'Europe/London',
  );
  assert.deepEqual(buckets[9], { hour: 9, answered: 1, notAnswered: 1 });
  assert.deepEqual(buckets[10], { hour: 10, answered: 1, notAnswered: 0 });
});

test('CDR date and time arguments', () => {
  const d = new Date(Date.UTC(2009, 1, 1, 23, 59, 59));
  assert.equal(N.cdrDate(d, 'UTC'), 'Feb-01-2009');
  assert.equal(N.cdrTime(d, 'UTC'), '23:59:59');
});

test('monitor.list as returned by PBXware 7.6.4 (empty strings for off flags)', async () => {
  const { normalizeMonitorList, toFlag } = await import('../src/pbxware/normalize.js');
  const list = normalizeMonitorList({
    1: { name: 'A', ext: '100', ip: '', status: 'offline', ua: '', dnd: '', on_call: '' },
    2: { name: 'B', ext: '101', ip: '10.0.0.2', status: 'online', ua: 'Yealink', dnd: '', on_call: '' },
    3: { name: 'C', ext: '102', ip: '10.0.0.3', status: 'online', ua: 'Yealink', dnd: '', on_call: 'Yes' },
    4: { name: 'D', ext: '103', ip: '10.0.0.4', status: 'online', ua: 'Yealink', dnd: 'DND', on_call: '' },
  });
  assert.deepEqual(list.map((e) => e.status), ['offline', 'available', 'on_call', 'dnd']);
  assert.equal(toFlag('no'), false);
});
