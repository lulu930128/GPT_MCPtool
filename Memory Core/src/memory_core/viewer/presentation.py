from __future__ import annotations

import json
from collections import Counter
from datetime import datetime
from typing import Any


def format_datetime(value: object) -> str:
    if not isinstance(value, str) or not value:
        return "—"
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return value
    return parsed.astimezone().strftime("%Y-%m-%d %H:%M")


def compact_text(value: object, *, limit: int = 90) -> str:
    if not isinstance(value, str) or not value.strip():
        return "—"
    text = " ".join(value.split())
    if len(text) <= limit:
        return text
    return f"{text[: limit - 1].rstrip()}…"


def pretty_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)


def display_identifier(value: object) -> str:
    if not isinstance(value, str):
        return "—"
    if len(value) <= 16:
        return value
    return f"{value[:8]}…{value[-4:]}"


def category_value(row: dict[str, Any], key: str) -> str:
    value = row.get(key)
    if not isinstance(value, str) or not value.strip():
        return "未分類"
    return value.strip()


def category_counts(rows: list[dict[str, Any]], key: str) -> list[tuple[str, int]]:
    counts = Counter(category_value(row, key) for row in rows)
    return sorted(counts.items(), key=lambda item: item[0].casefold())


def filter_by_category(
    rows: list[dict[str, Any]],
    key: str,
    selected_category: str | None,
) -> list[dict[str, Any]]:
    if selected_category is None:
        return list(rows)
    return [row for row in rows if category_value(row, key) == selected_category]


def candidate_display_title(candidate: dict[str, Any]) -> str:
    summary = candidate.get("summary")
    if isinstance(summary, str) and summary.strip():
        return summary.strip()
    operation = str(candidate.get("operation") or candidate.get("candidate_kind") or "change")
    content = candidate.get("proposed_content")
    content_title: object = None
    if isinstance(content, dict):
        content_title = content.get("title") or content.get("name") or content.get("change_reason")
    if isinstance(content_title, str) and content_title.strip():
        return f"{operation} · {content_title.strip()}"
    target_id = candidate.get("target_id")
    if isinstance(target_id, str) and target_id:
        return f"{operation} · {display_identifier(target_id)}"
    return f"{operation} · {candidate.get('target_type') or 'records'}"


def record_display_title(record: dict[str, Any]) -> str:
    title = record.get("title")
    if isinstance(title, str) and title.strip():
        return title.strip()
    return "未命名記憶"


def entity_display_title(entity: dict[str, Any]) -> str:
    name = entity.get("name")
    if isinstance(name, str) and name.strip():
        return name.strip()
    return "未命名實體"


def result_list_summary(row: dict[str, Any], result_type: str) -> str:
    if result_type == "entity":
        return compact_text(row.get("description"), limit=68)
    if result_type == "candidate":
        status = str(row.get("status") or "pending")
        operation = str(row.get("operation") or "change_set")
        return compact_text(f"{status} · {operation}", limit=68)
    return compact_text(row.get("summary") or row.get("body_markdown"), limit=68)


def record_primary_fields(record: dict[str, Any]) -> list[tuple[str, str]]:
    occurred = format_datetime(record.get("occurred_start"))
    if record.get("occurred_end"):
        occurred = f"{occurred} → {format_datetime(record.get('occurred_end'))}"
    return [
        ("資料類型", str(record.get("kind") or "—")),
        ("領域分類", category_value(record, "domain")),
        (
            "狀態",
            f"{record.get('lifecycle_status', '—')} / {record.get('verification_status', '—')}",
        ),
        ("發生時間", occurred),
        ("重要度", str(record.get("importance") if record.get("importance") is not None else "—")),
    ]


def record_technical_fields(record: dict[str, Any]) -> list[tuple[str, str]]:
    return [
        ("Record ID", str(record.get("id") or "—")),
        (
            "Schema",
            f"{record.get('schema_name', '—')} v{record.get('schema_version', '—')}",
        ),
        ("版本", str(record.get("version") or "—")),
        ("敏感度", f"{record.get('sensitivity', '—')} / {record.get('handling_policy', '—')}"),
        ("更新時間", format_datetime(record.get("updated_at"))),
        ("來源", f"{record.get('source_type', '—')} · {record.get('source_reference') or '—'}"),
    ]


