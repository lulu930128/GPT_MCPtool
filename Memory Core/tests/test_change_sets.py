from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from memory_core.db import Database
from memory_core.models import (
    CandidateOperation,
    CandidateResult,
    MemoryCandidate,
    Record,
    RecordLink,
    Revision,
)


def recipe_content(
    *,
    title: str = "ChangeSet Recipe",
    recipe_name: str = "ChangeSet Recipe",
    parent_recipe_ref: str | None = None,
) -> dict[str, object]:
    return {
        "kind": "fact",
        "domain": "lifestyle.cocktail",
        "title": title,
        "schema_name": "cocktail_recipe",
        "schema_version": 1,
        "payload": {
            "recipe_name": recipe_name,
            "recipe_origin": "original",
            "status": "tested",
            "ingredients": [
                {
                    "name": "Gin",
                    "amount": 45,
                    "unit": "ml",
                }
            ],
            "method": "shake",
            "steps": ["Shake with ice and strain."],
            "parent_recipe_ref": parent_recipe_ref,
        },
        "source_type": "conversation",
    }


def tasting_content(
    recipe_ref: str,
    *,
    recipe_version: int | None = None,
    title: str = "ChangeSet Tasting",
) -> dict[str, object]:
    payload: dict[str, object] = {
        "cocktail_name": title,
        "recipe_ref": recipe_ref,
        "rating": 8.5,
        "verdict": "good",
    }
    if recipe_version is not None:
        payload["recipe_version"] = recipe_version
    return {
        "kind": "event",
        "domain": "lifestyle.cocktail",
        "title": title,
        "occurred_start": "2026-07-27T20:00:00+08:00",
        "date_precision": "exact",
        "timezone_name": "Asia/Taipei",
        "schema_name": "cocktail_tasting",
        "schema_version": 1,
        "payload": payload,
        "source_type": "conversation",
    }


def change_set_payload(
    operations: list[dict[str, object]],
    *,
    idempotency_key: str,
    summary: str = "Create a Cocktail Recipe and its Tasting atomically",
) -> dict[str, object]:
    return {
        "summary": summary,
        "atomic": True,
        "operations": operations,
        "source_type": "conversation",
        "source_reference": "test:change-set",
        "idempotency_key": idempotency_key,
        "confidence": 0.95,
    }


def approve(
    client: TestClient,
    review_headers: dict[str, str],
    candidate: dict[str, object],
    *,
    idempotency_key: str,
):
    prepared = client.post(
        f"/api/v1/candidates/{candidate['id']}/prepare-review",
        headers=review_headers,
        json={"expected_review_digest": candidate["review_digest"]},
    )
    assert prepared.status_code == 200
    return client.post(
        f"/api/v1/candidates/{candidate['id']}/apply",
        headers=review_headers,
        json={
            "expected_review_digest": candidate["review_digest"],
            "approval_challenge": prepared.json()["approval_challenge"],
            "idempotency_key": idempotency_key,
        },
    )


