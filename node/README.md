# @bizreflex/nestjs-kpax

[![CI](https://github.com/Business-Reflection-Informatics-System/nestjs-kpax/actions/workflows/ci-node.yml/badge.svg)](https://github.com/Business-Reflection-Informatics-System/nestjs-kpax/actions/workflows/ci-node.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

NestJS module for the **KPAX API v1** (printer fleet / managed print services monitoring).

- **Typed client** for all KPAX v1 operations, plus helpers for devices, serial lookup,
  meters, volumes, supplies and alert history.
- **OAuth2 client credentials**: tokens cached, refreshed early, shared by concurrent calls.
- **Connections in your database.** Register KPAX instances at runtime (e.g. from an admin
  screen). Every process loads all active ones at boot and keeps them in sync — no
  restart to add, rotate or disable an instance.
- **Resilient**: honours KPAX rate-limit headers, retries transient failures, never
  re-sends a POST that may have been processed.
- NestJS 9 and 10, Node 18+. Runtime dependencies: only NestJS + axios (as peers).

```ts
@Injectable()
export class PrinterService {
  constructor(private readonly kpax: KpaxConnectionRegistry) {}

  async findPrinter(connectionId: number, serial: string) {
    const client = await this.kpax.get(connectionId);
    return client.findDeviceBySerial(serial); // exact match or null
  }
}
```

> Not affiliated with KPAX. You need your own KPAX instance and an API client
> (client id/secret) from its API panel.

## Install

Releases are published as tarballs on
[GitHub Releases](https://github.com/Business-Reflection-Informatics-System/nestjs-kpax/releases):

```bash
npm install https://github.com/Business-Reflection-Informatics-System/nestjs-kpax/releases/download/v0.1.0/bizreflex-nestjs-kpax-0.1.0.tgz
```

No git or GitHub token is needed at install time, and the lockfile pins the tarball's
integrity hash. Peer dependencies: `@nestjs/common`, `@nestjs/axios`, `axios`, `rxjs`,
`reflect-metadata`.

## Quick start

**1. A table for connections** — [example knex migration](examples/knex-migration/20260101000000_create_kpax_connections_table.js)
(PostgreSQL / SQLite).

**2. A store.** With knex, extend the bundled one and plug in your encryption:

```ts
@Injectable()
export class KpaxConnectionDbStore extends KnexKpaxConnectionStore {
  constructor(@Inject(KNEX) knex: Knex, cipher: SecretCipher) {
    super({
      knex: () => knex,
      encrypt: (plain) => cipher.encrypt(plain),
      decrypt: (payload) => cipher.decrypt(payload),
    });
  }
}
```

**3. Register the module once:**

```ts
KpaxModule.forRootAsync({
  isGlobal: true,
  imports: [KpaxCryptoModule],          // whatever the store needs
  connectionStore: KpaxConnectionDbStore,
  useFactory: () => ({ registry: { syncIntervalMs: 60_000 } }),
});
```

**4. Use it anywhere:**

```ts
const client = await registry.get(connectionId);
for await (const device of client.iterateDevices()) { /* every page */ }
```

A complete, tested example (store, AES-GCM cipher, admin CRUD controller with connection
testing) is in [examples/nestjs-admin](examples/nestjs-admin).

No database? Skip the store and use
`KpaxClientFactory.forConnection({ host, clientId, clientSecret })`.

## Documentation

| Guide | What's in it |
|---|---|
| [Integration guide](docs/integration-guide.md) | Table, store, module, admin endpoints, multi-process deployments, rollout |
| [Architecture](docs/architecture.md) | Components, boot sequence, multi-process sync, token handling |
| [Connection registry](docs/connection-registry.md) | Store contract, registry API, sync semantics |
| [Client API](docs/client-api.md) | Every client method, typed `call()`, pagination, recipes |
| [Errors & resilience](docs/errors-and-resilience.md) | Error types, retries, rate limits, mapping to HTTP |
| [KPAX API notes](../docs/kpax-api-notes.md) | Auth, scopes, hierarchy, dates, spec quirks |
| [Development](docs/development.md) | Build, test, regenerate types, release |

## Module options

All optional. Connection details are never configured here.

| Option | Default | |
|---|---|---|
| `defaultScopes` | read scopes ([list](../docs/kpax-api-notes.md#scopes)) | Requested when a connection has none |
| `timeoutMs` | `30000` | Per HTTP attempt |
| `maxRetries` | `4` | For 429 / 5xx / network errors |
| `baseDelayMs` / `maxDelayMs` | `500` / `60000` | Backoff base and cap (also caps `Retry-After`) |
| `tokenRefreshSkewSeconds` | `60` | Refresh tokens this long before expiry |
| `maxCachedConnections` | `50` | Ad-hoc `forConnection()` clients kept |
| `registry.loadOnBoot` | `true` | Load all active connections at start-up |
| `registry.syncIntervalMs` | `60000` | Re-check the store for changes from other processes; `0` = off |
| `registry.loadOnMiss` | `true` | `get(id)` reads an unknown id from the store once |
| `registry.failOnBootError` | `false` | Abort start-up if the initial load fails |

Module extras: `isGlobal` (default `false`), `connectionStore` (class implementing `KpaxConnectionStore`).

## License

[MIT](LICENSE) © 2026 BizReflex LLC-FZ
