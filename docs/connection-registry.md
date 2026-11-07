# Connection registry

`KpaxConnectionRegistry` keeps one `KpaxClient` per active connection in your store.
Inject it wherever you need KPAX.

## The store contract

```ts
interface KpaxConnectionStore {
  findActive(): Promise<KpaxConnectionRecord[]>;                 // boot + full sync
  findById(id: KpaxConnectionId): Promise<KpaxConnectionRecord | null>;
  findActiveVersions?(): Promise<KpaxConnectionVersion[]>;        // optional, cheap sync
}

interface KpaxConnectionRecord {
  id: string | number;
  name: string;
  host: string;          // https://acme.kpax.cloud (trailing / and /api/v1 are stripped)
  clientId: string;
  clientSecret: string;  // DECRYPTED
  scopes?: string[];     // omit for module defaults
  isActive: boolean;
  updatedAt: number;     // must change on every write
}
```

Rules for implementers:

- Return **decrypted** secrets. If one can't be decrypted, return `''`: the registry skips
  that row and logs it, instead of failing the whole load.
- `findById` must return inactive rows too (with `isActive: false`); the registry uses that
  to remove them. Return `null` for deleted rows.
- Bump `updatedAt` on every change. It is the only signal other processes use.
- Implement `findActiveVersions()` if you can — sync then reads two columns instead of
  decrypting every row.

### `KnexKpaxConnectionStore`

A ready-made store for the `kpax_connections` table
([migration](../examples/knex-migration/20260101000000_create_kpax_connections_table.js)).
Extend it so Nest can inject your services:

```ts
@Injectable()
export class KpaxConnectionDbStore extends KnexKpaxConnectionStore {
  constructor(@Inject(KNEX) knex: Knex, cipher: SecretCipher) {
    super({
      knex: () => knex,                        // knex instance (sync or async)
      encrypt: (plain) => cipher.encrypt(plain),
      decrypt: (payload) => cipher.decrypt(payload),
      // table: 'kpax_connections', schema: 'public', now: Date.now
    });
  }
}
```

Besides the three read methods it provides the admin operations:

| Method | Notes |
|---|---|
| `listViews()` / `getView(id)` | Secret-free rows (`hasClientSecret` instead of the secret) |
| `create(input, actorId?)` | Validates URL + credentials, unique name (case-insensitive), encrypts the secret |
| `update(id, patch, actorId?)` | Blank/omitted `clientSecret` keeps the stored one; `scopes: []` resets to defaults |
| `setActive(id, bool, actorId?)` | |
| `softDelete(id, actorId?)` | Sets `deleted_at`, frees the name, hides the row everywhere |

Validation failures throw `KpaxConfigurationError` — map them to 400 in your controller.
`knex` is not a dependency of this package; any knex 2.x/3.x instance works.

## Registry API

```ts
registry.get(id)            // Promise<KpaxClient>; throws KpaxConnectionNotFoundError
registry.peek(id)           // KpaxClient | undefined, never touches the store
registry.has(id)
registry.list()             // KpaxConnectionSummary[] (no secrets)
registry.entriesList()      // [{ connection, client }] for fan-out jobs
registry.reload(id)         // re-read one row: add / replace / remove
registry.remove(id)         // drop from this process
registry.sync({ full? })    // reconcile with the store; returns { added, updated, removed, failed }
registry.isLoaded           // true after the first successful load
```

### After admin writes

Call `reload(id)` (create/update/activate/deactivate) or `remove(id)` (delete) in the same
request, so the change is live in that process immediately:

```ts
const view = await store.update(id, body, user.id);
await registry.reload(view.id);
```

### Fan-out across all instances

```ts
for (const { connection, client } of registry.entriesList()) {
  try {
    const page = await client.searchDevices({ attributes: METERS, perPage: 1000 });
    await this.saveMeters(connection.id, page.data);
  } catch (e) {
    this.logger.error(`Meter pull failed for ${connection.name}: ${e.message}`);
  }
}
```

Isolate failures per connection: one bad instance shouldn't stop the rest.

## Sync semantics

| Option | Default | Effect |
|---|---|---|
| `registry.loadOnBoot` | `true` | Full load in `onApplicationBootstrap` |
| `registry.syncIntervalMs` | `60000` | Periodic `sync()`; timer is `unref()`'d and cleared on shutdown. `0` disables |
| `registry.loadOnMiss` | `true` | `get(id)` calls `reload(id)` once for unknown ids |
| `registry.failOnBootError` | `false` | Throw from bootstrap if the initial load fails |

- Concurrent `sync()` calls share one run.
- `sync()` uses `findActiveVersions()` when available (after the first load); `sync({ full: true })`
  always reads every active row.
- Rows whose `updatedAt` hasn't changed are skipped.
- A connection whose credentials didn't change (only `name`) keeps its client and token.
- Bad rows end up in `result.failed`; they don't block other rows.

Worst-case staleness for a change made in **another** process is `syncIntervalMs`. New
connections are available everywhere immediately thanks to `loadOnMiss`.

### Instant propagation (optional)

If 60 s is too slow for credential rotation, broadcast admin changes and reload on receipt.
With NATS:

```ts
// admin service, after a write
await this.registry.reload(id);
this.nats.publish('kpax.connection.changed', JSON.stringify({ id }));

// every process
@Injectable()
export class KpaxChangeListener implements OnApplicationBootstrap {
  constructor(private readonly nats: NatsService, private readonly registry: KpaxConnectionRegistry) {}
  onApplicationBootstrap() {
    this.nats.subscribe('kpax.connection.changed', async (msg) => {
      const { id } = JSON.parse(msg);
      await this.registry.reload(id).catch(() => undefined);
    });
  }
}
```

Keep the periodic sync on as a safety net for missed messages.

## Without a store

Don't pass `connectionStore`; the registry stays empty and `get()` throws
`KpaxConfigurationError`. Use the factory instead:

```ts
const client = factory.forConnection({ host, clientId, clientSecret, scopes });
```

`forConnection` caches up to `maxCachedConnections` clients (LRU) by fingerprint.
