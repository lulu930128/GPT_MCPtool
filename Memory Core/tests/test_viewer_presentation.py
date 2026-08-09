from __future__ import annotations

import json
import os

import pytest

from memory_core.viewer.editor import (
    entity_create_document,
    entity_update_document,
    media_experience_batch_document,
    parse_json_object,
    record_create_document,
    record_update_document,
)
from memory_core.viewer.presentation import (
    candidate_display_title,
    candidate_primary_fields,
    candidate_technical_fields,
    category_counts,
    compact_text,
    display_identifier,
    entity_display_title,
    entity_primary_fields,
    filter_by_category,
    format_datetime,
    pretty_json,
    record_display_title,
    record_primary_fields,
    record_summary_lines,
    record_technical_fields,
    result_list_summary,
)
from memory_core.viewer.settings import ViewerSettings


def test_presentation_helpers_keep_unicode_and_bound_long_text() -> None:
    assert compact_text("  Summer   Pockets  ") == "Summer Pockets"
    assert compact_text("abcdefgh", limit=6) == "abcde…"
    assert display_identifier("1234567890abcdefghijkl") == "12345678…ijkl"
    assert "調酒" in pretty_json({"title": "調酒"})
    assert json.loads(pretty_json({"b": 1, "a": 2})) == {"a": 2, "b": 1}


def test_format_datetime_handles_iso_and_unparseable_values() -> None:
    assert format_datetime(None) == "—"
    assert format_datetime("not-a-date") == "not-a-date"
    assert len(format_datetime("2026-07-28T12:30:00+08:00")) == 16


def test_record_summary_includes_schema_and_revision_version() -> None:
    lines = dict(
        record_summary_lines(
            {
                "title": "測試",
                "id": "record-1",
                "kind": "fact",
                "domain": "projects",
                "schema_name": "generic",
                "schema_version": 1,
                "version": 3,
            }
        )
    )
    assert lines["Schema"] == "generic v1"
    assert lines["版本"] == "3"
    assert lines["資料類型"] == "fact"
    assert lines["領域分類"] == "projects"


def test_categories_are_sorted_counted_and_keep_all_rows() -> None:
    rows = [
        {"id": "1", "domain": "media.galgame"},
        {"id": "2", "domain": "career"},
        {"id": "3", "domain": "media.galgame"},
        {"id": "4", "domain": ""},
    ]
    assert category_counts(rows, "domain") == [
        ("career", 1),
        ("media.galgame", 2),
        ("未分類", 1),
    ]
    assert filter_by_category(rows, "domain", None) == rows
    assert [row["id"] for row in filter_by_category(rows, "domain", "media.galgame")] == [
        "1",
        "3",
    ]


def test_candidate_title_prefers_summary_then_content_then_target() -> None:
    assert candidate_display_title({"summary": "完整變更摘要"}) == "完整變更摘要"
    assert (
        candidate_display_title(
            {
                "operation": "create",
                "target_type": "record",
                "proposed_content": {"title": "白瀬瑠璃的日月光任職經歷"},
            }
        )
        == "create · 白瀬瑠璃的日月光任職經歷"
    )
    assert "archive · record-" in candidate_display_title(
        {"operation": "archive", "target_id": "record-1234567890abcdef"}
    )


def test_v2_titles_and_list_summaries_use_safe_fallbacks() -> None:
    assert record_display_title({}) == "未命名記憶"
    assert entity_display_title({"name": "  "}) == "未命名實體"
    assert result_list_summary({"body_markdown": "第一行\n第二行"}, "record") == "第一行 第二行"
    long_summary = "長" * 100
    assert result_list_summary({"summary": long_summary}, "record").endswith("…")
    assert len(result_list_summary({"summary": long_summary}, "record")) == 68


