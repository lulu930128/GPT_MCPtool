from __future__ import annotations

from datetime import UTC, datetime

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import func, inspect, select, text
from sqlalchemy.orm import Session

from personal_asset_os.database import Database
from personal_asset_os.domain.enums import (
    AccountKind,
    AccountSubtype,
    ApprovalSource,
    AuditAction,
    FinancialEventKind,
)
from personal_asset_os.errors import UnsafeOperationError
from personal_asset_os.models import AuditLog, FinancialEvent, LedgerTransaction, Posting
from personal_asset_os.services import financial_events
from personal_asset_os.settings import Settings
from tests.helpers import add_account

OCCURRED_AT = "2026-08-09T04:30:00Z"


def _event_payload(*, event_id: str, key: str, description: str = "拉麵") -> dict[str, object]:
    return {
        "id": event_id,
        "event_kind": "expense",
        "occurred_at": OCCURRED_AT,
        "amount": "180",
        "description": description,
        "merchant": "巷口麵店",
        "idempotency_key": key,
    }


def test_capture_is_idempotent_and_does_not_touch_ledger(client: TestClient) -> None:
    event_id = "2b213953-d6d4-4dd7-b63b-4a82da66eae3"
    payload = _event_payload(event_id=event_id, key="capture-ramen-001")

    first = client.post("/api/financial-events", json=payload)
    assert first.status_code == 201
    assert first.json()["created"] is True
    assert first.json()["status"] == "pending_match"
    assert first.json()["version"] == 1

    retry = client.post("/api/financial-events", json=payload)
    assert retry.status_code == 201
    assert retry.json()["created"] is False
    assert retry.json()["id"] == event_id

    conflict_payload = {**payload, "description": "不同內容"}
    conflict = client.post("/api/financial-events", json=conflict_payload)
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "CONFLICT"

    assert client.get("/api/transactions").json() == []
    dashboard = client.get("/api/dashboard").json()
    assert dashboard["quality"] == "not_initialized"
    assert dashboard["capture"]["pending_count"] == 1
    assert dashboard["capture"]["pending_amount"] == "180.000000"


def test_update_uses_version_and_reject_preserves_tombstone(client: TestClient) -> None:
    event_id = "8f97af69-a7be-48e2-8ea0-7ed7748d27e6"
    payload = _event_payload(event_id=event_id, key="capture-edit-001")
    client.post("/api/financial-events", json=payload).raise_for_status()

    updated = client.patch(
        f"/api/financial-events/{event_id}",
        json={"expected_version": 1, "description": "晚餐拉麵", "amount": "200"},
    )
    assert updated.status_code == 200
    assert updated.json()["version"] == 2
    assert updated.json()["description"] == "晚餐拉麵"

    stale = client.patch(
        f"/api/financial-events/{event_id}",
        json={"expected_version": 1, "description": "覆蓋較新內容"},
    )
    assert stale.status_code == 409

    rejected = client.post(
        f"/api/financial-events/{event_id}/reject",
        json={"expected_version": 2, "reason": "重複記錄"},
    )
    assert rejected.status_code == 200
    assert rejected.json()["status"] == "rejected"
    assert rejected.json()["version"] == 3
    assert rejected.json()["changed"] is True
    assert client.get(f"/api/financial-events/{event_id}").json()["rejected_reason"] == "重複記錄"
    assert client.get("/api/transactions").json() == []


def test_finalize_creates_one_balanced_transaction_and_is_retry_safe(client: TestClient) -> None:
    bank = client.post(
        "/api/accounts",
        json={"name": "日常銀行", "kind": "asset", "subtype": "bank", "is_liquid": True},
    ).json()
    other_bank = client.post(
        "/api/accounts",
        json={"name": "備用銀行", "kind": "asset", "subtype": "bank", "is_liquid": True},
    ).json()
    event_id = "93ba2111-3087-4ab7-a48f-df78bb2cb5a0"
    client.post(
        "/api/financial-events",
        json=_event_payload(event_id=event_id, key="capture-finalize-001"),
    ).raise_for_status()

    decision = {"expected_version": 1, "payment_account_id": bank["id"]}
    finalized = client.post(f"/api/financial-events/{event_id}/finalize", json=decision)
    assert finalized.status_code == 201
    body = finalized.json()
    assert body["created"] is True
    assert body["event"]["status"] == "matched"
    assert body["event"]["approval_source"] == "local_ui"
    assert len(body["transaction"]["postings"]) == 2
    assert sum(float(item["base_amount"]) for item in body["transaction"]["postings"]) == 0

    retry = client.post(f"/api/financial-events/{event_id}/finalize", json=decision)
    assert retry.status_code == 201
    assert retry.json()["created"] is False
    assert retry.json()["transaction"]["id"] == body["transaction"]["id"]
    assert len(client.get("/api/transactions").json()) == 1

    conflicting_decision = client.post(
        f"/api/financial-events/{event_id}/finalize",
        json={"expected_version": 1, "payment_account_id": other_bank["id"]},
    )
    assert conflicting_decision.status_code == 409
    dashboard = client.get("/api/dashboard").json()
    assert dashboard["metrics"]["monthly_expense"] == "180.000000"
    assert dashboard["capture"]["pending_count"] == 0


