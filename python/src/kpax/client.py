"""Synchronous KPAX API v1 client. See docs/client-behavior.md for the behaviour ids (Bxx)."""

from __future__ import annotations

import email.utils
import json as _json
import random
import threading
import time
from typing import Any, Callable, Dict, Iterator, List, Mapping, Optional, Sequence, TypeVar, cast
from urllib.parse import quote, urlparse

import httpx

from .errors import KpaxApiError, KpaxAuthError, KpaxConfigurationError
from .models import (
    Account,
    AlertHistoryEvent,
    ConnectionTestResult,
    Device,
    Page,
    PaginationMeta,
    RateLimit,
    ServerStatus,
)

T = TypeVar("T")

DEFAULT_SCOPES: Sequence[str] = (
    "accounts:read",
    "agents:read",
    "devices:read",
    "hierarchy-elements:read",
    "dynamic-groups:read",
    "profiles:read",
    "rules:read",
    "labels:read",
    "server:read",
)

_IDEMPOTENT = {"GET", "PUT", "DELETE"}


class KpaxClient:
    """Client for one KPAX instance.

    >>> with KpaxClient("https://acme.kpax.cloud", client_id, client_secret) as kpax:
    ...     device = kpax.find_device_by_serial("ABCD123456789")

    Thread-safe: one instance can be shared by threads; they share one token.
    """

    def __init__(
        self,
        host: str,
        client_id: str,
        client_secret: str,
        *,
        scopes: Optional[Sequence[str]] = None,
        timeout: float = 30.0,
        max_retries: int = 4,
        base_delay: float = 0.5,
        max_delay: float = 60.0,
        token_refresh_skew: float = 60.0,
        http_client: Optional[httpx.Client] = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.host = _normalize_host(host)
        self.client_id = (client_id or "").strip()
        self._client_secret = (client_secret or "").strip()
        if not self.client_id or not self._client_secret:
            raise KpaxConfigurationError(f"KPAX connection for {self.host} is missing client_id or client_secret")
        self.scopes = list(scopes) if scopes else list(DEFAULT_SCOPES)
        self.timeout = timeout
        self.max_retries = max_retries
        self.base_delay = base_delay
        self.max_delay = max_delay
        self.token_refresh_skew = token_refresh_skew
        self._http = http_client or httpx.Client()
        self._owns_http = http_client is None
        self._sleep = sleep
        self._clock = clock

        self._token: Optional[str] = None
        self._token_expires_at = 0.0
        self._token_lock = threading.Lock()
        self._blocked_until = 0.0
        self.last_rate_limit: Optional[RateLimit] = None

    # ------------------------------------------------------------ lifecycle

    def close(self) -> None:
        if self._owns_http:
            self._http.close()

    def __enter__(self) -> KpaxClient:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # ------------------------------------------------------- server/hierarchy

    def server_status(self) -> ServerStatus:
        return ServerStatus.from_json(self.request("GET", "/server/status") or {})

    def hierarchy(self, object_type: Optional[str] = None, object_id: Optional[int] = None) -> Dict[str, Any]:
        """Accounts, agents, devices and dynamic groups under a container (default: the client's own level)."""
        query = {"object_type": object_type, "object_id": object_id} if object_type else None
        return cast("Dict[str, Any]", self.request("GET", "/hierarchy-elements", query=query))

    # ------------------------------------------------------------- accounts

    def list_accounts(
        self, *, parent_id: Optional[int] = None, with_children: Optional[bool] = None, page: Optional[int] = None
    ) -> Page[Account]:
        query: Dict[str, Any] = {"page": page}
        if parent_id is not None:
            query.update(parent_type="account", parent_id=parent_id, with_children=with_children)
        return _page(self.request("GET", "/accounts", query=query), Account.from_json)

    def iter_accounts(
        self, *, parent_id: Optional[int] = None, with_children: Optional[bool] = None
    ) -> Iterator[Account]:
        return paginate(lambda p: self.list_accounts(parent_id=parent_id, with_children=with_children, page=p))

    def get_account(self, account_id: int) -> Account:
        return Account.from_json(self.request("GET", "/accounts/{account_id}", path_params={"account_id": account_id}))

    # -------------------------------------------------------------- devices

    def list_devices(
        self,
        *,
        parent_type: Optional[str] = None,
        parent_id: Optional[int] = None,
        with_children: Optional[bool] = None,
        schema: str = "core",
        page: Optional[int] = None,
        per_page: Optional[int] = None,
        sort: Optional[str] = None,
    ) -> Page[Device]:
        """One page of devices. ``per_page`` (≤1000) only applies to the core schema (B12)."""
        query = {
            **_scope(parent_type, parent_id, with_children),
            "schema": schema,
            "sort": sort,
            "page": page,
            "per_page": per_page if schema == "core" else None,
        }
        return _page(self.request("GET", "/devices", query=query), Device.from_json)

    def iter_devices(
        self,
        *,
        parent_type: Optional[str] = None,
        parent_id: Optional[int] = None,
        with_children: Optional[bool] = None,
        schema: str = "core",
        per_page: Optional[int] = None,
        sort: Optional[str] = None,
    ) -> Iterator[Device]:
        """Every device across all pages; 1000 per page on the core schema (B12)."""
        if per_page is None and schema == "core":
            per_page = 1000
        return paginate(
            lambda p: self.list_devices(
                parent_type=parent_type,
                parent_id=parent_id,
                with_children=with_children,
                schema=schema,
                page=p,
                per_page=per_page,
                sort=sort,
            )
        )

    def get_device(self, device_id: int) -> Device:
        """Full device. Meters, supplies, alerts, … are in ``device.raw``."""
        return Device.from_json(self.request("GET", "/devices/{device_id}", path_params={"device_id": device_id}))

    def search_devices_by_serial(
        self,
        serial: str,
        *,
        parent_type: Optional[str] = None,
        parent_id: Optional[int] = None,
        schema: Optional[str] = None,
    ) -> List[Device]:
        """Partial serial search (≥5 characters), all pages."""
        s = (serial or "").strip()
        if len(s) < 5:
            raise ValueError("KPAX serial-number search needs at least 5 characters")
        return list(
            paginate(
                lambda p: _page(
                    self.request(
                        "GET",
                        "/devices/search-by-serial-number",
                        query={"serial_number": s, **_scope(parent_type, parent_id, None), "schema": schema, "page": p},
                    ),
                    Device.from_json,
                )
            )
        )

    def find_device_by_serial(
        self, serial: str, *, parent_type: Optional[str] = None, parent_id: Optional[int] = None
    ) -> Optional[Device]:
        """Exact, case-insensitive match on the effective or original serial (B13).

        Returns None when nothing matches; raises KpaxApiError(409) when several devices match.
        """
        want = (serial or "").strip().upper()
        hits = [
            d
            for d in self.search_devices_by_serial(want, parent_type=parent_type, parent_id=parent_id)
            if any(isinstance(v, str) and v.strip().upper() == want for v in (d.serial_number, d.serial_number_origin))
        ]
        if len(hits) > 1:
            raise KpaxApiError(
                409,
                "GET",
                "/devices/search-by-serial-number",
                {"matches": [d.id for d in hits]},
                f"Serial {want} matches {len(hits)} KPAX devices",
            )
        return hits[0] if hits else None

    def search_devices(
        self,
        *,
        parent_type: Optional[str] = None,
        parent_id: Optional[int] = None,
        with_children: Optional[bool] = None,
        attributes: Optional[Sequence[Mapping[str, str]]] = None,
        filters: Optional[Sequence[Mapping[str, str]]] = None,
        attributes_with_last_check: Optional[bool] = None,
        profile_ids: Optional[Sequence[int]] = None,
        sort: Optional[str] = None,
        page: Optional[int] = None,
        per_page: Optional[int] = None,
    ) -> Page[Dict[str, Any]]:
        """``POST /devices/search``: bulk read of chosen attributes across a fleet (B14)."""
        form: Dict[str, str] = {}
        if parent_type:
            form["parent_type"] = parent_type
            form["parent_id"] = str(parent_id)
            if with_children is not None:
                form["with_children"] = "1" if with_children else "0"
        if attributes:
            form["attributes"] = _json.dumps(list(attributes), separators=(",", ":"))
        if filters:
            form["filters"] = _json.dumps(list(filters), separators=(",", ":"))
        if attributes_with_last_check is not None:
            form["attributes_with_last_check"] = "1" if attributes_with_last_check else "0"
        if profile_ids:
            form["profile_id"] = ",".join(str(i) for i in profile_ids)
        if sort:
            form["sort"] = sort
        if page is not None:
            form["page"] = str(page)
        if per_page is not None:
            form["per_page"] = str(per_page)
        return _page(self.request("POST", "/devices/search", form=form), dict)

    def iter_device_search(self, **kwargs: Any) -> Iterator[Dict[str, Any]]:
        kwargs.pop("page", None)
        return paginate(lambda p: self.search_devices(page=p, **kwargs))

    def get_device_volumes(
        self,
        device_id: int,
        *,
        start_date: str,
        end_date: str,
        interval: str = "daily",
        volume_name: Optional[str] = None,
    ) -> Dict[str, Dict[str, float]]:
        """``{volume_name: {date: count}}``. Dates are YYYY-MM-DD, UTC (B15)."""
        return cast(
            "Dict[str, Dict[str, float]]",
            self.request(
                "GET",
                "/devices/{device_id}/volumes",
                path_params={"device_id": device_id},
                query={
                    "interval": interval,
                    "start_date": start_date,
                    "end_date": end_date,
                    "volume_name": volume_name,
                },
            ),
        )

    def get_device_history(
        self,
        device_id: int,
        *,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        sort: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        return cast(
            "List[Dict[str, Any]]",
            self.request(
                "GET",
                "/devices/{device_id}/history",
                path_params={"device_id": device_id},
                query={"start_date": start_date, "end_date": end_date, "sort": sort},
            ),
        )

    def get_device_attribute_history(
        self,
        device_id: int,
        namespace: str,
        name: str,
        *,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        sort: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        return cast(
            "List[Dict[str, Any]]",
            self.request(
                "GET",
                "/devices/{device_id}/attributes/history",
                path_params={"device_id": device_id},
                query={
                    "namespace": namespace,
                    "name": name,
                    "start_date": start_date,
                    "end_date": end_date,
                    "sort": sort,
                },
            ),
        )

    def get_supply_cycles(
        self, device_id: int, cartridge: str, nb_cycles: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """Toner replacement cycles; ``cartridge`` is black, cyan, magenta or yellow."""
        return cast(
            "List[Dict[str, Any]]",
            self.request(
                "GET",
                "/devices/{device_id}/supply-cycles",
                path_params={"device_id": device_id},
                query={"cartridge": cartridge, "nb_cycles": nb_cycles},
            ),
        )

    def get_technical_alert_history(
        self,
        device_id: int,
        *,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        sort: Optional[str] = None,
    ) -> List[AlertHistoryEvent]:
        """Alert events for a device, all pages."""
        return list(
            paginate(
                lambda p: _page(
                    self.request(
                        "GET",
                        "/devices/{device_id}/technical-status-events/history",
                        path_params={"device_id": device_id},
                        query={"start_date": start_date, "end_date": end_date, "sort": sort, "page": p},
                    ),
                    AlertHistoryEvent.from_json,
                )
            )
        )

    def list_device_attributes(self, filter: Optional[str] = None, locale: Optional[str] = None) -> Any:
        return self.request("GET", "/devices/attributes", query={"filter": filter, "locale": locale})

    def list_profiles(self) -> Any:
        return self.request("GET", "/profiles")

    # ------------------------------------------------------- connection test

    def test_connection(self) -> ConnectionTestResult:
        """Token + ``GET /server/status``. Never raises (B17)."""
        started = self._clock()
        try:
            server = self.server_status()
            return ConnectionTestResult(ok=True, latency_ms=_ms(self._clock() - started), server=server)
        except KpaxAuthError as e:
            return ConnectionTestResult(False, _ms(self._clock() - started), "auth", e.status, str(e))
        except KpaxApiError as e:
            return ConnectionTestResult(False, _ms(self._clock() - started), "api", e.status, str(e))
        except Exception as e:
            return ConnectionTestResult(False, _ms(self._clock() - started), "api", None, str(e))

    @classmethod
    def test_credentials(cls, host: str, client_id: str, client_secret: str, **kwargs: Any) -> ConnectionTestResult:
        """Like test_connection, but also reports invalid configuration as ``stage='config'``."""
        try:
            client = cls(host, client_id, client_secret, **kwargs)
        except KpaxConfigurationError as e:
            return ConnectionTestResult(ok=False, latency_ms=0, stage="config", message=str(e))
        with client:
            return client.test_connection()

    # ------------------------------------------------------------ transport

    def request(
        self,
        method: str,
        path: str,
        *,
        path_params: Optional[Mapping[str, Any]] = None,
        query: Optional[Mapping[str, Any]] = None,
        json: Any = None,
        form: Optional[Mapping[str, str]] = None,
    ) -> Any:
        """Call any KPAX v1 endpoint with auth, retries and rate-limit handling.

        ``path`` is relative to /api/v1, with ``{name}`` placeholders filled from ``path_params``.
        Returns the parsed JSON body (None for an empty body).
        """
        method = method.upper()
        resolved = _interpolate(path, path_params)
        res = self._send(method, resolved, query, json, form)
        body = _parse(res)
        if not 200 <= res.status_code < 300:
            raise KpaxApiError(res.status_code, method, resolved, body)
        return body

    def _send(
        self,
        method: str,
        path: str,
        query: Optional[Mapping[str, Any]],
        json_body: Any,
        form: Optional[Mapping[str, str]],
    ) -> httpx.Response:
        url = f"{self.host}/api/v1{path}"
        params = _compact(query)
        attempt = 0
        refreshed = False

        while True:
            wait = self._blocked_until - self._clock()
            if wait > 0:
                self._sleep(min(wait, self.max_delay))

            token = self._get_token()
            headers = {"Accept": "application/json", "Authorization": f"Bearer {token}"}
            try:
                res = self._http.request(
                    method,
                    url,
                    params=params,
                    json=json_body if form is None else None,
                    data=dict(form) if form is not None else None,
                    headers=headers,
                    timeout=self.timeout,
                )
            except httpx.TransportError as e:
                if method in _IDEMPOTENT and attempt < self.max_retries:
                    self._sleep(self._backoff(attempt))
                    attempt += 1
                    continue
                raise KpaxApiError(0, method, path, {"message": str(e)}) from e

            self._track_rate_limit(res.headers)

            if res.status_code == 401 and not refreshed:  # B04
                refreshed = True
                self._invalidate_token()
                continue

            if res.status_code == 429 and attempt < self.max_retries:  # B06
                delay = self._retry_after(res.headers)
                delay = min(self._backoff(attempt) if delay is None else delay, self.max_delay)
                attempt += 1
                self._blocked_until = max(self._blocked_until, self._clock() + delay)
                self._sleep(delay)
                continue

            if res.status_code >= 500 and method in _IDEMPOTENT and attempt < self.max_retries:  # B07
                self._sleep(self._backoff(attempt))
                attempt += 1
                continue

            return res

    # ---------------------------------------------------------------- token

    def _get_token(self) -> str:
        if self._token and self._clock() < self._token_expires_at:
            return self._token
        with self._token_lock:  # B03: one fetch for concurrent callers
            if self._token and self._clock() < self._token_expires_at:
                return self._token
            self._fetch_token()
            assert self._token is not None
            return self._token

    def _invalidate_token(self) -> None:
        with self._token_lock:
            self._token = None
            self._token_expires_at = 0.0

    def _fetch_token(self) -> None:
        form = {
            "grant_type": "client_credentials",
            "client_id": self.client_id,
            "client_secret": self._client_secret,
            "scope": " ".join(self.scopes),
        }
        try:
            res = self._http.post(
                f"{self.host}/oauth/token",
                data=form,
                headers={"Accept": "application/json"},
                timeout=self.timeout,
            )
        except httpx.TransportError as e:
            raise KpaxAuthError(0, self.host, {"message": str(e)}) from e
        body = _parse(res)
        if not 200 <= res.status_code < 300:
            raise KpaxAuthError(res.status_code, self.host, body)
        if not isinstance(body, dict) or not isinstance(body.get("access_token"), str):
            raise KpaxAuthError(res.status_code, self.host, {"message": "Token response did not include access_token"})
        ttl = float(body.get("expires_in") or 3600)
        self._token = body["access_token"]
        self._token_expires_at = self._clock() + max(ttl - self.token_refresh_skew, 0)

    # --------------------------------------------------------------- helpers

    def _backoff(self, attempt: int) -> float:
        exp: float = self.base_delay * (2.0**attempt)
        return min(exp / 2 + random.random() * (exp / 2), self.max_delay)

    def _track_rate_limit(self, headers: httpx.Headers) -> None:
        limit = _int_header(headers, "x-ratelimit-limit")
        remaining = _int_header(headers, "x-ratelimit-remaining")
        reset = _int_header(headers, "x-ratelimit-reset")
        if limit is None and remaining is None and reset is None:
            return
        self.last_rate_limit = RateLimit(limit=limit, remaining=remaining, reset=reset)
        if remaining == 0 and reset:  # B08
            self._blocked_until = max(self._blocked_until, float(reset))

    def _retry_after(self, headers: httpx.Headers) -> Optional[float]:
        ra = headers.get("retry-after")
        if ra:
            try:
                return max(float(ra), 0.0)
            except ValueError:
                try:
                    when = email.utils.parsedate_to_datetime(ra)
                    return max(float(when.timestamp()) - self._clock(), 0.0)
                except (TypeError, ValueError):
                    pass
        reset = _int_header(headers, "x-ratelimit-reset")
        if reset is not None:
            return max(reset - self._clock(), 0.0)
        return None


# --------------------------------------------------------------------------
# module helpers


def paginate(
    fetch_page: Callable[[int], Page[T]], *, start_page: int = 1, max_pages: Optional[int] = None
) -> Iterator[T]:
    """Walk KPAX pagination (B11)."""
    page = start_page
    fetched = 0
    while True:
        res = fetch_page(page)
        items = res.data or []
        yield from items
        fetched += 1
        meta = res.meta
        if not items or meta is None:
            return
        current = meta.current_page or page
        last = meta.last_page or current
        if current >= last or (max_pages is not None and fetched >= max_pages):
            return
        page = current + 1


def _page(body: Any, convert: Callable[[Mapping[str, Any]], T]) -> Page[T]:
    if not isinstance(body, dict):
        return Page(data=[])
    data = body.get("data") or []
    return Page(
        data=[convert(item) for item in data if isinstance(item, Mapping)],
        meta=PaginationMeta.from_json(body.get("meta")),
        links=body.get("links") if isinstance(body.get("links"), dict) else None,
    )


def _scope(parent_type: Optional[str], parent_id: Optional[int], with_children: Optional[bool]) -> Dict[str, Any]:
    if not parent_type:
        return {}
    return {
        "parent_type": parent_type,
        "parent_id": parent_id,
        "with_children": with_children if parent_type == "account" else None,
    }


def _normalize_host(host: str) -> str:
    h = (host or "").strip().rstrip("/")
    if h.lower().endswith("/api/v1"):
        h = h[: -len("/api/v1")].rstrip("/")
    parsed = urlparse(h)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise KpaxConfigurationError(f'KPAX host is not a valid http(s) URL: "{h}"')
    return h


def _interpolate(path: str, params: Optional[Mapping[str, Any]]) -> str:
    out = path
    while "{" in out:
        start = out.index("{")
        end = out.index("}", start)
        name = out[start + 1 : end]
        value = (params or {}).get(name)
        if value is None or value == "":
            raise ValueError(f'Missing path parameter "{name}" for {path}')
        out = out[:start] + quote(str(value), safe="") + out[end + 1 :]
    return out


def _compact(query: Optional[Mapping[str, Any]]) -> Optional[Dict[str, Any]]:
    """Drop None values; booleans become true/false (B16)."""
    if not query:
        return None
    out: Dict[str, Any] = {}
    for k, v in query.items():
        if v is None:
            continue
        out[k] = ("true" if v else "false") if isinstance(v, bool) else v
    return out or None


def _parse(res: httpx.Response) -> Any:
    text = res.text
    if not text:
        return None
    try:
        return res.json()
    except ValueError:
        return text


def _int_header(headers: httpx.Headers, name: str) -> Optional[int]:
    v = headers.get(name)
    if v is None or v == "":
        return None
    try:
        return int(float(v))
    except ValueError:
        return None


def _ms(seconds: float) -> int:
    return round(seconds * 1000)


__all__ = ["DEFAULT_SCOPES", "KpaxClient", "paginate"]
