"""Typed models for the common KPAX resources. Each keeps the JSON it came from in ``raw``."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Generic, List, Mapping, Optional, TypeVar

T = TypeVar("T")


def to_int(value: Any) -> Optional[int]:
    """KPAX ids arrive as numbers or numeric strings (B18)."""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    try:
        return int(str(value).strip())
    except ValueError:
        return None


def _str(value: Any) -> Optional[str]:
    return None if value is None else str(value)


@dataclass(frozen=True)
class PaginationMeta:
    current_page: Optional[int] = None
    last_page: Optional[int] = None
    per_page: Optional[int] = None
    total: Optional[int] = None
    from_: Optional[int] = None
    to: Optional[int] = None

    @classmethod
    def from_json(cls, raw: Optional[Mapping[str, Any]]) -> Optional[PaginationMeta]:
        if not isinstance(raw, Mapping):
            return None
        return cls(
            current_page=to_int(raw.get("current_page")),
            last_page=to_int(raw.get("last_page")),
            per_page=to_int(raw.get("per_page")),
            total=to_int(raw.get("total")),
            from_=to_int(raw.get("from")),
            to=to_int(raw.get("to")),
        )


@dataclass(frozen=True)
class Page(Generic[T]):
    data: List[T]
    meta: Optional[PaginationMeta] = None
    links: Optional[Dict[str, Any]] = None


@dataclass(frozen=True)
class Account:
    id: Optional[int]
    name: Optional[str]
    parent_type: Optional[str] = None
    parent_id: Optional[int] = None
    activation_code: Optional[str] = None
    raw: Dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_json(cls, raw: Mapping[str, Any]) -> Account:
        return cls(
            id=to_int(raw.get("id")),
            name=_str(raw.get("name")),
            parent_type=_str(raw.get("parent_type")),
            parent_id=to_int(raw.get("parent_id")),
            activation_code=_str(raw.get("activation_code")),
            raw=dict(raw),
        )


@dataclass(frozen=True)
class Device:
    """Core device fields. Meters, supplies, alerts etc. of a full device are in ``raw``."""

    id: Optional[int]
    serial_number: Optional[str] = None
    serial_number_origin: Optional[str] = None
    manufacturer: Optional[str] = None
    manufacturer_origin: Optional[str] = None
    model: Optional[str] = None
    model_origin: Optional[str] = None
    parent_type: Optional[str] = None
    parent_id: Optional[int] = None
    profile_id: Optional[int] = None
    agent_id: Optional[int] = None
    mac_address: Optional[str] = None
    typology: Optional[str] = None
    last_check: Optional[str] = None
    created_at: Optional[str] = None
    raw: Dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_json(cls, raw: Mapping[str, Any]) -> Device:
        return cls(
            id=to_int(raw.get("id")),
            serial_number=_str(raw.get("serial_number")),
            serial_number_origin=_str(raw.get("serial_number_origin")),
            manufacturer=_str(raw.get("manufacturer")),
            manufacturer_origin=_str(raw.get("manufacturer_origin")),
            model=_str(raw.get("model")),
            model_origin=_str(raw.get("model_origin")),
            parent_type=_str(raw.get("parent_type")),
            parent_id=to_int(raw.get("parent_id")),
            profile_id=to_int(raw.get("profile_id")),
            agent_id=to_int(raw.get("agent_id")),
            mac_address=_str(raw.get("mac_address")),
            typology=_str(raw.get("typology")),
            last_check=_str(raw.get("last_check")),
            created_at=_str(raw.get("created_at")),
            raw=dict(raw),
        )


@dataclass(frozen=True)
class ServerStatus:
    version: Optional[str]
    timezone_server: Optional[str] = None
    date_server: Optional[str] = None
    raw: Dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_json(cls, raw: Mapping[str, Any]) -> ServerStatus:
        return cls(
            version=_str(raw.get("version")),
            timezone_server=_str(raw.get("timezone_server")),
            date_server=_str(raw.get("date_server")),
            raw=dict(raw),
        )


@dataclass(frozen=True)
class AlertHistoryEvent:
    value: Optional[str]
    first_time_seen_on: Optional[str] = None
    last_time_seen_on: Optional[str] = None
    event_end_date: Optional[str] = None
    occurrences: Optional[int] = None
    raw: Dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_json(cls, raw: Mapping[str, Any]) -> AlertHistoryEvent:
        return cls(
            value=_str(raw.get("value")),
            first_time_seen_on=_str(raw.get("first_time_seen_on")),
            last_time_seen_on=_str(raw.get("last_time_seen_on")),
            event_end_date=_str(raw.get("event_end_date")),
            occurrences=to_int(raw.get("occurrences")),
            raw=dict(raw),
        )


@dataclass(frozen=True)
class RateLimit:
    limit: Optional[int] = None
    remaining: Optional[int] = None
    reset: Optional[int] = None
    """Unix seconds when the window resets."""


@dataclass(frozen=True)
class ConnectionTestResult:
    ok: bool
    latency_ms: int
    stage: Optional[str] = None
    """``config`` (invalid settings), ``auth`` (token refused) or ``api`` (token OK, call failed)."""
    status: Optional[int] = None
    message: Optional[str] = None
    server: Optional[ServerStatus] = None
