from __future__ import annotations

import json
from collections.abc import Callable

import httpx
import pytest

from memory_core.viewer.client import ViewerApiClient, ViewerApiError

TOKEN = "mcore_viewer_test_secret"


def build_client(handler: Callable[[httpx.Request], httpx.Response]) -> ViewerApiClient:
    return ViewerApiClient(
        base_url="http://127.0.0.1:8765",
        token=TOKEN,
        transport=httpx.MockTransport(handler),
    )


def test_viewer_client_uses_read_endpoints_and_auth_header() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/links"):
            return httpx.Response(200, json=[])
        if request.url.path.endswith("/overview"):
            return httpx.Response(200, json={"records": {}})
        return httpx.Response(200, json=[{"id": "record-1"}])

    client = build_client(handler)
    try:
        assert client.base_url == "http://127.0.0.1:8765"
        assert client.overview() == {"records": {}}
        assert client.list_records(include_deleted=False) == [{"id": "record-1"}]
        assert client.list_record_links("record-1", direction="inbound") == []
    finally:
        client.close()

    assert [request.method for request in requests] == ["GET", "GET", "GET"]
    assert requests[0].headers["X-Memory-Core-Token"] == TOKEN
    assert requests[1].url.params["include_deleted"] == "false"
    assert requests[2].url.params["direction"] == "inbound"


def test_viewer_client_search_preserves_filters() -> None:
    captured: httpx.Request | None = None

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal captured
        captured = request
        return httpx.Response(200, json=[])

    client = build_client(handler)
    try:
        assert client.search("調酒", filters={"domain": "lifestyle.cocktail"}) == []
    finally:
        client.close()

    assert captured is not None
    assert captured.url.path == "/api/v1/search"
    assert captured.url.params["q"] == "調酒"
    assert captured.url.params["domain"] == "lifestyle.cocktail"


def test_viewer_client_redacts_token_from_public_error() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            403,
            headers={"X-Request-ID": "request-123"},
            json={
                "error": {
                    "code": "insufficient_scope",
                    "message": "Missing required scope",
                }
            },
        )

    client = build_client(handler)
    try:
        with pytest.raises(ViewerApiError) as caught:
            client.overview()
    finally:
        client.close()

    message = caught.value.public_message()
    assert "insufficient_scope" in message
    assert "request-123" in message
    assert TOKEN not in message
    assert TOKEN not in repr(caught.value)


def test_viewer_client_rejects_invalid_list_shape() -> None:
    client = build_client(lambda _request: httpx.Response(200, json={"not": "a list"}))
    try:
        with pytest.raises(ViewerApiError, match="清單格式不正確"):
            client.list_entities(include_deleted=False)
    finally:
        client.close()


def test_control_center_record_writes_are_read_back_and_version_checked() -> None:
    requests: list[httpx.Request] = []
    state = {"version": 1, "deleted_at": None}

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "POST":
            state["version"] = 1
        elif request.method == "PATCH":
            state["version"] = 2
        elif request.method == "DELETE":
            state["version"] = 3
            state["deleted_at"] = "2026-07-28T00:00:00Z"
        return httpx.Response(
            200 if request.method != "POST" else 201,
            json={"id": "record-1", **state},
        )

    client = build_client(handler)
    try:
        assert client.create_record({"kind": "fact", "title": "測試"})["version"] == 1
        assert (
            client.update_record(
                "record-1",
                {"title": "測試 2", "expected_version": 1},
            )["version"]
            == 2
        )
        assert (
            client.archive_record(
                "record-1",
                expected_version=2,
                reason="完成",
            )["deleted_at"]
            is not None
        )
    finally:
        client.close()

    assert [request.method for request in requests] == [
        "POST",
        "GET",
        "PATCH",
        "GET",
        "DELETE",
        "GET",
    ]
    assert json.loads(requests[0].content)["title"] == "測試"
    assert requests[4].url.params["expected_version"] == "2"
    assert requests[4].url.params["reason"] == "完成"


