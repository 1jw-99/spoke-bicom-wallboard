// Minimal, read-only client for the PBXware 7.x HTTP API.
//
// Requests look like:  GET {base}/?apikey=KEY&action=pbxware.object.method&arg=value
// Responses are JSON. An object with an "error" key means the call failed.
//
// Only the actions in READ_ONLY_ACTIONS can be called. The PBXware API key is very
// powerful (it can delete things), so this allowlist is a second line of defence
// on top of restricting the key itself in PBXware.

import http from 'node:http';
import https from 'node:https';

export const READ_ONLY_ACTIONS = new Set([
  'pbxware.tenant.list',
  'pbxware.ext.list',
  'pbxware.monitor.list',
  'pbxware.monitor.live_calls',
  'pbxware.monitor.trunks',
  'pbxware.dashboard.calls',
  'pbxware.dashboard.ext_online',
  'pbxware.dashboard.sip_registrations',
  'pbxware.dashboard.services',
  'pbxware.dashboard.cpu',
  'pbxware.dashboard.memory',
  'pbxware.dashboard.disk_usage',
  'pbxware.cdr.download',
]);

export class PbxwareError extends Error {
  constructor(message, { action, status } = {}) {
    super(message);
    this.name = 'PbxwareError';
    this.action = action;
    this.status = status;
  }
}

/** Build the request URL. Exported for tests. The API key is never logged. */
export function buildUrl(baseUrl, apiKey, action, params = {}) {
  const url = new URL(baseUrl.replace(/\/+$/, '') + '/');
  url.searchParams.set('apikey', apiKey);
  url.searchParams.set('action', action);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  return url;
}

/** Simple promise concurrency limiter. */
export function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

// Reuse connections to the PBX: ~3 requests a second would otherwise mean a fresh TCP + TLS
// handshake each time (load on the PBX, and memory churn in the wallboard).
const agents = {
  'https:': new https.Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 4, timeout: 30000 }),
  'http:': new http.Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 4, timeout: 30000 }),
};

function defaultTransport(url, { timeoutMs, tlsVerify }) {
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'spoke-bicom-wallboard/0.1' },
        rejectUnauthorized: tlsVerify,
        timeout: timeoutMs,
        agent: tlsVerify || url.protocol !== 'https:' ? agents[url.protocol] : undefined,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end();
  });
}

export function createClient({ url, apiKey, timeoutMs = 8000, tlsVerify = true, maxConcurrency = 2 }, transport = defaultTransport) {
  const limit = createLimiter(maxConcurrency);
  const stats = { requests: 0, errors: 0, lastError: null };

  async function call(action, params = {}) {
    if (!READ_ONLY_ACTIONS.has(action)) {
      throw new PbxwareError(`Action "${action}" is not on the read-only allowlist`, { action });
    }
    return limit(async () => {
      stats.requests++;
      const target = buildUrl(url, apiKey, action, params);
      let res;
      try {
        res = await transport(target, { timeoutMs, tlsVerify });
      } catch (err) {
        stats.errors++;
        stats.lastError = `${action}: ${err.message}`;
        throw new PbxwareError(`${action} request failed: ${err.message}`, { action });
      }
      if (res.status < 200 || res.status >= 300) {
        stats.errors++;
        stats.lastError = `${action}: HTTP ${res.status}`;
        throw new PbxwareError(`${action} returned HTTP ${res.status}`, { action, status: res.status });
      }
      let data;
      try {
        data = JSON.parse(res.body);
      } catch {
        stats.errors++;
        stats.lastError = `${action}: response was not JSON`;
        throw new PbxwareError(`${action} returned a non-JSON response`, { action, status: res.status });
      }
      if (data && typeof data === 'object' && !Array.isArray(data) && 'error' in data) {
        stats.errors++;
        stats.lastError = `${action}: ${data.error}`;
        throw new PbxwareError(`${action}: ${data.error}`, { action, status: res.status });
      }
      return data;
    });
  }

  return { call, stats };
}
