from __future__ import annotations

from fastapi import APIRouter, Request
from sqlalchemy import text

from memory_core import __version__
from memory_core.api.deps import SessionDep
from memory_core.build import STARTUP_BUILD_ID
from memory_core.schemas import HealthResponse, VersionResponse

router = APIRouter(tags=["system"])


@router.get("/health", response_model=HealthResponse)
def health(request: Request, session: SessionDep) -> HealthResponse:
    try:
        session.execute(text("SELECT 1"))
        return HealthResponse(
            status="ok",
            database="ok",
            version=__version__,
            environment=request.app.state.settings.environment,
            build_id=STARTUP_BUILD_ID,
        )
    except Exception:  # pragma: no cover - failure path depends on environment
        return HealthResponse(
            status="degraded",
            database="error",
            version=__version__,
            environment=request.app.state.settings.environment,
            build_id=STARTUP_BUILD_ID,
        )


@router.get("/version", response_model=VersionResponse)
def version() -> VersionResponse:
    return VersionResponse(name="Memory Core", version=__version__)
