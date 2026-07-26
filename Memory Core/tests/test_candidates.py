from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from memory_core.db import Database
from memory_core.models import EntityRelation, MemoryCandidate, RecordEntity, RecordLink
from memory_core.services import candidates as candidate_service


def candidate_payload(idempotency_key: str = "candidate-001") -> dict[str, object]:
    return {
        "change": {
            "change_type": "record_create",
            "content": {
                "kind": "idea",
                "domain": "general",
                "title": "由 MCP 提出的候選記憶",
                "body_markdown": "尚未核准前不能進入正式資料。",
                "source_type": "mcp",
            },
        },
        "source_type": "mcp",
        "idempotency_key": idempotency_key,
        "confidence": 0.8,
    }


def test_candidate_rejects_naive_occurrence_before_creating_pending_row(
    client: TestClient,
    database: Database,
    candidate_headers: dict[str, str],
) -> None:
    payload = candidate_payload("naive-occurrence")
    change = payload["change"]
    assert isinstance(change, dict)
    content = change["content"]
    assert isinstance(content, dict)
    content["occurred_start"] = "2025-07-16T00:00:00"
    content["timezone_name"] = "Asia/Taipei"

    response = client.post(
        "/api/v1/candidates",
        headers=candidate_headers,
        json=payload,
    )
    assert response.status_code == 422
    assert "timezone" in response.text.lower()

    with database.session_factory() as session:
        candidate_count = session.scalar(select(func.count()).select_from(MemoryCandidate))
    assert candidate_count == 0


def test_legacy_candidate_with_naive_occurrence_returns_422_on_apply(
    client: TestClient,
    database: Database,
    admin_headers: dict[str, str],
    candidate_headers: dict[str, str],
    review_headers: dict[str, str],
) -> None:
    payload = candidate_payload("legacy-naive-occurrence")
    change = payload["change"]
    assert isinstance(change, dict)
    content = change["content"]
    assert isinstance(content, dict)
    content["occurred_start"] = "2025-07-16T00:00:00+08:00"

    created = client.post(
        "/api/v1/candidates",
        headers=candidate_headers,
        json=payload,
    )
    assert created.status_code == 201
    candidate_id = created.json()["id"]

    with database.session_factory() as session:
        stored = session.get(MemoryCandidate, candidate_id)
        assert stored is not None
        stored.proposed_content = {
            **stored.proposed_content,
            "occurred_start": "2025-07-16T00:00:00",
        }
        stored.review_digest = candidate_service._stored_candidate_review_digest(stored)
        review_digest = stored.review_digest
        session.commit()

    prepared = client.post(
        f"/api/v1/candidates/{candidate_id}/prepare-review",
        headers=review_headers,
        json={"expected_review_digest": review_digest},
    )
    assert prepared.status_code == 200

    applied = client.post(
        f"/api/v1/candidates/{candidate_id}/apply",
        headers=review_headers,
        json={
            "expected_review_digest": review_digest,
            "approval_challenge": prepared.json()["approval_challenge"],
            "idempotency_key": "apply-legacy-naive-occurrence",
        },
    )
    assert applied.status_code == 422
    assert applied.json()["error"]["code"] == "invalid_operation"
    assert "timezone" in applied.json()["error"]["message"].lower()

    current = client.get(
        f"/api/v1/candidates/{candidate_id}",
        headers=review_headers,
    )
    assert current.status_code == 200
    assert current.json()["status"] == "pending"
    records = client.get("/api/v1/records", headers=admin_headers).json()
    assert all(item["title"] != "由 MCP 提出的候選記憶" for item in records)


def approve_candidate(
    client: TestClient,
    review_headers: dict[str, str],
    candidate: dict[str, object],
    *,
    idempotency_key: str,
) -> dict[str, object]:
    candidate_id = candidate["id"]
    review_digest = candidate["review_digest"]
    prepared = client.post(
        f"/api/v1/candidates/{candidate_id}/prepare-review",
        headers=review_headers,
        json={"expected_review_digest": review_digest},
    )
    assert prepared.status_code == 200
    approved = client.post(
        f"/api/v1/candidates/{candidate_id}/apply",
        headers=review_headers,
        json={
            "expected_review_digest": review_digest,
            "approval_challenge": prepared.json()["approval_challenge"],
            "idempotency_key": idempotency_key,
        },
    )
    assert approved.status_code == 200
    result = approved.json()
    assert isinstance(result, dict)
    return result


