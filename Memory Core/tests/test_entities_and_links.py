from fastapi.testclient import TestClient


def test_entity_tag_and_record_links(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    entity = client.post(
        "/api/v1/entities",
        headers=admin_headers,
        json={"entity_type": "media", "name": "STEINS;GATE"},
    )
    assert entity.status_code == 201
    entity_id = entity.json()["id"]

    record = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json={
            "kind": "reflection",
            "domain": "media",
            "title": "作品心得",
            "body_markdown": "世界線與選擇。",
        },
    )
    assert record.status_code == 201
    record_id = record.json()["id"]

    tag = client.post(
        "/api/v1/tags",
        headers=admin_headers,
        json={"name": "時間旅行", "category": "theme"},
    )
    assert tag.status_code == 201

    entity_link = client.post(
        f"/api/v1/records/{record_id}/entities",
        headers=admin_headers,
        json={"entity_id": entity_id, "role": "subject"},
    )
    assert entity_link.status_code == 204

    tag_link = client.post(
        f"/api/v1/records/{record_id}/tags",
        headers=admin_headers,
        json={"tag_id": tag.json()["id"]},
    )
    assert tag_link.status_code == 204

    second_entity = client.post(
        "/api/v1/entities",
        headers=admin_headers,
        json={"entity_type": "person", "name": "岡部倫太郎"},
    ).json()
    relation = client.post(
        "/api/v1/relations/entities",
        headers=admin_headers,
        json={
            "subject_entity_id": second_entity["id"],
            "predicate": "appears_in",
            "object_entity_id": entity_id,
            "source_record_id": record_id,
        },
    )
    assert relation.status_code == 201
    assert relation.json()["predicate"] == "appears_in"


def test_entity_relation_requires_timezone_aware_datetimes(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    subject = client.post(
        "/api/v1/entities",
        headers=admin_headers,
        json={"entity_type": "person", "name": "測試主體"},
    ).json()
    object_entity = client.post(
        "/api/v1/entities",
        headers=admin_headers,
        json={"entity_type": "organization", "name": "測試組織"},
    ).json()
    base_payload = {
        "subject_entity_id": subject["id"],
        "predicate": "works_at",
        "object_entity_id": object_entity["id"],
    }

    naive = client.post(
        "/api/v1/relations/entities",
        headers=admin_headers,
        json={**base_payload, "valid_from": "2025-07-16T00:00:00"},
    )
    assert naive.status_code == 422
    assert "timezone" in naive.text.lower()

    aware = client.post(
        "/api/v1/relations/entities",
        headers=admin_headers,
        json={**base_payload, "valid_from": "2025-07-16T00:00:00+08:00"},
    )
    assert aware.status_code == 201
    assert aware.json()["valid_from"] == "2025-07-15T16:00:00Z"
