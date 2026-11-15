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


def test_mcp_uses_same_loaded_build_as_http(client: TestClient, monkeypatch) -> None:
    import asyncio

    from mcp import Client

    before = client.get("/api/health").json()["buildId"]
    monkeypatch.setattr("personal_asset_os.mcp_server.source_build_id", lambda *_: "changed-source")

    async def exercise() -> None:
        async with Client(client.app.state.mcp_server, raise_exceptions=True) as mcp:
            result = await mcp.call_tool("get_asset_system_status", {})
            assert result.structured_content["build_id"] == before
            assert result.structured_content["build_identity"] == "startup-v1"

    asyncio.run(exercise())


def test_build_binds_locks_config_and_delivered_frontend(tmp_path) -> None:
    from personal_asset_os.build import source_build_id

    dist = tmp_path / "frontend" / "dist"
    dist.mkdir(parents=True)
    widget = dist / "index.html"
    widget.write_text("old", encoding="utf-8")
    before = source_build_id(tmp_path)
    widget.write_text("new", encoding="utf-8")
    assert source_build_id(tmp_path) != before
    before = source_build_id(tmp_path)
    (tmp_path / "uv.lock").write_text("changed lock", encoding="utf-8")
    assert source_build_id(tmp_path) != before
    before = source_build_id(tmp_path)
    (tmp_path / "frontend" / "vite.config.ts").write_text("config", encoding="utf-8")
    assert source_build_id(tmp_path) != before
    stage = tmp_path / "stage"
    stage.mkdir()
    (stage / "index.html").write_text("new", encoding="utf-8")
    assert source_build_id(tmp_path, frontend_dist=stage) == source_build_id(tmp_path)


def test_code_only_schema_check_never_mutates_database(tmp_path) -> None:
    import hashlib
    import json
    import sqlite3
    import subprocess
    import sys
    from pathlib import Path

    from alembic.config import Config
    from alembic.script import ScriptDirectory

    from personal_asset_os.migrations import code_only_schema_preflight

    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "migrations"))
    head = ScriptDirectory.from_config(config).get_current_head()
    missing = tmp_path / "missing.db"
    assert code_only_schema_preflight(missing, root)["allowed"] is False
    assert not missing.exists()
    dbpath = tmp_path / "data" / "personal_asset_os.db"
    dbpath.parent.mkdir()
    with sqlite3.connect(dbpath) as db:
        db.execute("CREATE TABLE alembic_version (version_num TEXT)")
        db.execute("INSERT INTO alembic_version VALUES ('old-schema')")
    before = hashlib.sha256(dbpath.read_bytes()).hexdigest()
    assert code_only_schema_preflight(dbpath, root) == {
        "allowed": False, "code": "MIGRATION_REQUIRED"
    }
    assert hashlib.sha256(dbpath.read_bytes()).hexdigest() == before
    reply = subprocess.run(
        [sys.executable, "-B", str(root / "scripts" / "source-update-identity.py"),
         "--schema-data-dir", str(tmp_path)],
        check=True, capture_output=True, text=True,
    )
    assert json.loads(reply.stdout) == {"allowed": False, "code": "MIGRATION_REQUIRED"}
    assert hashlib.sha256(dbpath.read_bytes()).hexdigest() == before
    with sqlite3.connect(dbpath) as db:
        db.execute("UPDATE alembic_version SET version_num=?", (head,))
    before = hashlib.sha256(dbpath.read_bytes()).hexdigest()
    assert code_only_schema_preflight(dbpath, root)["allowed"] is True
    assert hashlib.sha256(dbpath.read_bytes()).hexdigest() == before


def test_new_app_loads_new_identity_for_http_and_mcp(settings, monkeypatch) -> None:
    import asyncio

    from mcp import Client

    from personal_asset_os.app import create_app

    monkeypatch.setattr("personal_asset_os.app.source_build_id", lambda *_: "new-loaded-build")
    app = create_app(settings)
    try:
        with TestClient(app) as http:
            assert http.get("/api/health").json()["buildId"] == "new-loaded-build"

            async def exercise() -> None:
                async with Client(app.state.mcp_server, raise_exceptions=True) as mcp:
                    result = await mcp.call_tool("get_asset_system_status", {})
                    assert result.structured_content["build_id"] == "new-loaded-build"

            asyncio.run(exercise())
    finally:
        app.state.database.engine.dispose()
