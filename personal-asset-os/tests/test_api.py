from __future__ import annotations

from datetime import UTC, datetime

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from personal_asset_os.app import create_app
from personal_asset_os.models import AuditLog, DailyValuationSnapshot
from personal_asset_os.settings import Settings
from tests.broker_helpers import FakeBrokerReader, broker_result


def test_health_and_empty_dashboard(client: TestClient) -> None:
    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["ok"] is True
    assert health.json()["version"] == "1.1.0"
    assert health.json()["schemaRevision"] == "0005_reporting_annotations"
    assert len(health.json()["buildId"]) == 16
    assert health.json()["mobileUsbBridge"]["status"] == "disabled"
    assert health.json()["mobileUsbBridge"]["ready"] is False

    transport = client.get("/api/mobile/transport")
    assert transport.status_code == 200
    assert transport.json()["schema_version"] == "paos.mobile_usb_transport.v1"
    assert transport.json()["enabled"] is False

    dashboard = client.get("/api/dashboard")
    assert dashboard.status_code == 200
    body = dashboard.json()
    assert body["base_currency"] == "TWD"
    assert body["quality"] == "not_initialized"
    assert body["capture"]["pending_count"] == 0
    assert body["metrics"]["provisional_net_worth"] == "0.000000"
    assert body["broker"]["status"] == "disabled"
    assert body["review"]["schema_version"] == "paos.dashboard_review.v1"
    assert body["review"]["asset_allocation"]["total"] == "0.000000"
    assert any("尚未建立個人帳戶" in warning for warning in body["warnings"])

    history = client.get("/api/dashboard/history?range=1m")
    assert history.status_code == 200
    assert history.json()["series"] == []
    assert history.json()["coverage"]["gap_policy"] == (
        "missing_dates_are_omitted_not_zero_filled"
    )

    ai_status = client.get("/api/ai/status")
    assert ai_status.status_code == 200
    assert isinstance(ai_status.json()["configured"], bool)
    assert "api_key" not in ai_status.text.lower()


def test_api_credit_card_flow(client: TestClient) -> None:
    bank = client.post(
        "/api/accounts",
        json={"name": "API 銀行", "kind": "asset", "subtype": "bank", "is_liquid": True},
    ).json()
    card = client.post(
        "/api/accounts",
        json={
            "name": "API 信用卡",
            "kind": "liability",
            "subtype": "credit_card",
            "is_liquid": False,
        },
    ).json()
    client.post(
        "/api/transactions/opening-balance",
        json={
            "account_id": bank["id"],
            "amount": "5000",
            "occurred_at": "2026-08-06T01:00:00Z",
            "description": "期初",
            "idempotency_key": "api-opening-bank",
        },
    ).raise_for_status()
    client.post(
        "/api/transactions/expense",
        json={
            "payment_account_id": card["id"],
            "amount": "500",
            "occurred_at": "2026-08-06T02:00:00Z",
            "description": "API 餐飲",
            "idempotency_key": "api-card-expense",
        },
    ).raise_for_status()
    client.post(
        "/api/transactions/card-payment",
        json={
            "bank_account_id": bank["id"],
            "card_account_id": card["id"],
            "amount": "500",
            "occurred_at": "2026-08-06T03:00:00Z",
            "description": "API 繳卡費",
            "idempotency_key": "api-card-payment",
        },
    ).raise_for_status()
    dashboard = client.get("/api/dashboard").json()
    assert dashboard["metrics"]["monthly_expense"] == "500.000000"
    assert dashboard["metrics"]["debt"] == "0.000000"
    assert dashboard["metrics"]["liquid_cash"] == "4500.000000"


