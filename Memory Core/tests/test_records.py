from fastapi.testclient import TestClient
from sqlalchemy import func, select

from memory_core.db import Database
from memory_core.models import AuditEvent, Revision


def record_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "kind": "reflection",
        "domain": "general",
        "title": "Memory Core 第一筆記憶",
        "summary": "確認通用記憶可以保存",
        "body_markdown": "這是一筆 **測試** 記憶。",
        "date_precision": "day",
        "timezone_name": "Asia/Taipei",
    }
    payload.update(overrides)
    return payload


def test_record_lifecycle_keeps_revisions_and_audit(
    client: TestClient,
    database: Database,
    admin_headers: dict[str, str],
) -> None:
    created_response = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json=record_payload(),
    )
    assert created_response.status_code == 201
    created = created_response.json()
    assert created["version"] == 1

    updated_response = client.patch(
        f"/api/v1/records/{created['id']}",
        headers=admin_headers,
        json={
            "expected_version": 1,
            "title": "Memory Core 已更新記憶",
            "change_reason": "修正標題",
        },
    )
    assert updated_response.status_code == 200
    updated = updated_response.json()
    assert updated["version"] == 2

    stale_response = client.patch(
        f"/api/v1/records/{created['id']}",
        headers=admin_headers,
        json={"expected_version": 1, "title": "過期寫入"},
    )
    assert stale_response.status_code == 409
    assert stale_response.json()["error"]["code"] == "version_conflict"

    archived_response = client.delete(
        f"/api/v1/records/{created['id']}",
        headers=admin_headers,
        params={"expected_version": 2, "reason": "測試封存"},
    )
    assert archived_response.status_code == 200
    archived = archived_response.json()
    assert archived["deleted_at"] is not None
    assert archived["version"] == 3

    hidden = client.get(f"/api/v1/records/{created['id']}", headers=admin_headers)
    assert hidden.status_code == 404
    archived_readback = client.get(
        f"/api/v1/records/{created['id']}",
        headers=admin_headers,
        params={"include_deleted": True},
    )
    assert archived_readback.status_code == 200
    assert archived_readback.json()["lifecycle_status"] == "archived"
    assert archived_readback.json()["deleted_at"] is not None

    with database.session_factory() as session:
        revision_count = session.scalar(
            select(func.count()).select_from(Revision).where(Revision.target_id == created["id"])
        )
        audit_count = session.scalar(
            select(func.count())
            .select_from(AuditEvent)
            .where(AuditEvent.target_id == created["id"])
        )
    assert revision_count == 3
    assert audit_count == 3


def test_record_occurrence_requires_timezone_aware_datetimes(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    naive = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json=record_payload(occurred_start="2025-07-16T00:00:00"),
    )
    assert naive.status_code == 422
    assert "timezone" in naive.text.lower()

    aware = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json=record_payload(occurred_start="2025-07-16T00:00:00+08:00"),
    )
    assert aware.status_code == 201
    assert aware.json()["occurred_start"] == "2025-07-15T16:00:00Z"


def test_restricted_records_require_separate_scope(
    client: TestClient,
    admin_headers: dict[str, str],
    reader_headers: dict[str, str],
) -> None:
    created = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json=record_payload(title="受限制的私人資料", sensitivity="restricted"),
    ).json()

    admin_read = client.get(f"/api/v1/records/{created['id']}", headers=admin_headers)
    assert admin_read.status_code == 200

    reader_read = client.get(f"/api/v1/records/{created['id']}", headers=reader_headers)
    assert reader_read.status_code == 404

    reader_list = client.get("/api/v1/records", headers=reader_headers)
    assert reader_list.status_code == 200
    assert reader_list.json() == []
