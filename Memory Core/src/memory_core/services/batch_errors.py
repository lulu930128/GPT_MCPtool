from __future__ import annotations

import re
from dataclasses import dataclass

from memory_core.errors import DomainError

_MAX_PUBLIC_MESSAGE_CHARS = 500
_SAFE_CODE = re.compile(r"^[a-z][a-z0-9_]{0,79}$")
_WINDOWS_USER_HOME = re.compile(r"(?i)(?<![A-Za-z0-9])[A-Z]:[\\/]Users[\\/][^\\/\s,;，。；、]+")
_WINDOWS_DRIVE_PATH = re.compile(r"(?i)(?<![A-Za-z0-9])[A-Z]:[\\/][^\r\n,;，。；]*")
_WINDOWS_UNC_PATH = re.compile(r"(?<![\\/])\\\\[^\\/\s]+[\\/][^\r\n,;，。；]*")
_BEARER_TOKEN = re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}")
_NAMED_SECRET = re.compile(
    r"(?i)\b(api[_-]?key|authorization|cookie|password|private[_-]?key|secret|token)"
    r"\s*[:=]\s*[^\s,;]+"
)
_OPENAI_STYLE_KEY = re.compile(r"\bsk-[A-Za-z0-9_-]{8,}")
_JWT = re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")

_RETRY_SAME_PLAN_CODES = {
    "backend_timeout",
    "backend_unavailable",
    "database_busy",
    "database_locked",
    "serialization_failure",
    "transient_database_busy",
}
_NEW_BATCH_REQUIRED_CODES = {
    "batch_item_plan_digest_mismatch",
    "candidate_conflict",
    "forbidden",
    "identity_conflict",
    "invalid_batch_operation_reference",
    "invalid_operation",
    "not_found",
    "schema_validation_failed",
    "unsupported_batch_operation",
    "unresolved_batch_operation_reference",
    "version_conflict",
}


@dataclass(frozen=True, slots=True)
class BatchExecutionError:
    code: str
    message: str
    retry_policy: str


def redact_batch_error_text(value: str) -> str:
    projected = _WINDOWS_USER_HOME.sub("[local-user-home]", value)
    projected = _WINDOWS_UNC_PATH.sub("[local-network-share]", projected)
    projected = _WINDOWS_DRIVE_PATH.sub("[local-path]", projected)
    projected = _BEARER_TOKEN.sub("Bearer [secret hidden]", projected)
    projected = _NAMED_SECRET.sub(lambda match: f"{match.group(1)}=[secret hidden]", projected)
    projected = _OPENAI_STYLE_KEY.sub("[secret hidden]", projected)
    projected = _JWT.sub("[secret hidden]", projected)
    return projected[:_MAX_PUBLIC_MESSAGE_CHARS]


def project_batch_execution_error(error: Exception) -> BatchExecutionError:
    raw_code = getattr(error, "code", None)
    code = raw_code if isinstance(raw_code, str) and _SAFE_CODE.fullmatch(raw_code) else None
    if code is None:
        code = "batch_item_apply_failed"

    if isinstance(error, DomainError):
        message = redact_batch_error_text(error.message)
    else:
        message = "Batch item execution failed."

    if code in _RETRY_SAME_PLAN_CODES:
        retry_policy = "retry_same_plan"
    elif code in _NEW_BATCH_REQUIRED_CODES:
        retry_policy = "new_batch_required"
    else:
        # Unknown failures are conservative: the same sealed plan is not replayed until a
        # maintainer explicitly classifies the error as transient.
        retry_policy = "new_batch_required"
    return BatchExecutionError(
        code=code,
        message=message or "Batch item execution failed.",
        retry_policy=retry_policy,
    )