def test_invalid_finalize_keeps_event_pending_and_paired_mobile_requires_matching_device(
    client: TestClient, session: Session
) -> None:
    event, _ = financial_events.capture_event(
        session,
        event_id="de727657-5120-43b4-8ef1-f17e254b5725",
        event_kind=FinancialEventKind.EXPENSE,
        occurred_at=datetime(2026, 8, 9, 5, 0, tzinfo=UTC),
        amount=180,
        description="拉麵",
        idempotency_key="paired-mobile-closed",
    )
    bank = add_account(session, "服務測試銀行", AccountKind.ASSET, AccountSubtype.BANK)
    transaction_count = select(func.count()).select_from(LedgerTransaction)
    posting_count = select(func.count()).select_from(Posting)
    before_transactions = int(session.scalar(transaction_count) or 0)
    before_postings = int(session.scalar(posting_count) or 0)

    try:
        financial_events.finalize_event(
            session,
            event_id=event.id,
            expected_version=1,
            payment_account_id=bank.id,
            approval_source=ApprovalSource.PAIRED_MOBILE,
        )
    except UnsafeOperationError:
        pass
    else:
        raise AssertionError("缺少已驗證裝置身分時必須拒絕 paired-mobile")

    with pytest.raises(UnsafeOperationError, match="與事件相符"):
        financial_events.finalize_event(
            session,
            event_id=event.id,
            expected_version=1,
            payment_account_id=bank.id,
            approval_source=ApprovalSource.PAIRED_MOBILE,
            actor="mobile_device:other-device",
            authenticated_mobile_device_id="other-device",
        )

    assert event.status.value == "pending_match"
    assert int(session.scalar(transaction_count) or 0) == before_transactions
    assert int(session.scalar(posting_count) or 0) == before_postings


def test_financial_event_operations_are_audited(session: Session) -> None:
    event, _ = financial_events.capture_event(
        session,
        event_kind=FinancialEventKind.INCOME,
        occurred_at=datetime(2026, 8, 9, 6, 0, tzinfo=UTC),
        amount=500,
        description="退款",
        idempotency_key="audit-event-001",
    )
    financial_events.update_pending_event(
        session,
        event_id=event.id,
        expected_version=1,
        patch={"note": "人工確認"},
    )
    financial_events.reject_pending_event(
        session,
        event_id=event.id,
        expected_version=2,
        reason="不是收入",
    )
    session.flush()
    actions = list(
        session.scalars(
            select(AuditLog.action)
            .where(AuditLog.entity_id == event.id)
            .order_by(AuditLog.created_at)
        )
    )
    assert actions == [AuditAction.CREATE, AuditAction.UPDATE, AuditAction.REJECT]
    assert session.scalar(select(func.count()).select_from(FinancialEvent)) == 1


def test_migration_round_trip_from_0001_expands_audit_contract(
    database: Database, settings: Settings
) -> None:
    config = Config(str(settings.project_root / "alembic.ini"))
    config.set_main_option("script_location", str(settings.project_root / "migrations"))
    config.set_main_option("sqlalchemy.url", f"sqlite:///{settings.database_path.as_posix()}")

    database.engine.dispose()
    command.downgrade(config, "0001_initial")
    assert "financial_events" not in inspect(database.engine).get_table_names()
    command.upgrade(config, "head")

    with database.session() as session:
        revision = session.scalar(text("SELECT version_num FROM alembic_version"))
        assert revision == "0005_reporting_annotations"
        assert "daily_valuation_snapshots" in inspect(database.engine).get_table_names()
        assert "transaction_reporting_annotations" in inspect(database.engine).get_table_names()
        event, _ = financial_events.capture_event(
            session,
            event_kind=FinancialEventKind.EXPENSE,
            occurred_at=datetime(2026, 8, 9, 7, 0, tzinfo=UTC),
            amount=60,
            description="遷移驗證",
            idempotency_key="migration-audit-001",
        )
        financial_events.update_pending_event(
            session,
            event_id=event.id,
            expected_version=1,
            patch={"note": "UPDATE enum 可寫入"},
        )
        session.flush()
        assert session.scalar(
            select(func.count())
            .select_from(AuditLog)
            .where(AuditLog.action == AuditAction.UPDATE)
        ) == 1


def test_downgrade_refuses_to_discard_financial_events(
    database: Database, settings: Settings
) -> None:
    with database.session() as session:
        financial_events.capture_event(
            session,
            event_kind=FinancialEventKind.EXPENSE,
            occurred_at=datetime(2026, 8, 9, 8, 0, tzinfo=UTC),
            amount=80,
            description="保留的事件",
            idempotency_key="downgrade-guard-001",
        )

    config = Config(str(settings.project_root / "alembic.ini"))
    config.set_main_option("script_location", str(settings.project_root / "migrations"))
    config.set_main_option("sqlalchemy.url", f"sqlite:///{settings.database_path.as_posix()}")
    database.engine.dispose()
    with pytest.raises(RuntimeError, match="Financial Event data exists"):
        command.downgrade(config, "0001_initial")
