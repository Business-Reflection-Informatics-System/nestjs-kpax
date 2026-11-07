# BizReflex.Kpax (.NET)

.NET client for the **KPAX API v1**: OAuth2 client credentials, retries and rate limits,
`IAsyncEnumerable` pagination, typed models and device helpers. No dependencies beyond
the BCL (`HttpClient`, `System.Text.Json`). Targets .NET 8; runs on .NET 8, 9 and 10.

```csharp
using BizReflex.Kpax;

using var kpax = new KpaxClient(new KpaxClientOptions
{
    Host = "https://acme.kpax.cloud",
    ClientId = config["Kpax:ClientId"],
    ClientSecret = config["Kpax:ClientSecret"],
});

var device = await kpax.FindDeviceBySerialAsync("ABCD123456789");   // exact match or null
await foreach (var d in kpax.GetDevicesAsync(new DeviceListOptions { Scope = new Scope("account", 12, WithChildren: true) }))
{
    Console.WriteLine($"{d.Id} {d.SerialNumber}");
}
```

## Install

Every `v*` release attaches `BizReflex.Kpax.<version>.nupkg`. Download it into a local
folder feed and reference it:

```bash
mkdir -p ~/nuget-local
curl -L -o ~/nuget-local/BizReflex.Kpax.0.1.0.nupkg \
  https://github.com/Business-Reflection-Informatics-System/nestjs-kpax/releases/download/v0.1.0/BizReflex.Kpax.0.1.0.nupkg
dotnet nuget add source ~/nuget-local --name local
dotnet add package BizReflex.Kpax --version 0.1.0
```

## With dependency injection

```csharp
services.AddHttpClient("kpax");
services.AddSingleton(sp => new KpaxClient(
    sp.GetRequiredService<IOptions<KpaxClientOptions>>().Value,
    sp.GetRequiredService<IHttpClientFactory>().CreateClient("kpax")));
```

A `KpaxClient` is thread-safe; register it as a singleton per KPAX instance. When you pass
an `HttpClient`, the client doesn't dispose it.

## Client

`KpaxClientOptions`: `Host`, `ClientId`, `ClientSecret` (required), `Scopes` (default
`KpaxClientOptions.DefaultScopes`), `Timeout` (30 s per attempt), `MaxRetries` (4),
`BaseDelay`/`MaxDelay` (500 ms/60 s), `TokenRefreshSkew` (60 s).

| Method | Returns |
|---|---|
| `GetServerStatusAsync()` | `ServerStatus` |
| `GetHierarchyAsync(objectType?, objectId?)` | `JsonElement` |
| `ListAccountsAsync` / `GetAccountsAsync` / `GetAccountAsync` | `Page<Account>` / `IAsyncEnumerable<Account>` / `Account` |
| `ListDevicesAsync(DeviceListOptions)` / `GetDevicesAsync` (1000/page) | `Page<Device>` / `IAsyncEnumerable<Device>` |
| `GetDeviceAsync(id)` | `Device` (meters, supplies… in `Raw`) |
| `SearchDevicesBySerialAsync` / `FindDeviceBySerialAsync` | `IReadOnlyList<Device>` / `Device?` |
| `SearchDevicesAsync(DeviceSearchOptions)` / `SearchAllDevicesAsync` | `Page<JsonElement>` / `IAsyncEnumerable<JsonElement>` |
| `GetDeviceVolumesAsync(id, VolumeOptions)` | `Dictionary<string, Dictionary<string, double>>` |
| `GetDeviceHistoryAsync`, `GetDeviceAttributeHistoryAsync`, `GetSupplyCyclesAsync` | `JsonElement` (array) |
| `GetTechnicalAlertHistoryAsync(id, DateRange?)` | `IReadOnlyList<AlertHistoryEvent>` (all pages) |
| `ListDeviceAttributesAsync`, `ListProfilesAsync` | `JsonElement` |
| `SendAsync(method, path, KpaxRequest?)` / `SendAsync<T>(...)` | any endpoint, same pipeline |
| `TestConnectionAsync()` / `KpaxClient.TestCredentialsAsync(options)` | `ConnectionTestResult` (never throws) |
| `LastRateLimit` | last `X-RateLimit-*` values |

Every method takes an optional `CancellationToken`, which also cancels retry waits.

```csharp
// Any endpoint
var runs = await kpax.SendAsync(HttpMethod.Get, "/rules/executions-history",
    new KpaxRequest { Query = new Dictionary<string, object?> { ["rule_id"] = 3, ["page"] = 2 } });
```

## Errors

| Exception | When |
|---|---|
| `KpaxConfigurationException` | Invalid host, missing id/secret (constructor) |
| `KpaxAuthException` | `/oauth/token` refused the credentials (`Status`, `Body`) |
| `KpaxApiException` | Non-2xx after retries (`Status`, `Method`, `Path`, `Body`, `IsForbidden`, …); `Status == 0` for a persistent network error |
| `ArgumentException` | Serial search under 5 characters |
| `OperationCanceledException` | Your token was cancelled |

All derive from `KpaxException` (except the last two).

## Behaviour

Retries, rate limits and token handling follow the shared
[client behaviour spec](../docs/client-behavior.md); `tests/` covers each item. KPAX notes:
[../docs/kpax-api-notes.md](../docs/kpax-api-notes.md).

## Development

```bash
cd dotnet
dotnet build -c Release
dotnet run --project tests/BizReflex.Kpax.Tests -c Release   # self-contained test runner, exit code = failures
dotnet pack src/BizReflex.Kpax -c Release -o out
```

License: [MIT](LICENSE) © 2026 BizReflex LLC-FZ
