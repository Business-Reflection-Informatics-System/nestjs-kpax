# Changelog

## 0.1.0 — 2026-11-07

First release.

- `KpaxModule` (`forRoot` / `forRootAsync`, `isGlobal`, `connectionStore`).
- `KpaxConnectionRegistry`: loads all active connections at boot, `get(id)` with load-on-miss,
  `reload` / `remove`, periodic sync via `findActiveVersions`, bad rows skipped.
- `KpaxClient`: typed `call()` over all 57 KPAX v1 operations; helpers for accounts, devices,
  serial lookup (exact match), fleet search, volumes, history, supply cycles, alert history.
- OAuth2 client credentials with per-connection token cache, early refresh, single-flight,
  refresh-and-retry on 401.
- Resilience: `Retry-After` / `X-RateLimit-*` handling, exponential backoff for idempotent
  methods, POST never retried after 5xx/network errors.
- `KpaxClientFactory`: ad-hoc connections, `testConnection()` with failure stage.
- `KnexKpaxConnectionStore`: reads + admin writes (encrypted secrets, unique names, soft delete).
- Docs, example knex migration, example admin module (tested end to end).
