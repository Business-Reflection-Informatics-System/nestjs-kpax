from __future__ import annotations

import json
import threading
from urllib.parse import parse_qs

import httpx
import pytest

from kpax import (
    DEFAULT_SCOPES,
    Account,
    Device,
    KpaxApiError,
    KpaxAuthError,
    KpaxClient,
    KpaxConfigurationError,
)

from .conftest import Clock, MockKpax, fixture, json_response


# B01 B02
def test_client_credentials_and_bearer(client: KpaxClient, mock: MockKpax) -> None:
    status = client.server_status()
    assert status.version == "3.20.0"
    form = mock.token_requests[0]
    assert form["grant_type"] == "client_credentials"
    assert form["client_id"] == "cid"
    assert form["client_secret"] == "secret-1"
    assert form["scope"] == " ".join(DEFAULT_SCOPES)
    req = mock.calls[0]
    assert str(req.url) == "https://acme.kpax.cloud/api/v1/server/status"
    assert req.headers["authorization"] == "Bearer tok-1"
    assert req.headers["accept"] == "application/json"


# B03
def test_token_cached_and_refreshed_before_expiry(client: KpaxClient, mock: MockKpax, clock: Clock) -> None:
    client.server_status()
    client.server_status()
    assert len(mock.token_requests) == 1
    clock.now += 3600 - 60 + 1  # past expires_in - skew
    client.server_status()
    assert len(mock.token_requests) == 2


