from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, status

from memory_core.api.deps import ClientDep, RequestIdDep, SessionDep, require_scopes
from memory_core.schemas import TagCreate, TagRead
from memory_core.services import tags

router = APIRouter(prefix="/tags", tags=["tags"])

TagReader = Annotated[ClientDep, Depends(require_scopes("records:read"))]
TagWriter = Annotated[ClientDep, Depends(require_scopes("records:write"))]


@router.post("", response_model=TagRead, status_code=status.HTTP_201_CREATED)
def create_tag(
    payload: TagCreate,
    session: SessionDep,
    principal: TagWriter,
    request_id: RequestIdDep,
) -> TagRead:
    tag = tags.create_tag(session, principal, payload, request_id=request_id)
    session.commit()
    return TagRead.model_validate(tag)


@router.get("", response_model=list[TagRead])
def list_tags(
    session: SessionDep,
    _principal: TagReader,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[TagRead]:
    return [
        TagRead.model_validate(tag) for tag in tags.list_tags(session, limit=limit, offset=offset)
    ]
