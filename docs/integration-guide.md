# Integration guide

How to give a NestJS app KPAX connections that admins manage at runtime. The finished
code is in [`examples/nestjs-admin`](../examples/nestjs-admin) and is covered by
`test/example-admin.e2e.spec.ts` (HTTP, two app instances sharing one database, real
AES-GCM, mock KPAX).

## 1. Table

Use [`examples/knex-migration`](../examples/knex-migration/20260101000000_create_kpax_connections_table.js)
(PostgreSQL and SQLite), or create the equivalent in your migration tool:

| Column | Type | Notes |
|---|---|---|
| `id` | bigserial | |
| `name` | varchar(100) | Unique (case-insensitive) among non-deleted rows |
| `host` | varchar(255) | `https://<instance>.kpax.cloud` |
| `client_id` | varchar(255) | |
| `client_secret_encrypted` | text | Ciphertext from your `encrypt` hook |
| `scopes` | text, null | Space-separated; null = module defaults |
| `is_active` | boolean | Inactive rows are not loaded |
| `created_by`, `created_at`, `updated_by`, `updated_at` | bigint | Epoch millis; `updated_at` drives cross-process sync |
| `deleted_at` | bigint, null | Soft delete |

Using another ORM or a secrets manager? Implement `KpaxConnectionStore` yourself — see
[connection-registry.md](connection-registry.md#the-store-contract).

## 2. Encryption

Secrets must be encrypted at rest. Pass any `encrypt` / `decrypt` pair to the store. If
your app already has an encryption service, use it; otherwise the example's
[`SecretCipher`](../examples/nestjs-admin/secret-cipher.ts) (AES-256-GCM, key from
`KPAX_SECRET_KEY`) is enough. Use the same key in every process. Rotating it makes stored
secrets undecryptable: those rows are skipped and logged until re-saved.

## 3. Store

```ts
@Injectable()
export class KpaxConnectionDbStore extends KnexKpaxConnectionStore {
  constructor(@Inject(KNEX) knex: Knex, cipher: SecretCipher) {
    super({
      knex: () => knex,                 // or () => databaseService.getConnection()
      encrypt: (plain) => cipher.encrypt(plain),
      decrypt: (payload) => cipher.decrypt(payload),
      // table: 'kpax_connections', schema: 'public'
    });
  }
}
```

## 4. Module

```ts
@Module({
  imports: [
    KpaxModule.forRootAsync({
      isGlobal: true,                       // inject the registry anywhere
      imports: [KpaxCryptoModule],          // modules the store depends on
      connectionStore: KpaxConnectionDbStore,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        timeoutMs: config.get('KPAX_TIMEOUT_MS', 30_000),
        registry: { syncIntervalMs: config.get('KPAX_SYNC_INTERVAL_MS', 60_000) },
      }),
    }),
  ],
  controllers: [KpaxConnectionsController],
})
export class KpaxConnectionsModule {}
```

The store's dependencies must be resolvable inside `KpaxModule`: global providers (e.g. a
`@Global()` database module) or modules listed in `imports`.

## 5. Admin endpoints

[`kpax-connections.controller.ts`](../examples/nestjs-admin/kpax-connections.controller.ts)
— **add your own auth guards**; these endpoints manage credentials.

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/admin/kpax-connections` | | List (no secrets; `loaded` = live in this process) |
| GET | `/:id` | | One connection |
| POST | `/` | `{ name, host, clientId, clientSecret, scopes?, isActive? }` | Created; live immediately |
| PATCH | `/:id` | Any subset; blank `clientSecret` keeps the stored one; `scopes: []` resets | Updated; applied immediately |
| DELETE | `/:id` | | 204, soft delete, removed from the registry |
| POST | `/:id/test` | | `{ ok, stage?, status?, message?, latencyMs, server? }` with the stored secret |
| POST | `/test` | `{ host, clientId, clientSecret, scopes? }` | Same, for credentials typed in a form before saving |

The pattern for every write: change the store, then apply it locally —
`registry.reload(id)` after create/update, `registry.remove(id)` after delete.

`testConnection` never throws; `stage` says what failed: `config` (invalid input), `auth`
(KPAX refused the client id/secret), `api` (token OK but `/server/status` failed — a 401
there usually means the `server:read` scope is missing).

## 6. Using connections

```ts
const client = await registry.get(connectionId);
const device = await client.findDeviceBySerial(serial);
```

Which connection a feature uses (per customer, per site, per integration) is your data
model's decision: store a `kpax_connection_id` where it belongs. The registry only needs
the id.

Fan-out jobs (e.g. a nightly meter pull) iterate every instance and isolate failures:

```ts
for (const { connection, client } of registry.entriesList()) {
  try {
    for await (const row of client.iterateDeviceSearch({ attributes: METERS, perPage: 1000 })) {
      await save(connection.id, row);
    }
  } catch (e) {
    logger.error(`KPAX pull failed for ${connection.name}: ${(e as Error).message}`);
  }
}
```

## 7. Multiple processes

Every process that imports the module (HTTP replicas, queue workers, schedulers) loads all
active connections at boot. After an admin write:

- the process that handled it is updated immediately,
- others see **new** connections on first use (`loadOnMiss`) and **edits/deletions** within
  `syncIntervalMs`.

For instant propagation, publish an event after writes and call `registry.reload(id)` in
each process — see [connection-registry.md](connection-registry.md#instant-propagation-optional).

## 8. Rollout checklist

1. Run the migration.
2. Set the encryption key (same value in every process).
3. Deploy. Each process logs `Loaded 0 KPAX connection(s)`.
4. In KPAX, create an API client (API panel) with at least the read scopes.
5. `POST /admin/kpax-connections/test` with its credentials → `ok: true`.
6. `POST /admin/kpax-connections` to save it. Logs show
   `KPAX connection 1 (<name>) registered -> https://<instance>.kpax.cloud`.
