// Loads configuration from the environment (and .env if present).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
}

const env = process.env;

function int(name, fallback) {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${v}"`);
  return n;
}

function list(name) {
  return (env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig() {
  const source = (env.WALLBOARD_SOURCE || 'pbxware7').toLowerCase();
  if (!['pbxware7', 'mock'].includes(source)) {
    throw new Error(`WALLBOARD_SOURCE must be "pbxware7" or "mock", got "${source}"`);
  }

  const tenants = (env.TENANTS || 'all').trim().toLowerCase() === 'all' ? 'all' : list('TENANTS');

  const config = {
    root,
    source,
    pbxware: {
      url: (env.PBXWARE_URL || '').replace(/\/+$/, ''),
      apiKey: env.PBXWARE_API_KEY || '',
      tlsVerify: (env.PBXWARE_TLS_VERIFY || 'true').toLowerCase() !== 'false',
      timeoutMs: int('PBXWARE_TIMEOUT_MS', 8000),
      maxConcurrency: int('PBXWARE_MAX_CONCURRENCY', 2),
    },
    tenants,
    tenantsExclude: list('TENANTS_EXCLUDE'),
    poll: {
      platformSeconds: int('POLL_PLATFORM_SECONDS', 5),
      tenantCycleSeconds: int('POLL_TENANT_CYCLE_SECONDS', 120),
      cdrSeconds: int('POLL_CDR_SECONDS', 60),
    },
    featuredTenants: list('FEATURED_TENANTS'),
    server: {
      port: int('PORT', 8080),
      host: env.HOST || '127.0.0.1',
      user: env.WALLBOARD_USER || '',
      password: env.WALLBOARD_PASSWORD || '',
    },
    timezone: env.TIMEZONE || 'Europe/London',
  };

  if (source === 'pbxware7') {
    if (!config.pbxware.url) throw new Error('PBXWARE_URL is required when WALLBOARD_SOURCE=pbxware7');
    if (!config.pbxware.apiKey) throw new Error('PBXWARE_API_KEY is required when WALLBOARD_SOURCE=pbxware7');
  }
  return config;
}
