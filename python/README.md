# bizreflex-kpax (Python)

Python client for the **KPAX API v1**: OAuth2 client credentials, retries and rate limits,
pagination, typed models and device helpers. One dependency: `httpx`. Python 3.10+.

```python
from kpax import KpaxClient

with KpaxClient("https://acme.kpax.cloud", client_id, client_secret) as kpax:
    device = kpax.find_device_by_serial("ABCD123456789")   # exact match or None
    if device:
        full = kpax.get_device(device.id)
        print(full.model, full.raw["meters"]["engine_count"]["value"])

    for d in kpax.iter_devices(parent_type="account", parent_id=12, with_children=True):
        print(d.id, d.serial_number)
```

## Install

From the GitHub release (wheel attached to every `v*` release):

```bash
pip install https://github.com/Business-Reflection-Informatics-System/nestjs-kpax/releases/download/v0.1.0/bizreflex_kpax-0.1.0-py3-none-any.whl
```

or straight from the repo:

```bash
pip install "bizreflex-kpax @ git+https://github.com/Business-Reflection-Informatics-System/nestjs-kpax@v0.1.0#subdirectory=python"
```

## Client

```python
KpaxClient(
    host, client_id, client_secret, *,
    scopes=None,               # default: read scopes (see docs/kpax-api-notes.md)
    timeout=30.0,              # seconds per attempt
    max_retries=4, base_delay=0.5, max_delay=60.0,
    token_refresh_skew=60.0,
    http_client=None,          # bring your own httpx.Client (proxies, mTLS, mocking)
)
```

Thread-safe: share one instance; threads share one token. Use it as a context manager or
call `close()`.

| Method | Returns |
|---|---|
| `server_status()` | `ServerStatus` |
| `hierarchy(object_type=None, object_id=None)` | `dict` |
| `list_accounts(parent_id=, with_children=, page=)` / `iter_accounts(...)` / `get_account(id)` | `Page[Account]` / iterator / `Account` |
| `list_devices(parent_type=, parent_id=, with_children=, schema="core", page=, per_page=, sort=)` | `Page[Device]` |
| `iter_devices(...)` | iterator of `Device` (1000 per page) |
| `get_device(id)` | `Device` (meters, supplies… in `.raw`) |
| `search_devices_by_serial(serial)` / `find_device_by_serial(serial)` | `list[Device]` / `Device \| None` |
| `search_devices(attributes=, filters=, ...)` / `iter_device_search(...)` | `Page[dict]` / iterator |
| `get_device_volumes(id, start_date=, end_date=, interval="daily", volume_name=None)` | `{name: {date: count}}` |
| `get_device_history(id, ...)`, `get_device_attribute_history(id, ns, name, ...)` | `list[dict]` |
| `get_supply_cycles(id, cartridge, nb_cycles=None)` | `list[dict]` |
| `get_technical_alert_history(id, ...)` | `list[AlertHistoryEvent]` (all pages) |
| `list_device_attributes(filter=None, locale=None)`, `list_profiles()` | parsed JSON |
| `request(method, path, path_params=, query=, json=, form=)` | any endpoint, same pipeline |
| `test_connection()` / `KpaxClient.test_credentials(host, id, secret)` | `ConnectionTestResult` (never raises) |
| `last_rate_limit` | last `X-RateLimit-*` values seen |

```python
# Any endpoint
runs = kpax.request("GET", "/rules/executions-history", query={"rule_id": 3, "page": 2})

# Meters across a fleet, checked in since yesterday (UTC)
for row in kpax.iter_device_search(
    parent_type="account", parent_id=12, with_children=True,
    attributes=[{"namespace": "kpax.core.print.devices", "name": "engine_count"}],
    filters=[{"namespace": "kpax.core.print.devices", "name": "last_check",
              "operator": "greater_or_equal", "value": "2026-11-06 00:00:00"}],
    attributes_with_last_check=True, per_page=1000,
):
    ...
```

## Errors

| Exception | When |
|---|---|
| `KpaxConfigurationError` | Invalid host, missing client id/secret (raised by the constructor) |
| `KpaxAuthError` | `/oauth/token` refused the credentials (`.status`, `.body`) |
| `KpaxApiError` | Non-2xx after retries (`.status`, `.method`, `.path`, `.body`, `.is_forbidden`, …); `status=0` for a persistent network error |
| `ValueError` | Serial search with fewer than 5 characters |

A 401 on some endpoints only usually means the API client lacks that scope.

## Behaviour

Retries, rate limits and token handling follow the shared
[client behaviour spec](../docs/client-behavior.md); the tests in `tests/` cover each item.
KPAX-specific notes (scopes, hierarchy, dates): [../docs/kpax-api-notes.md](../docs/kpax-api-notes.md).

## Development

```bash
cd python
pip install -e ".[dev]"
pytest && ruff check src tests && ruff format --check src tests && mypy
python -m build
```

License: [MIT](LICENSE) © 2026 BizReflex LLC-FZ
