from __future__ import annotations

import hashlib

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import inspect, select

from personal_asset_os.database import Database
from personal_asset_os.models import FinancialEvent, MobileDevice, MobilePairingSession
from personal_asset_os.services import mobile_sync
from personal_asset_os.settings import Settings

DEVICE_ID = "b50ab705-f4e4-4313-9b6e-e16f37ea94f8"
EVENT_ID = "57c08ea3-40da-4fb7-a4e0-791811fc28e4"


def _create_pairing_code(database: Database) -> str:
    with database.session() as session:
        _, code = mobile_sync.create_pairing_session(session)
        return code


def _pair(client: TestClient, database: Database) -> tuple[str, str]:
    code = _create_pairing_code(database)
    response = client.post(
        "/api/mobile/pair",
        json={
            "pairing_code": code,
            "device_id": DEVICE_ID,
            "display_name": "Galaxy S23 Ultra",
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["device"]["id"] == DEVICE_ID
    assert body["device"]["status"] == "active"
    assert body["token_type"] == "Bearer"
    return code, str(body["token"])


def _mobile_payload(
    *,
    event_id: str = EVENT_ID,
    local_sequence: int = 1,
    description: str = "拉麵",
) -> dict[str, object]:
    payload: dict[str, object] = {
        "schema_version": 1,
        "id": event_id,
        "event_kind": "expense",
        "occurred_at": "2026-08-09T04:30:00.000Z",
        "captured_at": "2026-08-09T04:31:00.000Z",
        "amount": "180",
        "currency": "TWD",
        "description": description,
        "merchant": "巷口麵店",
        "note": None,
        "payment_hint": None,
        "source": "mobile_sync",
        "device_id": DEVICE_ID,
        "local_sequence": local_sequence,
        "idempotency_key": f"mobile:{DEVICE_ID}:{local_sequence}:{event_id}",
    }
    payload["payload_hash"] = mobile_sync.mobile_payload_hash(payload)
    return payload


def test_pairing_is_single_use_and_desktop_only_stores_token_hash(
    client: TestClient, database: Database
) -> None:
    code, token = _pair(client, database)
    assert token not in code

    with database.session() as session:
        device = session.get(MobileDevice, DEVICE_ID)
        assert device is not None
        assert device.token_hash == hashlib.sha256(token.encode("utf-8")).hexdigest()
        assert device.token_hash != token
        pairing = session.scalar(select(MobilePairingSession))
        assert pairing is not None
        assert pairing.code_hash != code.replace("-", "")
        assert pairing.used_at is not None

    reused = client.post(
        "/api/mobile/pair",
        json={
            "pairing_code": code,
            "device_id": "67b78f0f-5e7d-4b7d-8669-ad04c6a7fa41",
            "display_name": "另一支手機",
        },
    )
    assert reused.status_code == 401
    assert reused.json()["error"]["code"] == "AUTHENTICATION_ERROR"

    authenticated = client.get(
        "/api/mobile/session", headers={"Authorization": f"Bearer {token}"}
    )
    assert authenticated.status_code == 200
    assert authenticated.json()["ingest_only"] is True


def test_mobile_event_ingest_is_retry_safe_and_never_touches_ledger(
    client: TestClient, database: Database
) -> None:
    _, token = _pair(client, database)
    payload = _mobile_payload()
    headers = {"Authorization": f"Bearer {token}"}

    first = client.post("/api/mobile/events", headers=headers, json=payload)
    assert first.status_code == 201
    assert first.json()["event"]["created"] is True
    assert first.json()["event"]["source"] == "mobile_sync"
    assert first.json()["event"]["status"] == "pending_match"
    assert first.json()["accepted_payload_hash"] == payload["payload_hash"]

    retry = client.post("/api/mobile/events", headers=headers, json=payload)
    assert retry.status_code == 201
    assert retry.json()["event"]["created"] is False
    assert retry.json()["event"]["id"] == EVENT_ID
    assert client.get("/api/transactions").json() == []

    with database.session() as session:
        events = list(session.scalars(select(FinancialEvent)))
        device = session.get(MobileDevice, DEVICE_ID)
        assert len(events) == 1
        assert device is not None
        assert device.last_accepted_sequence == 1
        assert device.last_seen_at is not None


def test_mobile_ingest_rejects_hash_sequence_conflict_and_revoked_token(
    client: TestClient, database: Database
) -> None:
    _, token = _pair(client, database)
    headers = {"Authorization": f"Bearer {token}"}
    payload = _mobile_payload()
    client.post("/api/mobile/events", headers=headers, json=payload).raise_for_status()

    bad_hash = {**_mobile_payload(local_sequence=2), "payload_hash": "0" * 64}
    rejected_hash = client.post("/api/mobile/events", headers=headers, json=bad_hash)
    assert rejected_hash.status_code == 409
    assert rejected_hash.json()["error"]["code"] == "CONFLICT"

    conflict = _mobile_payload(
        event_id="cf0e8f48-c896-435d-a55d-e9a3d351d193",
        local_sequence=1,
        description="不同記錄",
    )
    rejected_sequence = client.post("/api/mobile/events", headers=headers, json=conflict)
    assert rejected_sequence.status_code == 409
    assert rejected_sequence.json()["error"]["code"] == "CONFLICT"

    with database.session() as session:
        mobile_sync.revoke_device(session, DEVICE_ID)
    revoked = client.get("/api/mobile/session", headers=headers)
    assert revoked.status_code == 401
    assert revoked.json()["error"]["code"] == "AUTHENTICATION_ERROR"


def test_0003_migration_enforces_unique_device_sequence(
    database: Database, settings: Settings
) -> None:
    indexes = {
        item["name"]: item
        for item in inspect(database.engine).get_indexes("financial_events")
    }
    assert indexes["ix_financial_events_device_sequence"]["unique"] == 1

    with database.session() as session:
        mobile_sync.create_pairing_session(session)

    config = Config(str(settings.project_root / "alembic.ini"))
    config.set_main_option("script_location", str(settings.project_root / "migrations"))
    config.set_main_option("sqlalchemy.url", f"sqlite:///{settings.database_path.as_posix()}")
    database.engine.dispose()
    with pytest.raises(RuntimeError, match="pairing audit state exists"):
        command.downgrade(config, "0002_financial_events")