def test_candidate_with_aware_occurrence_applies_and_reads_back_as_utc(
    client: TestClient,
    admin_headers: dict[str, str],
    candidate_headers: dict[str, str],
    review_headers: dict[str, str],
) -> None:
    payload = candidate_payload("aware-occurrence")
    change = payload["change"]
    assert isinstance(change, dict)
    content = change["content"]
    assert isinstance(content, dict)
    content["occurred_start"] = "2025-07-16T00:00:00+08:00"
    content["timezone_name"] = "Asia/Taipei"

    proposed = client.post(
        "/api/v1/candidates",
        headers=candidate_headers,
        json=payload,
    )
    assert proposed.status_code == 201
    assert proposed.json()["proposed_content"]["occurred_start"] == "2025-07-15T16:00:00Z"

    approved = approve_candidate(
        client,
        review_headers,
        proposed.json(),
        idempotency_key="approve-aware-occurrence",
    )
    record = client.get(
        f"/api/v1/records/{approved['result_id']}",
        headers=admin_headers,
    )
    assert record.status_code == 200
    assert record.json()["occurred_start"] == "2025-07-15T16:00:00Z"


def test_candidate_record_create_can_atomically_link_existing_entities(
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
            "name": "サクラノ詩 -櫻の森の上を舞う-",
            "payload": {"aliases": ["櫻之詩", "桜の詩", "Sakura no Uta"]},
        },
    )
    assert entity.status_code == 201

    proposed = client.post(
        "/api/v1/candidates",
        headers=candidate_headers,
        json={
            "change": {
                "change_type": "record_create",
                "content": {
                    "kind": "state",
                    "domain": "media.galgame",
                    "title": "完成《サクラノ詩》",
                    "schema_name": "media_experience",
                    "payload": {
                        "canonical_entity_ref": f"entity:{entity.json()['id']}",
                        "progress": "completed",
                    },
                    "entity_links": [
                        {
                            "entity_ref": f"entity:{entity.json()['id']}",
                            "role": "subject",
                        }
                    ],
                },
            },
            "source_type": "test",
            "idempotency_key": "record-with-entity-link",
        },
    )
    assert proposed.status_code == 201
    approved = approve_candidate(
        client,
        review_headers,
        proposed.json(),
        idempotency_key="approve-record-with-link",
    )

    with database.session_factory() as session:
        link = session.scalar(
            select(RecordEntity).where(
                RecordEntity.record_id == approved["result_id"],
                RecordEntity.entity_id == entity.json()["id"],
                RecordEntity.role == "subject",
            )
        )
        assert link is not None


def test_candidate_entity_create_can_atomically_create_edition_relation(
    client: TestClient,
    database: Database,
    admin_headers: dict[str, str],
    candidate_headers: dict[str, str],
    review_headers: dict[str, str],
) -> None:
    base_entity = client.post(
        "/api/v1/entities",
        headers=admin_headers,
        json={"entity_type": "work", "name": "Summer Pockets"},
    )
    assert base_entity.status_code == 201

    proposed = client.post(
        "/api/v1/candidates",
        headers=candidate_headers,
        json={
            "change": {
                "change_type": "entity_create",
                "content": {
                    "entity_type": "work",
                    "name": "Summer Pockets REFLECTION BLUE",
                    "payload": {
                        "aliases": ["Summer Pockets RB"],
                        "media_type": "galgame",
                    },
                    "relations": [
                        {
                            "predicate": "expanded_edition_of",
                            "object_entity_ref": f"entity:{base_entity.json()['id']}",
                        }
                    ],
                },
            },
            "source_type": "test",
            "idempotency_key": "entity-with-edition-relation",
        },
    )
    assert proposed.status_code == 201
    approved = approve_candidate(
        client,
        review_headers,
        proposed.json(),
        idempotency_key="approve-entity-with-relation",
    )

    with database.session_factory() as session:
        relation = session.scalar(
            select(EntityRelation).where(
                EntityRelation.subject_entity_id == approved["result_id"],
                EntityRelation.object_entity_id == base_entity.json()["id"],
                EntityRelation.predicate == "expanded_edition_of",
            )
        )
        assert relation is not None


