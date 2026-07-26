from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status

from memory_core.api.deps import ClientDep, RequestIdDep, SessionDep, require_scopes
from memory_core.schemas import (
    RecordCreate,
    RecordEntityLinkCreate,
    RecordRead,
    RecordTagLinkCreate,
    RecordUpdate,
)
from memory_core.services import records

router = APIRouter(prefix="/records", tags=["records"])

RecordReader = Annotated[ClientDep, Depends(require_scopes("records:read"))]
RecordWriter = Annotated[ClientDep, Depends(require_scopes("records:write"))]


@router.post("", response_model=RecordRead, status_code=status.HTTP_201_CREATED)
def create_record(
    payload: RecordCreate,
    session: SessionDep,
    principal: RecordWriter,
    request_id: RequestIdDep,
) -> RecordRead:
    record = records.create_record(
        session,
        principal,
        payload,
        request_id=request_id,
    )
    session.commit()
    return RecordRead.model_validate(record)


@router.get("", response_model=list[RecordRead])
def list_records(
    session: SessionDep,
    principal: RecordReader,
    kind: str | None = None,
    domain: str | None = None,
    sensitivity: str | None = None,
    include_deleted: bool = False,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[RecordRead]:
    items = records.list_records(
        session,
        allow_restricted=principal.has_scope("restricted:read"),
        kind=kind,
        domain=domain,
        sensitivity=sensitivity,
        include_deleted=include_deleted,
        limit=limit,
        offset=offset,
    )
    return [RecordRead.model_validate(item) for item in items]


@router.get("/{record_id}", response_model=RecordRead)
def get_record(
    record_id: str,
    session: SessionDep,
    principal: RecordReader,
    include_deleted: bool = False,
) -> RecordRead:
    record = records.get_record(
        session,
        record_id,
        include_deleted=include_deleted,
        allow_restricted=principal.has_scope("restricted:read"),
    )
    return RecordRead.model_validate(record)


@router.patch("/{record_id}", response_model=RecordRead)
def update_record(
    record_id: str,
    payload: RecordUpdate,
    session: SessionDep,
    principal: RecordWriter,
    request_id: RequestIdDep,
) -> RecordRead:
    record = records.update_record(
        session,
        principal,
        record_id,
        payload,
        request_id=request_id,
    )
    session.commit()
    return RecordRead.model_validate(record)


@router.delete("/{record_id}", response_model=RecordRead)
def archive_record(
    record_id: str,
    expected_version: Annotated[int, Query(ge=1)],
    session: SessionDep,
    principal: RecordWriter,
    request_id: RequestIdDep,
    reason: str | None = None,
) -> RecordRead:
    record = records.archive_record(
        session,
        principal,
        record_id,
        expected_version=expected_version,
        request_id=request_id,
        change_reason=reason,
    )
    session.commit()
    return RecordRead.model_validate(record)


@router.post("/{record_id}/entities", status_code=status.HTTP_204_NO_CONTENT)
def link_entity(
    record_id: str,
    payload: RecordEntityLinkCreate,
    session: SessionDep,
    principal: RecordWriter,
    request_id: RequestIdDep,
) -> Response:
    records.link_entity(
        session,
        principal,
        record_id,
        payload.entity_id,
        payload.role,
        request_id=request_id,
    )
    session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{record_id}/tags", status_code=status.HTTP_204_NO_CONTENT)
def link_tag(
    record_id: str,
    payload: RecordTagLinkCreate,
    session: SessionDep,
    principal: RecordWriter,
    request_id: RequestIdDep,
) -> Response:
    records.link_tag(
        session,
        principal,
        record_id,
        payload.tag_id,
        request_id=request_id,
    )
    session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
