from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from memory_core.api.deps import ClientDep, SessionDep, require_scopes
from memory_core.schemas import DuplicateScanResult
from memory_core.services.duplicates import detect_duplicates

router = APIRouter(tags=["duplicates"])

DuplicateReader = Annotated[
    ClientDep,
    Depends(require_scopes("records:read", "entities:read")),
]


@router.get("/duplicates", response_model=DuplicateScanResult)
def duplicates(
    session: SessionDep,
    principal: DuplicateReader,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> DuplicateScanResult:
    return detect_duplicates(
        session,
        allow_restricted=principal.has_scope("restricted:read"),
        limit=limit,
    )
