from __future__ import annotations

import uuid

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

from memory_core import __version__
from memory_core.api.router import api_router
from memory_core.api.routes.system import router as system_router
from memory_core.config import Settings, get_settings
from memory_core.db import Database
from memory_core.errors import (
    TEMPORAL_VALIDATION_CODES,
    DomainError,
    operation_error_from_validation,
)
from memory_core.normalization.profiles import validate_registered_profiles


def create_app(settings: Settings | None = None, database: Database | None = None) -> FastAPI:
    validate_registered_profiles()
    resolved_settings = settings or get_settings()
    resolved_database = database or Database(resolved_settings)
    app = FastAPI(
        title="Memory Core API",
        version=__version__,
        docs_url="/docs" if resolved_settings.environment != "production" else None,
        redoc_url=None,
    )
    app.state.settings = resolved_settings
    app.state.database = resolved_database

    app.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=resolved_settings.allowed_hosts,
    )
    if resolved_settings.allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=resolved_settings.allowed_origins,
            allow_credentials=False,
            allow_methods=["GET", "POST", "PATCH", "DELETE"],
            allow_headers=["Content-Type", "X-Memory-Core-Token", "X-Request-ID"],
        )

    @app.middleware("http")
    async def request_id_middleware(request: Request, call_next):  # type: ignore[no-untyped-def]
        incoming = request.headers.get("X-Request-ID")
        request_id = incoming[:64] if incoming else str(uuid.uuid4())
        request.state.request_id = request_id
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        return response

    @app.exception_handler(DomainError)
    async def domain_error_handler(request: Request, exc: DomainError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "ok": False,
                "error": exc.error_payload(),
                "request_id": getattr(request.state, "request_id", None),
            },
        )

    @app.exception_handler(RequestValidationError)
    async def request_validation_error_handler(
        request: Request,
        exc: RequestValidationError,
    ) -> JSONResponse:
        errors = exc.errors()
        if any(str(error.get("type") or "") in TEMPORAL_VALIDATION_CODES for error in errors):
            domain_error = operation_error_from_validation(
                errors,
                fallback_message="The request contains an invalid temporal value",
            )
            return JSONResponse(
                status_code=domain_error.status_code,
                content={
                    "ok": False,
                    "error": domain_error.error_payload(),
                    "request_id": getattr(request.state, "request_id", None),
                },
            )
        return JSONResponse(
            status_code=422,
            content={"detail": jsonable_encoder(errors)},
        )

    app.include_router(system_router)
    app.include_router(api_router)
    return app
