from __future__ import annotations

from unittest.mock import Mock

from memory_core.viewer.app import MemoryCoreViewer


def test_stale_list_response_does_not_replace_current_view() -> None:
    viewer = object.__new__(MemoryCoreViewer)
    viewer._list_request_serial = 4
    viewer._current_view = "entities"
    viewer._render_records = Mock()
    viewer._render_collections = Mock()
    viewer._render_entities = Mock()
    viewer._render_candidates = Mock()

    viewer._render_list_if_current(3, "records", [{"id": "record-1"}])

    viewer._render_records.assert_not_called()
    viewer._render_entities.assert_not_called()

    viewer._render_list_if_current(4, "entities", [{"id": "entity-1"}])

    viewer._render_entities.assert_called_once_with([{"id": "entity-1"}])


def test_collection_detail_requires_current_request_and_matching_key() -> None:
    viewer = object.__new__(MemoryCoreViewer)
    viewer._detail_request_serial = 5
    viewer._render_collection_detail = Mock()

    viewer._render_collection_if_current(
        4,
        "media.galgame.completed",
        {"key": "media.galgame.completed"},
    )
    viewer._render_collection_if_current(
        5,
        "media.galgame.completed",
        {"key": "another.collection"},
    )
    viewer._render_collection_detail.assert_not_called()

    collection = {"key": "media.galgame.completed", "member_count": 12}
    viewer._render_collection_if_current(5, "media.galgame.completed", collection)
    viewer._render_collection_detail.assert_called_once_with(collection)


def test_stale_detail_response_does_not_replace_current_selection() -> None:
    viewer = object.__new__(MemoryCoreViewer)
    viewer._detail_request_serial = 8
    viewer._render_record_detail = Mock()
    viewer._render_entity_detail = Mock()
    viewer._render_candidate_detail = Mock()

    viewer._render_detail_if_current(
        7,
        "record",
        "record-1",
        {"id": "record-1"},
    )

    viewer._render_record_detail.assert_not_called()

    viewer._render_detail_if_current(
        8,
        "record",
        "record-2",
        {"id": "record-2"},
    )

    viewer._render_record_detail.assert_called_once_with({"id": "record-2"})
