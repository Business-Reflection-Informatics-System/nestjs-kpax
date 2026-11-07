# Client API

A `KpaxClient` talks to one KPAX instance. Get it from the registry
(`await registry.get(id)`) or the factory (`factory.forConnection(conn)`). Never construct
it yourself.

All dates are **UTC**. Date parameters are `YYYY-MM-DD`; `last_check` filters use
`YYYY-MM-DD HH:mm:ss`.

## Typed access to every endpoint — `call()`

```ts
const runs = await client.call('get', '/rules/executions-history', { query: { rule_id: 3, page: 2 } });
const cycles = await client.call('get', '/devices/{device_id}/supply-cycles', {
  path: { device_id: 42 },
  query: { cartridge: 'black', nb_cycles: 3 },
});
await client.call('post', '/labels', { body: { name: 'Region-East' } });
```

Paths, methods, path/query parameters, JSON bodies and response types all come from the
KPAX spec, so typos and wrong parameter types fail at compile time. Options:

| Option | For |
|---|---|
| `path` | `{device_id}`-style parameters (URL-encoded) |
| `query` | Query parameters (`undefined`/`null` are dropped) |
| `body` | JSON request body |
| `form` | `application/x-www-form-urlencoded` body (`POST /devices/search`) |

Returns the parsed 2xx body (`undefined` for 204); throws `KpaxApiError` otherwise.

## Convenience methods

### Server & hierarchy

| Method | Endpoint | Returns |
|---|---|---|
| `serverStatus()` | `GET /server/status` | Server info — cheapest credentials check |
| `hierarchy(scope?)` | `GET /hierarchy-elements` | Accounts, agents, devices, dynamic groups under the client's level (or `{ objectType, objectId }`) |

### Accounts

| Method | Notes |
|---|---|
| `listAccounts({ parentId?, withChildren?, page? })` | One page: `{ data, meta, links }` |
| `iterateAccounts({ parentId?, withChildren? })` | Async iterator over all pages |
| `getAccount(id)` | |

### Devices

| Method | Notes |
|---|---|
| `listDevices({ scope?, schema?, page?, perPage?, sort? })` | One page. `perPage` ≤ 1000, **core schema only** |
| `iterateDevices({ scope?, schema?, perPage?, sort? })` | All pages; defaults to 1000/page on core |
| `getDevice(id)` | `DeviceFull` (meters, supplies, alerts…) |
| `searchDevicesBySerial(serial, { scope?, schema? })` | Partial match, ≥ 5 chars, all pages |
| `findDeviceBySerial(serial, { scope? })` | **Exact**, case-insensitive match on effective or original serial. `null` if none; throws `KpaxApiError` (409) if several devices match |
| `searchDevices({ scope?, attributes?, filters?, attributesWithLastCheck?, profileIds?, sort?, page?, perPage? })` | Bulk read of chosen attributes across a fleet (form-encoded) |
| `iterateDeviceSearch(opts)` | All pages of `searchDevices` |
| `listDeviceAttributes(filter?, locale?)` | Attribute catalogue to pick `attributes` from |
| `listProfiles()` | Device profiles |

`scope` is `{ parentType: 'account' | 'dynamic_group', parentId, withChildren? }`. Omit it
to use the API client's own hierarchy level. `withChildren` is ignored for dynamic groups.

### Device history

| Method | Endpoint |
|---|---|
| `getDeviceVolumes(id, { interval?, startDate, endDate, volumeName? })` | `GET /devices/{id}/volumes` — `{ engine_count: { '2026-11-01': 120, … }, … }` |
| `getDeviceHistory(id, { startDate?, endDate?, sort? })` | Daily snapshots |
| `getDeviceAttributeHistory(id, { namespace, name }, { startDate?, endDate?, sort? })` | One attribute over time |
| `getSupplyCycles(id, cartridge, nbCycles?)` | Toner replacement cycles (`black`/`cyan`/`magenta`/`yellow`) |
| `getTechnicalAlertHistory(id, { startDate?, endDate?, sort? })` | Alert events, all pages |

`interval`: `daily` (default) · `weekly` · `monthly` · `quarterly` · `yearly`.
`volumeName`: `engine_count`, `total_mono`, `total_color`, `total_print`, `total_copy`,
`total_scan`, `total_fax`, `total_duplex`, … (see the type for the full list).

## Pagination helpers

```ts
import { kpaxPaginate, kpaxCollect } from '@bizreflex/nestjs-kpax';

for await (const device of client.iterateDevices()) { … }          // streaming
const all = await kpaxCollect(client.iterateAccounts());             // into an array
const first3 = kpaxPaginate((page) => client.listDevices({ page }), { maxPages: 3 });
```

Iteration stops at `meta.last_page`, on an empty page, or when `meta` is missing.

## Types

All schemas are exported: `KpaxDeviceCore`, `KpaxDeviceFull`, `KpaxDeviceSearchResult`,
`KpaxDeviceVolumes`, `KpaxDeviceDailySnapshot`, `KpaxDeviceSupplyCycle`,
`KpaxAlertHistoryEvent`, `KpaxAccount`, `KpaxProfile`, `KpaxPage<T>`, … and the raw
generated `paths`, `components`, `operations`.

## Recipes

### Match a KPAX alert e-mail to a device

```ts
const client = await registry.get(connectionId);
const device = await client.findDeviceBySerial(csvRow.serialNumber);
if (!device) throw new Error(`Serial ${csvRow.serialNumber} not in KPAX`);
const full = await client.getDevice(device.id);
```

### Monthly page counts for billing

```ts
const vols = await client.getDeviceVolumes(deviceId, {
  interval: 'monthly',
  startDate: '2026-10-01',
  endDate: '2026-10-31',
});
const mono = vols.total_mono?.['2026-10-01'] ?? 0;
const color = vols.total_color?.['2026-10-01'] ?? 0;
```

### Meters for every device checked in since yesterday

```ts
const since = '2026-11-06 00:00:00'; // UTC
for await (const d of client.iterateDeviceSearch({
  scope: { parentType: 'account', parentId: 12, withChildren: true },
  attributes: [
    { namespace: 'kpax.core.print.devices', name: 'engine_count' },
    { namespace: 'kpax.core.print.devices', name: 'total_mono' },
    { namespace: 'kpax.core.print.devices', name: 'total_color' },
  ],
  filters: [{ namespace: 'kpax.core.print.devices', name: 'last_check', operator: 'greater_or_equal', value: since }],
  attributesWithLastCheck: true,
  perPage: 1000,
})) {
  // d['kpax.core.print.devices'].engine_count.value …
}
```

### Rate-limit visibility

```ts
await client.serverStatus();
client.lastRateLimit; // { limit: 60, remaining: 42, reset: 1789… } — last headers seen
```
