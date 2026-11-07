import 'reflect-metadata';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { Injectable, Module } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { Test, TestingModule } from '@nestjs/testing';
import {
  KpaxClient,
  KPAX_CONNECTION_STORE,
  KpaxConnectionNotFoundError,
  KpaxConnectionRecord,
  KpaxConnectionRegistry,
  KpaxConnectionStore,
  KpaxModule,
  KpaxRegistryOptions,
} from '../src';
import { MockKpax } from './helpers/mock-kpax';

/** In-memory stand-in for the kpax_connections table, shared by "processes". */
@Injectable()
class MemoryDb {
  rows = new Map<number, KpaxConnectionRecord>();
  failNext = false;
  put(r: Partial<KpaxConnectionRecord> & { id: number }) {
    const prev = this.rows.get(r.id);
    this.rows.set(r.id, {
      name: `conn-${r.id}`,
      host: `https://c${r.id}.kpax.cloud`,
      clientId: `cid-${r.id}`,
      clientSecret: `secret-${r.id}`,
      isActive: true,
      ...prev,
      ...r,
      updatedAt: (prev?.updatedAt ?? 0) + 1,
    } as KpaxConnectionRecord);
  }
}

@Module({ providers: [MemoryDb], exports: [MemoryDb] })
class DbModule {}

@Injectable()
class MemoryStore implements KpaxConnectionStore {
  findByIdCalls = 0;
  constructor(private readonly db: MemoryDb) {}
  async findActive() {
    if (this.db.failNext) {
      this.db.failNext = false;
      throw new Error('db down');
    }
    return [...this.db.rows.values()].filter((r) => r.isActive);
  }
  async findById(id: string | number) {
    this.findByIdCalls++;
    return this.db.rows.get(Number(id)) ?? null;
  }
  async findActiveVersions() {
    return [...this.db.rows.values()]
      .filter((r) => r.isActive)
      .map((r) => ({ id: r.id, updatedAt: r.updatedAt }));
  }
}

const opened: TestingModule[] = [];

async function boot(
  db: MemoryDb,
  registry: KpaxRegistryOptions = {},
  mock = new MockKpax(),
) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      KpaxModule.forRootAsync({
        imports: [DbModule],
        connectionStore: MemoryStore,
        useFactory: () => ({
          baseDelayMs: 1,
          registry: { syncIntervalMs: 0, ...registry },
        }),
      }),
    ],
  })
    .overrideProvider(MemoryDb)
    .useValue(db)
    .overrideProvider(HttpService)
    .useValue(mock.httpService())
    .compile();
  opened.push(moduleRef);
  await moduleRef.init(); // runs onApplicationBootstrap
  return {
    mock,
    registry: moduleRef.get(KpaxConnectionRegistry),
    store: moduleRef.get<MemoryStore>(KPAX_CONNECTION_STORE, { strict: false }),
  };
}

beforeEach(() => {
  jest
    .spyOn(KpaxClient.prototype as any, 'sleep')
    .mockImplementation(async () => undefined);
});
afterEach(async () => {
  jest.restoreAllMocks();
  // Nest 10's close() re-throws a failed init(); ignore it during teardown.
  while (opened.length)
    await opened
      .pop()!
      .close()
      .catch(() => undefined);
});

