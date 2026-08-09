from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from memory_core.db import Database
from memory_core.models import MemoryCandidate


def recipe_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "recipe_name": "氣泡測試酒",
        "recipe_origin": "original",
        "status": "tested",
        "ingredients": [
            {"name": "琴酒", "amount": 45, "unit": "ml", "note": None},
            {"name": "氣泡水", "amount": None, "unit": "top_up", "note": None},
        ],
        "method": "build",
        "steps": ["杯中加入冰塊與琴酒", "以氣泡水補滿"],
        "ice": "cubed",
        "glassware": "highball",
        "garnish": [],
        "taste_profile": None,
        "evaluation": None,
        "tags": ["氣泡", "清爽"],
        "parent_recipe_ref": None,
    }
    payload.update(overrides)
    return payload


def record_content(
    *,
    schema_name: str,
    kind: str,
    title: str,
    payload: dict[str, object],
    occurred_start: str | None = None,
) -> dict[str, object]:
    content: dict[str, object] = {
        "kind": kind,
        "domain": "lifestyle.cocktail",
        "title": title,
        "schema_name": schema_name,
        "schema_version": 1,
        "payload": payload,
    }
    if occurred_start is not None:
        content.update(
            {
                "occurred_start": occurred_start,
                "date_precision": "exact",
                "timezone_name": "Asia/Taipei",
            }
        )
    return content


def propose_record(
    client: TestClient,
    candidate_headers: dict[str, str],
    *,
    content: dict[str, object],
    idempotency_key: str,
) -> object:
    return client.post(
        "/api/v1/candidates",
        headers=candidate_headers,
        json={
            "change": {"change_type": "record_create", "content": content},
            "source_type": "test",
            "idempotency_key": idempotency_key,
        },
    )


def approve(
    client: TestClient,
    review_headers: dict[str, str],
    candidate: dict[str, object],
    *,
    idempotency_key: str,
) -> dict[str, object]:
    candidate_id = candidate["id"]
    digest = candidate["review_digest"]
    prepared = client.post(
        f"/api/v1/candidates/{candidate_id}/prepare-review",
        headers=review_headers,
        json={"expected_review_digest": digest},
    )
    assert prepared.status_code == 200
    result = client.post(
        f"/api/v1/candidates/{candidate_id}/apply",
        headers=review_headers,
        json={
            "expected_review_digest": digest,
            "approval_challenge": prepared.json()["approval_challenge"],
            "idempotency_key": idempotency_key,
        },
    )
    assert result.status_code == 200
    response = result.json()
    assert isinstance(response, dict)
    return response


def test_direct_and_candidate_paths_share_cocktail_validation(
    client: TestClient,
    database: Database,
    admin_headers: dict[str, str],
    candidate_headers: dict[str, str],
) -> None:
    invalid_content = record_content(
        schema_name="cocktail_recipe",
        kind="fact",
        title="壞配方",
        payload=recipe_payload(
            ingredients=[{"name": "琴酒", "amount": -1, "unit": "ml"}],
        ),
    )
    direct = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json=invalid_content,
    )
    assert direct.status_code == 422
    assert direct.json()["error"]["code"] == "invalid_ingredient_amount"
    assert direct.json()["error"]["field"] == "payload.ingredients[0].amount"

    proposed = propose_record(
        client,
        candidate_headers,
        content=invalid_content,
        idempotency_key="invalid-cocktail-amount",
    )
    assert proposed.status_code == 422
    assert proposed.json()["error"]["code"] == "invalid_ingredient_amount"

    with database.session_factory() as session:
        count = session.scalar(select(func.count()).select_from(MemoryCandidate))
    assert count == 0


def test_candidate_stores_canonical_recipe_payload(
    client: TestClient,
    candidate_headers: dict[str, str],
) -> None:
    proposed = propose_record(
        client,
        candidate_headers,
        content=record_content(
            schema_name="cocktail_recipe",
            kind="fact",
            title="氣泡測試酒",
            payload=recipe_payload(
                recipe_name="  氣泡測試酒  ",
                tags=[" 氣泡 ", "清爽", "氣泡"],
            ),
        ),
        idempotency_key="canonical-cocktail-recipe",
    )
    assert proposed.status_code == 201
    stored_payload = proposed.json()["proposed_content"]["payload"]
    assert stored_payload["recipe_name"] == "氣泡測試酒"
    assert stored_payload["tags"] == ["氣泡", "清爽"]


def test_tasting_recipe_version_is_checked_before_candidate_insert(
    client: TestClient,
    database: Database,
    admin_headers: dict[str, str],
    candidate_headers: dict[str, str],
) -> None:
    recipe = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json=record_content(
            schema_name="cocktail_recipe",
            kind="fact",
            title="版本配方",
            payload=recipe_payload(recipe_name="版本配方"),
        ),
    ).json()
    before = 0
    with database.session_factory() as session:
        before = int(session.scalar(select(func.count()).select_from(MemoryCandidate)) or 0)

    tasting = propose_record(
        client,
        candidate_headers,
        content=record_content(
            schema_name="cocktail_tasting",
            kind="event",
            title="版本配方 tasting",
            occurred_start="2026-07-26T20:00:00+08:00",
            payload={
                "cocktail_name": "版本配方",
                "recipe_ref": f"record:{recipe['id']}",
                "recipe_version": 99,
                "ingredients_snapshot": [],
                "recipe_changes": [],
                "servings": 1,
                "rating": 8,
                "verdict": "good",
                "tasting_notes": None,
                "repeat_intent": "maybe",
                "rank_note": None,
                "observed_taste_profile": None,
            },
        ),
        idempotency_key="missing-recipe-version",
    )
    assert tasting.status_code == 422
    assert tasting.json()["error"]["code"] == "invalid_recipe_version"
    assert tasting.json()["error"]["field"] == "payload.recipe_version"

    with database.session_factory() as session:
        after = int(session.scalar(select(func.count()).select_from(MemoryCandidate)) or 0)
    assert after == before


