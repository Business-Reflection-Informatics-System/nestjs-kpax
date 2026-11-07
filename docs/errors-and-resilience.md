# Errors and resilience

## Error types

| Error | Thrown when | Useful fields |
|---|---|---|
| `KpaxApiError` | KPAX returned non-2xx after retries, or a network error persisted (`status: 0`) | `status`, `method`, `url`, `body`, `isUnauthorized`, `isForbidden`, `isNotFound`, `isRateLimited` |
| `KpaxAuthError` | `POST /oauth/token` refused the credentials or was unreachable (`status: 0`) | `status`, `host`, `body` |
| `KpaxConfigurationError` | Invalid connection (bad URL, missing id/secret), no store registered, store validation (duplicate name…) | `message` |
| `KpaxConnectionNotFoundError` | `registry.get(id)` for an unknown / inactive / deleted id (extends `KpaxConfigurationError`) | `connectionId` |
| `RangeError` | `searchDevicesBySerial` / `findDeviceBySerial` with fewer than 5 characters | |

None of these are `HttpException`s on purpose: a 401 or 403 from KPAX must not become
*your* API's 401/403 (which would log the user out or look like a permissions problem).
Map them at your controller boundary:

```ts
if (e instanceof KpaxConnectionNotFoundError) throw new NotFoundException(e.message);
if (e instanceof KpaxConfigurationError) throw new BadRequestException(e.message);
if (e instanceof KpaxAuthError) throw new BadGatewayException('KPAX rejected our credentials');
if (e instanceof KpaxApiError && e.isNotFound) throw new NotFoundException('Not found in KPAX');
if (e instanceof KpaxApiError) throw new BadGatewayException(`KPAX error ${e.status}`);
```

### KPAX status codes

| Status | Meaning in KPAX | What to do |
|---|---|---|
| 400 | Bad parameters | Fix the call |
| 401 | Bad/expired token **or missing scope** | The client already refreshed once. Persistent 401 on some endpoints only → add the scope to the connection |
| 403 | Resource outside the API client's hierarchy level | Use a client whose level covers it, or check `parent_id` |
| 404 | Not found | |
| 409 | Delete refused: resource still holds objects (message lists them) | Also used by `findDeviceBySerial` for ambiguous serials |
| 429 | Rate limited | Handled automatically; surfaces only after `maxRetries` |

## Retry policy

| Condition | GET / PUT / DELETE | POST |
|---|---|---|
| 401 | Refresh token, retry once | Same |
| 429 | Wait `Retry-After` (or until `X-RateLimit-Reset`, else backoff), retry | Same — KPAX didn't process it |
| 5xx | Exponential backoff + jitter, retry | **No retry** (may have been processed) |
| Network error / timeout | Backoff, retry | **No retry** |
| Other 4xx | No retry | No retry |

Backoff for attempt *n*: random between `baseDelayMs·2ⁿ/2` and `baseDelayMs·2ⁿ`, capped at
`maxDelayMs`. `Retry-After` is also capped at `maxDelayMs`. Retries stop after `maxRetries`.

With defaults (500 ms base, 4 retries) a GET facing persistent 503s gives up after roughly
0.25+0.5+1+2 … ≈ 4–8 s of waiting.

## Rate limits

KPAX sends `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (unix seconds)
and `Retry-After` on 429.

- Every response updates `client.lastRateLimit`.
- When `Remaining` hits `0`, that client holds new requests until `Reset` instead of
  burning requests on 429s. Other connections are unaffected.

For bulk jobs prefer fewer, larger calls: `searchDevices` with `perPage: 1000` over
per-device `getDevice` loops.

## Timeouts

`timeoutMs` (default 30 s) applies to each attempt, including the token request. A
timed-out attempt counts as a network error.

## Logging

The client logs retries at `warn` (`KpaxClient` context); the registry logs loads,
updates, removals and skipped rows (`KpaxConnectionRegistry` context). Secrets and tokens
are never logged.
