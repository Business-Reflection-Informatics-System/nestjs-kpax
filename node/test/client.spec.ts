import 'reflect-metadata';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { HttpService } from '@nestjs/axios';
import { Test } from '@nestjs/testing';
import {
  KpaxApiError,
  KpaxAuthError,
  KpaxClient,
  KpaxClientFactory,
  KpaxModule,
  kpaxCollect,
} from '../src';
import { json, MockKpax } from './helpers/mock-kpax';

const CONN = {
  host: 'https://acme.kpax.cloud/',
  clientId: 'cid',
  clientSecret: 'secret-1',
};

async function setup() {
  const mock = new MockKpax();
  const moduleRef = await Test.createTestingModule({
    imports: [KpaxModule.forRoot({ baseDelayMs: 1 })],
  })
    .overrideProvider(HttpService)
    .useValue(mock.httpService())
    .compile();
  const factory = moduleRef.get(KpaxClientFactory);
  return { mock, factory, client: factory.forConnection(CONN) };
}

let sleeps: number[];
beforeEach(() => {
  sleeps = [];
  jest
    .spyOn(KpaxClient.prototype as any, 'sleep')
    .mockImplementation(async (ms: any) => {
      sleeps.push(ms);
    });
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('auth', () => {
  it('uses client credentials and sends the bearer token', async () => {
    const { mock, client } = await setup();
    await client.serverStatus();
    const { host, form } = mock.tokenRequests[0];
    expect(host).toBe('https://acme.kpax.cloud');
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('client_id')).toBe('cid');
    expect(form.get('client_secret')).toBe('secret-1');
    expect(form.get('scope')).toContain('devices:read');
    expect(mock.calls[0].url.href).toBe(
      'https://acme.kpax.cloud/api/v1/server/status',
    );
    expect(mock.calls[0].auth).toBe('Bearer tok-1');
  });

  it('shares one token across concurrent calls', async () => {
    const { mock, client } = await setup();
    await Promise.all([
      client.serverStatus(),
      client.serverStatus(),
      client.serverStatus(),
    ]);
    expect(mock.tokenRequests).toHaveLength(1);
  });

  it('refreshes once on 401, then surfaces a persistent 401', async () => {
    const { mock, client } = await setup();
    let n = 0;
    mock.handler = () =>
      ++n === 1 ? json({ message: 'Unauthenticated.' }, 401) : json({ ok: 1 });
    await client.serverStatus();
    expect(mock.calls.map((c) => c.auth)).toEqual([
      'Bearer tok-1',
      'Bearer tok-2',
    ]);

    mock.handler = () => json({ message: 'Invalid scope(s) provided.' }, 401);
    const err = (await client.serverStatus().catch((e) => e)) as KpaxApiError;
    expect(err).toBeInstanceOf(KpaxApiError);
    expect(err.isUnauthorized).toBe(true);
    expect(err.message).toContain('Invalid scope');
  });

  it('throws KpaxAuthError when the token endpoint refuses', async () => {
    const { mock, client } = await setup();
    mock.tokenHandler = () => json({ error: 'invalid_client' }, 401);
    const err = await client.serverStatus().catch((e) => e);
    expect(err).toBeInstanceOf(KpaxAuthError);
    expect(err.message).toContain('invalid_client');
  });
});

describe('retries and rate limits', () => {
  it('waits Retry-After on 429', async () => {
    const { mock, client } = await setup();
    let n = 0;
    mock.handler = () =>
      ++n === 1
        ? json({}, 429, { 'retry-after': '7' })
        : json({ status: 'ok' });
    await client.serverStatus();
    expect(mock.calls).toHaveLength(2);
    expect(sleeps).toContain(7000);
  });

  it('holds requests when X-RateLimit-Remaining reaches 0', async () => {
    const { mock, client } = await setup();
    const reset = Math.floor(Date.now() / 1000) + 5;
    mock.handler = () =>
      json({ ok: 1 }, 200, {
        'x-ratelimit-limit': '60',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(reset),
      });
    await client.serverStatus();
    expect(client.lastRateLimit).toEqual({ limit: 60, remaining: 0, reset });
    await client.serverStatus();
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeGreaterThan(3000);
  });

  it('retries 5xx on GET but never re-sends a POST', async () => {
    const { mock, client } = await setup();
    let n = 0;
    mock.handler = () => (++n < 3 ? json({}, 503) : json({ ok: 1 }));
    await client.serverStatus();
    expect(mock.calls).toHaveLength(3);

    mock.calls = [];
    mock.handler = () => json({ message: 'boom' }, 502);
    const err = await client.searchDevices({}).catch((e) => e);
    expect(err.status).toBe(502);
    expect(mock.calls).toHaveLength(1);
  });

  it('does not retry 4xx', async () => {
    const { mock, client } = await setup();
    mock.handler = () => json({ message: 'This action is unauthorized.' }, 403);
    const err = await client.getDevice(42).catch((e) => e);
    expect(err.isForbidden).toBe(true);
    expect(mock.calls).toHaveLength(1);
  });
});

describe('devices', () => {
  it('walks every page with per_page=1000 on the core schema', async () => {
    const { mock, client } = await setup();
    mock.handler = ({ url }) => {
      const p = Number(url.searchParams.get('page'));
      const ids = p === 1 ? [1, 2] : p === 2 ? [3] : [4];
      return json({
        data: ids.map((id) => ({ id })),
        meta: { current_page: p, last_page: 3 },
      });
    };
    const devices = await kpaxCollect(
      client.iterateDevices({
        scope: { parentType: 'account', parentId: 12, withChildren: true },
      }),
    );
    expect(devices.map((d) => d.id)).toEqual([1, 2, 3, 4]);
    expect(Object.fromEntries(mock.calls[0].url.searchParams)).toEqual({
      parent_type: 'account',
      parent_id: '12',
      with_children: 'true',
      schema: 'core',
      per_page: '1000',
      page: '1',
    });
  });

  it('findDeviceBySerial matches exactly', async () => {
    const { mock, client } = await setup();
    mock.handler = () =>
      json({
        data: [
          {
            id: 7,
            serial_number: 'ABCD123456789',
            serial_number_origin: 'ABCD123456789',
          },
          {
            id: 8,
            serial_number: 'ABCD1234567890',
            serial_number_origin: 'ABCD1234567890',
          },
        ],
        meta: { current_page: 1, last_page: 1 },
      });
    expect((await client.findDeviceBySerial(' abcd123456789 '))?.id).toBe(7);
    expect(await client.findDeviceBySerial('ABCD123456780')).toBeNull();
    await expect(client.findDeviceBySerial('ABC')).rejects.toThrow(RangeError);
  });

  it('form-encodes /devices/search', async () => {
    const { mock, client } = await setup();
    mock.handler = () =>
      json({ data: [], meta: { current_page: 1, last_page: 1 } });
    await client.searchDevices({
      scope: { parentType: 'account', parentId: 3, withChildren: true },
      attributes: [
        { namespace: 'kpax.core.print.devices', name: 'engine_count' },
      ],
      filters: [
        {
          namespace: 'kpax.core.print.devices',
          name: 'last_check',
          operator: 'greater',
          value: '2026-11-01 00:00:00',
        },
      ],
      profileIds: [1, 4],
      perPage: 500,
    });
    const form = new URLSearchParams(mock.calls[0].body);
    expect(mock.calls[0].method).toBe('POST');
    expect(form.get('with_children')).toBe('1');
    expect(JSON.parse(form.get('attributes')!)).toEqual([
      { namespace: 'kpax.core.print.devices', name: 'engine_count' },
    ]);
    expect(JSON.parse(form.get('filters')!)[0].operator).toBe('greater');
    expect(form.get('profile_id')).toBe('1,4');
  });

  it('builds volume queries and typed call() paths', async () => {
    const { mock, client } = await setup();
    mock.handler = () => json({ engine_count: { '2026-11-01': 120 } });
    const v = await client.getDeviceVolumes(42, {
      startDate: '2026-11-01',
      endDate: '2026-11-05',
      volumeName: 'engine_count',
    });
    expect(v).toEqual({ engine_count: { '2026-11-01': 120 } });
    expect(mock.calls[0].url.pathname).toBe('/api/v1/devices/42/volumes');

    mock.handler = () => json([]);
    await client.call('get', '/devices/{device_id}/supply-cycles', {
      path: { device_id: 9 },
      query: { cartridge: 'black' },
    });
    expect(mock.calls[1].url.pathname).toBe('/api/v1/devices/9/supply-cycles');
    expect(mock.calls[1].url.searchParams.get('cartridge')).toBe('black');
  });
});

describe('factory.testConnection', () => {
  it('reports ok, auth and config failures without throwing', async () => {
    const { mock, factory } = await setup();
    expect((await factory.testConnection(CONN)).ok).toBe(true);

    mock.tokenHandler = () => json({ error: 'invalid_client' }, 401);
    const bad = await factory.testConnection(CONN);
    expect(bad).toMatchObject({ ok: false, stage: 'auth', status: 401 });

    const cfg = await factory.testConnection({ ...CONN, host: 'nope' });
    expect(cfg).toMatchObject({ ok: false, stage: 'config' });
  });
});