describe('KpaxConnectionRegistry', () => {
  it('creates one client per active connection on boot', async () => {
    const db = new MemoryDb();
    db.put({ id: 1, name: 'Acme' });
    db.put({ id: 2, name: 'Globex' });
    db.put({ id: 3, isActive: false });
    const { registry, mock } = await boot(db);

    expect(registry.isLoaded).toBe(true);
    expect(registry.list().map((c) => c.name)).toEqual(['Acme', 'Globex']);
    expect(registry.list()[0]).not.toHaveProperty('clientSecret');

    await (await registry.get(1)).serverStatus();
    await (await registry.get('2')).serverStatus();
    expect(mock.calls.map((c) => c.url.origin)).toEqual([
      'https://c1.kpax.cloud',
      'https://c2.kpax.cloud',
    ]);
    await expect(registry.get(3)).rejects.toBeInstanceOf(
      KpaxConnectionNotFoundError,
    );
  });

  it('applies an admin edit with reload(): new secret and host get a new client and token', async () => {
    const db = new MemoryDb();
    db.put({ id: 1 });
    const { registry, mock } = await boot(db);
    const before = await registry.get(1);
    await before.serverStatus();

    db.put({
      id: 1,
      host: 'https://moved.kpax.cloud',
      clientSecret: 'rotated',
    });
    await registry.reload(1);
    const after = await registry.get(1);
    expect(after).not.toBe(before);
    await after.serverStatus();

    expect(
      mock.tokenRequests.map((t) => [t.host, t.form.get('client_secret')]),
    ).toEqual([
      ['https://c1.kpax.cloud', 'secret-1'],
      ['https://moved.kpax.cloud', 'rotated'],
    ]);
  });

  it('keeps the warm client when only the name changes', async () => {
    const db = new MemoryDb();
    db.put({ id: 1 });
    const { registry } = await boot(db);
    const before = await registry.get(1);
    db.put({ id: 1, name: 'Renamed' });
    await registry.reload(1);
    expect(await registry.get(1)).toBe(before);
    expect(registry.list()[0].name).toBe('Renamed');
  });

  it('reload() removes deactivated or deleted connections', async () => {
    const db = new MemoryDb();
    db.put({ id: 1 });
    db.put({ id: 2 });
    const { registry } = await boot(db);
    db.put({ id: 1, isActive: false });
    db.rows.delete(2);
    expect(await registry.reload(1)).toBeNull();
    expect(await registry.reload(2)).toBeNull();
    expect(registry.list()).toEqual([]);
  });

  it('loads a connection created by another process on first get()', async () => {
    const db = new MemoryDb();
    const { registry } = await boot(db);
    db.put({ id: 9, name: 'New' });
    expect(registry.has(9)).toBe(false);
    const client = await registry.get(9);
    expect(client.host).toBe('https://c9.kpax.cloud');
    expect(registry.has(9)).toBe(true);
  });

  it('respects loadOnMiss: false', async () => {
    const db = new MemoryDb();
    const { registry, store } = await boot(db, { loadOnMiss: false });
    db.put({ id: 9 });
    await expect(registry.get(9)).rejects.toBeInstanceOf(
      KpaxConnectionNotFoundError,
    );
    expect(store.findByIdCalls).toBe(0);
  });

  it('sync() picks up changes made elsewhere, re-reading only changed rows', async () => {
    const db = new MemoryDb();
    db.put({ id: 1 });
    db.put({ id: 2 });
    db.put({ id: 3 });
    const { registry, store } = await boot(db);
    const c1 = await registry.get(1);

    db.put({ id: 2, clientSecret: 'changed' }); // edited elsewhere
    db.put({ id: 3, isActive: false }); // disabled elsewhere
    db.put({ id: 4 }); // created elsewhere
    store.findByIdCalls = 0;

    const res = await registry.sync();
    expect(res).toEqual({ added: [4], updated: [2], removed: [3], failed: [] });
    expect(store.findByIdCalls).toBe(2); // only ids 2 and 4
    expect(await registry.get(1)).toBe(c1);
    expect(registry.list().map((c) => c.id)).toEqual([1, 2, 4]);
  });

  it('skips a bad row without blocking the others', async () => {
    const db = new MemoryDb();
    db.put({ id: 1 });
    db.put({ id: 2, host: 'not a url' });
    db.put({ id: 3, clientSecret: '' }); // e.g. secret failed to decrypt
    const { registry } = await boot(db);
    expect(registry.list().map((c) => c.id)).toEqual([1]);
    const res = await registry.sync({ full: true });
    expect(res.failed.map((f) => f.id)).toEqual([2, 3]);
  });

  it('survives a failed boot load and recovers on the next sync', async () => {
    const db = new MemoryDb();
    db.put({ id: 1 });
    db.failNext = true;
    const { registry } = await boot(db);
    expect(registry.isLoaded).toBe(false);
    expect(registry.list()).toEqual([]);
    await registry.sync();
    expect(registry.list().map((c) => c.id)).toEqual([1]);
  });

  it('fails start-up when failOnBootError is set', async () => {
    const db = new MemoryDb();
    db.failNext = true;
    await expect(boot(db, { failOnBootError: true })).rejects.toThrow(
      'db down',
    );
  });

  it('runs periodic sync and stops it on shutdown', async () => {
    jest.useFakeTimers();
    try {
      const db = new MemoryDb();
      const { registry } = await boot(db, { syncIntervalMs: 1000 });
      const spy = jest.spyOn(registry, 'sync');
      db.put({ id: 5 });
      jest.advanceTimersByTime(1000);
      expect(spy).toHaveBeenCalledTimes(1);
      await opened.pop()!.close();
      jest.advanceTimersByTime(5000);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