def test_change_set_creates_recipe_and_tasting_with_pinned_local_reference(
    client: TestClient,
    database: Database,
    admin_headers: dict[str, str],
    candidate_headers: dict[str, str],
    review_headers: dict[str, str],
) -> None:
    payload = change_set_payload(
        [
            {
                "op_id": "tasting",
                "change": {
                    "change_type": "record_create",
                    "content": tasting_content("op:recipe"),
                },
            },
            {
                "op_id": "recipe",
                "change": {
                    "change_type": "record_create",
                    "content": recipe_content(),
                },
            },
        ],
        idempotency_key="changeset-recipe-tasting",
    )

    proposed = client.post(
        "/api/v1/candidates/change-sets",
        headers=candidate_headers,
        json=payload,
    )
    assert proposed.status_code == 201
    candidate = proposed.json()
    assert candidate["candidate_kind"] == "change_set"
    assert candidate["operation"] is None
    assert candidate["review_digest"].startswith("sha256:v2:")
    assert [item["op_id"] for item in candidate["operations"]] == ["tasting", "recipe"]
    assert candidate["results"] == []

    repeated = client.post(
        "/api/v1/candidates/change-sets",
        headers=candidate_headers,
        json=payload,
    )
    assert repeated.status_code == 201
    assert repeated.json()["id"] == candidate["id"]

    prepared = client.post(
        f"/api/v1/candidates/{candidate['id']}/prepare-review",
        headers=review_headers,
        json={"expected_review_digest": candidate["review_digest"]},
    )
    assert prepared.status_code == 200
    approval_payload = {
        "expected_review_digest": candidate["review_digest"],
        "approval_challenge": prepared.json()["approval_challenge"],
        "idempotency_key": "approve-changeset-recipe-tasting",
    }
    approved = client.post(
        f"/api/v1/candidates/{candidate['id']}/apply",
        headers=review_headers,
        json=approval_payload,
    )
    assert approved.status_code == 200
    applied = approved.json()
    assert applied["status"] == "applied"
    assert applied["validation_result"]["transaction_committed"] is True
    assert [item["op_id"] for item in applied["results"]] == ["tasting", "recipe"]

    results = {item["op_id"]: item for item in applied["results"]}
    recipe = client.get(
        f"/api/v1/records/{results['recipe']['result_id']}",
        headers=admin_headers,
    )
    tasting = client.get(
        f"/api/v1/records/{results['tasting']['result_id']}",
        headers=admin_headers,
    )
    assert recipe.status_code == 200
    assert tasting.status_code == 200
    assert tasting.json()["payload"]["recipe_ref"] == results["recipe"]["result_ref"]
    assert tasting.json()["payload"]["recipe_version"] == results["recipe"]["result_version"] == 1
    with database.session_factory() as session:
        link = session.scalar(
            select(RecordLink).where(
                RecordLink.subject_record_id == results["tasting"]["result_id"],
                RecordLink.relation == "uses_recipe",
                RecordLink.object_record_id == results["recipe"]["result_id"],
            )
        )
        assert link is not None
        assert link.target_revision_no == 1
        assert link.removed_at is None

    retried = client.post(
        f"/api/v1/candidates/{candidate['id']}/apply",
        headers=review_headers,
        json=approval_payload,
    )
    assert retried.status_code == 200
    assert retried.json()["results"] == applied["results"]


