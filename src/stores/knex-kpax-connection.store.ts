import {
  KpaxConnectionId,
  KpaxConnectionRecord,
  KpaxConnectionStore,
  KpaxConnectionVersion,
} from '../interfaces/kpax-connection.interface';
import { KpaxConfigurationError } from '../errors/kpax.errors';
import { normalizeKpaxConnection } from '../client/kpax-connection.util';

/** Any knex instance. Typed loosely so knex stays an app dependency, not ours. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type KnexLike = any;

export interface KnexKpaxConnectionStoreOptions {
  /** Returns the knex instance (e.g. `() => databaseService.getConnection()`). */
  knex: () => KnexLike | Promise<KnexLike>;
  /** Decrypts client_secret_encrypted. Return null when it can't be decrypted. */
  decrypt: (ciphertext: string) => string | null | Promise<string | null>;
  /** Encrypts a secret before it is written. Required only for the write methods. */
  encrypt?: (plaintext: string) => string | null | Promise<string | null>;
  /** Table name. Default 'kpax_connections'. */
  table?: string;
  /** Optional schema, e.g. 'public'. */
  schema?: string;
  /** Clock for created_at/updated_at (epoch millis). Default Date.now. */
  now?: () => number;
}

/** Secret-free row for admin screens. */
export interface KpaxConnectionView {
  id: KpaxConnectionId;
  name: string;
  host: string;
  clientId: string;
  scopes: string[];
  isActive: boolean;
  hasClientSecret: boolean;
  createdBy: KpaxConnectionId | null;
  createdAt: number | null;
  updatedBy: KpaxConnectionId | null;
  updatedAt: number;
}

export interface KpaxConnectionCreateInput {
  name: string;
  host: string;
  clientId: string;
  clientSecret: string;
  scopes?: string[];
  isActive?: boolean;
}

export interface KpaxConnectionUpdateInput {
  name?: string;
  host?: string;
  clientId?: string;
  /** Blank or undefined keeps the stored secret. */
  clientSecret?: string;
  /** Empty array clears custom scopes (module defaults apply). */
  scopes?: string[];
  isActive?: boolean;
}

/**
 * KpaxConnectionStore over a `kpax_connections` table (see
 * examples/knex-migration for the migration). Extend it in the app so Nest
 * can inject your own services:
 *
 *   @Injectable()
 *   export class AppKpaxConnectionStore extends KnexKpaxConnectionStore {
 *     constructor(@Inject(KNEX) knex: Knex, cipher: SecretCipher) {
 *       super({
 *         knex: () => knex,
 *         encrypt: (plain) => cipher.encrypt(plain),
 *         decrypt: (payload) => cipher.decrypt(payload),
 *       });
 *     }
 *   }
 *
 * Rows are soft-deleted (deleted_at) so anything referencing a connection id
 * keeps resolving historically.
 */
export class KnexKpaxConnectionStore implements KpaxConnectionStore {
  protected readonly table: string;

  constructor(protected readonly storeOptions: KnexKpaxConnectionStoreOptions) {
    this.table = storeOptions.table ?? 'kpax_connections';
  }

  // ------------------------------------------------- KpaxConnectionStore

  async findActive(): Promise<KpaxConnectionRecord[]> {
    const rows = await this.q(await this.db())
      .where({ is_active: true })
      .whereNull('deleted_at')
      .orderBy('id');
    return Promise.all(rows.map((r: Row) => this.toRecord(r)));
  }

  async findById(id: KpaxConnectionId): Promise<KpaxConnectionRecord | null> {
    const row = await this.findRow(id);
    return row ? this.toRecord(row) : null;
  }

  async findActiveVersions(): Promise<KpaxConnectionVersion[]> {
    const rows = await this.q(await this.db())
      .select('id', 'updated_at')
      .where({ is_active: true })
      .whereNull('deleted_at');
    return rows.map((r: Row) => ({
      id: normId(r.id),
      updatedAt: Number(r.updated_at ?? 0),
    }));
  }

