from pathlib import Path

from fastapi.testclient import TestClient

from memory_core.build import STARTUP_BUILD_ID, source_build_id


def test_source_identity_tracks_code_but_excludes_private_state(tmp_path: Path) -> None:
    package = tmp_path / "src" / "memory_core"
    package.mkdir(parents=True)
    code = package / "app.py"
    code.write_text("print('a')\n", encoding="utf-8")
    initial = source_build_id(tmp_path)
    (tmp_path / ".env").write_text("inert-private-fixture", encoding="utf-8")
    data = tmp_path / "data"
    data.mkdir()
    (data / "fixture.db").write_bytes(b"inert-private-fixture")
    assert source_build_id(tmp_path) == initial
    code.write_text("print('b')\n", encoding="utf-8")
    assert source_build_id(tmp_path) != initial


def test_backend_health_reports_startup_identity(client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr("memory_core.build.source_build_id", lambda: "changed-after-start")
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["build_id"] == STARTUP_BUILD_ID
    assert len(STARTUP_BUILD_ID) == 16