def test_relation_only_candidate_update_honors_base_version_without_bumping_record(
    client: TestClient,
    database: Database,
    admin_headers: dict[str, str],
    candidate_headers: dict[str, str],
    review_headers: dict[str, str],
) -> None:
    record = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json={"kind": "state", "domain": "media.galgame", "title": "Experience"},
    )
    entity = client.post(
        "/api/v1/entities",
        headers=admin_headers,
        json={"entity_type": "work", "name": "Linked work"},
    )
    assert record.status_code == 201
    assert entity.status_code == 201

    proposed = client.post(
        "/api/v1/candidates",
        headers=candidate_headers,
        json={
            "change": {
                "change_type": "record_update",
                "target_id": record.json()["id"],
                "base_version": 1,
                "content": {
                    "entity_links": [
                        {
                            "entity_ref": f"entity:{entity.json()['id']}",
                            "role": "subject",
                        }
                    ]
                },
            },
            "source_type": "test",
            "idempotency_key": "relation-only-record-update",
        },
    )
    assert proposed.status_code == 201
    approved = approve_candidate(
        client,
        review_headers,
        proposed.json(),
        idempotency_key="approve-relation-only-record-update",
    )
    assert approved["result_version"] == 1

    with database.session_factory() as session:
        link = session.scalar(
            select(RecordEntity).where(
                RecordEntity.record_id == record.json()["id"],
                RecordEntity.entity_id == entity.json()["id"],
                RecordEntity.role == "subject",
            )
        )
        assert link is not None


def test_record_archive_candidate_can_atomically_merge_into_canonical_record(
    client: TestClient,
    database: Database,
    admin_headers: dict[str, str],
    candidate_headers: dict[str, str],
    review_headers: dict[str, str],
) -> None:
    canonical = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json={"kind": "state", "domain": "media.galgame", "title": "Canonical experience"},
    ).json()
    duplicate = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json={"kind": "state", "domain": "media.galgame", "title": "Duplicate experience"},
    ).json()

    proposed = client.post(
        "/api/v1/candidates",
        headers=candidate_headers,
        json={
            "change": {
                "change_type": "record_archive",
                "target_id": duplicate["id"],
                "base_version": duplicate["version"],
                "change_reason": "Merged duplicate into canonical experience",
                "merged_into_ref": f"record:{canonical['id']}",
            },
            "source_type": "test",
            "idempotency_key": "merge-duplicate-record",
        },
    )
    assert proposed.status_code == 201
    approved = approve_candidate(
        client,
        review_headers,
        proposed.json(),
        idempotency_key="approve-merge-duplicate-record",
    )
    assert approved["result_id"] == duplicate["id"]
    assert approved["result_version"] == 2

    archived = client.get(
        f"/api/v1/records/{duplicate['id']}",
        headers=admin_headers,
        params={"include_deleted": True},
    )
    assert archived.status_code == 200
    assert archived.json()["lifecycle_status"] == "archived"
    with database.session_factory() as session:
        link = session.scalar(
            select(RecordLink).where(
                RecordLink.subject_record_id == duplicate["id"],
                RecordLink.relation == "merged_into",
                RecordLink.object_record_id == canonical["id"],
            )
        )
        assert link is not None


def test_entity_archive_candidate_can_atomically_merge_into_canonical_entity(
    client: TestClient,
    database: Database,
    admin_headers: dict[str, str],
    candidate_headers: dict[str, str],
    review_headers: dict[str, str],
) -> None:
    canonical = client.post(
        "/api/v1/entities",
        headers=admin_headers,
        json={"entity_type": "work", "name": "Canonical work"},
    ).json()
    duplicate = client.post(
        "/api/v1/entities",
        headers=admin_headers,
        json={"entity_type": "work", "name": "Duplicate work"},
    ).json()

    proposed = client.post(
        "/api/v1/candidates",
        headers=candidate_headers,
        json={
            "change": {
                "change_type": "entity_archive",
                "target_id": duplicate["id"],
                "base_version": duplicate["version"],
                "change_reason": "Merged duplicate into canonical work",
                "merged_into_ref": f"entity:{canonical['id']}",
            },
            "source_type": "test",
            "idempotency_key": "merge-duplicate-entity",
        },
    )
    assert proposed.status_code == 201
    approved = approve_candidate(
        client,
        review_headers,
        proposed.json(),
        idempotency_key="approve-merge-duplicate-entity",
    )
    assert approved["result_id"] == duplicate["id"]
    assert approved["result_version"] == 2

    archived = client.get(
        f"/api/v1/entities/{duplicate['id']}",
        headers=admin_headers,
        params={"include_deleted": True},
    )
    assert archived.status_code == 200
    with database.session_factory() as session:
        relation = session.scalar(
            select(EntityRelation).where(
                EntityRelation.subject_entity_id == duplicate["id"],
                EntityRelation.predicate == "merged_into",
                EntityRelation.object_entity_id == canonical["id"],
            )
        )
        assert relation is not None