def test_control_center_entity_writes_are_read_back() -> None:
    requests: list[httpx.Request] = []
    state = {"version": 1, "deleted_at": None}

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "PATCH":
            state["version"] = 2
        elif request.method == "DELETE":
            state["version"] = 3
            state["deleted_at"] = "2026-07-28T00:00:00Z"
        return httpx.Response(
            200 if request.method != "POST" else 201,
            json={"id": "entity-1", **state},
        )

    client = build_client(handler)
    try:
        assert client.create_entity({"entity_type": "person", "name": "白瀬瑠璃"})["version"] == 1
        assert (
            client.update_entity(
                "entity-1",
                {"name": "白瀬瑠璃", "expected_version": 1},
            )["version"]
            == 2
        )
        assert (
            client.archive_entity(
                "entity-1",
                expected_version=2,
                reason="合併",
            )["version"]
            == 3
        )
    finally:
        client.close()

    assert [request.method for request in requests] == [
        "POST",
        "GET",
        "PATCH",
        "GET",
        "DELETE",
        "GET",
    ]


def test_control_center_candidate_review_verifies_formal_result() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/prepare-review"):
            return httpx.Response(
                200,
                json={
                    "candidate": {
                        "id": "candidate-1",
                        "review_digest": "sha256:digest",
                        "status": "pending",
                    },
                    "approval_challenge": "x" * 40,
                    "challenge_expires_at": "2026-07-28T00:10:00Z",
                },
            )
        if request.url.path.endswith("/apply"):
            return httpx.Response(
                200,
                json={
                    "id": "candidate-1",
                    "status": "applied",
                    "target_type": "record",
                    "result_id": "record-1",
                    "result_version": 2,
                    "results": [],
                },
            )
        if request.url.path.endswith("/reject"):
            return httpx.Response(200, json={"id": "candidate-1", "status": "rejected"})
        if request.url.path == "/api/v1/records/record-1":
            return httpx.Response(200, json={"id": "record-1", "version": 2})
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    client = build_client(handler)
    try:
        prepared = client.prepare_candidate_review(
            "candidate-1",
            expected_review_digest="sha256:digest",
        )
        assert prepared["approval_challenge"] == "x" * 40
        approved = client.approve_candidate(
            "candidate-1",
            expected_review_digest="sha256:digest",
            approval_challenge="x" * 40,
            idempotency_key="approve-1",
            review_note="checked",
        )
        assert approved["status"] == "applied"
        rejected = client.reject_candidate(
            "candidate-1",
            reason="duplicate",
            expected_review_digest="sha256:digest",
            approval_challenge="y" * 40,
            idempotency_key="reject-1",
        )
        assert rejected["status"] == "rejected"
    finally:
        client.close()

    assert [request.method for request in requests] == ["POST", "POST", "GET", "POST"]


def test_control_center_candidate_lists_and_admin_operations() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/candidates":
            return httpx.Response(200, json=[{"id": "candidate-1", "status": "pending"}])
        if request.url.path == "/api/v1/candidates/stats":
            return httpx.Response(200, json={"pending": 1, "conflict": 0})
        if request.url.path == "/api/v1/candidates/candidate-1":
            return httpx.Response(200, json={"id": "candidate-1", "status": "pending"})
        if request.url.path in {"/api/v1/admin/export", "/api/v1/admin/backup"}:
            return httpx.Response(201, json={"operation_type": request.url.path.rsplit("/", 1)[-1]})
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    client = build_client(handler)
    try:
        assert client.list_candidates()[0]["id"] == "candidate-1"
        assert client.candidate_stats()["pending"] == 1
        assert client.get_candidate("candidate-1")["status"] == "pending"
        assert client.export_json()["operation_type"] == "export"
        assert client.backup_sqlite()["operation_type"] == "backup"
    finally:
        client.close()


