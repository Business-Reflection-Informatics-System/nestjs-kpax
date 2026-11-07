# Changelog

All packages in this repository share one version and are released together.

## 0.1.0 — 2026-11-07

First release.

- **Node / NestJS** (`@bizreflex/nestjs-kpax`): `KpaxModule` with a database-backed
  connection registry (load on boot, load on miss, reload/remove, cross-process sync), typed
  client over all KPAX v1 operations, `KnexKpaxConnectionStore`, example admin module.
- **Python** (`bizreflex-kpax`), **Go** (`…/nestjs-kpax/go`), **.NET** (`BizReflex.Kpax`),
  **PHP** (`bizreflex/kpax`): client core — OAuth2 client credentials with a shared cached
  token, rate-limit-aware retries (POST never retried after 5xx/network errors), pagination,
  typed models, device/serial/volume/history/supply/alert helpers, generic request, connection
  test.
- Shared [behaviour spec](docs/client-behavior.md) and JSON fixtures; every client is tested
  against them.
