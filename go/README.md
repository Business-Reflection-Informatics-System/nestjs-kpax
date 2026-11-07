# kpax (Go)

Go client for the **KPAX API v1**: OAuth2 client credentials, retries and rate limits,
pagination iterators, typed models and device helpers. Standard library only. Go 1.23+.

```go
import "github.com/Business-Reflection-Informatics-System/nestjs-kpax/go"

client, err := kpax.New(kpax.Config{
	Host:         "https://acme.kpax.cloud",
	ClientID:     os.Getenv("KPAX_CLIENT_ID"),
	ClientSecret: os.Getenv("KPAX_CLIENT_SECRET"),
})
if err != nil { log.Fatal(err) }

device, err := client.FindDeviceBySerial(ctx, "ABCD123456789", nil) // nil, nil if no match
for d, err := range client.Devices(ctx, kpax.DeviceListOptions{
	Scope: &kpax.Scope{ParentType: "account", ParentID: 12, WithChildren: kpax.Bool(true)},
}) {
	if err != nil { return err }
	fmt.Println(d.ID, d.SerialNumber)
}
```

## Install

```bash
go get github.com/Business-Reflection-Informatics-System/nestjs-kpax/go@v0.1.0
```

Releases tag the module as `go/vX.Y.Z` (Go's convention for modules in a subdirectory),
so `@v0.1.0` resolves to the `go/v0.1.0` tag.

## Client

`kpax.Config`: `Host`, `ClientID`, `ClientSecret` (required), `Scopes` (default
`kpax.DefaultScopes`), `Timeout` (30s per attempt), `MaxRetries` (4; `-1` disables),
`BaseDelay`/`MaxDelay` (500ms/60s), `TokenRefreshSkew` (60s), `HTTPClient`.

A `*kpax.Client` is safe for concurrent use; goroutines share one token. Every call takes a
`context.Context`, which also cancels retry waits.

| Method | Returns |
|---|---|
| `ServerStatus(ctx)` | `*ServerStatus` |
| `Hierarchy(ctx, objectType, objectID)` | `map[string]any` |
| `ListAccounts` / `Accounts` (iterator) / `GetAccount` | `*Page[Account]` / `iter.Seq2[Account, error]` / `*Account` |
| `ListDevices(ctx, DeviceListOptions)` / `Devices` (iterator, 1000/page) | `*Page[Device]` / `iter.Seq2[Device, error]` |
| `GetDevice(ctx, id)` | `*Device` (meters, supplies… in `Raw`, see `RawMap()`) |
| `SearchDevicesBySerial` / `FindDeviceBySerial` | `[]Device` / `*Device` |
| `SearchDevices(ctx, DeviceSearchOptions)` / `DeviceSearch` (iterator) | `*Page[map[string]any]` |
| `GetDeviceVolumes(ctx, id, VolumeOptions)` | `Volumes` (`map[name]map[date]float64`) |
| `GetDeviceHistory`, `GetDeviceAttributeHistory` | `[]map[string]any` |
| `GetSupplyCycles(ctx, id, cartridge, nbCycles)` | `[]map[string]any` |
| `GetTechnicalAlertHistory(ctx, id, DateRange)` | `[]AlertHistoryEvent` (all pages) |
| `ListDeviceAttributes`, `ListProfiles` | `any` |
| `Do(ctx, method, path, RequestOptions, out)` | any endpoint, same pipeline |
| `TestConnection(ctx)` / `kpax.TestCredentials(ctx, cfg)` | `ConnectionTestResult` (never errors) |
| `LastRateLimit()` | last `X-RateLimit-*` values |

Helpers: `kpax.Paginate`, `kpax.Collect`, `kpax.Bool`, `kpax.IsStatus(err, 404)`.

```go
// Any endpoint
var runs map[string]any
err := client.Do(ctx, "GET", "/rules/executions-history",
	kpax.RequestOptions{Query: map[string]any{"rule_id": 3, "page": 2}}, &runs)
```

## Errors

| Type | When |
|---|---|
| `*kpax.ConfigError` | Invalid host, missing id/secret (from `New`) |
| `*kpax.AuthError` | `/oauth/token` refused the credentials (`Status`, `Body`) |
| `*kpax.APIError` | Non-2xx after retries (`Status`, `Method`, `Path`, `Body`); `Status == 0` for a persistent network error |
| `kpax.ErrSerialTooShort` | Serial search under 5 characters |
| `context.Canceled` / `DeadlineExceeded` | Your context ended (also during retry waits) |

## Behaviour

Retries, rate limits and token handling follow the shared
[client behaviour spec](../docs/client-behavior.md); `client_test.go` covers each item. KPAX
notes (scopes, hierarchy, dates): [../docs/kpax-api-notes.md](../docs/kpax-api-notes.md).

## Development

```bash
cd go
gofmt -l . && go vet ./... && go test -race ./...
```

License: [MIT](LICENSE) © 2026 BizReflex LLC-FZ
