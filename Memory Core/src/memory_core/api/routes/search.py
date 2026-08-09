from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status

from memory_core.api.deps import ClientDep, SessionDep, require_scopes
from memory_core.schemas import SearchResult
from memory_core.services.search import SearchFilters, search_memory

router = APIRouter(tags=["search"])

SearchReader = Annotated[ClientDep, Depends(require_scopes("records:read", "entities:read"))]


@router.get("/search", response_model=list[SearchResult])
def search(
    q: Annotated[str, Query(min_length=1, max_length=500)],
    session: SessionDep,
    principal: SearchReader,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
    result_type: Literal["record", "entity"] | None = None,
    domain: Annotated[str | None, Query(min_length=1, max_length=80)] = None,
    schema_name: Annotated[str | None, Query(min_length=1, max_length=100)] = None,
    kind: Annotated[str | None, Query(min_length=1, max_length=60)] = None,
    sensitivity: Literal["public", "personal", "sensitive", "restricted"] | None = None,
    updated_after: datetime | None = None,
    updated_before: datetime | None = None,
) -> list[SearchResult]:
    for field_name, value in (
        ("updated_after", updated_after),
        ("updated_before", updated_before),
    ):
        if value is not None and value.utcoffset() is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=f"{field_name} must include a UTC offset",
            )
    if updated_after is not None and updated_before is not None and updated_before < updated_after:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="updated_before must not be earlier than updated_after",
        )
    return search_memory(
        session,
        q,
        allow_restricted=principal.has_scope("restricted:read"),
        limit=limit,
        filters=SearchFilters(
            result_type=result_type,
            domain=domain,
            schema_name=schema_name,
            kind=kind,
            sensitivity=sensitivity,
            updated_after=updated_after,
            updated_before=updated_before,
        ),
    )
