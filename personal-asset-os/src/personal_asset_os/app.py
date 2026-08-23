from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from personal_asset_os import __version__
from personal_asset_os.api.routes import router
from personal_asset_os.database import Database
from personal_asset_os.errors import PersonalAssetError
from personal_asset_os.mcp_server import create_mcp_server
from personal_asset_os.migrations import run_migrations
from personal_asset_os.services.broker_read import BrokerBridgeClient, BrokerSnapshotProvider
from personal_asset_os.services.broker_runtime import BrokerBridgeRuntime
from personal_asset_os.services.daily_snapshot_scheduler import run_daily_snapshot_loop
from personal_asset_os.services.fx_rates import FxRateProvider, OfficialUsdTwdRateProvider
from personal_asset_os.services.ledger import seed_system_accounts
from personal_asset_os.services.mobile_usb_bridge import MobileUsbBridge
from personal_asset_os.services.reporting import seed_settings
from personal_asset_os.settings import Settings

logger = logging.getLogger(__name__)


def create_app(
    settings: Settings | None = None,
    *,
    broker_reader: BrokerSnapshotProvider | None = None,
    fx_reader: FxRateProvider | None = None,
    mobile_usb_bridge: MobileUsbBridge | None = None,
) -> FastAPI:
    resolved = settings or Settings()
    resolved.ensure_directories()
    run_migrations(resolved.database_path, resolved.project_root)
    database = Database(resolved.database_path)
    with database.session() as session:
        seed_system_accounts(session)
        seed_settings(session)
    resolved_broker_reader = broker_reader or BrokerBridgeClient(resolved)
    resolved_fx_reader = fx_reader or OfficialUsdTwdRateProvider(resolved)
    broker_runtime = BrokerBridgeRuntime(resolved) if broker_reader is None else None
    resolved_mobile_usb_bridge = mobile_usb_bridge or MobileUsbBridge(resolved)
    mcp_server = create_mcp_server(
        database, resolved, resolved_broker_reader, resolved_fx_reader
    )
    mcp_app = mcp_server.streamable_http_app(
        streamable_http_path="/",
        json_response=True,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        del app
        snapshot_stop = asyncio.Event()
        snapshot_task: asyncio.Task[None] | None = None
        mobile_bridge_stop = asyncio.Event()
        mobile_bridge_task = asyncio.create_task(
            resolved_mobile_usb_bridge.run(mobile_bridge_stop),
            name="paos-mobile-usb-bridge",
        )
        if broker_runtime is not None:
            broker_runtime.start()
        if resolved.daily_snapshot_enabled:
            snapshot_task = asyncio.create_task(
                run_daily_snapshot_loop(
                    database,
                    settings=resolved,
                    broker_reader=resolved_broker_reader,
                    fx_reader=resolved_fx_reader,
                    stop_event=snapshot_stop,
                ),
                name="paos-daily-valuation-snapshot",
            )
        try:
            async with mcp_server.session_manager.run():
                yield
        finally:
            snapshot_stop.set()
            mobile_bridge_stop.set()
            if snapshot_task is not None:
                await snapshot_task
            await mobile_bridge_task
            if broker_runtime is not None:
                broker_runtime.stop()
            database.engine.dispose()

    app = FastAPI(
        title="Personal Asset OS",
        version=__version__,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        lifespan=lifespan,
    )
    app.state.settings = resolved
    app.state.database = database
    app.state.mcp_server = mcp_server
    app.state.broker_reader = resolved_broker_reader
    app.state.fx_reader = resolved_fx_reader
    app.state.broker_runtime = broker_runtime
    app.state.mobile_usb_bridge = resolved_mobile_usb_bridge

    @app.exception_handler(PersonalAssetError)
    async def product_error_handler(request: Request, exc: PersonalAssetError) -> JSONResponse:
        logger.info("Product error on %s: %s", request.url.path, exc.code)
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": exc.code, "message": exc.message, "details": exc.details}},
        )

    @app.exception_handler(RequestValidationError)
    async def request_validation_handler(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        logger.info("Request validation error on %s", request.url.path)
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": "REQUEST_VALIDATION_ERROR",
                    "message": "輸入資料不完整或格式不正確",
                    "details": {"fields": jsonable_encoder(exc.errors())},
                }
            },
        )

    app.include_router(router)
    app.mount("/mcp", mcp_app, name="mcp")
    assets = resolved.frontend_dist / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/", include_in_schema=False)
    def index() -> Response:
        index_path = resolved.frontend_dist / "index.html"
        if index_path.is_file():
            return FileResponse(index_path)
        return JSONResponse(
            status_code=503,
            content={
                "error": {
                    "code": "FRONTEND_NOT_BUILT",
                    "message": "Dashboard 尚未建置，請執行 frontend npm run build",
                }
            },
        )

    return app