def test_archive_merge_reference_must_match_target_type(
    client: TestClient,
    candidate_headers: dict[str, str],
) -> None:
    response = client.post(
        "/api/v1/candidates",
        headers=candidate_headers,
        json={
            "change": {
                "change_type": "record_archive",
                "target_id": "duplicate-record",
                "base_version": 1,
                "merged_into_ref": "entity:wrong-type",
            },
            "source_type": "test",
            "idempotency_key": "wrong-merge-ref-type",
        },
    )
    assert response.status_code == 422


def test_candidate_is_idempotent_and_requires_reviewer(
    client: TestClient,
    admin_headers: dict[str, str],
    candidate_headers: dict[str, str],
    review_headers: dict[str, str],
) -> None:
    first = client.post(
        "/api/v1/candidates",
        headers=candidate_headers,
        json=candidate_payload(),
    )
    assert first.status_code == 201
    candidate = first.json()
    assert candidate["status"] == "pending"

    repeated = client.post(
        "/api/v1/candidates",
        headers=candidate_headers,
        json=candidate_payload(),
    )
    assert repeated.status_code == 201
    assert repeated.json()["id"] == candidate["id"]

    prepare = client.post(
        f"/api/v1/candidates/{candidate['id']}/prepare-review",
        headers=review_headers,
        json={"expected_review_digest": candidate["review_digest"]},
    )
    assert prepare.status_code == 200
    challenge = prepare.json()["approval_challenge"]
    approval_payload = {
        "expected_review_digest": candidate["review_digest"],
        "approval_challenge": challenge,
        "idempotency_key": "approve-candidate-001",
        "review_note": "使用者確認內容正確",
    }
    denied = client.post(
        f"/api/v1/candidates/{candidate['id']}/apply",
        headers=candidate_headers,
        json=approval_payload,
    )
    assert denied.status_code == 403

    applied = client.post(
        f"/api/v1/candidates/{candidate['id']}/apply",
        headers=review_headers,
        json=approval_payload,
    )
    assert applied.status_code == 200
    applied_candidate = applied.json()
    assert applied_candidate["status"] == "applied"
    assert applied_candidate["target_id"] is None
    assert applied_candidate["result_id"]
    assert applied_candidate["result_version"] == 1

    retried = client.post(
        f"/api/v1/candidates/{candidate['id']}/apply",
        headers=review_headers,
        json=approval_payload,
    )
    assert retried.status_code == 200
    assert retried.json()["result_id"] == applied_candidate["result_id"]

    changed_retry = client.post(
        f"/api/v1/candidates/{candidate['id']}/apply",
        headers=review_headers,
        json={**approval_payload, "review_note": "不同的審核要求"},
    )
    assert changed_retry.status_code == 409
    assert changed_retry.json()["error"]["code"] == "candidate_conflict"

    record = client.get(
        f"/api/v1/records/{applied_candidate['result_id']}",
        headers=admin_headers,
    )
    assert record.status_code == 200
    assert record.json()["title"] == "由 MCP 提出的候選記憶"


def test_idempotency_key_cannot_be_reused_for_different_content(
    client: TestClient,
    candidate_headers: dict[str, str],
) -> None:
    first_payload = candidate_payload("same-key")
    assert (
        client.post(
            "/api/v1/candidates",
            headers=candidate_headers,
            json=first_payload,
        ).status_code
        == 201
    )
    changed_payload = candidate_payload("same-key")
    change = changed_payload["change"]
    assert isinstance(change, dict)
    proposed_content = change["content"]
    assert isinstance(proposed_content, dict)
    proposed_content["title"] = "不同內容"
    conflict = client.post(
        "/api/v1/candidates",
        headers=candidate_headers,
        json=changed_payload,
    )
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "candidate_conflict"


def test_candidate_contract_rejects_unknown_and_noop_fields(
    client: TestClient,
    candidate_headers: dict[str, str],
) -> None:
    unknown_content = candidate_payload("unknown-content")
    change = unknown_content["change"]
    assert isinstance(change, dict)
    content = change["content"]
    assert isinstance(content, dict)
    content["unexpected_field"] = "must not be ignored"
    assert (
        client.post(
            "/api/v1/candidates",
            headers=candidate_headers,
            json=unknown_content,
        ).status_code
        == 422
    )

    no_op_update = {
        "change": {
            "change_type": "record_update",
            "target_id": "record-id",
            "base_version": 1,
            "content": {"change_reason": "reason without a data change"},
        },
        "source_type": "mcp",
        "idempotency_key": "noop-update",
    }
    assert (
        client.post(
            "/api/v1/candidates",
            headers=candidate_headers,
            json=no_op_update,
        ).status_code
        == 422
    )