def test_v2_primary_and_technical_fields_are_separated() -> None:
    record = {
        "id": "record-1",
        "kind": "fact",
        "domain": "",
        "schema_name": "generic",
        "schema_version": 1,
        "version": 3,
        "source_type": "manual",
    }
    primary = dict(record_primary_fields(record))
    technical = dict(record_technical_fields(record))
    assert primary["領域分類"] == "未分類"
    assert "Record ID" not in primary
    assert technical["Record ID"] == "record-1"
    assert technical["Schema"] == "generic v1"

    entity_primary = dict(entity_primary_fields({"entity_type": "project"}))
    assert entity_primary["實體類型"] == "project"

    candidate = {
        "id": "candidate-1",
        "status": "pending",
        "operation": "create",
        "review_digest": "sha256:test",
        "risk_flags": ["personal"],
    }
    assert dict(candidate_primary_fields(candidate))["狀態"] == "pending"
    assert dict(candidate_technical_fields(candidate))["Review digest"] == "sha256:test"


def test_viewer_settings_pop_token_and_require_loopback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MEMORY_CORE_CONTROL_CENTER_TOKEN", "mcore_local")
    monkeypatch.setenv("MEMORY_CORE_CONTROL_CENTER_API_BASE_URL", "http://localhost:8765")
    settings = ViewerSettings.from_environment()
    assert settings.api_base_url == "http://localhost:8765"
    assert settings.layout == "v2"
    assert "MEMORY_CORE_CONTROL_CENTER_TOKEN" not in os.environ

    monkeypatch.setenv("MEMORY_CORE_CONTROL_CENTER_TOKEN", "mcore_local")
    monkeypatch.setenv("MEMORY_CORE_CONTROL_CENTER_API_BASE_URL", "https://example.com")
    with pytest.raises(ValueError, match="loopback"):
        ViewerSettings.from_environment()


def test_control_center_rejects_legacy_read_only_viewer_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("MEMORY_CORE_CONTROL_CENTER_TOKEN", raising=False)
    monkeypatch.setenv("MEMORY_CORE_VIEWER_TOKEN", "mcore_legacy_read_only")
    with pytest.raises(ValueError, match="控制中心 credential"):
        ViewerSettings.from_environment()
    assert "MEMORY_CORE_VIEWER_TOKEN" not in os.environ


def test_viewer_settings_accepts_legacy_layout_and_rejects_unknown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MEMORY_CORE_CONTROL_CENTER_TOKEN", "mcore_local")
    monkeypatch.setenv("MEMORY_CORE_VIEWER_LAYOUT", "legacy")
    assert ViewerSettings.from_environment().layout == "legacy"

    monkeypatch.setenv("MEMORY_CORE_CONTROL_CENTER_TOKEN", "mcore_local")
    monkeypatch.setenv("MEMORY_CORE_VIEWER_LAYOUT", "experimental")
    with pytest.raises(ValueError, match="v2 或 legacy"):
        ViewerSettings.from_environment()


def test_editor_documents_expose_complete_mutable_contracts() -> None:
    record_create = record_create_document()
    assert record_create["kind"] == "fact"
    assert record_create["payload"] == {}
    assert record_create["date_precision"] == "unknown"

    record_update = record_update_document(
        {
            "title": "原標題",
            "version": 4,
            "kind": "fact",
            "domain": "career",
            "source_type": "manual",
            "payload": {"status": "active"},
        }
    )
    assert record_update["expected_version"] == 4
    assert record_update["payload"] == {"status": "active"}
    assert "kind" not in record_update
    assert "domain" not in record_update
    assert "source_type" not in record_update

    entity_create = entity_create_document()
    assert entity_create["entity_type"] == "person"
    entity_update = entity_update_document({"name": "測試", "version": 2, "entity_type": "person"})
    assert entity_update["expected_version"] == 2
    assert "entity_type" not in entity_update

    batch_create = media_experience_batch_document()
    assert batch_create["profile_id"] == "media.experience.v1"
    assert len(batch_create["items"]) == 1
    assert batch_create["items"][0]["media_type"] == "galgame"


def test_parse_json_object_requires_valid_object() -> None:
    assert parse_json_object('{"title": "調酒"}') == {"title": "調酒"}
    with pytest.raises(ValueError, match="最外層"):
        parse_json_object('["not", "an", "object"]')
    with pytest.raises(ValueError, match="JSON 格式錯誤"):
        parse_json_object('{"broken":}')
