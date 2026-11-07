import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import knexFactory, { Knex } from 'knex';
import { KnexKpaxConnectionStore, KpaxConfigurationError } from '../src';

// The example migration (examples/knex-migration), run against SQLite.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const migration = require('../examples/knex-migration/20260101000000_create_kpax_connections_table.js');

const encrypt = (p: string) => 'enc:' + Buffer.from(p).toString('base64');
const decrypt = (c: string) =>
  c.startsWith('enc:') ? Buffer.from(c.slice(4), 'base64').toString() : null;

let db: Knex;
let clock: number;
let store: KnexKpaxConnectionStore;

beforeEach(async () => {
  db = knexFactory({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await migration.up(db);
  clock = 1_000;
  store = new KnexKpaxConnectionStore({
    knex: () => db,
    encrypt,
    decrypt,
    now: () => clock,
  });
});
afterEach(() => db.destroy());

const input = {
  name: 'Acme',
  host: 'https://acme.kpax.cloud/api/v1/',
  clientId: 'cid',
  clientSecret: 'secret-1',
};

describe('KnexKpaxConnectionStore', () => {
  it('creates a connection with an encrypted secret and returns a secret-free view', async () => {
    const view = await store.create(input, 42);
    expect(view).toMatchObject({
      name: 'Acme',
      host: 'https://acme.kpax.cloud',
      clientId: 'cid',
      isActive: true,
      hasClientSecret: true,
      createdBy: 42,
      updatedAt: 1000,
    });
    expect(view).not.toHaveProperty('clientSecret');

    const raw = await db('kpax_connections').first();
    expect(raw.client_secret_encrypted).toBe(encrypt('secret-1'));
    expect(raw.client_secret_encrypted).not.toContain('secret-1');
  });

  it('serves decrypted records to the registry', async () => {
    const a = await store.create(input);
    await store.create({ ...input, name: 'Off', isActive: false });
    const active = await store.findActive();
    expect(active).toEqual([
      {
        id: a.id,
        name: 'Acme',
        host: 'https://acme.kpax.cloud',
        clientId: 'cid',
        clientSecret: 'secret-1',
        scopes: undefined,
        isActive: true,
        updatedAt: 1000,
      },
    ]);
    expect(await store.findActiveVersions()).toEqual([
      { id: a.id, updatedAt: 1000 },
    ]);
  });

  it('keeps the stored secret when an update leaves it blank, and bumps updated_at', async () => {
    const a = await store.create(input);
    clock = 1_000; // same millisecond: updated_at must still move forward
    const v = await store.update(a.id, {
      name: 'Acme US',
      clientSecret: '  ',
      scopes: ['devices:read', 'server:read'],
    });
    expect(v.updatedAt).toBe(1001);
    const rec = await store.findById(a.id);
    expect(rec).toMatchObject({
      name: 'Acme US',
      clientSecret: 'secret-1',
      scopes: ['devices:read', 'server:read'],
    });

    clock = 5_000;
    await store.update(a.id, { clientSecret: 'secret-2' });
    expect((await store.findById(a.id))!.clientSecret).toBe('secret-2');
  });

  it('validates host, credentials and unique names', async () => {
    await store.create(input);
    await expect(store.create({ ...input, name: ' acme ' })).rejects.toThrow(
      'already exists',
    );
    await expect(
      store.create({ ...input, name: 'X', host: 'ftp://x' }),
    ).rejects.toBeInstanceOf(KpaxConfigurationError);
    await expect(
      store.create({ ...input, name: 'Y', clientSecret: '' }),
    ).rejects.toThrow('missing clientId or clientSecret');
    await expect(store.create({ ...input, name: '' })).rejects.toThrow(
      'name is required',
    );
  });

  it('soft-deletes, frees the name, and hides the row everywhere', async () => {
    const a = await store.create(input);
    clock = 2_000;
    expect(await store.softDelete(a.id, 7)).toBe(true);
    expect(await store.findById(a.id)).toBeNull();
    expect(await store.findActive()).toEqual([]);
    expect(await store.listViews()).toEqual([]);
    expect(await store.softDelete(a.id)).toBe(false);
    const raw = await db('kpax_connections').where({ id: a.id }).first();
    expect(raw.deleted_at).toBe(2000);
    await expect(store.create(input)).resolves.toMatchObject({
      name: 'Acme',
    });
  });

  it('returns an empty secret when a row cannot be decrypted', async () => {
    const a = await store.create(input);
    await db('kpax_connections')
      .where({ id: a.id })
      .update({ client_secret_encrypted: 'garbage' });
    expect((await store.findById(a.id))!.clientSecret).toBe('');
  });

  it('refuses writes without an encrypt function', async () => {
    const readOnly = new KnexKpaxConnectionStore({ knex: () => db, decrypt });
    await expect(readOnly.create(input)).rejects.toThrow('needs an `encrypt`');
  });
});