def test_candidate_update_becomes_conflict_when_target_version_changes(
    client: TestClient,
    admin_headers: dict[str, str],
    candidate_headers: dict[str, str],
    review_headers: dict[str, str],
) -> None:
    record = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json={"kind": "state", "domain": "general", "title": "原始狀態"},
    ).json()
    candidate = client.post(
        "/api/v1/candidates",
        headers=candidate_headers,
        json={
            "change": {
                "change_type": "record_update",
                "target_id": record["id"],
                "base_version": 1,
                "content": {"title": "候選更新"},
            },
            "source_type": "mcp",
            "idempotency_key": "stale-update",
        },
    ).json()

    direct_update = client.patch(
        f"/api/v1/records/{record['id']}",
        headers=admin_headers,
        json={"expected_version": 1, "title": "人工先更新"},
    )
    assert direct_update.status_code == 200

    prepared = client.post(
        f"/api/v1/candidates/{candidate['id']}/prepare-review",
        headers=review_headers,
        json={"expected_review_digest": candidate["review_digest"]},
    ).json()
    apply = client.post(
        f"/api/v1/candidates/{candidate['id']}/apply",
        headers=review_headers,
        json={
            "expected_review_digest": candidate["review_digest"],
            "approval_challenge": prepared["approval_challenge"],
            "idempotency_key": "approve-stale-update",
        },
    )
    assert apply.status_code == 409
    assert apply.json()["error"]["code"] == "candidate_conflict"

    conflicts = client.get(
        "/api/v1/candidates",
        headers=admin_headers,
        params={"status": "conflict"},
    )
    assert conflicts.status_code == 200
    assert conflicts.json()[0]["id"] == candidate["id"]


def test_candidate_review_rejects_wrong_digest_and_challenge(
    client: TestClient,
    candidate_headers: dict[str, str],
    review_headers: dict[str, str],
) -> None:
    candidate = client.post(
        "/api/v1/candidates",
        headers=candidate_headers,
        json=candidate_payload("digest-check"),
    ).json()

    wrong_digest = client.post(
        f"/api/v1/candidates/{candidate['id']}/prepare-review",
        headers=review_headers,
        json={"expected_review_digest": "sha256:v1:" + ("0" * 64)},
    )
    assert wrong_digest.status_code == 409
    assert wrong_digest.json()["error"]["code"] == "candidate_digest_mismatch"

    prepared = client.post(
        f"/api/v1/candidates/{candidate['id']}/prepare-review",
        headers=review_headers,
        json={"expected_review_digest": candidate["review_digest"]},
    ).json()
    invalid_challenge = client.post(
        f"/api/v1/candidates/{candidate['id']}/apply",
        headers=review_headers,
        json={
            "expected_review_digest": candidate["review_digest"],
            "approval_challenge": "x" * len(prepared["approval_challenge"]),
            "idempotency_key": "wrong-challenge",
        },
    )
    assert invalid_challenge.status_code == 409
    assert invalid_challenge.json()["error"]["code"] == "invalid_review_challenge"

    current = client.get(
        f"/api/v1/candidates/{candidate['id']}",
        headers=review_headers,
    )
    assert current.status_code == 200
    assert current.json()["status"] == "pending"

    replacement_content = client.post(
        f"/api/v1/candidates/{candidate['id']}/apply",
        headers=review_headers,
        json={
            "expected_review_digest": candidate["review_digest"],
            "approval_challenge": prepared["approval_challenge"],
            "idempotency_key": "replacement-content",
            "proposed_content": {"title": "must never replace the candidate"},
        },
    )
    assert replacement_content.status_code == 422


