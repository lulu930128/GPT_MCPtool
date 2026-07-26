from __future__ import annotations

from typing import Any

from sqlalchemy import Select, select
from sqlalchemy.orm import Session

from memory_core.db_types import utc_now
from memory_core.errors import (
    AuthorizationError,
    NotFoundError,
    OperationError,
    VersionConflictError,
)
from memory_core.models import Entity, Record, RecordEntity, RecordLink, RecordTag, Revision, Tag
from memory_core.schemas import RecordCreate, RecordRead, RecordUpdate
from memory_core.security import ClientPrincipal
from memory_core.services.audit import add_audit_event


def _snapshot(record: Record) -> dict[str, Any]:
    return RecordRead.model_validate(record).model_dump(mode="json")


def _base_record_query(*, include_deleted: bool, allow_restricted: bool) -> Select[tuple[Record]]:
    statement = select(Record)
    if not include_deleted:
        statement = statement.where(Record.deleted_at.is_(None))
    if not allow_restricted:
        statement = statement.where(
            Record.sensitivity != "restricted",
            Record.handling_policy != "company_restricted",
        )
    return statement


def get_record(
    session: Session,
    record_id: str,
    *,
    include_deleted: bool = False,
    allow_restricted: bool = False,
) -> Record:
    statement = _base_record_query(
        include_deleted=include_deleted,
        allow_restricted=allow_restricted,
    ).where(Record.id == record_id)
    record = session.scalar(statement)
    if record is None:
        raise NotFoundError("record")
    return record


def list_records(
    session: Session,
    *,
    allow_restricted: bool,
    kind: str | None = None,
    domain: str | None = None,
    sensitivity: str | None = None,
    include_deleted: bool = False,
    limit: int = 50,
    offset: int = 0,
) -> list[Record]:
    statement = _base_record_query(
        include_deleted=include_deleted,
        allow_restricted=allow_restricted,
    )
    if kind:
        statement = statement.where(Record.kind == kind)
    if domain:
        statement = statement.where(Record.domain == domain)
    if sensitivity:
        statement = statement.where(Record.sensitivity == sensitivity)
    statement = statement.order_by(Record.updated_at.desc()).offset(offset).limit(limit)
    return list(session.scalars(statement))


def create_record(
    session: Session,
    principal: ClientPrincipal,
    payload: RecordCreate,
    *,
    request_id: str | None,
    change_reason: str | None = None,
) -> Record:
    _require_sensitivity_write(principal, payload.sensitivity.value)
    _require_handling_write(principal, payload.handling_policy.value)
    if payload.supersedes_id:
        get_record(
            session,
            payload.supersedes_id,
            include_deleted=True,
            allow_restricted=principal.has_scope("restricted:read"),
        )
    values = payload.model_dump(mode="python")
    values["kind"] = payload.kind.value
    values["date_precision"] = payload.date_precision.value
    values["sensitivity"] = payload.sensitivity.value
    values["handling_policy"] = payload.handling_policy.value
    record = Record(**values, created_by_client_id=principal.id)
    session.add(record)
    session.flush()
    session.add(
        Revision(
            target_type="record",
            target_id=record.id,
            revision_no=1,
            old_data=None,
            new_data=_snapshot(record),
            changed_by_client_id=principal.id,
            change_reason=change_reason or "created",
        )
    )
    add_audit_event(
        session,
        principal,
        action="record.create",
        outcome="success",
        request_id=request_id,
        target_type="record",
        target_id=record.id,
        details={"kind": record.kind, "domain": record.domain},
    )
    session.flush()
    return record


def update_record(
    session: Session,
    principal: ClientPrincipal,
    record_id: str,
    payload: RecordUpdate,
    *,
    request_id: str | None,
) -> Record:
    record = get_record(session, record_id, allow_restricted=True)
    _require_record_write(principal, record)
    if record.version != payload.expected_version:
        raise VersionConflictError(payload.expected_version, record.version)

    old_data = _snapshot(record)
    values = payload.model_dump(exclude_unset=True, mode="python")
    values.pop("expected_version", None)
    change_reason = values.pop("change_reason", None)
    for field_name in ("title", "importance", "schema_name", "schema_version", "payload"):
        if field_name in values and values[field_name] is None:
            raise OperationError(f"{field_name} cannot be null")
    if "sensitivity" in values and values["sensitivity"] is not None:
        sensitivity = values["sensitivity"].value
        _require_sensitivity_write(principal, sensitivity)
        values["sensitivity"] = sensitivity
    for enum_field in ("date_precision", "handling_policy"):
        if enum_field in values and values[enum_field] is not None:
            values[enum_field] = values[enum_field].value

    if "supersedes_id" in values and values["supersedes_id"] is not None:
        if values["supersedes_id"] == record.id:
            raise OperationError("A record cannot supersede itself")
        get_record(
            session,
            values["supersedes_id"],
            include_deleted=True,
            allow_restricted=principal.has_scope("restricted:read"),
        )

    for field_name, value in values.items():
        setattr(record, field_name, value)
    if record.handling_policy == "company_restricted" and record.sensitivity != "restricted":
        raise OperationError("company_restricted records must use restricted sensitivity")
    _require_handling_write(principal, record.handling_policy)
    if record.occurred_start and record.occurred_end:
        if record.occurred_end < record.occurred_start:
            raise OperationError("occurred_end must not be earlier than occurred_start")
    record.version += 1
    record.updated_at = utc_now()
    session.flush()
    session.add(
        Revision(
            target_type="record",
            target_id=record.id,
            revision_no=record.version,
            old_data=old_data,
            new_data=_snapshot(record),
            changed_by_client_id=principal.id,
            change_reason=change_reason,
        )
    )
    add_audit_event(
        session,
        principal,
        action="record.update",
        outcome="success",
        request_id=request_id,
        target_type="record",
        target_id=record.id,
        details={"changed_fields": sorted(values)},
    )
    session.flush()
    return record


