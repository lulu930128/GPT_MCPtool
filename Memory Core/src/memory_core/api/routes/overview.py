from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from memory_core.api.deps import ClientDep, SessionDep, require_scopes
from memory_core.schemas import MemoryOverview
from memory_core.services.overview import get_memory_overview

router = APIRouter(tags=["overview"])

OverviewReader = Annotated[
    ClientDep,
    Depends(require_scopes("records:read", "entities:read")),
]


@router.get("/overview", response_model=MemoryOverview)
def overview(
    session: SessionDep,
    principal: OverviewReader,
) -> MemoryOverview:
    return get_memory_overview(
        session,
        allow_restricted=principal.has_scope("restricted:read"),
    )