def test_cocktail_preference_is_singleton_at_propose_time(
    client: TestClient,
    database: Database,
    admin_headers: dict[str, str],
    candidate_headers: dict[str, str],
) -> None:
    preference_payload = {
        "preferred_flavors": ["酸甜"],
        "disliked_flavors": [],
        "perceived_strength": "medium",
        "alcohol_requirement": None,
        "avoid_characteristics": [],
        "presentation_preferences": [],
        "confirmed_favorite_recipe_refs": [],
        "notes": None,
    }
    existing = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json=record_content(
            schema_name="cocktail_preference",
            kind="state",
            title="調酒口味偏好",
            payload=preference_payload,
        ),
    )
    assert existing.status_code == 201

    with database.session_factory() as session:
        before = int(session.scalar(select(func.count()).select_from(MemoryCandidate)) or 0)
    duplicate = propose_record(
        client,
        candidate_headers,
        content=record_content(
            schema_name="cocktail_preference",
            kind="state",
            title="另一筆調酒口味偏好",
            payload=preference_payload,
        ),
        idempotency_key="duplicate-cocktail-preference",
    )
    assert duplicate.status_code == 422
    error = duplicate.json()["error"]
    assert error["code"] == "cocktail_preference_singleton_conflict"
    assert f"record:{existing.json()['id']}" in error["message"]

    with database.session_factory() as session:
        after = int(session.scalar(select(func.count()).select_from(MemoryCandidate)) or 0)
    assert after == before


def test_recipe_parent_cycle_is_rejected_on_update_candidate(
    client: TestClient,
    admin_headers: dict[str, str],
    candidate_headers: dict[str, str],
) -> None:
    recipe = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json=record_content(
            schema_name="cocktail_recipe",
            kind="fact",
            title="循環配方",
            payload=recipe_payload(recipe_name="循環配方"),
        ),
    ).json()
    cyclic_payload = recipe_payload(
        recipe_name="循環配方",
        parent_recipe_ref=f"record:{recipe['id']}",
    )
    response = client.post(
        "/api/v1/candidates",
        headers=candidate_headers,
        json={
            "change": {
                "change_type": "record_update",
                "target_id": recipe["id"],
                "base_version": recipe["version"],
                "content": {"payload": cyclic_payload},
            },
            "source_type": "test",
            "idempotency_key": "cocktail-parent-cycle",
        },
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "recipe_reference_cycle"


def test_recipe_revision_remains_available_after_update(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    recipe = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json=record_content(
            schema_name="cocktail_recipe",
            kind="fact",
            title="歷史配方",
            payload=recipe_payload(recipe_name="歷史配方"),
        ),
    ).json()
    updated_payload = recipe_payload(
        recipe_name="歷史配方",
        ingredients=[
            {"name": "琴酒", "amount": 50, "unit": "ml", "note": None},
            {"name": "氣泡水", "amount": None, "unit": "top_up", "note": None},
        ],
    )
    updated = client.patch(
        f"/api/v1/records/{recipe['id']}",
        headers=admin_headers,
        json={
            "expected_version": recipe["version"],
            "payload": updated_payload,
        },
    )
    assert updated.status_code == 200
    assert updated.json()["version"] == 2

    revision = client.get(
        f"/api/v1/records/{recipe['id']}/revisions/1",
        headers=admin_headers,
    )
    assert revision.status_code == 200
    assert revision.json()["version"] == 1
    assert revision.json()["payload"]["ingredients"][0]["amount"] == 45


def test_registered_schema_identity_cannot_be_added_by_record_update(
    client: TestClient,
    database: Database,
    admin_headers: dict[str, str],
    candidate_headers: dict[str, str],
) -> None:
    generic = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json={
            "kind": "fact",
            "domain": "lifestyle.cocktail",
            "title": "舊式一般調酒筆記",
            "schema_name": "generic",
            "schema_version": 1,
            "payload": {"note": "保留為一般筆記"},
        },
    ).json()
    with database.session_factory() as session:
        before = int(session.scalar(select(func.count()).select_from(MemoryCandidate)) or 0)

    response = client.post(
        "/api/v1/candidates",
        headers=candidate_headers,
        json={
            "change": {
                "change_type": "record_update",
                "target_id": generic["id"],
                "base_version": generic["version"],
                "content": {
                    "schema_name": "cocktail_recipe",
                    "schema_version": 1,
                    "payload": recipe_payload(recipe_name="不應直接轉換"),
                },
            },
            "source_type": "test",
            "idempotency_key": "cocktail-schema-conversion-blocked",
        },
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_record_schema_envelope"
    with database.session_factory() as session:
        after = int(session.scalar(select(func.count()).select_from(MemoryCandidate)) or 0)
    assert after == before
