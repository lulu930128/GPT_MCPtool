from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any

LOCAL_PATH_PLACEHOLDER = "[local path hidden]"
LOCAL_SOURCE_PLACEHOLDER = "local source (path hidden)"

_WINDOWS_USER_HOME = re.compile(r"(?i)(?<![A-Za-z0-9])[A-Z]:[\\/]Users[\\/][^\\/\s,;，。；、]+")
_WINDOWS_DRIVE_PREFIX = re.compile(r"(?i)(?<![A-Za-z0-9])[A-Z]:[\\/]")
_WINDOWS_UNC_ROOT = re.compile(r"(?<![\\/])\\\\[^\\/\s]+[\\/][^\\/\s]+")
_MACHINE_PATH_KEYS = {
    "absolute_path",
    "directory",
    "file_path",
    "folder_path",
    "local_path",
    "root_path",
    "source_path",
    "workspace_path",
}


def contains_machine_local_path(value: str) -> bool:
    return bool(
        _WINDOWS_USER_HOME.search(value)
        or _WINDOWS_DRIVE_PREFIX.search(value)
        or _WINDOWS_UNC_ROOT.search(value)
    )


def contains_machine_local_value(value: Any) -> bool:
    if isinstance(value, str):
        return contains_machine_local_path(value)
    if isinstance(value, Mapping):
        return any(
            contains_machine_local_value(key) or contains_machine_local_value(item)
            for key, item in value.items()
        )
    if isinstance(value, Sequence) and not isinstance(value, bytes):
        return any(contains_machine_local_value(item) for item in value)
    return False


def redact_machine_local_text(value: str) -> str:
    projected = _WINDOWS_USER_HOME.sub("[local-user-home]", value)
    projected = _WINDOWS_UNC_ROOT.sub("[local-network-share]", projected)
    return _WINDOWS_DRIVE_PREFIX.sub("[local-drive]/", projected)


def safe_source_reference(value: Any) -> Any:
    if isinstance(value, str) and contains_machine_local_path(value):
        return LOCAL_SOURCE_PLACEHOLDER
    return project_external_value(value)


def project_external_value(value: Any, *, field_name: str | None = None) -> Any:
    projected, _redacted_fields = _project_external_value(
        value,
        field_name=field_name,
        field_path=field_name or "value",
    )
    return projected


def project_external_value_with_redactions(
    value: Any,
    *,
    root: str,
) -> tuple[Any, list[str]]:
    return _project_external_value(value, field_name=None, field_path=root)


def _project_external_value(
    value: Any,
    *,
    field_name: str | None,
    field_path: str,
) -> tuple[Any, list[str]]:
    if (
        field_name is not None
        and _is_machine_path_key(field_name)
        and value not in (None, "", [], {})
        and contains_machine_local_value(value)
    ):
        return LOCAL_PATH_PLACEHOLDER, [field_path]
    if isinstance(value, str):
        projected = redact_machine_local_text(value)
        return projected, ([field_path] if projected != value else [])
    if isinstance(value, Mapping):
        projected_mapping: dict[str, Any] = {}
        redacted_fields: list[str] = []
        for key, item in value.items():
            string_key = str(key)
            projected_item, item_redactions = _project_external_value(
                item,
                field_name=string_key,
                field_path=f"{field_path}.{string_key}",
            )
            projected_mapping[string_key] = projected_item
            redacted_fields.extend(item_redactions)
        return projected_mapping, redacted_fields
    if isinstance(value, Sequence) and not isinstance(value, bytes):
        projected_items: list[Any] = []
        redacted_fields = []
        for index, item in enumerate(value):
            projected_item, item_redactions = _project_external_value(
                item,
                field_name=None,
                field_path=f"{field_path}[{index}]",
            )
            projected_items.append(projected_item)
            redacted_fields.extend(item_redactions)
        return projected_items, redacted_fields
    return value, []


def _is_machine_path_key(value: str) -> bool:
    normalized = value.strip().casefold().replace("-", "_")
    return normalized in _MACHINE_PATH_KEYS or normalized.endswith(("_path", "_directory"))
