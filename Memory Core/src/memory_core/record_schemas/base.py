from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class RecordSchemaValidationIssue(Exception):
    code: str
    field: str
    message: str
    received_value: object | None = None
    example: object | None = None


def payload_field_path(parts: tuple[object, ...]) -> str:
    path = "payload"
    for part in parts:
        if isinstance(part, int):
            path = f"{path}[{part}]"
        else:
            path = f"{path}.{part}"
    return path


def scalar_error_value(value: object) -> object | None:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return None
