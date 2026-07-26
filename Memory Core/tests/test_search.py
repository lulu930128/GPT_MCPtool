from fastapi.testclient import TestClient


def test_search_supports_cjk_substrings(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    client.post(
        "/api/v1/records",
        headers=admin_headers,
        json={
            "kind": "reflection",
            "domain": "media",
            "title": "日文作品的閱讀進度",
            "body_markdown": "シュタインズ・ゲートを読み終えた。",
        },
    )

    chinese = client.get(
        "/api/v1/search",
        headers=admin_headers,
        params={"q": "閱讀進度"},
    )
    assert chinese.status_code == 200
    assert chinese.json()[0]["result_type"] == "record"

    japanese = client.get(
        "/api/v1/search",
        headers=admin_headers,
        params={"q": "ゲート"},
    )
    assert japanese.status_code == 200
    assert japanese.json()[0]["title"] == "日文作品的閱讀進度"


def test_search_normalizes_natural_language_memory_questions(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    catalog = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json={
            "kind": "fact",
            "domain": "media.galgame",
            "title": "Galgame 完食紀錄",
            "summary": "使用者已完成的作品清單。",
            "body_markdown": "這是使用者玩過的 Galgame 完食清單。",
        },
    )
    assert catalog.status_code == 201

    queries = (
        "我玩過哪些 Galgame？",
        "有哪些 Galgame 已經完食？",
        "我玩過的 Galgame 完食清單",
    )
    for query in queries:
        response = client.get(
            "/api/v1/search",
            headers=admin_headers,
            params={"q": query},
        )
        assert response.status_code == 200
        results = response.json()
        assert results
        assert results[0]["id"] == catalog.json()["id"]
        assert results[0]["score"] > 0
        assert results[0]["matched_fields"]
        assert results[0]["matched_terms"]
        assert results[0]["query_strategy"] in {
            "exact_title",
            "token_coverage",
            "token_fallback",
        }
        assert "？" not in results[0]["normalized_query"]


def test_search_falls_back_when_query_tokens_are_alternative_aliases(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    target = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json={
            "kind": "fact",
            "domain": "media.galgame",
            "title": "玩過《櫻之詩》",
            "summary": "使用者已完成這部作品。",
        },
    )
    assert target.status_code == 201

    response = client.get(
        "/api/v1/search",
        headers=admin_headers,
        params={"q": "櫻之詩 桜の詩 サクラノ詩"},
    )

    assert response.status_code == 200
    results = response.json()
    assert results
    assert results[0]["id"] == target.json()["id"]
    assert results[0]["query_strategy"] == "token_fallback"
    assert results[0]["matched_terms"] == ["櫻之詩"]
    assert "title" in results[0]["matched_fields"]


def test_search_supports_result_domain_kind_sensitivity_and_time_filters(
    client: TestClient,
    admin_headers: dict[str, str],
    reader_headers: dict[str, str],
) -> None:
    record = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json={
            "kind": "fact",
            "domain": "media.galgame",
            "title": "Summer Pockets",
            "sensitivity": "personal",
        },
    )
    restricted = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json={
            "kind": "note",
            "domain": "private",
            "title": "Summer restricted",
            "sensitivity": "restricted",
        },
    )
    entity = client.post(
        "/api/v1/entities",
        headers=admin_headers,
        json={
            "entity_type": "work",
            "name": "Summer entity",
        },
    )
    assert record.status_code == 201
    assert restricted.status_code == 201
    assert entity.status_code == 201

    record_only = client.get(
        "/api/v1/search",
        headers=admin_headers,
        params={
            "q": "Summer",
            "result_type": "record",
            "domain": "media.galgame",
            "kind": "fact",
            "sensitivity": "personal",
            "updated_before": "2100-01-01T00:00:00+00:00",
        },
    )
    assert record_only.status_code == 200
    assert [item["id"] for item in record_only.json()] == [record.json()["id"]]

    entity_only = client.get(
        "/api/v1/search",
        headers=admin_headers,
        params={"q": "Summer", "result_type": "entity", "kind": "work"},
    )
    assert entity_only.status_code == 200
    assert [item["id"] for item in entity_only.json()] == [entity.json()["id"]]

    restricted_hidden = client.get(
        "/api/v1/search",
        headers=reader_headers,
        params={
            "q": "Summer",
            "result_type": "record",
            "sensitivity": "restricted",
        },
    )
    assert restricted_hidden.status_code == 200
    assert restricted_hidden.json() == []

    future_only = client.get(
        "/api/v1/search",
        headers=admin_headers,
        params={"q": "Summer", "updated_after": "2100-01-01T00:00:00+00:00"},
    )
    assert future_only.status_code == 200
    assert future_only.json() == []

    invalid_range = client.get(
        "/api/v1/search",
        headers=admin_headers,
        params={
            "q": "Summer",
            "updated_after": "2030-01-01T00:00:00+00:00",
            "updated_before": "2020-01-01T00:00:00+00:00",
        },
    )
    assert invalid_range.status_code == 422