def test_api_reporting_annotation_changes_projection_without_mutating_ledger(
    client: TestClient,
) -> None:
    bank = client.post(
        "/api/accounts",
        json={"name": "分類測試銀行", "kind": "asset", "subtype": "bank", "is_liquid": True},
    ).json()
    client.post(
        "/api/transactions/opening-balance",
        json={
            "account_id": bank["id"],
            "amount": "1000",
            "occurred_at": "2026-08-23T01:00:00Z",
            "description": "分類測試期初",
            "idempotency_key": "api-annotation-opening-001",
        },
    ).raise_for_status()
    original = client.post(
        "/api/transactions/expense",
        json={
            "payment_account_id": bank["id"],
            "amount": "120",
            "occurred_at": "2026-08-23T02:00:00Z",
            "description": "舊消費去向",
            "idempotency_key": "api-annotation-expense-001",
        },
    ).json()

    response = client.put(
        f"/api/transactions/{original['id']}/reporting-annotation",
        json={
            "category": "吃飯",
            "note": "舊消費去向",
            "expected_version": 0,
            "reason": "將舊欄位轉為報表分類與備註",
        },
    )

    assert response.status_code == 200
    assert response.json()["changed"] is True
    assert response.json()["ledger_mutated"] is False
    assert response.json()["annotation"]["category"] == "吃飯"
    persisted = next(
        item for item in client.get("/api/transactions").json() if item["id"] == original["id"]
    )
    assert persisted["description"] == "舊消費去向"
    assert persisted["postings"] == original["postings"]
    recent = next(
        item
        for item in client.get("/api/dashboard").json()["recent_transactions"]
        if item["id"] == original["id"]
    )
    assert recent["category"] == "吃飯"
    assert recent["note"] == "舊消費去向"


def test_validation_error_has_predictable_envelope(client: TestClient) -> None:
    response = client.post("/api/accounts", json={"name": "", "kind": "asset", "subtype": "bank"})
    assert response.status_code == 422
    body = response.json()
    assert body["error"]["code"] == "REQUEST_VALIDATION_ERROR"
    assert body["error"]["message"]


def test_dashboard_applies_injected_broker_snapshot(settings: Settings) -> None:
    now = datetime(2026, 8, 20, 2, 0, tzinfo=UTC)
    reader = FakeBrokerReader(broker_result(as_of=now))
    app = create_app(settings, broker_reader=reader)

    with TestClient(app) as client:
        response = client.get("/api/dashboard")

    assert response.status_code == 200
    body = response.json()
    assert body["metrics"]["investment_market_value"] == "12000.000000"
    assert body["broker"]["status"] == "complete"
    assert body["positions"][0]["position_source"] == "kgi_broker"
    assert reader.calls == 1


def test_daily_snapshot_api_is_idempotent_and_history_get_is_read_only(
    settings: Settings,
) -> None:
    now = datetime(2026, 8, 20, 2, 0, tzinfo=UTC)
    reader = FakeBrokerReader(broker_result(as_of=now))
    app = create_app(settings, broker_reader=reader)

    with TestClient(app) as client:
        first = client.post("/api/valuation-snapshots/daily")
        second = client.post("/api/valuation-snapshots/daily")
        with app.state.database.session() as session:
            before = (
                int(
                    session.scalar(
                        select(func.count()).select_from(DailyValuationSnapshot)
                    )
                    or 0
                ),
                int(
                    session.scalar(
                        select(func.count())
                        .select_from(AuditLog)
                        .where(AuditLog.entity_type == "daily_valuation_snapshot")
                    )
                    or 0
                ),
            )
        history = client.get("/api/dashboard/history?range=1m")
        with app.state.database.session() as session:
            after = (
                int(
                    session.scalar(
                        select(func.count()).select_from(DailyValuationSnapshot)
                    )
                    or 0
                ),
                int(
                    session.scalar(
                        select(func.count())
                        .select_from(AuditLog)
                        .where(AuditLog.entity_type == "daily_valuation_snapshot")
                    )
                    or 0
                ),
            )

    assert first.status_code == 201
    assert first.json()["created"] is True
    assert second.status_code == 201
    assert second.json()["created"] is False
    assert second.json()["snapshot"]["id"] == first.json()["snapshot"]["id"]
    assert history.status_code == 200
    assert len(history.json()["series"]) == 1
    assert history.json()["series"][0]["metrics"]["investment_market_value"] == (
        "12000.000000"
    )
    assert before == after == (1, 1)
    assert reader.calls == 1


def test_dashboard_history_rejects_unknown_range(client: TestClient) -> None:
    response = client.get("/api/dashboard/history?range=all")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "REQUEST_VALIDATION_ERROR"
