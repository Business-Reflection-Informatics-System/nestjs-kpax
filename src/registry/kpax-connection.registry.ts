import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { KPAX_CONNECTION_STORE } from '../kpax.constants';
import {
  KpaxConnectionId,
  KpaxConnectionRecord,
  KpaxConnectionStore,
  KpaxConnectionSummary,
} from '../interfaces/kpax-connection.interface';
import { KpaxClientFactory } from '../client/kpax-client.factory';
import { KpaxClient } from '../client/kpax.client';
import {
  KpaxConfigurationError,
  KpaxConnectionNotFoundError,
} from '../errors/kpax.errors';

interface Entry {
  record: KpaxConnectionRecord;
  fingerprint: string;
  client: KpaxClient;
}

export interface KpaxSyncResult {
  added: KpaxConnectionId[];
  updated: KpaxConnectionId[];
  removed: KpaxConnectionId[];
  failed: { id: KpaxConnectionId; error: string }[];
}

/**
 * One KpaxClient per active connection in the store.
 *
 * - On application bootstrap it loads every active connection.
 * - get(id) returns the connection's client (loading it from the store on a
 *   miss, so a connection created in another pod works immediately).
 * - reload(id) / remove(id) apply an admin change in this process at once.
 * - A periodic sync picks up changes made by other processes and pods.
 *
 * Changing a connection's host, client id, secret or scopes yields a new
 * client with a new token; editing only its name keeps the existing client.
 */
