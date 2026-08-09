from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import AfterValidator, AwareDatetime, BeforeValidator, Field
from pydantic_core import PydanticCustomError

TIMEZONE_AWARE_DATETIME_DESCRIPTION = (
    "RFC 3339 timezone-aware timestamp. Include Z or an explicit numeric UTC offset "
    "such as +08:00. Naive timestamps are invalid. Stored values are normalized to UTC."
)
IANA_TIMEZONE_DESCRIPTION = (
    "Optional IANA timezone for the event context, such as Asia/Taipei. This does not "
    "replace the required Z or numeric offset in occurred_start and occurred_end."
)


@dataclass(frozen=True, slots=True)
class TemporalValidationIssue(Exception):
    code: str
    field: str
    message: str
    received_value: object | None = None
    example: object | None = None


def _require_timezone_offset(value: Any) -> Any:
    if isinstance(value, datetime):
        if value.tzinfo is None or value.utcoffset() is None:
            raise PydanticCustomError(
                "timezone_offset_required",
                "Timestamp must include Z or an explicit numeric UTC offset such as +08:00.",
                {"example": "2025-07-16T00:00:00+08:00"},
            )
        return value
    if isinstance(value, str):
        normalized = value.strip()
        try:
            parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
        except ValueError:
            return value
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise PydanticCustomError(
                "timezone_offset_required",
                "Timestamp must include Z or an explicit numeric UTC offset such as +08:00.",
                {"example": "2025-07-16T00:00:00+08:00"},
            )
    return value


def _normalize_datetime_to_utc(value: datetime) -> datetime:
    return value.astimezone(UTC)


def _validate_iana_timezone(value: str) -> str:
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise PydanticCustomError(
            "invalid_timezone_name",
            "timezone_name must be a valid IANA timezone.",
            {"example": "Asia/Taipei"},
        ) from exc
    return value


TimezoneAwareDatetime = Annotated[
    AwareDatetime,
    BeforeValidator(_require_timezone_offset),
    AfterValidator(_normalize_datetime_to_utc),
    Field(
        description=TIMEZONE_AWARE_DATETIME_DESCRIPTION,
        examples=["2025-07-16T00:00:00+08:00"],
    ),
]

IanaTimezoneName = Annotated[
    str,
    Field(
        min_length=1,
        max_length=80,
        description=IANA_TIMEZONE_DESCRIPTION,
        examples=["Asia/Taipei"],
    ),
    AfterValidator(_validate_iana_timezone),
]


def validate_record_temporal_state(
    *,
    occurred_start: datetime | None,
    occurred_end: datetime | None,
    date_precision: str,
) -> None:
    if occurred_end is not None and occurred_start is None:
        raise TemporalValidationIssue(
            code="occurred_start_required",
            field="occurred_end",
            message="occurred_end requires occurred_start.",
            received_value=occurred_end.isoformat(),
            example="Set occurred_start or use null for occurred_end.",
        )
    if occurred_start is not None and occurred_end is not None and occurred_end < occurred_start:
        raise TemporalValidationIssue(
            code="invalid_time_range",
            field="occurred_end",
            message="occurred_end must not be earlier than occurred_start.",
            received_value=occurred_end.isoformat(),
        )
    if occurred_start is None and date_precision != "unknown":
        raise TemporalValidationIssue(
            code="date_precision_without_occurrence",
            field="date_precision",
            message='date_precision must be "unknown" when occurred_start is null.',
            received_value=date_precision,
            example="unknown",
        )
    if occurred_start is not None and date_precision == "unknown":
        raise TemporalValidationIssue(
            code="date_precision_required",
            field="date_precision",
            message=(
                'date_precision must describe a non-null occurred_start and cannot be "unknown".'
            ),
            received_value=date_precision,
            example="day",
        )


def localize_utc_timestamp(value: object, timezone_name: object) -> str | None:
    if not isinstance(value, str) or not isinstance(timezone_name, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            return None
        return parsed.astimezone(ZoneInfo(timezone_name)).isoformat()
    except (ValueError, ZoneInfoNotFoundError):
        return None
