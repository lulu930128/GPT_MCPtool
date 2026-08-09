from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from memory_core.db import Database
from memory_core.models import (
    CandidateBatch,
    CandidateItem,
    Entity,
    MemoryCandidate,
    Record,
)


def _batch_payload(idempotency_key: str = "media-batch-1") -> dict[str, object]:
    return {
        "profile_id": "media.experience.v1",
        "profile_version": 1,
        "summary": "Two independently reviewable media experiences",
        "items": [
            {
                "client_item_id": "galgame-1",
                "work_title": "Summer  Pockets",
                "media_type": "galgame",
                "progress": "completed",
                "rating": 9,
                "tags": ["Key", " key ", "泣きゲー"],
            },
            {
                "client_item_id": "anime-1",
                "work_title": "葬送のフリーレン",
                "media_type": "anime",
                "progress": "in_progress",
            },
        ],
        "source_type": "mcp",
        "source_reference": "test conversation",
        "idempotency_key": idempotency_key,
        "confidence": 0.9,
        "risk_flags": [],
    }


def test_media_batch_is_candidate_first_then_applies_each_item_and_groups_records(
    client: TestClient,
    database: Database,
    candidate_headers: dict[str, str],
    review_headers: dict[str, str],
    reader_headers: dict[str, str],
) -> None:
    created = client.post(
        "/api/v1/candidates/batches/media-experiences",
        headers=candidate_headers,
        json=_batch_payload(),
    )
    assert created.status_code == 201, created.text
    batch = created.json()
    assert batch["candidate"]["candidate_kind"] == "batch"
    assert batch["plan_state"] == "ready"
    assert batch["item_count"] == 2
    assert [item["decision"] for item in batch["items"]] == ["create", "create"]
    assert batch["items"][0]["normalized_snapshot"]["payload"]["work_title"] == ("Summer Pockets")
    assert batch["items"][0]["normalized_snapshot"]["payload"]["tags"] == [
        "Key",
        "泣きゲー",
    ]

    with database.session_factory() as session:
        assert session.scalar(select(func.count()).select_from(Record)) == 0
        assert session.scalar(select(func.count()).select_from(Entity)) == 0

    candidate = batch["candidate"]
    prepared = client.post(
        f"/api/v1/candidates/{candidate['id']}/prepare-review",
        headers=review_headers,
        json={"expected_review_digest": candidate["review_digest"]},
    )
    assert prepared.status_code == 200, prepared.text
    applied = client.post(
        f"/api/v1/candidates/{candidate['id']}/apply",
        headers=review_headers,
        json={
            "expected_review_digest": candidate["review_digest"],
            "approval_challenge": prepared.json()["approval_challenge"],
            "idempotency_key": "approve-media-batch-1",
        },
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["status"] == "applied"
    assert applied.json()["validation_result"]["execution"] == {
        "item_count": 2,
        "applied": 2,
        "skipped": 0,
        "failed": 0,
        "unverified": 0,
        "pending": 0,
    }

    detail = client.get(
        f"/api/v1/candidates/{candidate['id']}/batch",
        headers=review_headers,
    )
    assert detail.status_code == 200
    assert detail.json()["execution_state"] == "applied"
    assert {item["execution_state"] for item in detail.json()["items"]} == {"applied"}
    assert all(item["verified_at"] is not None for item in detail.json()["items"])
    assert all(
        result["verify_status"] == "verified"
        for item in detail.json()["items"]
        for result in item["results"]
    )
    item_page = client.get(
        f"/api/v1/candidates/{candidate['id']}/items",
        headers=review_headers,
        params={"limit": 1, "offset": 1, "execution_state": "applied"},
    )
    assert item_page.status_code == 200, item_page.text
    assert item_page.json()["total"] == 2
    assert item_page.json()["limit"] == 1
    assert item_page.json()["offset"] == 1
    assert item_page.json()["truncated"] is False
    assert len(item_page.json()["items"]) == 1
    item_id = item_page.json()["items"][0]["id"]
    item_detail = client.get(
        f"/api/v1/candidates/{candidate['id']}/items/{item_id}",
        headers=review_headers,
    )
    assert item_detail.status_code == 200, item_detail.text
    assert item_detail.json()["id"] == item_id
    invalid_filter = client.get(
        f"/api/v1/candidates/{candidate['id']}/items",
        headers=review_headers,
        params={"execution_state": "unknown"},
    )
    assert invalid_filter.status_code == 422

    records = client.get("/api/v1/records", headers=reader_headers)
    assert records.status_code == 200
    assert {record["title"] for record in records.json()} == {
        "Summer Pockets",
        "葬送のフリーレン",
    }
    collections = client.get("/api/v1/collections", headers=reader_headers)
    assert collections.status_code == 200
    assert collections.json()[0]["key"] == "media.galgame.completed"
    assert collections.json()[0]["member_count"] == 1
    members = client.get(
        "/api/v1/collections/media.galgame.completed",
        headers=reader_headers,
    )
    assert members.status_code == 200
    assert [item["record"]["title"] for item in members.json()["members"]] == ["Summer Pockets"]

    repeated = client.post(
        f"/api/v1/candidates/{candidate['id']}/apply",
        headers=review_headers,
        json={
            "expected_review_digest": candidate["review_digest"],
            "approval_challenge": prepared.json()["approval_challenge"],
            "idempotency_key": "approve-media-batch-1",
        },
    )
    assert repeated.status_code == 200, repeated.text
    with database.session_factory() as session:
        assert session.scalar(select(func.count()).select_from(Record)) == 2
        assert session.scalar(select(func.count()).select_from(Entity)) == 2


def test_duplicate_identity_blocks_review_until_revision_excludes_one_item(
    client: TestClient,
    database: Database,
    candidate_headers: dict[str, str],
    review_headers: dict[str, str],
) -> None:
    payload = _batch_payload("duplicate-batch")
    items = payload["items"]
    assert isinstance(items, list)
    items[1] = {
        "client_item_id": "duplicate",
        "work_title": "Ｓｕｍｍｅｒ　Ｐｏｃｋｅｔｓ",
        "media_type": "galgame",
        "progress": "completed",
    }
    created = client.post(
        "/api/v1/candidates/batches/media-experiences",
        headers=candidate_headers,
        json=payload,
    )
    assert created.status_code == 201
    batch = created.json()
    assert batch["plan_state"] == "blocked"
    assert [item["error_code"] for item in batch["items"]] == [
        "duplicate_batch_identity",
        "duplicate_batch_identity",
    ]
    blocked_prepare = client.post(
        f"/api/v1/candidates/{batch['candidate']['id']}/prepare-review",
        headers=review_headers,
        json={"expected_review_digest": batch["candidate"]["review_digest"]},
    )
    assert blocked_prepare.status_code == 409

    items[1]["resolution"] = {"exclude": True}
    revised = client.patch(
        f"/api/v1/candidates/{batch['candidate']['id']}/batch",
        headers=review_headers,
        json={
            "profile_id": "media.experience.v1",
            "profile_version": 1,
            "summary": "Resolved duplicate",
            "items": items,
            "expected_revision_no": 1,
        },
    )
    assert revised.status_code == 200, revised.text
    revised_batch = revised.json()
    assert revised_batch["current_revision_no"] == 2
    assert revised_batch["plan_state"] == "ready"
    assert [item["decision"] for item in revised_batch["items"]] == [
        "create",
        "excluded",
    ]
    with database.session_factory() as session:
        stored = session.scalar(
            select(MemoryCandidate).where(MemoryCandidate.id == batch["candidate"]["id"])
        )
        assert stored is not None
        assert stored.batch is not None
        assert len(stored.batch.revisions) == 2
        current_items = list(
            session.scalars(
                select(CandidateItem).where(
                    CandidateItem.batch_revision_id == stored.batch.revisions[1].id
                )
            )
        )
        assert len(current_items) == 2
        assert session.scalar(select(func.count()).select_from(CandidateBatch)) == 1


def test_batch_version_conflict_isolated_to_one_item_and_retry_does_not_duplicate_success(
    client: TestClient,
    database: Database,
    admin_headers: dict[str, str],
    candidate_headers: dict[str, str],
    review_headers: dict[str, str],
) -> None:
    entity = client.post(
        "/api/v1/entities",
        headers=admin_headers,
        json={
            "entity_type": "work",
            "name": "Existing Work",
            "payload": {
                "media_type": "galgame",
                "aliases": [],
                "identity_key": "galgame:existing work",
            },
        },
    ).json()
    record = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json={
            "kind": "state",
            "domain": "media.galgame",
            "title": "Existing Work",
            "summary": "old",
            "schema_name": "media_experience",
            "schema_version": 1,
            "payload": {
                "work_title": "Existing Work",
                "media_type": "galgame",
                "progress": "planned",
            },
        },
    ).json()
    linked = client.post(
        f"/api/v1/records/{record['id']}/entities",
        headers=admin_headers,
        json={"entity_id": entity["id"], "role": "work"},
    )
    assert linked.status_code == 204

    payload = _batch_payload("partial-batch")
    payload["items"] = [
        {
            "work_title": "Existing Work",
            "media_type": "galgame",
            "progress": "completed",
        },
        {
            "work_title": "Independent Work",
            "media_type": "anime",
            "progress": "in_progress",
        },
    ]
    created = client.post(
        "/api/v1/candidates/batches/media-experiences",
        headers=candidate_headers,
        json=payload,
    ).json()
    candidate = created["candidate"]
    assert [item["decision"] for item in created["items"]] == ["update", "create"]
    prepared = client.post(
        f"/api/v1/candidates/{candidate['id']}/prepare-review",
        headers=review_headers,
        json={"expected_review_digest": candidate["review_digest"]},
    ).json()

    raced = client.patch(
        f"/api/v1/records/{record['id']}",
        headers=admin_headers,
        json={
            "expected_version": 1,
            "summary": "concurrent change",
            "change_reason": "simulate reviewer race",
        },
    )
    assert raced.status_code == 200
    assert raced.json()["version"] == 2

    approval_payload = {
        "expected_review_digest": candidate["review_digest"],
        "approval_challenge": prepared["approval_challenge"],
        "idempotency_key": "approve-partial-batch",
    }
    applied = client.post(
        f"/api/v1/candidates/{candidate['id']}/apply",
        headers=review_headers,
        json=approval_payload,
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["status"] == "pending"
    assert applied.json()["validation_result"]["execution"] == {
        "item_count": 2,
        "applied": 1,
        "skipped": 0,
        "failed": 1,
        "unverified": 0,
        "pending": 0,
    }
    detail = client.get(
        f"/api/v1/candidates/{candidate['id']}/batch",
        headers=review_headers,
    ).json()
    assert detail["execution_state"] == "partially_applied"
    assert [item["execution_state"] for item in detail["items"]] == [
        "failed",
        "applied",
    ]
    failed_item = detail["items"][0]
    assert failed_item["error_code"] is None
    assert failed_item["execution_error_code"] == "version_conflict"
    assert failed_item["retry_policy"] == "new_batch_required"
    assert failed_item["attempt_count"] == 1

    repeated = client.post(
        f"/api/v1/candidates/{candidate['id']}/apply",
        headers=review_headers,
        json=approval_payload,
    )
    assert repeated.status_code == 200
    repeated_detail = client.get(
        f"/api/v1/candidates/{candidate['id']}/batch",
        headers=review_headers,
    ).json()
    assert repeated_detail["items"][0]["attempt_count"] == 1
    assert repeated_detail["items"][0]["execution_error_code"] == "version_conflict"
    with database.session_factory() as session:
        assert (
            session.scalar(
                select(func.count()).select_from(Record).where(Record.title == "Independent Work")
            )
            == 1
        )
