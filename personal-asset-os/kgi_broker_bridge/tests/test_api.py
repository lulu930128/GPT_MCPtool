from __future__ import annotations

import asyncio

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr

from kgi_broker_bridge.adapters.disabled import DisabledBrokerAdapter
from kgi_broker_bridge.adapters.kgi_inventory import KGIInventoryAdapter
from kgi_broker_bridge.api import create_app
from kgi_broker_bridge.identity import AccountIdentityProjector
from kgi_broker_bridge.service import BrokerBridgeService
from tests.helpers import FakeGateway, synthetic_batch

TOKEN = "synthetic-local-api-token-for-tests-0001"


def live_test_app() -> FastAPI:
    adapter = KGIInventoryAdapter(
        gateway=FakeGateway(synthetic_batch()),
        identity=AccountIdentityProjector("synthetic-hmac-key-for-tests-0001"),
    )
    return create_app(
        BrokerBridgeService(adapter=adapter), api_token=SecretStr(TOKEN)
    )


def test_health_is_bounded_and_positions_require_bearer_token() -> None:
    async def exercise() -> None:
        transport = ASGITransport(app=live_test_app())
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            health = await client.get("/api/health")
            assert health.status_code == 200
            assert health.json()["schema_version"] == "broker.health.v1"
            assert "account_ref" not in health.text
            assert health.headers["cache-control"] == "no-store"

            unauthorized = await client.get("/api/v1/positions")
            assert unauthorized.status_code == 401
            assert unauthorized.json() == {
                "error": {
                    "code": "unauthorized",
                    "message": "A valid local bearer token is required.",
                }
            }

            positions = await client.get(
                "/api/v1/positions", headers={"Authorization": f"Bearer {TOKEN}"}
            )
            assert positions.status_code == 200
            assert positions.json()["schema_version"] == "broker.position.v1"
            assert positions.headers["cache-control"] == "no-store"
            assert synthetic_batch().account_ref not in positions.text

            positions_v2 = await client.get(
                "/api/v2/positions", headers={"Authorization": f"Bearer {TOKEN}"}
            )
            assert positions_v2.status_code == 200
            assert positions_v2.json()["schema_version"] == "broker.position.v2"
            assert {scope["market"] for scope in positions_v2.json()["scopes"]} == {
                "TW",
                "US",
            }

    asyncio.run(exercise())


def test_disabled_runtime_fails_closed_and_exposes_no_trading_routes() -> None:
    app = create_app(
        BrokerBridgeService(adapter=DisabledBrokerAdapter()),
        api_token=SecretStr(TOKEN),
    )

    async def exercise() -> None:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            result = await client.get(
                "/api/v1/positions", headers={"Authorization": f"Bearer {TOKEN}"}
            )
            assert result.status_code == 503
            assert result.json()["error"]["code"] == "adapter_not_configured"

            paths = (await client.get("/openapi.json")).json()["paths"]
            assert set(paths) == {
                "/api/health",
                "/api/v1/positions",
                "/api/v2/positions",
            }

    asyncio.run(exercise())