def test_search_excludes_superseded_records(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    record = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json={
            "kind": "state",
            "domain": "media.galgame",
            "title": "Old canonical experience",
        },
    )
    assert record.status_code == 201
    superseded = client.patch(
        f"/api/v1/records/{record.json()['id']}",
        headers=admin_headers,
        json={
            "expected_version": 1,
            "lifecycle_status": "superseded",
            "change_reason": "replaced by canonical record",
        },
    )
    assert superseded.status_code == 200

    response = client.get(
        "/api/v1/search",
        headers=admin_headers,
        params={"q": "Old canonical experience"},
    )
    assert response.status_code == 200
    assert response.json() == []


def test_search_matches_multiple_tokens_across_record_fields(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    target = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json={
            "kind": "reflection",
            "domain": "media",
            "title": "玩過《櫻之詩》",
            "summary": "作品類型是 Galgame。",
            "body_markdown": "這款作品已經玩過。",
        },
    )
    assert target.status_code == 201
    partial = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json={
            "kind": "note",
            "domain": "media",
            "title": "Galgame 待玩清單",
        },
    )
    assert partial.status_code == 201

    response = client.get(
        "/api/v1/search",
        headers=admin_headers,
        params={"q": "櫻之詩 Galgame 玩過"},
    )

    assert response.status_code == 200
    results = response.json()
    assert results[0]["id"] == target.json()["id"]
    assert {item["id"] for item in results} == {target.json()["id"]}
    assert partial.json()["id"] not in {item["id"] for item in results}


def test_search_matches_multiple_tokens_across_entity_fields(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    target = client.post(
        "/api/v1/entities",
        headers=admin_headers,
        json={
            "entity_type": "media",
            "name": "櫻之詩",
            "canonical_name": "Sakura no Uta",
            "description": "已經玩過的 Galgame。",
        },
    )
    assert target.status_code == 201

    response = client.get(
        "/api/v1/search",
        headers=admin_headers,
        params={"q": "櫻之詩 Galgame 玩過"},
    )

    assert response.status_code == 200
    assert response.json()[0]["id"] == target.json()["id"]
    assert response.json()[0]["result_type"] == "entity"


def test_multi_token_search_preserves_restricted_filtering(
    client: TestClient,
    admin_headers: dict[str, str],
    reader_headers: dict[str, str],
) -> None:
    restricted = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json={
            "kind": "note",
            "domain": "work",
            "title": "internal alpha launch",
            "sensitivity": "restricted",
            "handling_policy": "company_restricted",
        },
    )
    assert restricted.status_code == 201

    admin_result = client.get(
        "/api/v1/search",
        headers=admin_headers,
        params={"q": "internal alpha"},
    )
    reader_result = client.get(
        "/api/v1/search",
        headers=reader_headers,
        params={"q": "internal alpha"},
    )

    assert admin_result.status_code == 200
    assert admin_result.json()[0]["id"] == restricted.json()["id"]
    assert reader_result.status_code == 200
    assert reader_result.json() == []


def test_multi_token_search_filters_low_coverage_generic_matches(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    target = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json={
            "kind": "reflection",
            "domain": "media",
            "title": "Summer Pockets",
            "summary": "Galgame 完食紀錄",
            "body_markdown": "這款作品已經玩過。",
        },
    )
    unrelated = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json={
            "kind": "reflection",
            "domain": "media",
            "title": "玩過《櫻之詩》",
            "summary": "作品類型是 Galgame。",
        },
    )
    assert target.status_code == 201
    assert unrelated.status_code == 201

    response = client.get(
        "/api/v1/search",
        headers=admin_headers,
        params={"q": "Summer Pockets Galgame 玩過"},
    )

    assert response.status_code == 200
    ids = [item["id"] for item in response.json()]
    assert ids == [target.json()["id"]]
    assert unrelated.json()["id"] not in ids


def test_multi_token_search_prioritizes_exact_title_across_result_types(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    record = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json={
            "kind": "note",
            "domain": "media",
            "title": "Summer Pockets",
        },
    )
    entity = client.post(
        "/api/v1/entities",
        headers=admin_headers,
        json={
            "entity_type": "media",
            "name": "Summer archive",
            "description": "Pockets collection",
        },
    )
    assert record.status_code == 201
    assert entity.status_code == 201

    response = client.get(
        "/api/v1/search",
        headers=admin_headers,
        params={"q": "Summer Pockets"},
    )

    assert response.status_code == 200
    results = response.json()
    assert results[0]["id"] == record.json()["id"]
