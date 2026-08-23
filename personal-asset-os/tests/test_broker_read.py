from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
import pytest
from pydantic import ValidationError

from personal_asset_os.services.broker_read import BrokerBridgeClient
from personal_asset_os.settings import Settings

NOW = datetime(2026, 8, 20, 2, 0, tzinfo=UTC)
TOKEN = "synthetic-local-token-that-is-long-enough"


def payload(*, source_as_of: datetime = NOW) -> dict[str, object]:
    return {
        "schema_version": "broker.position.v2",
        "broker": "KGI",
        "captured_at": NOW.isoformat(),
        "status": "complete",
        "scopes": [
            {
                "market": "TW",
                "account": {
                    "opaque_id": "kgi_0123456789abcdef01234567",
                    "masked_label": "****1234",
                },
                "status": "complete",
                "source": "kgi.inventory_sum",
                "source_as_of": source_as_of.isoformat(),
                "positions": [
                    {
                        "market": "TW",
                        "symbol": "2330",
                        "name": "台積電",
                        "currency": "TWD",
                        "settlement_currency": None,
                        "position_type": "cash",
                        "quantity": "10",
                        "average_cost": "1000",
                    }
                ],
                "valuations": [
                    {
                        "market": "TW",
                        "symbol": "2330",
                        "name": "台積電",
                        "currency": "TWD",
                        "last_price": "1200",
                        "native_market_value": "12000",
                        "price_as_of": source_as_of.isoformat(),
                        "price_quality": "broker_reported",
                        "broker_unrealized_pnl_native": "2000",
                        "broker_unrealized_pnl_twd": "2000",
                    }
                ],
                "warnings": [],
                "error_code": None,
            },
            {
                "market": "US",
                "account": {
                    "opaque_id": "kgi_abcdef0123456789abcdef01",
                    "masked_label": "****5678",
                },
                "status": "explicit_empty",
                "source": "kgi.stock_position_report",
                "source_as_of": source_as_of.isoformat(),
                "positions": [],
                "valuations": [],
                "warnings": [],
                "error_code": None,
            },
        ],
        "warnings": [],
        "payload_hash": "a" * 64,
    }


def settings(**values: object) -> Settings:
    return Settings(
        _env_file=None,
        broker_bridge_enabled=True,
        broker_bridge_api_token=TOKEN,
        **values,
    )


def test_bridge_client_reads_strict_contract_and_keeps_token_secret() -> None:
    requests = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        assert request.url == "http://127.0.0.1:18878/api/v2/positions"
        assert request.headers["Authorization"] == f"Bearer {TOKEN}"
        return httpx.Response(200, json=payload())

    client = BrokerBridgeClient(settings(), transport=httpx.MockTransport(handler))
    first = client.read(now=NOW)
    second = client.read(now=NOW + timedelta(seconds=1))

    assert first.status == "complete"
    assert first.read_mode == "live"
    assert first.snapshot is not None
    assert first.snapshot.scopes[0].valuations[0].native_market_value == 12000  # type: ignore[union-attr]
    assert second.read_mode == "memory_cache"
    assert requests == 1
    assert TOKEN not in repr(settings())


def test_bridge_error_is_unavailable_not_empty() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"error": {"code": "upstream", "message": "failed"}})

    result = BrokerBridgeClient(
        settings(broker_cache_ttl_seconds=0), transport=httpx.MockTransport(handler)
    ).read(now=NOW)

    assert result.status == "unavailable"
    assert result.snapshot is None
    assert "HTTP 503" in result.warnings[0]
    assert "failed" not in result.warnings[0]


def test_old_snapshot_is_marked_stale() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload(source_as_of=NOW - timedelta(minutes=10)))

    result = BrokerBridgeClient(
        settings(broker_price_max_age_seconds=60), transport=httpx.MockTransport(handler)
    ).read(now=NOW)

    assert result.status == "stale"
    assert result.snapshot is not None
    assert any("未標示為即時" in warning for warning in result.warnings)


def test_malformed_snapshot_fails_soft_instead_of_becoming_zero_holdings() -> None:
    malformed = payload()
    malformed["scopes"][0]["positions"][0]["quantity"] = "0"  # type: ignore[index]

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=malformed)

    result = BrokerBridgeClient(
        settings(broker_cache_ttl_seconds=0), transport=httpx.MockTransport(handler)
    ).read(now=NOW)

    assert result.status == "unavailable"
    assert result.snapshot is None
    assert "格式不符合契約" in result.warnings[0]


def test_broker_configuration_rejects_non_loopback_and_short_token() -> None:
    with pytest.raises(ValidationError):
        Settings(_env_file=None, broker_bridge_url="https://example.com")
    with pytest.raises(ValidationError):
        Settings(
            _env_file=None,
            broker_bridge_enabled=True,
            broker_bridge_api_token="too-short",
        )
