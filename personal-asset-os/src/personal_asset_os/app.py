from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from personal_asset_os import __version__
from personal_asset_os.api.routes import router
from personal_asset_os.database import Database
from personal_asset_os.errors import PersonalAssetError
from personal_asset_os.mcp_server import create_mcp_server
from personal_asset_os.migrations import run_migrations
from personal_asset_os.services.ledger import seed_system_accounts
from personal_asset_os.services.reporting import seed_settings
from personal_asset_os.settings import Settings

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved = settings or Settings()
    resolved.ensure_directories()
    run_migrations(resolved.database_path, resolved.project_root)
    database = Database(resolved.database_path)
    with database.session() as session:
        seed_system_accounts(session)
        seed_settings(session)
    mcp_server = create_mcp_server(database, resolved)
    mcp_app = mcp_server.streamable_http_app(
        streamable_http_path="/",
        json_response=True,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        del app
        async with mcp_server.session_manager.run():
            try:
                yield
            finally:
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
                    "details": {"fields": exc.errors()},
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
