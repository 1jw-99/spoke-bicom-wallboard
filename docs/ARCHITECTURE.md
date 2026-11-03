# Architecture

```
PBXware 7.6 API  ──►  Data source (adapter)  ──►  Snapshot  ──►  Web server  ──►  Browser (wallboard)
 (polled, read-only)   src/adapters/pbxware7.js     (JSON)       src/server.js     public/ (SSE)
```

- **The browser never talks to the PBX.** Only the wallboard server holds the API key.
- **Adapters are swappable.** Each data source produces the same *snapshot* (below). The page only
  reads the snapshot, so moving from Bicom to MiRTA means writing `src/adapters/mirta.js` and
  adding it to `src/adapters/index.js`. The UI and server stay as they are.
- **Mock mode** (`WALLBOARD_SOURCE=mock`) runs the real PBXware adapter against a fake API
  (`src/adapters/mock-client.js`), so demos and development exercise the same parsing code.

## Polling and load on the PBX

PBXware 7.6 has no push/webhook API, so everything is polled:

| What | API actions | Default interval |
|---|---|---|
| Platform totals, live calls, trunks, SIP registrations, services | `dashboard.calls`, `monitor.live_calls`, `monitor.trunks`, `dashboard.sip_registrations`, `dashboard.services` | every 5 s |
| CPU / memory / disk | `dashboard.cpu`, `dashboard.memory`, `dashboard.disk_usage` | every ~30 s |
| Each tenant's extensions and counters | `monitor.list` + `dashboard.calls` with `server=<tenant>` | one full cycle every 120 s, spread evenly |
| Featured tenant (agent grid) | `monitor.list` + `monitor.live_calls` with `server=<tenant>` | every 5 s |
| Calls by hour | `cdr.download` (today, incremental, 1,000 per page) | every 60 s |

With ~125 tenants that is roughly 3 requests per second on average, with at most
`PBXWARE_MAX_CONCURRENCY` (default 2) in flight at once. Tune the intervals in `.env`.

## Snapshot format

```jsonc
{
  "source": "pbxware7" | "mock",
  "generatedAt": "ISO time",
  "timezone": "Europe/London",
  "health": { "platformOkAt", "tenantsOkAt", "cdrOkAt", "lastError", "requests", "errors", "tenantCount", "tenantCycleSeconds" },
  "platform": {
    "calls": { "now", "lastHour", "today", "answered" },
    "sipRegistrations": { "registered", "failed", "lagged" } | null,
    "services": [{ "name", "status", "ok" }],
    "trunks": [{ "id", "name", "ip", "status", "online" }],
    "system": { "cpu", "memory", "disk" },           // percentages or null
    "liveCalls": [{ "id", "fromName", "fromNumber", "toName", "toNumber", "startedAt", "durationSec" }],
    "hourly": [{ "hour": 0-23, "answered", "notAnswered" }]
  },
  "tenants": [{
    "id", "name", "code", "updatedAt", "error",
    "calls": { "now", "lastHour", "today", "answered" },
    "extensions": { "total", "online", "offline", "onCall", "available", "dnd" }
  }],
  "featured": {
    "tenantId", "name", "code", "calls", "extensions", "updatedAt",
    "agents": [{ "ext", "name", "status": "available|on_call|dnd|offline", "ua", "ip",
                 "call": { "otherName", "otherNumber", "direction": "in|out", "durationSec" } }],
    "liveCalls": [ ...as above, this tenant only ]
  } | null
}
```

## What PBXware 7.6 cannot provide (and MiRTA will)

The 7.6 API has **no queue object**, so this version has no calls-waiting, longest-wait, queue
tables, agent pause states or service level. When the MiRTA adapter is written, add to the snapshot:

- `tenants[].queues[]`: waiting, longest wait, agents logged in / paused, answered, abandoned, service level
  (MiRTA OpenAPI `GET /queues/{id}/state`, ProxyAPI `QUEUE`/`AGENT` actions and queue logs)
- `featured.agents[].paused` / `pauseReason` (queue membership)

and the matching panels to the page (see the "Spoke Call Centre Wallboard – Mockup" design).

## Known limitations

- Platform-wide live calls carry no tenant field, and extension numbers repeat across tenants,
  so the live calls list can't say which tenant a call belongs to.
- The documented response examples are not always consistent. Run `npm run probe` against the
  real PBX and adjust `src/pbxware/normalize.js` (and its tests) if field names differ.
- Calls by hour is platform-wide. Per-tenant hourly charts would need one CDR poll per tenant.
