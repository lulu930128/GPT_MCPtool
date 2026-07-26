from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from memory_core.operations import verify_sqlite_backup


def test_export_excludes_credentials_and_backup_is_readable(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    created = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json={"kind": "note", "domain": "general", "title": "備份測試"},
    )
    assert created.status_code == 201

    export = client.post("/api/v1/admin/export", headers=admin_headers)
    assert export.status_code == 201
    export_path = Path(export.json()["file_path"])
    document = json.loads(export_path.read_text(encoding="utf-8"))
    assert "client_credentials" not in document["tables"]
    assert len(document["tables"]["records"]) == 1

    backup = client.post("/api/v1/admin/backup", headers=admin_headers)
    assert backup.status_code == 201
    backup_path = Path(backup.json()["file_path"])
    result = verify_sqlite_backup(backup_path)
    assert result == {"integrity": "ok", "records": 1, "entities": 0}
    assert backup_path.with_suffix(".manifest.json").is_file()
