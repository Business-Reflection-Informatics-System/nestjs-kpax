# Client behaviour spec

Every client in this repository (Node, Python, Go, .NET, PHP) implements the behaviour
below and has tests for each item, tagged with its id (`B01`…). The shared JSON fixtures in
[`fixtures/`](../fixtures) are what those tests serve from their mock KPAX.

## Configuration

| | |
|---|---|
| `host` | `https://<instance>.kpax.cloud`. Trimmed; trailing `/` and a trailing `/api/v1` are removed. Must be an `http`/`https` URL. |
| `clientId`, `clientSecret` | Required (non-blank). |
| `scopes` | Default: `accounts:read agents:read devices:read hierarchy-elements:read dynamic-groups:read profiles:read rules:read labels:read server:read` |
| `timeout` | 30 s per attempt |
| `maxRetries` | 4 |
| `baseDelay` / `maxDelay` | 500 ms / 60 s |
| `tokenRefreshSkew` | 60 s |

Invalid configuration raises a **configuration error** at construction (B10).

## Behaviour

| Id | Behaviour |
|---|---|
| **B01** | Token: `POST {host}/oauth/token`, `application/x-www-form-urlencoded`: `grant_type=client_credentials`, `client_id`, `client_secret`, `scope` (space-joined). |
| **B02** | API calls go to `{host}/api/v1{path}` with `Authorization: Bearer <token>` and `Accept: application/json`. |
| **B03** | The token is cached until `expires_in − tokenRefreshSkew` (`expires_in` defaults to 3600). Concurrent callers share one token request. |
| **B04** | API 401 → drop the token, fetch a new one, retry **once**. A second 401 → API error with status 401. |
| **B05** | Token endpoint non-2xx (or unreachable) → **auth error** with status and body. |
| **B06** | 429 → wait `Retry-After` (seconds or HTTP date), else until `X-RateLimit-Reset`, else backoff; capped at `maxDelay`; retry. Applies to **every** method. |
| **B07** | 5xx or network error → exponential backoff with jitter (`base·2ⁿ/2 … base·2ⁿ`, capped), retry — **only GET, PUT, DELETE**. POST is never retried on 5xx/network errors. Other 4xx are never retried. At most `maxRetries` retries. |
| **B08** | `X-RateLimit-Remaining: 0` with `X-RateLimit-Reset` → later requests on the same client wait until the reset. The last seen `{limit, remaining, reset}` is exposed. |
| **B09** | Non-2xx after retries → **API error** with `status`, `method`, `path`, parsed `body`; the message includes KPAX's `message`/`error` field when present. |
| **B10** | Configuration validation (see above). |
| **B11** | Pagination follows `meta.current_page` / `meta.last_page`; stops on the last page, an empty `data`, or missing `meta`. |
| **B12** | `listDevices` defaults to `schema=core`; `per_page` is only sent with `core`; iterating devices defaults to 1000 per page. |
| **B13** | `findDeviceBySerial`: input trimmed, ≥ 5 characters (else an argument error); searches all pages of `/devices/search-by-serial-number`; returns the device whose `serial_number` **or** `serial_number_origin` equals the input case-insensitively; none → null/nil; more than one → API error with status 409. |
| **B14** | `searchDevices`: `POST /devices/search` form-encoded; `attributes` and `filters` are JSON strings; `with_children` / `attributes_with_last_check` are `1`/`0`; `profile_id` is comma-joined. |
| **B15** | `getDeviceVolumes`: query `interval` (default `daily`), `start_date`, `end_date`, optional `volume_name`. Result: `{ volumeName: { date: number } }`. |
| **B16** | Query parameters that are null/undefined are omitted. Booleans in GET queries are sent as `true`/`false`. Path parameters are URL-encoded. |
| **B17** | `testConnection` never throws: returns `{ ok, stage?: config\|auth\|api, status?, message?, latencyMs }`, calling `GET /server/status`. |
| **B18** | Numeric ids are accepted as JSON numbers or numeric strings. |

## Methods (all clients)

Names follow each language's conventions (`find_device_by_serial`, `FindDeviceBySerialAsync`, …).

| Method | KPAX endpoint |
|---|---|
| `serverStatus` | `GET /server/status` |
| `hierarchy(objectType?, objectId?)` | `GET /hierarchy-elements` |
| `listAccounts` / iterate / `getAccount` | `/accounts`, `/accounts/{id}` |
| `listDevices` / iterate / `getDevice` | `/devices`, `/devices/{id}` |
| `searchDevicesBySerial` / `findDeviceBySerial` | `GET /devices/search-by-serial-number` |
| `searchDevices` / iterate | `POST /devices/search` |
| `getDeviceVolumes` | `GET /devices/{id}/volumes` |
| `getDeviceHistory` | `GET /devices/{id}/history` |
| `getDeviceAttributeHistory` | `GET /devices/{id}/attributes/history` |
| `getSupplyCycles` | `GET /devices/{id}/supply-cycles` |
| `getTechnicalAlertHistory` (all pages) | `GET /devices/{id}/technical-status-events/history` |
| `listDeviceAttributes`, `listProfiles` | `/devices/attributes`, `/profiles` |
| `request(method, path, …)` | Any endpoint, same auth/retry pipeline |
| `testConnection` | `GET /server/status` |

Typed models: `Account`, `Device` (core fields), `PaginationMeta`, `Page<T>`, `ServerStatus`,
`AlertHistoryEvent`. Everything else (full device, history, supply cycles, search results,
hierarchy) is returned as parsed JSON (maps / dictionaries), and every typed model also keeps
the raw JSON it was built from.