def test_control_center_batch_create_and_apply_are_read_back_per_item() -> None:
    requests: list[httpx.Request] = []
    candidate = {
        "id": "batch-candidate-1",
        "candidate_kind": "batch",
        "status": "pending",
    }
    batch = {
        "candidate": candidate,
        "batch_id": "batch-1",
        "profile_id": "media.experience.v1",
        "profile_version": 1,
        "current_revision_no": 1,
        "plan_hash": "sha256:plan",
        "item_count": 1,
        "execution_state": "not_started",
        "items": [
            {
                "id": "item-1",
                "execution_state": "not_started",
                "verified_at": None,
            }
        ],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/api/v1/candidates/batches/media-experiences":
            return httpx.Response(201, json=batch)
        if request.url.path == "/api/v1/candidates/batch-candidate-1/apply":
            return httpx.Response(
                200,
                json={**candidate, "status": "applied"},
            )
        if request.url.path == "/api/v1/candidates/batch-candidate-1/batch":
            if any(item.url.path.endswith("/apply") for item in requests):
                return httpx.Response(
                    200,
                    json={
                        **batch,
                        "candidate": {**candidate, "status": "applied"},
                        "execution_state": "applied",
                        "items": [
                            {
                                "id": "item-1",
                                "execution_state": "applied",
                                "verified_at": "2026-07-29T00:00:00Z",
                            }
                        ],
                    },
                )
            return httpx.Response(200, json=batch)
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    viewer = build_client(handler)
    try:
        created = viewer.create_media_experience_batch(
            {
                "items": [
                    {
                        "work_title": "Summer Pockets",
                        "media_type": "galgame",
                        "progress": "completed",
                    }
                ]
            }
        )
        assert created["plan_hash"] == "sha256:plan"
        approved = viewer.approve_candidate(
            "batch-candidate-1",
            expected_review_digest="sha256:v2:digest",
            approval_challenge="x" * 40,
            idempotency_key="approve-batch-1",
            review_note=None,
        )
        assert approved["status"] == "applied"
    finally:
        viewer.close()

    assert [request.method for request in requests] == ["POST", "GET", "POST", "GET"]


def test_control_center_accepts_verified_partial_batch_without_hiding_failures() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/apply"):
            return httpx.Response(
                200,
                json={
                    "id": "batch-candidate-1",
                    "candidate_kind": "batch",
                    "status": "pending",
                },
            )
        if request.url.path.endswith("/batch"):
            return httpx.Response(
                200,
                json={
                    "execution_state": "partially_applied",
                    "execution_summary": {
                        "item_count": 2,
                        "applied": 1,
                        "failed": 1,
                        "unverified": 0,
                        "skipped": 0,
                        "pending": 0,
                    },
                    "items": [
                        {
                            "id": "item-applied",
                            "execution_state": "applied",
                            "verified_at": "2026-07-29T00:00:00Z",
                        },
                        {
                            "id": "item-failed",
                            "execution_state": "failed",
                            "verified_at": None,
                            "execution_error_code": "version_conflict",
                            "retry_policy": "new_batch_required",
                        },
                    ],
                },
            )
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    viewer = build_client(handler)
    try:
        approved = viewer.approve_candidate(
            "batch-candidate-1",
            expected_review_digest="sha256:v2:digest",
            approval_challenge="x" * 40,
            idempotency_key="approve-batch-partial",
            review_note=None,
        )
    finally:
        viewer.close()

    assert approved["status"] == "pending"
    assert approved["_batch"]["execution_state"] == "partially_applied"
    assert approved["_batch"]["items"][1]["execution_error_code"] == "version_conflict"


def test_control_center_pages_batch_items() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        if request.url.path.endswith("/items/item-2"):
            return httpx.Response(200, json={"id": "item-2"})
        if request.url.path.endswith("/items"):
            return httpx.Response(
                200,
                json={
                    "candidate_id": "batch-candidate-1",
                    "total": 2,
                    "limit": 1,
                    "offset": 1,
                    "truncated": False,
                    "items": [{"id": "item-2"}],
                },
            )
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    viewer = build_client(handler)
    try:
        page = viewer.list_candidate_batch_items(
            "batch-candidate-1",
            limit=1,
            offset=1,
            execution_state="failed",
        )
        item = viewer.get_candidate_batch_item("batch-candidate-1", "item-2")
    finally:
        viewer.close()

    assert page["total"] == 2
    assert item["id"] == "item-2"
    assert captured[0].url.params["limit"] == "1"
    assert captured[0].url.params["offset"] == "1"
    assert captured[0].url.params["execution_state"] == "failed"
