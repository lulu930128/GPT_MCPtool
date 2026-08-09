from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from memory_core.api.deps import ClientDep, SessionDep, require_scopes
from memory_core.schemas import (
    CollectionDetailRead,
    CollectionMemberRead,
    CollectionRead,
    RecordRead,
)
from memory_core.services import collections

router = APIRouter(prefix="/collections", tags=["collections"])
MemoryReader = Annotated[ClientDep, Depends(require_scopes("records:read"))]


@router.get("", response_model=list[CollectionRead])
def list_memory_collections(
    session: SessionDep,
    principal: MemoryReader,
    domain: str | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[CollectionRead]:
    items = collections.list_collections(
        session,
        allow_restricted=principal.has_scope("restricted:read"),
        domain=domain,
        limit=limit,
        offset=offset,
    )
    return [
        CollectionRead(
            id=collection.id,
            key=collection.key,
            name=collection.name,
            description=collection.description,
            domain=collection.domain,
            lifecycle_status=collection.lifecycle_status,
            version=collection.version,
            member_count=member_count,
            created_at=collection.created_at,
            updated_at=collection.updated_at,
        )
        for collection, member_count in items
    ]


@router.get("/{collection_key}", response_model=CollectionDetailRead)
def get_memory_collection(
    collection_key: str,
    session: SessionDep,
    principal: MemoryReader,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> CollectionDetailRead:
    collection, member_count, items = collections.list_collection_records(
        session,
        collection_key,
        allow_restricted=principal.has_scope("restricted:read"),
        limit=limit,
        offset=offset,
    )
    members = [
        CollectionMemberRead(
            record=RecordRead.model_validate(record),
            position=member.position,
            created_at=member.created_at,
            updated_at=member.updated_at,
        )
        for member, record in items
    ]
    return CollectionDetailRead.model_validate(
        {
            **CollectionRead.model_validate(
                {
                    "id": collection.id,
                    "key": collection.key,
                    "name": collection.name,
                    "description": collection.description,
                    "domain": collection.domain,
                    "lifecycle_status": collection.lifecycle_status,
                    "version": collection.version,
                    "member_count": member_count,
                    "created_at": collection.created_at,
                    "updated_at": collection.updated_at,
                }
            ).model_dump(),
            "members": members,
        }
    )
