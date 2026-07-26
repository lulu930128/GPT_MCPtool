from __future__ import annotations

from fastapi.testclient import TestClient


def test_duplicate_scan_finds_entity_alias_and_record_canonical_overlap(
    client: TestClient,
    admin_headers: dict[str, str],
    reader_headers: dict[str, str],
) -> None:
    first_entity = client.post(
        "/api/v1/entities",
        headers=admin_headers,
        json={
            "entity_type": "work",
            "name": "サクラノ詩 -櫻の森の上を舞う-",
            "payload": {"aliases": ["櫻之詩", "Sakura no Uta"]},
        },
    )
    second_entity = client.post(
        "/api/v1/entities",
        headers=admin_headers,
        json={
            "entity_type": "work",
            "name": "櫻之詩",
            "payload": {"aliases": ["桜の詩"]},
        },
    )
    assert first_entity.status_code == 201
    assert second_entity.status_code == 201

    record_ids: list[str] = []
    for title in ("完成《櫻之詩》", "玩過《桜の詩》"):
        response = client.post(
            "/api/v1/records",
            headers=admin_headers,
            json={
                "kind": "state",
                "domain": "media.galgame",
                "title": title,
                "schema_name": "media_experience",
                "payload": {
                    "canonical_entity_ref": f"entity:{first_entity.json()['id']}",
                    "progress": "completed",
                },
            },
        )
        assert response.status_code == 201
        record_ids.append(response.json()["id"])

    response = client.get(
        "/api/v1/duplicates",
        headers=reader_headers,
        params={"limit": 20},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["scanned_records"] == 2
    assert payload["scanned_entities"] == 2
    assert payload["scan_truncated"] is False

    findings = payload["findings"]
    entity_finding = next(
        item for item in findings if item["finding_type"] == "entity_identity_overlap"
    )
    assert set(entity_finding["refs"]) == {
        f"entity:{first_entity.json()['id']}",
        f"entity:{second_entity.json()['id']}",
    }
    assert entity_finding["confidence"] == "high"
    assert "aliases" in entity_finding["matched_on"]

    record_finding = next(
        item for item in findings if item["finding_type"] == "record_canonical_overlap"
    )
    assert set(record_finding["refs"]) == {
        f"record:{record_ids[0]}",
        f"record:{record_ids[1]}",
    }
    assert record_finding["confidence"] == "high"
    assert record_finding["matched_on"] == ["schema_name", "canonical_entity_ref"]


def test_duplicate_scan_preserves_restricted_visibility(
    client: TestClient,
    admin_headers: dict[str, str],
    reader_headers: dict[str, str],
) -> None:
    for title in ("restricted duplicate", "restricted duplicate"):
        response = client.post(
            "/api/v1/records",
            headers=admin_headers,
            json={
                "kind": "note",
                "domain": "private",
                "title": title,
                "sensitivity": "restricted",
            },
        )
        assert response.status_code == 201

    reader = client.get("/api/v1/duplicates", headers=reader_headers)
    assert reader.status_code == 200
    assert reader.json()["scanned_records"] == 0
    assert reader.json()["findings"] == []

    admin = client.get("/api/v1/duplicates", headers=admin_headers)
    assert admin.status_code == 200
    assert admin.json()["scanned_records"] == 2
    assert admin.json()["findings"][0]["finding_type"] == "record_title_overlap"


def test_duplicate_scan_finds_experience_inside_catalog_payload(
    client: TestClient,
    admin_headers: dict[str, str],
    reader_headers: dict[str, str],
) -> None:
    catalog = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json={
            "kind": "state",
            "domain": "media.galgame",
            "title": "Galgame 完食紀錄",
            "schema_name": "media_experience_catalog",
            "payload": {
                "categories": {
                    "催淚向": [
                        "Summer Pockets / Summer Pockets REFLECTION BLUE",
                        "はつゆきさくら",
                    ]
                }
            },
        },
    ).json()
    experience = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json={
            "kind": "state",
            "domain": "media.galgame",
            "title": "使用者玩過《Summer Pockets》",
            "schema_name": "media_experience",
            "payload": {"work_title": "Summer Pockets", "progress": "completed"},
        },
    ).json()

    response = client.get(
        "/api/v1/duplicates",
        headers=reader_headers,
        params={"limit": 20},
    )
    assert response.status_code == 200
    finding = next(
        item
        for item in response.json()["findings"]
        if item["finding_type"] == "record_catalog_item_overlap"
    )
    assert set(finding["refs"]) == {
        f"record:{catalog['id']}",
        f"record:{experience['id']}",
    }
    assert finding["confidence"] == "medium"
    assert finding["matched_on"] == ["payload.categories", "payload.work_title"]
