from __future__ import annotations

from fastapi.testclient import TestClient


def test_overview_reports_visible_memory_and_index_state(
    client: TestClient,
    admin_headers: dict[str, str],
    reader_headers: dict[str, str],
) -> None:
    visible_record = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json={
            "kind": "fact",
            "domain": "media.galgame",
            "title": "Visible record",
            "schema_name": "media_experience",
            "schema_version": 1,
        },
    )
    assert visible_record.status_code == 201
    restricted_record = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json={
            "kind": "fact",
            "domain": "private",
            "title": "Restricted record",
            "sensitivity": "restricted",
            "schema_name": "private_note",
            "schema_version": 2,
        },
    )
    assert restricted_record.status_code == 201
    entity = client.post(
        "/api/v1/entities",
        headers=admin_headers,
        json={"entity_type": "work", "name": "Archived entity"},
    )
    assert entity.status_code == 201
    archived = client.delete(
        f"/api/v1/entities/{entity.json()['id']}",
        headers=admin_headers,
        params={"expected_version": 1, "reason": "overview fixture"},
    )
    assert archived.status_code == 200

    visible = client.get("/api/v1/overview", headers=reader_headers)
    assert visible.status_code == 200
    payload = visible.json()
    assert payload["scope"] == "visible"
    assert payload["restricted_included"] is False
    assert payload["records"] == {"active": 1, "superseded": 0, "archived": 0}
    assert payload["entities"] == {"active": 0, "archived": 1}
    assert payload["domains"] == {"media.galgame": 1}
    assert payload["domain_taxonomy"] == {"media.galgame": "canonical"}
    assert payload["schema_versions"] == {"media_experience@1": 1}
    # Unit-test databases use SQLAlchemy metadata only; Alembic owns FTS creation.
    assert payload["index"]["status"] == "unavailable"
    assert payload["index"]["searchable_records"] == 1
    assert payload["index"]["indexed_records"] == 0

    unrestricted = client.get("/api/v1/overview", headers=admin_headers)
    assert unrestricted.status_code == 200
    admin_payload = unrestricted.json()
    assert admin_payload["restricted_included"] is True
    assert admin_payload["records"]["active"] == 2
    assert admin_payload["domains"] == {"media.galgame": 1, "private": 1}
    assert admin_payload["domain_taxonomy"] == {
        "media.galgame": "canonical",
        "private": "custom",
    }
    assert admin_payload["schema_versions"] == {
        "media_experience@1": 1,
        "private_note@2": 1,
    }
    assert admin_payload["index"]["status"] == "unavailable"
    assert admin_payload["index"]["searchable_records"] == 2
    assert admin_payload["index"]["indexed_records"] == 0


def test_candidate_stats_require_reviewer_and_return_bounded_counts(
    client: TestClient,
    candidate_headers: dict[str, str],
    reader_headers: dict[str, str],
    review_headers: dict[str, str],
) -> None:
    created = client.post(
        "/api/v1/candidates",
        headers=candidate_headers,
        json={
            "change": {
                "change_type": "record_create",
                "content": {
                    "kind": "idea",
                    "domain": "general",
                    "title": "Pending overview candidate",
                },
            },
            "source_type": "test",
            "idempotency_key": "overview-pending",
        },
    )
    assert created.status_code == 201

    denied = client.get("/api/v1/candidates/stats", headers=reader_headers)
    assert denied.status_code == 403

    stats = client.get("/api/v1/candidates/stats", headers=review_headers)
    assert stats.status_code == 200
    assert stats.json() == {
        "pending": 1,
        "applied": 0,
        "rejected": 0,
        "conflict": 0,
        "expired": 0,
    }
