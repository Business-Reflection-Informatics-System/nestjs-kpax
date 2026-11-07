"""Errors raised by the KPAX client."""

from __future__ import annotations

import json
from typing import Any, Optional


class KpaxError(Exception):
    """Base class for every error raised by this package."""


class KpaxConfigurationError(KpaxError):
    """Invalid host or missing client id/secret (B10)."""


class KpaxAuthError(KpaxError):
    """The ``/oauth/token`` endpoint refused the credentials or was unreachable (B05).

    ``status`` is 0 when the endpoint could not be reached.
    """

    def __init__(self, status: int, host: str, body: Any) -> None:
        self.status = status
        self.host = host
        self.body = body
        super().__init__(f"KPAX token request to {host} failed with HTTP {status}{_describe(body)}")


class KpaxApiError(KpaxError):
    """KPAX answered with a non-2xx status after retries (B09).

    ``status`` is 0 for a network error that persisted through retries. KPAX uses
    401 both for bad tokens and for missing scopes, and 403 for resources outside
    the API client's hierarchy level.
    """

    def __init__(
        self,
        status: int,
        method: str,
        path: str,
        body: Any,
        message: Optional[str] = None,
    ) -> None:
        self.status = status
        self.method = method
        self.path = path
        self.body = body
        super().__init__(message or f"KPAX {method} {path} failed with HTTP {status}{_describe(body)}")

    @property
    def is_unauthorized(self) -> bool:
        return self.status == 401

    @property
    def is_forbidden(self) -> bool:
        return self.status == 403

    @property
    def is_not_found(self) -> bool:
        return self.status == 404

    @property
    def is_rate_limited(self) -> bool:
        return self.status == 429


def _describe(body: Any) -> str:
    if body is None or body == "":
        return ""
    if isinstance(body, str):
        return f": {body[:300]}"
    if isinstance(body, dict):
        for key in ("message", "error_description", "error"):
            if isinstance(body.get(key), str):
                return f": {body[key]}"
    try:
        return f": {json.dumps(body)[:300]}"
    except (TypeError, ValueError):
        return ""
