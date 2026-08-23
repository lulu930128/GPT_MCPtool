from __future__ import annotations


class BridgeError(Exception):
    def __init__(self, *, code: str, message: str, http_status: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status


class AuthenticationError(BridgeError):
    def __init__(self) -> None:
        super().__init__(
            code="unauthorized",
            message="A valid local bearer token is required.",
            http_status=401,
        )


class AdapterNotConfiguredError(BridgeError):
    def __init__(self) -> None:
        super().__init__(
            code="adapter_not_configured",
            message="The live KGI adapter is not configured.",
            http_status=503,
        )


_UPSTREAM_ERRORS: dict[str, tuple[str, int]] = {
    "auth_failed": ("KGI authentication failed.", 502),
    "ca_failed": ("KGI certificate authentication failed.", 502),
    "account_unavailable": ("A KGI securities account is not available.", 502),
    "inventory_fetch_failed": ("KGI inventory could not be retrieved.", 502),
    "sdk_unavailable": ("The configured KGI SDK runtime is unavailable.", 503),
    "timeout": ("The KGI inventory request timed out.", 504),
    "worker_protocol_invalid": ("The KGI worker returned an invalid response.", 502),
    "internal_error": ("The KGI worker failed safely.", 502),
}


class KGIUpstreamError(BridgeError):
    def __init__(self, reason: str) -> None:
        message, http_status = _UPSTREAM_ERRORS.get(
            reason,
            _UPSTREAM_ERRORS["internal_error"],
        )
        safe_reason = reason if reason in _UPSTREAM_ERRORS else "internal_error"
        super().__init__(
            code=f"kgi_{safe_reason}",
            message=message,
            http_status=http_status,
        )


class AmbiguousEmptyInventoryError(BridgeError):
    def __init__(self) -> None:
        super().__init__(
            code="ambiguous_empty_inventory",
            message="KGI returned no publishable positions without an explicit empty confirmation.",
            http_status=502,
        )


class SchemaParseError(BridgeError):
    def __init__(self, field: str) -> None:
        super().__init__(
            code="schema_parse_failed",
            message=f"KGI inventory schema validation failed for field: {field}.",
            http_status=502,
        )