def test_change_set_rejects_unresolved_local_reference_without_pending_candidate(
    client: TestClient,
    database: Database,
    candidate_headers: dict[str, str],
) -> None:
    response = client.post(
        "/api/v1/candidates/change-sets",
        headers=candidate_headers,
        json=change_set_payload(
            [
                {
                    "op_id": "tasting",
                    "change": {
                        "change_type": "record_create",
                        "content": tasting_content("op:missing"),
                    },
                }
            ],
            idempotency_key="unresolved-change-set",
        ),
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "unresolved_local_reference"

    with database.session_factory() as session:
        count = session.scalar(select(func.count()).select_from(MemoryCandidate))
    assert count == 0


def test_change_set_rejects_local_tasting_without_required_occurrence(
    client: TestClient,
    database: Database,
    candidate_headers: dict[str, str],
) -> None:
    invalid_tasting = tasting_content("op:recipe")
    invalid_tasting.pop("occurred_start")
    response = client.post(
        "/api/v1/candidates/change-sets",
        headers=candidate_headers,
        json=change_set_payload(
            [
                {
                    "op_id": "recipe",
                    "change": {
                        "change_type": "record_create",
                        "content": recipe_content(),
                    },
                },
                {
                    "op_id": "tasting",
                    "change": {
                        "change_type": "record_create",
                        "content": invalid_tasting,
                    },
                },
            ],
            idempotency_key="local-tasting-missing-time",
        ),
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "date_precision_without_occurrence"

    with database.session_factory() as session:
        count = session.scalar(select(func.count()).select_from(MemoryCandidate))
    assert count == 0


def test_change_set_rejects_local_reference_outside_registered_field(
    client: TestClient,
    database: Database,
    candidate_headers: dict[str, str],
) -> None:
    content = recipe_content()
    content["body_markdown"] = "op:recipe"
    response = client.post(
        "/api/v1/candidates/change-sets",
        headers=candidate_headers,
        json=change_set_payload(
            [
                {
                    "op_id": "recipe",
                    "change": {
                        "change_type": "record_create",
                        "content": content,
                    },
                }
            ],
            idempotency_key="invalid-local-ref-field",
        ),
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "local_reference_not_allowed"

    with database.session_factory() as session:
        count = session.scalar(select(func.count()).select_from(MemoryCandidate))
    assert count == 0


def test_change_set_rejects_cyclic_recipe_dependencies(
    client: TestClient,
    database: Database,
    candidate_headers: dict[str, str],
) -> None:
    response = client.post(
        "/api/v1/candidates/change-sets",
        headers=candidate_headers,
        json=change_set_payload(
            [
                {
                    "op_id": "recipe_a",
                    "change": {
                        "change_type": "record_create",
                        "content": recipe_content(
                            title="Recipe A",
                            recipe_name="Recipe A",
                            parent_recipe_ref="op:recipe_b",
                        ),
                    },
                },
                {
                    "op_id": "recipe_b",
                    "change": {
                        "change_type": "record_create",
                        "content": recipe_content(
                            title="Recipe B",
                            recipe_name="Recipe B",
                            parent_recipe_ref="op:recipe_a",
                        ),
                    },
                },
            ],
            idempotency_key="cyclic-change-set",
        ),
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "cyclic_dependency"

    with database.session_factory() as session:
        count = session.scalar(select(func.count()).select_from(MemoryCandidate))
    assert count == 0


def test_change_set_version_conflict_rolls_back_earlier_operations(
    client: TestClient,
    database: Database,
    admin_headers: dict[str, str],
    candidate_headers: dict[str, str],
    review_headers: dict[str, str],
) -> None:
    target = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json={"kind": "fact", "title": "Update target"},
    ).json()
    proposed = client.post(
        "/api/v1/candidates/change-sets",
        headers=candidate_headers,
        json=change_set_payload(
            [
                {
                    "op_id": "create_first",
                    "change": {
                        "change_type": "record_create",
                        "content": {
                            "kind": "fact",
                            "title": "Must roll back",
                        },
                    },
                },
                {
                    "op_id": "stale_update",
                    "change": {
                        "change_type": "record_update",
                        "target_id": target["id"],
                        "base_version": target["version"],
                        "content": {"title": "ChangeSet update"},
                    },
                },
            ],
            idempotency_key="rollback-version-conflict",
        ),
    ).json()

    updated = client.patch(
        f"/api/v1/records/{target['id']}",
        headers=admin_headers,
        json={"expected_version": 1, "title": "Concurrent update"},
    )
    assert updated.status_code == 200

    applied = approve(
        client,
        review_headers,
        proposed,
        idempotency_key="approve-rollback-version-conflict",
    )
    assert applied.status_code == 409

    current = client.get(
        f"/api/v1/candidates/{proposed['id']}",
        headers=review_headers,
    ).json()
    assert current["status"] == "conflict"
    assert current["results"] == []
    assert current["validation_result"]["transaction_committed"] is False

    with database.session_factory() as session:
        created = session.scalar(select(Record).where(Record.title == "Must roll back"))
        result_count = session.scalar(select(func.count()).select_from(CandidateResult))
        revision_count = session.scalar(
            select(func.count())
            .select_from(Revision)
            .where(Revision.change_reason.like(f"candidate:{proposed['id']}/op:%"))
        )
    assert created is None
    assert result_count == 0
    assert revision_count == 0


def test_change_set_tasting_pins_recipe_update_result_version(
    client: TestClient,
    database: Database,
    admin_headers: dict[str, str],
    candidate_headers: dict[str, str],
    review_headers: dict[str, str],
) -> None:
    recipe = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json=recipe_content(title="Recipe v1", recipe_name="Versioned Recipe"),
    ).json()
    updated_payload = recipe_content(recipe_name="Versioned Recipe")["payload"]
    assert isinstance(updated_payload, dict)
    updated_payload["status"] = "favorite"

    proposed = client.post(
        "/api/v1/candidates/change-sets",
        headers=candidate_headers,
        json=change_set_payload(
            [
                {
                    "op_id": "tasting",
                    "change": {
                        "change_type": "record_create",
                        "content": tasting_content(
                            "op:recipe_update",
                            title="Tasting after Recipe v2",
                        ),
                    },
                },
                {
                    "op_id": "recipe_update",
                    "change": {
                        "change_type": "record_update",
                        "target_id": recipe["id"],
                        "base_version": 1,
                        "content": {
                            "title": "Recipe v2",
                            "payload": updated_payload,
                        },
                    },
                },
            ],
            idempotency_key="changeset-recipe-update-tasting",
        ),
    )
    assert proposed.status_code == 201

    approved = approve(
        client,
        review_headers,
        proposed.json(),
        idempotency_key="approve-recipe-update-tasting",
    )
    assert approved.status_code == 200
    results = {item["op_id"]: item for item in approved.json()["results"]}
    assert results["recipe_update"]["result_version"] == 2
    tasting = client.get(
        f"/api/v1/records/{results['tasting']['result_id']}",
        headers=admin_headers,
    )
    assert tasting.status_code == 200
    assert tasting.json()["payload"]["recipe_ref"] == results["recipe_update"]["result_ref"]
    assert tasting.json()["payload"]["recipe_version"] == 2
    with database.session_factory() as session:
        link = session.scalar(
            select(RecordLink).where(
                RecordLink.subject_record_id == results["tasting"]["result_id"],
                RecordLink.relation == "uses_recipe",
                RecordLink.object_record_id == recipe["id"],
            )
        )
        assert link is not None
        assert link.target_revision_no == 2


def test_cocktail_link_projection_soft_removes_obsolete_payload_reference(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    recipe = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json=recipe_content(title="Link recipe", recipe_name="Link recipe"),
    ).json()
    tasting = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json=tasting_content(
            f"record:{recipe['id']}",
            recipe_version=1,
            title="Linked tasting",
        ),
    ).json()

    outbound = client.get(
        f"/api/v1/records/{tasting['id']}/links",
        headers=admin_headers,
        params={"direction": "outbound"},
    )
    assert outbound.status_code == 200
    assert outbound.json()[0]["role"] == "uses_recipe"
    assert outbound.json()[0]["target_ref"] == f"record:{recipe['id']}"
    assert outbound.json()[0]["target_revision_no"] == 1
    assert outbound.json()[0]["status"] == "active"

    inbound = client.get(
        f"/api/v1/records/{recipe['id']}/links",
        headers=admin_headers,
        params={"direction": "inbound"},
    )
    assert inbound.status_code == 200
    assert inbound.json()[0]["source_ref"] == f"record:{tasting['id']}"

    updated = client.patch(
        f"/api/v1/records/{tasting['id']}",
        headers=admin_headers,
        json={
            "expected_version": 1,
            "payload": {
                "cocktail_name": "Linked tasting",
                "ingredients_snapshot": [{"name": "Gin", "amount": 45, "unit": "ml"}],
                "rating": 8.5,
                "verdict": "good",
            },
        },
    )
    assert updated.status_code == 200

    active = client.get(
        f"/api/v1/records/{tasting['id']}/links",
        headers=admin_headers,
    )
    assert active.status_code == 200
    assert active.json() == []
    removed = client.get(
        f"/api/v1/records/{tasting['id']}/links",
        headers=admin_headers,
        params={"include_removed": True},
    )
    assert removed.status_code == 200
    assert removed.json()[0]["status"] == "removed"
    assert removed.json()[0]["removed_at"] is not None


def test_cocktail_preference_link_tracks_recipe_identity_without_revision_pin(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    recipe = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json=recipe_content(title="Favorite recipe", recipe_name="Favorite recipe"),
    ).json()
    preference = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json={
            "kind": "state",
            "domain": "lifestyle.cocktail",
            "title": "Confirmed cocktail preferences",
            "schema_name": "cocktail_preference",
            "schema_version": 1,
            "verification_status": "confirmed",
            "payload": {
                "preferred_flavors": ["citrus"],
                "confirmed_favorite_recipe_refs": [f"record:{recipe['id']}"],
            },
        },
    )
    assert preference.status_code == 201

    links = client.get(
        f"/api/v1/records/{preference.json()['id']}/links",
        headers=admin_headers,
    )
    assert links.status_code == 200
    assert links.json()[0]["role"] == "favorite_recipe"
    assert links.json()[0]["target_ref"] == f"record:{recipe['id']}"
    assert links.json()[0]["target_revision_no"] is None