@Injectable()
export class KpaxConnectionRegistry
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(KpaxConnectionRegistry.name);
  private readonly entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncing: Promise<KpaxSyncResult> | null = null;
  private loaded = false;

  constructor(
    private readonly factory: KpaxClientFactory,
    @Optional()
    @Inject(KPAX_CONNECTION_STORE)
    private readonly store: KpaxConnectionStore | null,
  ) {}

  // ------------------------------------------------------------ lifecycle

  async onApplicationBootstrap(): Promise<void> {
    if (!this.store) return;
    const opts = this.factory.options.registry;
    if (opts.loadOnBoot) {
      try {
        const res = await this.sync({ full: true });
        this.logger.log(
          `Loaded ${this.entries.size} KPAX connection(s)` +
            (res.failed.length ? `, ${res.failed.length} failed` : ''),
        );
      } catch (e) {
        if (opts.failOnBootError) throw e;
        this.logger.error(
          `Initial KPAX connection load failed; will retry on next sync: ${
            (e as Error).message
          }`,
        );
      }
    }
    if (opts.syncIntervalMs > 0) {
      this.timer = setInterval(() => {
        this.sync().catch((e) =>
          this.logger.warn(`KPAX connection sync failed: ${e.message}`),
        );
      }, opts.syncIntervalMs);
      // Never keep the process alive just for this timer.
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // --------------------------------------------------------------- lookup

  /** True once the first load has completed. */
  get isLoaded(): boolean {
    return this.loaded;
  }

  /** Client for an active connection. Throws KpaxConnectionNotFoundError. */
  async get(id: KpaxConnectionId): Promise<KpaxClient> {
    const entry = this.entries.get(key(id));
    if (entry) return entry.client;
    if (this.store && this.factory.options.registry.loadOnMiss) {
      const client = await this.reload(id);
      if (client) return client;
    }
    throw new KpaxConnectionNotFoundError(id);
  }

  /** Client if registered, otherwise undefined. Never touches the store. */
  peek(id: KpaxConnectionId): KpaxClient | undefined {
    return this.entries.get(key(id))?.client;
  }

  has(id: KpaxConnectionId): boolean {
    return this.entries.has(key(id));
  }

  /** Secret-free view of every registered connection. */
  list(): KpaxConnectionSummary[] {
    return [...this.entries.values()].map(({ record }) => summarize(record));
  }

  /** Every registered client with its connection, e.g. for a job that fans out per instance. */
  entriesList(): { connection: KpaxConnectionSummary; client: KpaxClient }[] {
    return [...this.entries.values()].map(({ record, client }) => ({
      connection: summarize(record),
      client,
    }));
  }

  // -------------------------------------------------------------- changes

  /**
   * Re-read one connection from the store and apply it in this process: add,
   * replace, or remove it if it is gone or inactive. Call after admin writes.
   */
  async reload(id: KpaxConnectionId): Promise<KpaxClient | null> {
    const store = this.requireStore();
    const record = await store.findById(id);
    if (!record || !record.isActive) {
      this.remove(id);
      return null;
    }
    return this.upsert(record);
  }

  /** Drop a connection from this process (its token is discarded too). */
  remove(id: KpaxConnectionId): boolean {
    const entry = this.entries.get(key(id));
    if (!entry) return false;
    this.entries.delete(key(id));
    this.releaseIfUnused(entry);
    this.logger.log(`KPAX connection ${id} (${entry.record.name}) removed`);
    return true;
  }

  /**
   * Bring this process in line with the store. With `full`, or when the store
   * has no findActiveVersions(), every active row is read; otherwise only rows
   * whose updatedAt changed are. Concurrent calls share one run.
   */
  sync(opts: { full?: boolean } = {}): Promise<KpaxSyncResult> {
    if (!this.syncing) {
      this.syncing = this.doSync(!!opts.full).finally(() => {
        this.syncing = null;
      });
    }
    return this.syncing;
  }

  // ------------------------------------------------------------ internals

  private async doSync(full: boolean): Promise<KpaxSyncResult> {
    const store = this.requireStore();
    const result: KpaxSyncResult = {
      added: [],
      updated: [],
      removed: [],
      failed: [],
    };

    let records: KpaxConnectionRecord[];
    if (!full && this.loaded && store.findActiveVersions) {
      const versions = await store.findActiveVersions();
      const live = new Set(versions.map((v) => key(v.id)));
      for (const [k, entry] of this.entries) {
        if (!live.has(k)) {
          this.remove(entry.record.id);
          result.removed.push(entry.record.id);
        }
      }
      records = [];
      for (const v of versions) {
        const current = this.entries.get(key(v.id));
        if (current && current.record.updatedAt === v.updatedAt) continue;
        const rec = await store.findById(v.id);
        if (rec && rec.isActive) records.push(rec);
      }
    } else {
      records = (await store.findActive()).filter((r) => r.isActive);
      const live = new Set(records.map((r) => key(r.id)));
      for (const [k, entry] of this.entries) {
        if (!live.has(k)) {
          this.remove(entry.record.id);
          result.removed.push(entry.record.id);
        }
      }
    }

    for (const record of records) {
      const existed = this.entries.get(key(record.id));
      if (existed && existed.record.updatedAt === record.updatedAt) continue;
      try {
        this.upsert(record);
        (existed ? result.updated : result.added).push(record.id);
      } catch (e) {
        // A bad row (invalid URL, undecryptable secret) must not block the rest.
        result.failed.push({ id: record.id, error: (e as Error).message });
        this.logger.error(
          `KPAX connection ${record.id} (${record.name}) skipped: ${
            (e as Error).message
          }`,
        );
      }
    }

    this.loaded = true;
    if (result.added.length || result.updated.length || result.removed.length) {
      this.logger.log(
        `KPAX connections synced: +${result.added.length} ~${result.updated.length} -${result.removed.length}`,
      );
    }
    return result;
  }

  private upsert(record: KpaxConnectionRecord): KpaxClient {
    const k = key(record.id);
    const existing = this.entries.get(k);
    const client = this.factory.create(record); // validates + normalises
    const fingerprint = this.factory.fingerprint(client.connection);

    if (existing && existing.fingerprint === fingerprint) {
      // Only non-connection fields changed (name, etc.): keep the warm client.
      existing.record = record;
      return existing.client;
    }

    this.entries.set(k, { record, fingerprint, client });
    if (existing) {
      this.releaseIfUnused(existing);
      this.logger.log(
        `KPAX connection ${record.id} (${record.name}) updated -> ${client.host}`,
      );
    } else {
      this.logger.log(
        `KPAX connection ${record.id} (${record.name}) registered -> ${client.host}`,
      );
    }
    return client;
  }

  private releaseIfUnused(entry: Entry) {
    for (const e of this.entries.values()) {
      if (e.fingerprint === entry.fingerprint) return;
    }
    this.factory.release(entry.client.connection);
  }

  private requireStore(): KpaxConnectionStore {
    if (!this.store) {
      throw new KpaxConfigurationError(
        'No KPAX connectionStore registered; pass one to KpaxModule.forRoot/forRootAsync',
      );
    }
    return this.store;
  }
}

function summarize(record: KpaxConnectionRecord): KpaxConnectionSummary {
  return {
    id: record.id,
    name: record.name,
    host: record.host,
    clientId: record.clientId,
    scopes: record.scopes,
    updatedAt: record.updatedAt,
  };
}

function key(id: KpaxConnectionId): string {
  return String(id);
}
