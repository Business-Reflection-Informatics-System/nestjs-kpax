"""KPAX API v1 client for Python. https://github.com/Business-Reflection-Informatics-System/nestjs-kpax"""

from .client import DEFAULT_SCOPES, KpaxClient, paginate
from .errors import KpaxApiError, KpaxAuthError, KpaxConfigurationError, KpaxError
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

__version__ = "0.1.0"

__all__ = [
    "KpaxClient",
    "DEFAULT_SCOPES",
    "paginate",
    "KpaxError",
    "KpaxApiError",
    "KpaxAuthError",
    "KpaxConfigurationError",
    "Account",
    "AlertHistoryEvent",
    "ConnectionTestResult",
    "Device",
    "Page",
    "PaginationMeta",
    "RateLimit",
    "ServerStatus",
    "__version__",
]