  // ------------------------------------------------------- admin reads

  /** All non-deleted connections, without secrets. */
  async listViews(): Promise<KpaxConnectionView[]> {
    const rows = await this.q(await this.db())
      .whereNull('deleted_at')
      .orderBy('name');
    return rows.map((r: Row) => toView(r));
  }

  async getView(id: KpaxConnectionId): Promise<KpaxConnectionView | null> {
    const row = await this.findRow(id);
    return row ? toView(row) : null;
  }

  // ------------------------------------------------------ admin writes

  async create(
    input: KpaxConnectionCreateInput,
    actorId?: KpaxConnectionId | null,
  ): Promise<KpaxConnectionView> {
    const name = requireName(input.name);
    const conn = normalizeKpaxConnection({
      host: input.host,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      scopes: input.scopes,
    });
    await this.assertNameFree(name);
    const now = this.now();
    const row = {
      name,
      host: conn.host,
      client_id: conn.clientId,
      client_secret_encrypted: await this.encryptSecret(conn.clientSecret),
      scopes: joinScopes(conn.scopes),
      is_active: input.isActive ?? true,
      created_by: actorId ?? null,
      created_at: now,
      updated_by: actorId ?? null,
      updated_at: now,
    };
    const inserted = await this.q(await this.db()).insert(row, ['id']);
    const id = normId(
      Array.isArray(inserted) ? inserted[0]?.id ?? inserted[0] : inserted,
    );
    return (await this.getView(id)) as KpaxConnectionView;
  }

  async update(
    id: KpaxConnectionId,
    input: KpaxConnectionUpdateInput,
    actorId?: KpaxConnectionId | null,
  ): Promise<KpaxConnectionView> {
    const row = await this.findRow(id);
    if (!row)
      throw new KpaxConfigurationError(`KPAX connection "${id}" not found`);

    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = requireName(input.name);
      if (name !== row.name) await this.assertNameFree(name, id);
      patch.name = name;
    }

    const newSecret = input.clientSecret?.trim()
      ? input.clientSecret
      : undefined;
    // Validate the resulting connection as a whole; the stored secret stands in
    // when none is supplied (we only need to know one exists).
    const conn = normalizeKpaxConnection({
      host: input.host ?? row.host,
      clientId: input.clientId ?? row.client_id,
      clientSecret: newSecret ?? (row.client_secret_encrypted ? 'stored' : ''),
      scopes: input.scopes ?? splitScopes(row.scopes),
    });
    if (input.host !== undefined) patch.host = conn.host;
    if (input.clientId !== undefined) patch.client_id = conn.clientId;
    if (newSecret) {
      patch.client_secret_encrypted = await this.encryptSecret(
        newSecret.trim(),
      );
    }
    if (input.scopes !== undefined) patch.scopes = joinScopes(conn.scopes);
    if (input.isActive !== undefined) patch.is_active = input.isActive;

