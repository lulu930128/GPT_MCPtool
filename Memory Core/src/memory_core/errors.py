from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from memory_core.record_schemas import RecordSchemaValidationIssue
from memory_core.temporal import TemporalValidationIssue


class DomainError(Exception):
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        *,
        field: str | None = None,
        received_value: object | None = None,
        example: object | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.field = field
        self.received_value = received_value
        self.example = example

    def error_payload(self) -> dict[str, object]:
        payload: dict[str, object] = {"code": self.code, "message": self.message}
        if self.field is not None:
            payload["field"] = self.field
        if self.received_value is not None:
            payload["received_value"] = self.received_value
        if self.example is not None:
            payload["example"] = self.example
        return payload


class NotFoundError(DomainError):
    def __init__(self, resource: str) -> None:
        super().__init__(404, "not_found", f"{resource} was not found")


class VersionConflictError(DomainError):
    def __init__(self, expected: int, actual: int) -> None:
        super().__init__(
            409,
            "version_conflict",
            f"Expected version {expected}, but current version is {actual}",
        )


class CandidateConflictError(DomainError):
    def __init__(self, message: str) -> None:
        super().__init__(409, "candidate_conflict", message)


class CandidateExpiredError(DomainError):
    def __init__(self) -> None:
        super().__init__(410, "candidate_expired", "The candidate has expired")


class CandidateDigestMismatchError(DomainError):
    def __init__(self) -> None:
        super().__init__(
            409,
            "candidate_digest_mismatch",
            "The candidate no longer matches the content that was reviewed",
        )


class ReviewChallengeError(DomainError):
    def __init__(self, message: str = "The review challenge is invalid") -> None:
        super().__init__(409, "invalid_review_challenge", message)


class ReviewChallengeExpiredError(DomainError):
    def __init__(self) -> None:
        super().__init__(410, "review_challenge_expired", "The review challenge has expired")


class OperationError(DomainError):
    def __init__(
        self,
        message: str,
        *,
        code: str = "invalid_operation",
        field: str | None = None,
        received_value: object | None = None,
        example: object | None = None,
    ) -> None:
        super().__init__(
            422,
            code,
            message,
            field=field,
            received_value=received_value,
            example=example,
        )


class AuthorizationError(DomainError):
    def __init__(self, message: str = "The client does not have the required scope") -> None:
        super().__init__(403, "forbidden", message)


TEMPORAL_VALIDATION_CODES = {
    "timezone_offset_required",
    "invalid_timezone_name",
    "occurred_start_required",
    "invalid_time_range",
    "date_precision_without_occurrence",
    "date_precision_required",
}


def operation_error_from_temporal(issue: TemporalValidationIssue) -> OperationError:
    return OperationError(
        issue.message,
        code=issue.code,
        field=issue.field,
        received_value=issue.received_value,
        example=issue.example,
    )


def operation_error_from_record_schema(
    issue: RecordSchemaValidationIssue,
) -> OperationError:
    return OperationError(
        issue.message,
        code=issue.code,
        field=issue.field,
        received_value=issue.received_value,
        example=issue.example,
    )


def operation_error_from_validation(
    errors: Sequence[Mapping[str, Any]],
    *,
    fallback_message: str,
) -> OperationError:
    for error in errors:
        error_type = str(error.get("type") or "")
        if error_type not in TEMPORAL_VALIDATION_CODES:
            continue
        context = error.get("ctx")
        context_mapping = context if isinstance(context, Mapping) else {}
        field = context_mapping.get("field")
        if not isinstance(field, str):
            location = error.get("loc")
            if isinstance(location, (tuple, list)):
                field = next(
                    (
                        part
                        for part in reversed(location)
                        if isinstance(part, str) and part not in {"body", "content"}
                    ),
                    None,
                )
        example = context_mapping.get("example")
        received = error.get("input")
        if not isinstance(received, (str, int, float, bool)):
            received = None
        return OperationError(
            str(error.get("msg") or fallback_message),
            code=error_type,
            field=field if isinstance(field, str) else None,
            received_value=received,
            example=example,
        )
    return OperationError(fallback_message)