def archive_record(
    session: Session,
    principal: ClientPrincipal,
    record_id: str,
    *,
    expected_version: int,
    request_id: str | None,
    change_reason: str | None,
) -> Record:
    record = get_record(session, record_id, allow_restricted=True)
    _require_record_write(principal, record)
    if record.version != expected_version:
        raise VersionConflictError(expected_version, record.version)
    old_data = _snapshot(record)
    record.deleted_at = utc_now()
    record.lifecycle_status = "archived"
    record.version += 1
    record.updated_at = utc_now()
    session.flush()
    session.add(
        Revision(
            target_type="record",
            target_id=record.id,
            revision_no=record.version,
            old_data=old_data,
            new_data=_snapshot(record),
            changed_by_client_id=principal.id,
            change_reason=change_reason or "archived",
        )
    )
    add_audit_event(
        session,
        principal,
        action="record.archive",
        outcome="success",
        request_id=request_id,
        target_type="record",
        target_id=record.id,
    )
    session.flush()
    return record


def link_entity(
    session: Session,
    principal: ClientPrincipal,
    record_id: str,
    entity_id: str,
    role: str,
    *,
    request_id: str | None,
) -> RecordEntity:
    record = get_record(session, record_id, allow_restricted=True)
    _require_record_write(principal, record)
    entity = session.get(Entity, entity_id)
    if entity is None or entity.deleted_at is not None:
        raise NotFoundError("entity")
    if entity.sensitivity == "restricted" and not principal.has_scope("restricted:read"):
        raise NotFoundError("entity")
    existing = session.get(RecordEntity, (record_id, entity_id, role))
    if existing:
        return existing
    link = RecordEntity(record_id=record_id, entity_id=entity_id, role=role)
    session.add(link)
    add_audit_event(
        session,
        principal,
        action="record.entity_link",
        outcome="success",
        request_id=request_id,
        target_type="record",
        target_id=record_id,
        details={"entity_id": entity_id, "role": role},
    )
    session.flush()
    return link


def create_link(
    session: Session,
    principal: ClientPrincipal,
    subject_record_id: str,
    relation: str,
    object_record_id: str,
    *,
    request_id: str | None,
) -> RecordLink:
    if subject_record_id == object_record_id:
        raise OperationError("A record cannot link to itself")
    subject = get_record(session, subject_record_id, allow_restricted=True)
    object_record = get_record(session, object_record_id, allow_restricted=True)
    _require_record_write(principal, subject)
    _require_record_write(principal, object_record)
    existing = session.scalar(
        select(RecordLink).where(
            RecordLink.subject_record_id == subject_record_id,
            RecordLink.relation == relation,
            RecordLink.object_record_id == object_record_id,
        )
    )
    if existing is not None:
        return existing
    link = RecordLink(
        subject_record_id=subject_record_id,
        relation=relation,
        object_record_id=object_record_id,
    )
    session.add(link)
    add_audit_event(
        session,
        principal,
        action="record.link_create",
        outcome="success",
        request_id=request_id,
        target_type="record_link",
        details={
            "subject_record_id": subject_record_id,
            "relation": relation,
            "object_record_id": object_record_id,
        },
    )
    session.flush()
    return link


def link_tag(
    session: Session,
    principal: ClientPrincipal,
    record_id: str,
    tag_id: str,
    *,
    request_id: str | None,
) -> RecordTag:
    record = get_record(session, record_id, allow_restricted=True)
    _require_record_write(principal, record)
    if session.get(Tag, tag_id) is None:
        raise NotFoundError("tag")
    existing = session.get(RecordTag, (record_id, tag_id))
    if existing:
        return existing
    link = RecordTag(record_id=record_id, tag_id=tag_id)
    session.add(link)
    add_audit_event(
        session,
        principal,
        action="record.tag_link",
        outcome="success",
        request_id=request_id,
        target_type="record",
        target_id=record_id,
        details={"tag_id": tag_id},
    )
    session.flush()
    return link


def _require_sensitivity_write(principal: ClientPrincipal, sensitivity: str) -> None:
    if sensitivity == "restricted" and not principal.has_scope("restricted:write"):
        raise AuthorizationError("restricted:write scope is required")


def _require_handling_write(principal: ClientPrincipal, handling_policy: str) -> None:
    if handling_policy == "company_restricted" and not principal.has_scope("restricted:write"):
        raise AuthorizationError("restricted:write scope is required")


def _require_record_write(principal: ClientPrincipal, record: Record) -> None:
    _require_sensitivity_write(principal, record.sensitivity)
