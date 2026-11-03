// Web server: serves the wallboard page, the latest snapshot as JSON, and a
// Server-Sent Events stream so screens update without reloading.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { loadConfig } from './config.js';
import { createSource } from './adapters/index.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'",
};

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function checkAuth(req, { user, password }) {
  if (!user && !password) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const [u, ...rest] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
  return safeEqual(u, user) && safeEqual(rest.join(':'), password);
}

export function createServer(config, source) {
  const publicDir = path.join(config.root, 'public');
  const clients = new Set();
  let latest = source.getSnapshot();

  source.on('update', (snap) => {
    latest = snap;
    const msg = `data: ${JSON.stringify(snap)}\n\n`;
    for (const res of clients) res.write(msg);
  });
  source.on('error', (err) => console.error(`[source] ${err.message}`));

  // Keep SSE connections alive through proxies.
  const keepAlive = setInterval(() => {
    for (const res of clients) res.write(': keep-alive\n\n');
  }, 25000);
  keepAlive.unref();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/healthz') {
      const ok = !!(latest.health?.platformOkAt || latest.source === 'mock');
      res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok, source: latest.source, platformOkAt: latest.health?.platformOkAt ?? null }));
    }

    if (!checkAuth(req, config.server)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Spoke wallboard"', ...SECURITY_HEADERS });
      return res.end('Authentication required');
    }

    if (url.pathname === '/api/snapshot') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
      return res.end(JSON.stringify(latest));
    }

    const tenantMatch = url.pathname.match(/^\/api\/tenant\/(\d{1,9})$/);
    if (tenantMatch) {
      let detail = null;
      try {
        detail = await source.getTenantDetail(tenantMatch[1]);
      } catch {
        detail = null;
      }
      res.writeHead(detail ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
      return res.end(JSON.stringify(detail ?? { error: 'Unknown tenant' }));
    }

    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', ...SECURITY_HEADERS });
      res.write(`data: ${JSON.stringify(latest)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    // Static files
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(publicDir + path.sep)) {
      res.writeHead(400);
      return res.end('Bad path');
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', ...SECURITY_HEADERS });
      res.end(body);
    } catch {
      res.writeHead(404, SECURITY_HEADERS);
      res.end('Not found');
    }
  });

  return server;
}

// Run directly: node src/server.js
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const source = createSource(config);
  const server = createServer(config, source);
  server.listen(config.server.port, config.server.host, () => {
    console.log(`Spoke wallboard (${config.source}) on http://${config.server.host}:${config.server.port}`);
    if (!config.server.user) console.warn('Warning: WALLBOARD_USER/WALLBOARD_PASSWORD not set, the wallboard is open to anyone who can reach it.');
  });
  source.start();
  const shutdown = () => {
    source.stop();
    server.close(() => process.exit(0));
    // Open SSE streams never end on their own, so close them rather than wait.
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