# B03
def test_concurrent_callers_share_one_token(mock: MockKpax) -> None:
    gate = threading.Event()
    original = mock.__call__

    def slow(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/oauth/token":
            gate.wait(1)
        return original(request)

    kpax = KpaxClient(
        "https://acme.kpax.cloud", "cid", "s", http_client=httpx.Client(transport=httpx.MockTransport(slow))
    )
    threads = [threading.Thread(target=kpax.server_status) for _ in range(5)]
    for t in threads:
        t.start()
    gate.set()
    for t in threads:
        t.join()
    assert len(mock.token_requests) == 1
    assert len(mock.calls) == 5


# B04
def test_refresh_once_on_401_then_surface(client: KpaxClient, mock: MockKpax) -> None:
    n = {"i": 0}

    def handler(r: httpx.Request) -> httpx.Response:
        n["i"] += 1
        return (
            json_response({"message": "Unauthenticated."}, 401)
            if n["i"] == 1
            else json_response(fixture("server-status.json"))
        )

    mock.handler = handler
    client.server_status()
    assert [c.headers["authorization"] for c in mock.calls] == ["Bearer tok-1", "Bearer tok-2"]

    mock.handler = lambda r: json_response({"message": "Invalid scope(s) provided."}, 401)
    with pytest.raises(KpaxApiError) as e:
        client.server_status()
    assert e.value.status == 401 and e.value.is_unauthorized
    assert "Invalid scope" in str(e.value)


# B05
def test_token_endpoint_refusal(client: KpaxClient, mock: MockKpax) -> None:
    mock.token_handler = lambda r: json_response({"error": "invalid_client"}, 401)
    with pytest.raises(KpaxAuthError) as e:
        client.server_status()
    assert e.value.status == 401
    assert "invalid_client" in str(e.value)


# B06
def test_429_waits_retry_after(client: KpaxClient, mock: MockKpax, clock: Clock) -> None:
    n = {"i": 0}

    def handler(r: httpx.Request) -> httpx.Response:
        n["i"] += 1
        return (
            json_response({}, 429, {"Retry-After": "7"})
            if n["i"] == 1
            else json_response(fixture("server-status.json"))
        )

    mock.handler = handler
    client.server_status()
    assert len(mock.calls) == 2
    assert 7 in clock.sleeps


# B06: POST is retried on 429
def test_429_retries_post(client: KpaxClient, mock: MockKpax) -> None:
    n = {"i": 0}

    def handler(r: httpx.Request) -> httpx.Response:
        n["i"] += 1
        return json_response({}, 429, {"Retry-After": "1"}) if n["i"] == 1 else json_response({"data": []})

    mock.handler = handler
    client.search_devices()
    assert len(mock.calls) == 2


# B07
def test_5xx_retried_for_get_not_post(client: KpaxClient, mock: MockKpax) -> None:
    n = {"i": 0}

    def handler(r: httpx.Request) -> httpx.Response:
        n["i"] += 1
        return json_response({}, 503) if n["i"] < 3 else json_response(fixture("server-status.json"))

    mock.handler = handler
    client.server_status()
    assert len(mock.calls) == 3

    mock.calls.clear()
    mock.handler = lambda r: json_response({"message": "boom"}, 502)
    with pytest.raises(KpaxApiError) as e:
        client.search_devices()
    assert e.value.status == 502
    assert len(mock.calls) == 1


# B07
def test_network_error_retried_for_get(client: KpaxClient, mock: MockKpax) -> None:
    n = {"i": 0}

    def handler(r: httpx.Request) -> httpx.Response:
        n["i"] += 1
        if n["i"] == 1:
            raise httpx.ConnectError("reset", request=r)
        return json_response(fixture("server-status.json"))

    mock.handler = handler
    assert client.server_status().version == "3.20.0"


# B07: 4xx not retried; B09 error details
def test_4xx_not_retried_and_error_details(client: KpaxClient, mock: MockKpax) -> None:
    mock.handler = lambda r: json_response({"message": "This action is unauthorized."}, 403)
    with pytest.raises(KpaxApiError) as e:
        client.get_device(42)
    assert e.value.is_forbidden
    assert e.value.method == "GET" and e.value.path == "/devices/42"
    assert e.value.body == {"message": "This action is unauthorized."}
    assert "unauthorized" in str(e.value)
    assert len(mock.calls) == 1


# B08
def test_rate_limit_exhausted_holds_next_request(client: KpaxClient, mock: MockKpax, clock: Clock) -> None:
    reset = int(clock.now) + 5
    mock.handler = lambda r: json_response(
        fixture("server-status.json"),
        200,
        {"X-RateLimit-Limit": "60", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": str(reset)},
    )
    client.server_status()
    assert client.last_rate_limit is not None
    assert (client.last_rate_limit.limit, client.last_rate_limit.remaining, client.last_rate_limit.reset) == (
        60,
        0,
        reset,
    )
    client.server_status()
    assert clock.sleeps == [pytest.approx(5)]


# B10
@pytest.mark.parametrize(
    "host,cid,secret,msg",
    [
        ("not a url", "a", "b", "not a valid"),
        ("ftp://x.kpax.cloud", "a", "b", "not a valid"),
        ("https://x.kpax.cloud", "a", " ", "missing client_id or client_secret"),
        ("https://x.kpax.cloud", "", "b", "missing client_id or client_secret"),
    ],
)
def test_configuration_validation(host: str, cid: str, secret: str, msg: str) -> None:
    with pytest.raises(KpaxConfigurationError, match=msg):
        KpaxClient(host, cid, secret)


# B10
def test_host_normalisation() -> None:
    assert KpaxClient(" https://acme.kpax.cloud/api/v1/ ", "a", "b").host == "https://acme.kpax.cloud"


# B11 B12 B18
def test_iterate_devices_all_pages(client: KpaxClient, mock: MockKpax) -> None:
    mock.handler = lambda r: json_response(fixture(f"devices-page-{r.url.params['page']}.json"))
    devices = list(client.iter_devices(parent_type="account", parent_id=12, with_children=True))
    assert [d.id for d in devices] == [1, 2, 3, 4]
    assert isinstance(devices[0], Device) and devices[0].model == "TASKalfa 2554ci"
    assert mock.query(0) == {
        "parent_type": "account",
        "parent_id": "12",
        "with_children": "true",
        "schema": "core",
        "page": "1",
        "per_page": "1000",
    }


# B12
def test_per_page_only_with_core_schema(client: KpaxClient, mock: MockKpax) -> None:
    mock.handler = lambda r: json_response({"data": []})
    client.list_devices(schema="full", per_page=500)
    assert "per_page" not in mock.query(0)


# B11 B18
def test_iterate_accounts(client: KpaxClient, mock: MockKpax) -> None:
    mock.handler = lambda r: json_response(fixture(f"accounts-page-{r.url.params['page']}.json"))
    accounts = list(client.iter_accounts())
    assert [a.id for a in accounts] == [10, 11, 12]
    assert isinstance(accounts[1], Account) and accounts[1].parent_id == 1


# B13
def test_find_device_by_serial(client: KpaxClient, mock: MockKpax) -> None:
    mock.handler = lambda r: json_response(fixture("serial-search.json"))
    found = client.find_device_by_serial(" abcd123456789 ")
    assert found is not None and found.id == 7
    assert mock.query(0)["serial_number"] == "ABCD123456789"
    origin = client.find_device_by_serial("xyz987654321")
    assert origin is not None and origin.id == 9
    assert client.find_device_by_serial("ABCD12345678") is None
    with pytest.raises(ValueError):
        client.find_device_by_serial("ABC")


# B13
def test_find_device_by_serial_ambiguous(client: KpaxClient, mock: MockKpax) -> None:
    dup = fixture("serial-search.json")
    dup["data"][1]["serial_number"] = "ABCD123456789"
    mock.handler = lambda r: json_response(dup)
    with pytest.raises(KpaxApiError) as e:
        client.find_device_by_serial("ABCD123456789")
    assert e.value.status == 409


# B14
def test_search_devices_form(client: KpaxClient, mock: MockKpax) -> None:
    mock.handler = lambda r: json_response({"data": [], "meta": {"current_page": 1, "last_page": 1}})
    client.search_devices(
        parent_type="account",
        parent_id=3,
        with_children=True,
        attributes=[{"namespace": "kpax.core.print.devices", "name": "engine_count"}],
        filters=[
            {
                "namespace": "kpax.core.print.devices",
                "name": "last_check",
                "operator": "greater",
                "value": "2026-11-01 00:00:00",
            }
        ],
        attributes_with_last_check=False,
        profile_ids=[1, 4],
        per_page=500,
    )
    req = mock.calls[0]
    assert req.method == "POST" and req.url.path == "/api/v1/devices/search"
    assert req.headers["content-type"].startswith("application/x-www-form-urlencoded")
    form = {k: v[0] for k, v in parse_qs(req.content.decode()).items()}
    assert form["with_children"] == "1"
    assert form["attributes_with_last_check"] == "0"
    assert json.loads(form["attributes"]) == [{"namespace": "kpax.core.print.devices", "name": "engine_count"}]
    assert json.loads(form["filters"])[0]["operator"] == "greater"
    assert form["profile_id"] == "1,4"
    assert form["per_page"] == "500"


# B15
def test_volumes(client: KpaxClient, mock: MockKpax) -> None:
    mock.handler = lambda r: json_response(fixture("volumes.json"))
    v = client.get_device_volumes(42, start_date="2026-11-01", end_date="2026-11-02", volume_name="engine_count")
    assert v["engine_count"]["2026-11-01"] == 120
    assert mock.calls[0].url.path == "/api/v1/devices/42/volumes"
    assert mock.query(0) == {
        "interval": "daily",
        "start_date": "2026-11-01",
        "end_date": "2026-11-02",
        "volume_name": "engine_count",
    }


# B16
def test_null_query_params_omitted_and_path_encoded(client: KpaxClient, mock: MockKpax) -> None:
    mock.handler = lambda r: json_response(fixture("supply-cycles.json"))
    cycles = client.get_supply_cycles(9, "black")
    assert cycles[0]["ref_part_number"] == "TK-8345K"
    assert mock.query(0) == {"cartridge": "black"}
    mock.handler = lambda r: json_response({})
    client.request("GET", "/devices/{device_id}", path_params={"device_id": "a/b"})
    assert mock.calls[1].url.raw_path == b"/api/v1/devices/a%2Fb"


# B11
def test_alert_history_all_pages(client: KpaxClient, mock: MockKpax) -> None:
    mock.handler = lambda r: json_response(fixture(f"alerts-page-{r.url.params['page']}.json"))
    events = client.get_technical_alert_history(42)
    assert [e.value for e in events] == ["Toner low", "Paper jam"]
    assert events[0].occurrences == 4


def test_full_device_keeps_raw(client: KpaxClient, mock: MockKpax) -> None:
    mock.handler = lambda r: json_response(fixture("device-full.json"))
    d = client.get_device(42)
    assert d.serial_number == "SN0000000042"
    assert d.raw["meters"]["engine_count"]["value"] == 152340


# B17
def test_test_connection_never_raises(client: KpaxClient, mock: MockKpax) -> None:
    assert client.test_connection().ok
    mock.token_handler = lambda r: json_response({"error": "invalid_client"}, 401)
    client._invalidate_token()
    res = client.test_connection()
    assert (res.ok, res.stage, res.status) == (False, "auth", 401)
    cfg = KpaxClient.test_credentials("nope", "a", "b")
    assert (cfg.ok, cfg.stage) == (False, "config")
