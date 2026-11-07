import 'reflect-metadata';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { Global, INestApplication, Module } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { Test } from '@nestjs/testing';
import knexFactory, { Knex } from 'knex';
import request from 'supertest';
import { KpaxClient, KpaxConnectionRegistry } from '@bizreflex/nestjs-kpax';
import { KpaxConnectionsModule } from '../examples/nestjs-admin/kpax-connections.module';
import { KNEX } from '../examples/nestjs-admin/kpax-connection.store';
import { MockKpax } from './helpers/mock-kpax';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const migration = require('../examples/knex-migration/20260101000000_create_kpax_connections_table.js');

const BASE = '/admin/kpax-connections';
const apps: INestApplication[] = [];
let db: Knex;
let mock: MockKpax;

async function boot() {
  @Global()
  @Module({ providers: [{ provide: KNEX, useValue: db }], exports: [KNEX] })
  class DatabaseModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [DatabaseModule, KpaxConnectionsModule],
  })
    .overrideProvider(HttpService)
    .useValue(mock.httpService())
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  apps.push(app);
  return {
    server: app.getHttpServer(),
    registry: app.get(KpaxConnectionRegistry),
  };
}

beforeEach(async () => {
  process.env.KPAX_SECRET_KEY = 'test-key';
  process.env.KPAX_SYNC_INTERVAL_MS = '0';
  db = knexFactory({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await migration.up(db);
  mock = new MockKpax();
  jest
    .spyOn(KpaxClient.prototype as any, 'sleep')
    .mockImplementation(async () => undefined);
});

afterEach(async () => {
  jest.restoreAllMocks();
  while (apps.length) await apps.pop()!.close();
  await db.destroy();
});

const body = {
  name: 'Acme',
  host: 'https://acme.kpax.cloud',
  clientId: 'cid',
  clientSecret: 'secret-1',
};

describe('examples/nestjs-admin', () => {
  it('creates, uses, rotates and deletes a connection over HTTP', async () => {
    const a = await boot();
    const b = await boot(); // a second process sharing the DB

    const created = (await request(a.server).post(BASE).send(body).expect(201))
      .body;
    expect(created).toMatchObject({
      name: 'Acme',
      hasClientSecret: true,
      loaded: true,
    });
    expect(JSON.stringify(created)).not.toContain('secret-1');
    const raw = await db('kpax_connections').first();
    expect(raw.client_secret_encrypted).toMatch(/^v1:/);

    await (await a.registry.get(created.id)).serverStatus();
    await (await b.registry.get(created.id)).serverStatus(); // loaded on miss

    await request(a.server)
      .patch(`${BASE}/${created.id}`)
      .send({ clientSecret: 'secret-2' })
      .expect(200);
    await (await a.registry.get(created.id)).serverStatus();
    expect((await b.registry.sync()).updated).toEqual([created.id]);
    await (await b.registry.get(created.id)).serverStatus();

    // Each process holds its own token cache: one token per process per secret.
    expect(mock.tokenRequests.map((t) => t.form.get('client_secret'))).toEqual([
      'secret-1',
      'secret-1',
      'secret-2',
      'secret-2',
    ]);

    await request(a.server).delete(`${BASE}/${created.id}`).expect(204);
    expect(a.registry.has(created.id)).toBe(false);
    await request(a.server).get(`${BASE}/${created.id}`).expect(404);
  });

  it('validates input and tests credentials', async () => {
    const { server } = await boot();
    await request(server)
      .post(BASE)
      .send({ ...body, host: 'nope' })
      .expect(400);
    await request(server).post(BASE).send(body).expect(201);
    await request(server)
      .post(BASE)
      .send({ ...body, name: 'ACME' })
      .expect(400);

    const ok = await request(server)
      .post(`${BASE}/test`)
      .send(body)
      .expect(200);
    expect(ok.body.ok).toBe(true);
    mock.tokenHandler = () => ({
      status: 401,
      body: { error: 'invalid_client' },
    });
    const bad = await request(server)
      .post(`${BASE}/test`)
      .send(body)
      .expect(200);
    expect(bad.body).toMatchObject({ ok: false, stage: 'auth' });
  });
});
