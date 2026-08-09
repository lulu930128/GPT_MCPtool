from __future__ import annotations

from fastapi.testclient import TestClient


def test_health_and_empty_dashboard(client: TestClient) -> None:
    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["ok"] is True
    assert health.json()["schemaRevision"] == "0002_financial_events"
    assert len(health.json()["buildId"]) == 16

    dashboard = client.get("/api/dashboard")
    assert dashboard.status_code == 200
    body = dashboard.json()
    assert body["base_currency"] == "TWD"
    assert body["quality"] == "not_initialized"
    assert body["capture"]["pending_count"] == 0
    assert body["metrics"]["provisional_net_worth"] == "0.000000"
    assert any("尚未建立個人帳戶" in warning for warning in body["warnings"])

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


def test_validation_error_has_predictable_envelope(client: TestClient) -> None:
    response = client.post("/api/accounts", json={"name": "", "kind": "asset", "subtype": "bank"})
    assert response.status_code == 422
    body = response.json()
    assert body["error"]["code"] == "REQUEST_VALIDATION_ERROR"
    assert body["error"]["message"]
