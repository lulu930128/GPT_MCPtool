from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, status

from memory_core.api.deps import ClientDep, RequestIdDep, SessionDep, require_scopes
from memory_core.schemas import (
    EntityCreate,
    EntityRead,
    EntityRelationCreate,
    EntityRelationRead,
    EntityUpdate,
)
from memory_core.services import entities

router = APIRouter(tags=["entities"])

EntityReader = Annotated[ClientDep, Depends(require_scopes("entities:read"))]
EntityWriter = Annotated[ClientDep, Depends(require_scopes("entities:write"))]


@router.post("/entities", response_model=EntityRead, status_code=status.HTTP_201_CREATED)
def create_entity(
    payload: EntityCreate,
    session: SessionDep,
    principal: EntityWriter,
    request_id: RequestIdDep,
) -> EntityRead:
    entity = entities.create_entity(session, principal, payload, request_id=request_id)
    session.commit()
    return EntityRead.model_validate(entity)


@router.get("/entities", response_model=list[EntityRead])
def list_entities(
    session: SessionDep,
    principal: EntityReader,
    entity_type: str | None = None,
    include_deleted: bool = False,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[EntityRead]:
    items = entities.list_entities(
        session,
        allow_restricted=principal.has_scope("restricted:read"),
        entity_type=entity_type,
        include_deleted=include_deleted,
        limit=limit,
        offset=offset,
    )
    return [EntityRead.model_validate(item) for item in items]


@router.get("/entities/{entity_id}", response_model=EntityRead)
def get_entity(
    entity_id: str,
    session: SessionDep,
    principal: EntityReader,
    include_deleted: bool = False,
) -> EntityRead:
    entity = entities.get_entity(
        session,
        entity_id,
        include_deleted=include_deleted,
        allow_restricted=principal.has_scope("restricted:read"),
    )
    return EntityRead.model_validate(entity)


@router.patch("/entities/{entity_id}", response_model=EntityRead)
def update_entity(
    entity_id: str,
    payload: EntityUpdate,
    session: SessionDep,
    principal: EntityWriter,
    request_id: RequestIdDep,
) -> EntityRead:
    entity = entities.update_entity(
        session,
        principal,
        entity_id,
        payload,
        request_id=request_id,
    )
    session.commit()
    return EntityRead.model_validate(entity)


@router.delete("/entities/{entity_id}", response_model=EntityRead)
def archive_entity(
    entity_id: str,
    expected_version: Annotated[int, Query(ge=1)],
    session: SessionDep,
    principal: EntityWriter,
    request_id: RequestIdDep,
    reason: str | None = None,
) -> EntityRead:
    entity = entities.archive_entity(
        session,
        principal,
        entity_id,
        expected_version=expected_version,
        request_id=request_id,
        change_reason=reason,
    )
    session.commit()
    return EntityRead.model_validate(entity)


@router.post(
    "/relations/entities",
    response_model=EntityRelationRead,
    status_code=status.HTTP_201_CREATED,
)
def create_entity_relation(
    payload: EntityRelationCreate,
    session: SessionDep,
    principal: EntityWriter,
    request_id: RequestIdDep,
) -> EntityRelationRead:
    relation = entities.create_relation(session, principal, payload, request_id=request_id)
    session.commit()
    return EntityRelationRead.model_validate(relation)
