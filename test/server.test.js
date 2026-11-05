import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendToClient } from '../src/server.js';

function fakeRes() {
  return {
    destroyed: false,
    writableLength: 0,
    write(chunk) { this.writableLength += chunk.length; }, // never drains: a stalled screen
    destroy() { this.destroyed = true; },
  };
}

test('a screen that stops reading is dropped instead of queueing updates forever', () => {
  const clients = new Set();
  const res = fakeRes();
  clients.add(res);
  const update = 'x'.repeat(100 * 1024);
  let sent = 0;
  while (sendToClient(clients, res, update, 1024 * 1024)) sent++;
  assert.equal(res.destroyed, true);
  assert.equal(clients.has(res), false);
  assert.ok(res.writableLength <= 1024 * 1024 + update.length, 'backlog is bounded');
  assert.ok(sent >= 10 && sent <= 11);
});
