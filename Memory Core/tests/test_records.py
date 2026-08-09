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


def test_record_revision_preserves_historical_restricted_boundary(
    client: TestClient,
    admin_headers: dict[str, str],
    reader_headers: dict[str, str],
) -> None:
    created = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json=record_payload(
            title="Historical restricted content",
            sensitivity="restricted",
        ),
    ).json()
    updated = client.patch(
        f"/api/v1/records/{created['id']}",
        headers=admin_headers,
        json={
            "expected_version": 1,
            "title": "Current personal content",
            "sensitivity": "personal",
        },
    )
    assert updated.status_code == 200
    assert updated.json()["version"] == 2

    current_for_reader = client.get(
        f"/api/v1/records/{created['id']}",
        headers=reader_headers,
    )
    assert current_for_reader.status_code == 200
    hidden_historical = client.get(
        f"/api/v1/records/{created['id']}/revisions/1",
        headers=reader_headers,
    )
    assert hidden_historical.status_code == 404
    visible_current_revision = client.get(
        f"/api/v1/records/{created['id']}/revisions/2",
        headers=reader_headers,
    )
    assert visible_current_revision.status_code == 200
    assert visible_current_revision.json()["title"] == "Current personal content"
    admin_historical = client.get(
        f"/api/v1/records/{created['id']}/revisions/1",
        headers=admin_headers,
    )
    assert admin_historical.status_code == 200
    assert admin_historical.json()["sensitivity"] == "restricted"


def test_record_occurrence_requires_timezone_aware_datetimes(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    naive = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json=record_payload(
            occurred_start="2025-07-16T00:00:00",
            date_precision="day",
            timezone_name="Asia/Taipei",
        ),
    )
    assert naive.status_code == 422
    assert naive.json()["error"] == {
        "code": "timezone_offset_required",
        "field": "occurred_start",
        "message": "Timestamp must include Z or an explicit numeric UTC offset such as +08:00.",
        "received_value": "2025-07-16T00:00:00",
        "example": "2025-07-16T00:00:00+08:00",
    }

    aware = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json=record_payload(
            occurred_start="2025-07-16T00:00:00+08:00",
            date_precision="day",
            timezone_name="Asia/Taipei",
        ),
    )
    assert aware.status_code == 201
    assert aware.json()["occurred_start"] == "2025-07-15T16:00:00Z"
    assert aware.json()["timezone_name"] == "Asia/Taipei"


def test_record_occurrence_validates_timezone_range_and_precision(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    invalid_timezone = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json=record_payload(timezone_name="Taipei"),
    )
    assert invalid_timezone.status_code == 422
    assert invalid_timezone.json()["error"]["code"] == "invalid_timezone_name"
    assert invalid_timezone.json()["error"]["field"] == "timezone_name"

    missing_precision = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json=record_payload(occurred_start="2025-07-16T00:00:00+08:00"),
    )
    assert missing_precision.status_code == 422
    assert missing_precision.json()["error"]["code"] == "date_precision_required"
    assert missing_precision.json()["error"]["field"] == "date_precision"

    precision_without_occurrence = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json=record_payload(date_precision="day"),
    )
    assert precision_without_occurrence.status_code == 422
    assert (
        precision_without_occurrence.json()["error"]["code"] == "date_precision_without_occurrence"
    )

    invalid_range = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json=record_payload(
            occurred_start="2025-07-16T10:00:00+08:00",
            occurred_end="2025-07-16T09:00:00+08:00",
            date_precision="exact",
        ),
    )
    assert invalid_range.status_code == 422
    assert invalid_range.json()["error"]["code"] == "invalid_time_range"
    assert invalid_range.json()["error"]["field"] == "occurred_end"

    offset_only = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json=record_payload(
            occurred_start="2025-07-16T00:00:00Z",
            date_precision="exact",
        ),
    )
    assert offset_only.status_code == 201
    assert offset_only.json()["timezone_name"] is None


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