def test_change_set_apply_validation_failure_rolls_back_and_stays_pending(
    client: TestClient,
    database: Database,
    admin_headers: dict[str, str],
    candidate_headers: dict[str, str],
    review_headers: dict[str, str],
) -> None:
    recipe = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json=recipe_content(title="External recipe", recipe_name="External recipe"),
    ).json()
    proposed = client.post(
        "/api/v1/candidates/change-sets",
        headers=candidate_headers,
        json=change_set_payload(
            [
                {
                    "op_id": "create_first",
                    "change": {
                        "change_type": "record_create",
                        "content": {
                            "kind": "fact",
                            "title": "Must also roll back",
                        },
                    },
                },
                {
                    "op_id": "tasting",
                    "change": {
                        "change_type": "record_create",
                        "content": tasting_content(
                            f"record:{recipe['id']}",
                            recipe_version=1,
                            title="External recipe tasting",
                        ),
                    },
                },
            ],
            idempotency_key="rollback-reference-invalidated",
        ),
    ).json()

    archived = client.delete(
        f"/api/v1/records/{recipe['id']}",
        headers=admin_headers,
        params={"expected_version": 1},
    )
    assert archived.status_code == 200

    applied = approve(
        client,
        review_headers,
        proposed,
        idempotency_key="approve-rollback-reference-invalidated",
    )
    assert applied.status_code == 422
    assert applied.json()["error"]["code"] == "invalid_recipe_reference"

    current = client.get(
        f"/api/v1/candidates/{proposed['id']}",
        headers=review_headers,
    ).json()
    assert current["status"] == "pending"
    assert current["results"] == []

    with database.session_factory() as session:
        assert session.scalar(select(Record).where(Record.title == "Must also roll back")) is None
        assert session.scalar(select(func.count()).select_from(CandidateResult)) == 0


def test_change_set_digest_covers_persisted_operations(
    client: TestClient,
    database: Database,
    candidate_headers: dict[str, str],
    review_headers: dict[str, str],
) -> None:
    proposed = client.post(
        "/api/v1/candidates/change-sets",
        headers=candidate_headers,
        json=change_set_payload(
            [
                {
                    "op_id": "record",
                    "change": {
                        "change_type": "record_create",
                        "content": {"kind": "fact", "title": "Digest protected"},
                    },
                }
            ],
            idempotency_key="changeset-digest",
        ),
    ).json()
    with database.session_factory() as session:
        operation = session.scalar(
            select(CandidateOperation).where(CandidateOperation.candidate_id == proposed["id"])
        )
        assert operation is not None
        operation.change_data = {
            **operation.change_data,
            "content": {
                **operation.change_data["content"],
                "title": "Tampered",
            },
        }
        session.commit()

    prepared = client.post(
        f"/api/v1/candidates/{proposed['id']}/prepare-review",
        headers=review_headers,
        json={"expected_review_digest": proposed["review_digest"]},
    )
    assert prepared.status_code == 409
    assert prepared.json()["error"]["code"] == "candidate_digest_mismatch"
