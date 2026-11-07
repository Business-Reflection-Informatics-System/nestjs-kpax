# bizreflex/kpax (PHP)

PHP client for the **KPAX API v1**: OAuth2 client credentials, retries and rate limits,
generator-based pagination, typed models and device helpers. No Composer dependencies;
PHP 8.1+ with `ext-json` and `ext-curl` (or your own transport).

```php
use BizReflex\Kpax\KpaxClient;

$kpax = new KpaxClient('https://acme.kpax.cloud', $clientId, $clientSecret);

$device = $kpax->findDeviceBySerial('ABCD123456789');   // exact match or null
foreach ($kpax->iterDevices(parentType: 'account', parentId: 12, withChildren: true) as $d) {
    echo $d->id, ' ', $d->serialNumber, PHP_EOL;
}
```

## Install

The package lives in the `php/` folder of the repository. Every `v*` release attaches
`bizreflex-kpax-php-<version>.zip`; point Composer at it with a `package` repository:

```json
{
    "repositories": [{
        "type": "package",
        "package": {
            "name": "bizreflex/kpax",
            "version": "0.1.0",
            "dist": {
                "url": "https://github.com/Business-Reflection-Informatics-System/nestjs-kpax/releases/download/v0.1.0/bizreflex-kpax-php-0.1.0.zip",
                "type": "zip"
            },
            "autoload": { "psr-4": { "BizReflex\\Kpax\\": "src/" } }
        }
    }],
    "require": { "bizreflex/kpax": "0.1.0" }
}
```

## Client

```php
new KpaxClient(
    host: 'https://acme.kpax.cloud',
    clientId: '…',
    clientSecret: '…',
    scopes: null,            // default KpaxClient::DEFAULT_SCOPES
    timeout: 30.0,           // seconds per attempt
    maxRetries: 4, baseDelay: 0.5, maxDelay: 60.0,
    tokenRefreshSkew: 60.0,
    transport: null,         // default CurlTransport; implement Transport for Guzzle / PSR-18
);
```

| Method | Returns |
|---|---|
| `serverStatus()` | `ServerStatus` |
| `hierarchy(?objectType, ?objectId)` | `array` |
| `listAccounts(...)` / `iterAccounts(...)` / `getAccount($id)` | `Page<Account>` / `Generator<Account>` / `Account` |
| `listDevices(parentType:, parentId:, withChildren:, schema: 'core', page:, perPage:, sort:)` | `Page<Device>` |
| `iterDevices(...)` | `Generator<Device>` (1000 per page) |
| `getDevice($id)` | `Device` (meters, supplies… in `->raw`) |
| `searchDevicesBySerial($serial)` / `findDeviceBySerial($serial)` | `list<Device>` / `?Device` |
| `searchDevices(attributes:, filters:, ...)` / `iterDeviceSearch(...)` | `Page<array>` / `Generator<array>` |
| `getDeviceVolumes($id, $start, $end, interval: 'daily', volumeName: null)` | `[name => [date => count]]` |
| `getDeviceHistory`, `getDeviceAttributeHistory`, `getSupplyCycles` | `list<array>` |
| `getTechnicalAlertHistory($id, ...)` | `list<AlertHistoryEvent>` (all pages) |
| `listDeviceAttributes`, `listProfiles` | decoded JSON |
| `request($method, $path, $pathParams, $query, $json, $form)` | any endpoint, same pipeline |
| `testConnection()` / `KpaxClient::testCredentials($host, $id, $secret)` | `ConnectionTestResult` (never throws) |
| `lastRateLimit()` | last `X-RateLimit-*` values |

```php
// Any endpoint
$runs = $kpax->request('GET', '/rules/executions-history', query: ['rule_id' => 3, 'page' => 2]);

// Custom transport (e.g. Guzzle)
final class GuzzleTransport implements BizReflex\Kpax\Transport\Transport {
    public function __construct(private GuzzleHttp\Client $http) {}
    public function send(HttpRequest $r): HttpResponse {
        try {
            $res = $this->http->request($r->method, $r->url, ['headers' => $r->headers, 'body' => $r->body,
                'timeout' => $r->timeout, 'http_errors' => false]);
        } catch (GuzzleHttp\Exception\TransferException $e) {
            throw new BizReflex\Kpax\Exception\TransportException($e->getMessage(), 0, $e);
        }
        $headers = [];
        foreach ($res->getHeaders() as $k => $v) { $headers[strtolower($k)] = implode(', ', $v); }
        return new HttpResponse($res->getStatusCode(), $headers, (string) $res->getBody());
    }
}
```

## Errors

| Exception | When |
|---|---|
| `KpaxConfigurationException` | Invalid host, missing id/secret (constructor) |
| `KpaxAuthException` | `/oauth/token` refused the credentials (`->status`, `->body`) |
| `KpaxApiException` | Non-2xx after retries (`->status`, `->method`, `->path`, `->body`, `isForbidden()`, …); status 0 for a persistent network error |
| `InvalidArgumentException` | Serial search under 5 characters |

All library exceptions extend `BizReflex\Kpax\Exception\KpaxException`.

## Behaviour

Retries, rate limits and token handling follow the shared
[client behaviour spec](../docs/client-behavior.md); `tests/` covers each item. A
`KpaxClient` holds its token in memory; in PHP-FPM, that means one token per request unless
you keep the client in a long-running worker. KPAX notes:
[../docs/kpax-api-notes.md](../docs/kpax-api-notes.md).

## Development

```bash
cd php
php tests/run.php        # self-contained runner; no PHPUnit needed
```

License: [MIT](LICENSE) © 2026 BizReflex LLC-FZ