def entity_primary_fields(entity: dict[str, Any]) -> list[tuple[str, str]]:
    return [
        ("實體類型", category_value(entity, "entity_type")),
        ("Canonical name", str(entity.get("canonical_name") or "—")),
        ("狀態", "archived" if entity.get("deleted_at") else "active"),
        ("更新時間", format_datetime(entity.get("updated_at"))),
    ]


def entity_technical_fields(entity: dict[str, Any]) -> list[tuple[str, str]]:
    return [
        ("Entity ID", str(entity.get("id") or "—")),
        ("版本", str(entity.get("version") or "—")),
        ("敏感度", f"{entity.get('sensitivity', '—')} / {entity.get('handling_policy', '—')}"),
        ("建立時間", format_datetime(entity.get("created_at"))),
        ("更新時間", format_datetime(entity.get("updated_at"))),
    ]


def candidate_primary_fields(candidate: dict[str, Any]) -> list[tuple[str, str]]:
    risk_flags = candidate.get("risk_flags")
    formatted_flags = (
        ", ".join(str(flag) for flag in risk_flags) if isinstance(risk_flags, list) else "—"
    )
    return [
        ("狀態", str(candidate.get("status") or "—")),
        ("操作", str(candidate.get("operation") or "change_set")),
        ("目標", str(candidate.get("target_type") or "records")),
        ("來源", str(candidate.get("source_type") or "—")),
        ("到期時間", format_datetime(candidate.get("expires_at"))),
        ("風險標記", formatted_flags or "—"),
    ]


def candidate_technical_fields(candidate: dict[str, Any]) -> list[tuple[str, str]]:
    return [
        ("Candidate ID", str(candidate.get("id") or "—")),
        ("Candidate kind", str(candidate.get("candidate_kind") or "single")),
        ("Target ID", str(candidate.get("target_id") or "—")),
        ("Base version", str(candidate.get("base_version") or "—")),
        ("Review digest", str(candidate.get("review_digest") or "—")),
    ]


def record_summary_lines(record: dict[str, Any]) -> list[tuple[str, str]]:
    occurred = format_datetime(record.get("occurred_start"))
    if record.get("occurred_end"):
        occurred = f"{occurred} → {format_datetime(record.get('occurred_end'))}"
    return [
        ("標題", str(record.get("title") or "—")),
        ("Record ID", str(record.get("id") or "—")),
        ("資料類型", str(record.get("kind") or "—")),
        ("領域分類", str(record.get("domain") or "—")),
        (
            "Schema",
            f"{record.get('schema_name', '—')} v{record.get('schema_version', '—')}",
        ),
        ("版本", str(record.get("version") or "—")),
        (
            "狀態",
            f"{record.get('lifecycle_status', '—')} / {record.get('verification_status', '—')}",
        ),
        ("敏感度", f"{record.get('sensitivity', '—')} / {record.get('handling_policy', '—')}"),
        ("發生時間", occurred),
        ("重要度", str(record.get("importance") if record.get("importance") is not None else "—")),
        ("更新時間", format_datetime(record.get("updated_at"))),
        ("來源", f"{record.get('source_type', '—')} · {record.get('source_reference') or '—'}"),
        ("摘要", str(record.get("summary") or "—")),
    ]


def entity_summary_lines(entity: dict[str, Any]) -> list[tuple[str, str]]:
    return [
        ("名稱", str(entity.get("name") or "—")),
        ("Entity ID", str(entity.get("id") or "—")),
        ("類型", str(entity.get("entity_type") or "—")),
        ("Canonical name", str(entity.get("canonical_name") or "—")),
        ("版本", str(entity.get("version") or "—")),
        ("敏感度", f"{entity.get('sensitivity', '—')} / {entity.get('handling_policy', '—')}"),
        ("更新時間", format_datetime(entity.get("updated_at"))),
        ("描述", str(entity.get("description") or "—")),
    ]


def format_summary(lines: list[tuple[str, str]]) -> str:
    width = max((len(label) for label, _ in lines), default=0)
    return "\n\n".join(f"{label:<{width}}  {value}" for label, value in lines)