    patch.updated_by = actorId ?? null;
    patch.updated_at = Math.max(this.now(), Number(row.updated_at ?? 0) + 1);
    await this.q(await this.db())
      .where({ id: row.id })
      .update(patch);
    return (await this.getView(row.id)) as KpaxConnectionView;
  }

  async setActive(
    id: KpaxConnectionId,
    isActive: boolean,
    actorId?: KpaxConnectionId | null,
  ): Promise<KpaxConnectionView> {
    return this.update(id, { isActive }, actorId);
  }

  /** Soft delete. Returns false when the connection didn't exist. */
  async softDelete(
    id: KpaxConnectionId,
    actorId?: KpaxConnectionId | null,
  ): Promise<boolean> {
    const row = await this.findRow(id);
    if (!row) return false;
    const now = Math.max(this.now(), Number(row.updated_at ?? 0) + 1);
    await this.q(await this.db())
      .where({ id: row.id })
      .update({
        deleted_at: now,
        is_active: false,
        updated_at: now,
        updated_by: actorId ?? null,
      });
    return true;
  }

  // --------------------------------------------------------- internals

  /** The knex instance. (Never return a query builder from an async function: it's a thenable and would execute.) */
  protected async db(): Promise<KnexLike> {
    return this.storeOptions.knex();
  }

  /** A fresh query builder on the table. */
  protected q(knex: KnexLike): KnexLike {
    const qb = knex(this.table);
    return this.storeOptions.schema
      ? qb.withSchema(this.storeOptions.schema)
      : qb;
  }

  protected async findRow(id: KpaxConnectionId): Promise<Row | null> {
    const row = await this.q(await this.db())
      .where({ id })
      .whereNull('deleted_at')
      .first();
    return row ?? null;
  }

  protected async toRecord(r: Row): Promise<KpaxConnectionRecord> {
    let secret: string | null = null;
    if (r.client_secret_encrypted) {
      try {
        secret = await this.storeOptions.decrypt(
          String(r.client_secret_encrypted),
        );
      } catch {
        secret = null;
      }
    }
    return {
      id: normId(r.id),
      name: String(r.name),
      host: String(r.host),
      clientId: String(r.client_id),
      // Empty when undecryptable: the registry rejects it and logs which row.
      clientSecret: secret ?? '',
      scopes: splitScopes(r.scopes),
      isActive: toBool(r.is_active),
      updatedAt: Number(r.updated_at ?? 0),
    };
  }

  private async encryptSecret(plain: string): Promise<string> {
    if (!this.storeOptions.encrypt) {
      throw new KpaxConfigurationError(
        'KnexKpaxConnectionStore needs an `encrypt` function for write operations',
      );
    }
    const enc = await this.storeOptions.encrypt(plain);
    if (!enc)
      throw new KpaxConfigurationError(
        'Failed to encrypt the KPAX client secret',
      );
    return enc;
  }

  private async assertNameFree(name: string, exceptId?: KpaxConnectionId) {
    let q = this.q(await this.db())
      .whereRaw('lower(name) = ?', [name.toLowerCase()])
      .whereNull('deleted_at');
    if (exceptId !== undefined) q = q.whereNot({ id: exceptId });
    if (await q.first()) {
      throw new KpaxConfigurationError(
        `A KPAX connection named "${name}" already exists`,
      );
    }
  }

  private now(): number {
    return (this.storeOptions.now ?? Date.now)();
  }
}

// ---------------------------------------------------------------------------

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function toView(r: Row): KpaxConnectionView {
  return {
    id: normId(r.id),
    name: String(r.name),
    host: String(r.host),
    clientId: String(r.client_id),
    scopes: splitScopes(r.scopes) ?? [],
    isActive: toBool(r.is_active),
    hasClientSecret: !!r.client_secret_encrypted,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at != null ? Number(r.created_at) : null,
    updatedBy: r.updated_by ?? null,
    updatedAt: Number(r.updated_at ?? 0),
  };
}

function requireName(name: string): string {
  const n = (name ?? '').trim();
  if (!n) throw new KpaxConfigurationError('KPAX connection name is required');
  if (n.length > 100)
    throw new KpaxConfigurationError(
      'KPAX connection name is too long (max 100)',
    );
  return n;
}

function splitScopes(v: unknown): string[] | undefined {
  if (v == null || v === '') return undefined;
  const list = String(v)
    .split(/[\s,]+/)
    .filter(Boolean);
  return list.length ? list : undefined;
}

function joinScopes(scopes?: string[]): string | null {
  return scopes?.length ? scopes.join(' ') : null;
}

function toBool(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 't' || v === 'true';
}

/** pg returns bigint ids as strings; keep numbers as numbers when safe. */
function normId(v: unknown): KpaxConnectionId {
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isSafeInteger(n) && String(n) === String(v) ? n : String(v);
}