def test_candidate_rejection_is_idempotent_and_writes_no_formal_data(
    client: TestClient,
    candidate_headers: dict[str, str],
    review_headers: dict[str, str],
) -> None:
    candidate = client.post(
        "/api/v1/candidates",
        headers=candidate_headers,
        json=candidate_payload("reject-candidate"),
    ).json()
    prepared = client.post(
        f"/api/v1/candidates/{candidate['id']}/prepare-review",
        headers=review_headers,
        json={"expected_review_digest": candidate["review_digest"]},
    ).json()
    payload = {
        "reason": "使用者決定不保存",
        "expected_review_digest": candidate["review_digest"],
        "approval_challenge": prepared["approval_challenge"],
        "idempotency_key": "reject-review-001",
    }
    first = client.post(
        f"/api/v1/candidates/{candidate['id']}/reject",
        headers=review_headers,
        json=payload,
    )
    assert first.status_code == 200
    assert first.json()["status"] == "rejected"
    assert first.json()["result_id"] is None

    repeated = client.post(
        f"/api/v1/candidates/{candidate['id']}/reject",
        headers=review_headers,
        json=payload,
    )
    assert repeated.status_code == 200
    assert repeated.json()["id"] == candidate["id"]


def test_expired_candidate_cannot_be_prepared_or_applied(
    client: TestClient,
    candidate_headers: dict[str, str],
    review_headers: dict[str, str],
    monkeypatch,
) -> None:
    candidate = client.post(
        "/api/v1/candidates",
        headers=candidate_headers,
        json=candidate_payload("expired-candidate"),
    ).json()
    expires_at = datetime.fromisoformat(candidate["expires_at"].replace("Z", "+00:00"))
    monkeypatch.setattr(
        candidate_service,
        "utc_now",
        lambda: expires_at + timedelta(seconds=1),
    )

    prepared = client.post(
        f"/api/v1/candidates/{candidate['id']}/prepare-review",
        headers=review_headers,
        json={"expected_review_digest": candidate["review_digest"]},
    )
    assert prepared.status_code == 410
    assert prepared.json()["error"]["code"] == "candidate_expired"

    current = client.get(
        f"/api/v1/candidates/{candidate['id']}",
        headers=review_headers,
    )
    assert current.status_code == 200
    assert current.json()["status"] == "expired"
    assert current.json()["review_action"] == "expire"


def test_review_scope_does_not_bypass_restricted_write_scope(
    client: TestClient,
    admin_headers: dict[str, str],
    candidate_headers: dict[str, str],
    review_headers: dict[str, str],
) -> None:
    payload = candidate_payload("restricted-candidate")
    change = payload["change"]
    assert isinstance(change, dict)
    content = change["content"]
    assert isinstance(content, dict)
    content["title"] = "restricted candidate"
    content["sensitivity"] = "restricted"

    candidate = client.post(
        "/api/v1/candidates",
        headers=candidate_headers,
        json=payload,
    ).json()
    prepared = client.post(
        f"/api/v1/candidates/{candidate['id']}/prepare-review",
        headers=review_headers,
        json={"expected_review_digest": candidate["review_digest"]},
    ).json()
    approval = client.post(
        f"/api/v1/candidates/{candidate['id']}/apply",
        headers=review_headers,
        json={
            "expected_review_digest": candidate["review_digest"],
            "approval_challenge": prepared["approval_challenge"],
            "idempotency_key": "restricted-approval",
        },
    )
    assert approval.status_code == 403
    assert approval.json()["error"]["code"] == "forbidden"

    current = client.get(
        f"/api/v1/candidates/{candidate['id']}",
        headers=review_headers,
    ).json()
    assert current["status"] == "pending"
    records = client.get("/api/v1/records", headers=admin_headers).json()
    assert all(item["title"] != "restricted candidate" for item in records)


def test_concurrent_approval_retry_creates_one_formal_record(
    client: TestClient,
    admin_headers: dict[str, str],
    candidate_headers: dict[str, str],
    review_headers: dict[str, str],
) -> None:
    candidate = client.post(
        "/api/v1/candidates",
        headers=candidate_headers,
        json=candidate_payload("concurrent-approval"),
    ).json()
    prepared = client.post(
        f"/api/v1/candidates/{candidate['id']}/prepare-review",
        headers=review_headers,
        json={"expected_review_digest": candidate["review_digest"]},
    ).json()
    approval_payload = {
        "expected_review_digest": candidate["review_digest"],
        "approval_challenge": prepared["approval_challenge"],
        "idempotency_key": "concurrent-approval-review",
    }

    def approve() -> object:
        return client.post(
            f"/api/v1/candidates/{candidate['id']}/apply",
            headers=review_headers,
            json=approval_payload,
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(lambda _index: approve(), range(2)))

    assert [response.status_code for response in responses] == [200, 200]
    result_ids = {response.json()["result_id"] for response in responses}
    assert len(result_ids) == 1
    records = client.get("/api/v1/records", headers=admin_headers).json()
    assert sum(item["id"] in result_ids for item in records) == 1
