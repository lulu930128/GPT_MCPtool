from __future__ import annotations

from datetime import UTC, datetime


def utc_now() -> datetime:
    return datetime.now(UTC)


def ensure_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def sqlite_utc(value: datetime) -> datetime:
    """Return naive UTC for SQLite persistence."""
    return ensure_utc(value).replace(tzinfo=None)
