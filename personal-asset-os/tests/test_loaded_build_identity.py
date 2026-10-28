from fastapi.testclient import TestClient


def test_health_keeps_startup_build_after_source_changes(client: TestClient, monkeypatch) -> None:
    before = client.get("/api/health").json()["buildId"]
    monkeypatch.setattr("personal_asset_os.build.source_build_id", lambda *_: "changed-source")
    monkeypatch.setattr("personal_asset_os.app.source_build_id", lambda *_: "changed-source")
    assert client.get("/api/health").json()["buildId"] == before
    assert client.get("/api/readyz").json()["buildId"] == before
    assert client.get("/api/system/info").json()["buildId"] == before
    for path in ("/api/health", "/api/readyz", "/api/system/info"):
        assert client.get(path).json()["buildIdentity"] == "startup-v1"
    assert len(before) == 16
