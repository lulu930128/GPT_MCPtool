from __future__ import annotations

import secrets
from typing import Annotated

from fastapi import Depends, FastAPI, Header, Request, Response
from fastapi.responses import JSONResponse
from pydantic import SecretStr

from kgi_broker_bridge import __version__
from kgi_broker_bridge.contracts import (
    BridgeErrorBody,
    BridgeErrorEnvelope,
    BrokerHealth,
    BrokerPositionSnapshot,
    BrokerPositionSnapshotV2,
)
from kgi_broker_bridge.errors import AuthenticationError, BridgeError
from kgi_broker_bridge.service import BrokerBridgeService


def create_app(service: BrokerBridgeService, *, api_token: SecretStr) -> FastAPI:
    expected_token = api_token.get_secret_value()
    if len(expected_token) < 32:
        raise ValueError("api token must contain at least 32 characters")

    app = FastAPI(
        title="KGI Broker Bridge",
        version=__version__,
        description="Loopback-only, read-only KGI broker isolation bridge.",
    )

    def require_bearer_token(
        authorization: Annotated[str | None, Header()] = None,
    ) -> None:
        if authorization is None:
            raise AuthenticationError
        scheme, separator, supplied = authorization.partition(" ")
        if (
            separator != " "
            or scheme.lower() != "bearer"
            or not secrets.compare_digest(supplied, expected_token)
        ):
            raise AuthenticationError

    @app.exception_handler(BridgeError)
    async def bridge_error_handler(_request: Request, exc: BridgeError) -> JSONResponse:
        envelope = BridgeErrorEnvelope(
            error=BridgeErrorBody(code=exc.code, message=exc.message)
        )
        return JSONResponse(
            status_code=exc.http_status,
            content=envelope.model_dump(mode="json"),
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/api/health", response_model=BrokerHealth)
    def get_health(response: Response) -> BrokerHealth:
        response.headers["Cache-Control"] = "no-store"
        return service.get_health()

    @app.get(
        "/api/v1/positions",
        response_model=BrokerPositionSnapshot,
        dependencies=[Depends(require_bearer_token)],
    )
    def get_positions(response: Response) -> BrokerPositionSnapshot:
        response.headers["Cache-Control"] = "no-store"
        return service.get_positions()

    @app.get(
        "/api/v2/positions",
        response_model=BrokerPositionSnapshotV2,
        dependencies=[Depends(require_bearer_token)],
    )
    def get_positions_v2(response: Response) -> BrokerPositionSnapshotV2:
        response.headers["Cache-Control"] = "no-store"
        return service.get_positions_v2()

    return app
