from fastapi.testclient import TestClient


def test_health_and_version_are_public(client: TestClient) -> None:
    health = client.get("/health")
    assert health.status_code == 200
    assert health.json()["status"] == "ok"
    assert health.headers["X-Request-ID"]

    version = client.get("/version")
    assert version.status_code == 200
    assert version.json() == {"name": "Memory Core", "version": "1.1.0"}


def test_private_api_requires_valid_token(client: TestClient) -> None:
    missing = client.get("/api/v1/records")
    assert missing.status_code == 401

    invalid = client.get(
        "/api/v1/records",
        headers={"X-Memory-Core-Token": "not-a-real-token"},
    )
    assert invalid.status_code == 401


def test_candidate_client_cannot_review(
    client: TestClient,
    candidate_headers: dict[str, str],
) -> None:
    response = client.get("/api/v1/candidates", headers=candidate_headers)
    assert response.status_code == 403


def test_review_client_cannot_directly_read_or_write_formal_data(
    client: TestClient,
    review_headers: dict[str, str],
) -> None:
    assert client.get("/api/v1/records", headers=review_headers).status_code == 403
    direct_write = client.post(
        "/api/v1/records",
        headers=review_headers,
        json={"kind": "idea", "domain": "general", "title": "must not write"},
    )
    assert direct_write.status_code == 403
