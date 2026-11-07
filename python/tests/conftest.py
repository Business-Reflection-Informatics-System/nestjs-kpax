from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import parse_qs

import httpx
import pytest

from kpax import KpaxClient

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"


def fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text())


class MockKpax:
    """A fake KPAX behind httpx.MockTransport."""

    def __init__(self) -> None:
        self.calls: List[httpx.Request] = []
        self.token_requests: List[Dict[str, str]] = []
        self.handler: Callable[[httpx.Request], httpx.Response] = lambda r: json_response(fixture("server-status.json"))
        self.token_handler: Optional[Callable[[httpx.Request], httpx.Response]] = None
        self._seq = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/oauth/token":
            form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            self.token_requests.append(form)
            if self.token_handler:
                return self.token_handler(request)
            self._seq += 1
            return json_response({"token_type": "Bearer", "expires_in": 3600, "access_token": f"tok-{self._seq}"})
        self.calls.append(request)
        return self.handler(request)

    def query(self, i: int) -> Dict[str, str]:
        return {k: v[0] for k, v in parse_qs(self.calls[i].url.query.decode()).items()}


def json_response(body: Any, status: int = 200, headers: Optional[Dict[str, str]] = None) -> httpx.Response:
    return httpx.Response(status, json=body, headers=headers)


class Clock:
    def __init__(self) -> None:
        self.now = 1_800_000_000.0
        self.sleeps: List[float] = []

    def time(self) -> float:
        return self.now

    def sleep(self, s: float) -> None:
        self.sleeps.append(s)
        self.now += s


@pytest.fixture()
def mock() -> MockKpax:
    return MockKpax()


@pytest.fixture()
def clock() -> Clock:
    return Clock()


@pytest.fixture()
def client(mock: MockKpax, clock: Clock) -> KpaxClient:
    return KpaxClient(
        "https://acme.kpax.cloud/",
        "cid",
        "secret-1",
        base_delay=0.001,
        http_client=httpx.Client(transport=httpx.MockTransport(mock)),
        sleep=clock.sleep,
        clock=clock.time,
    )
