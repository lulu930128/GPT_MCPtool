from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from memory_core.db_types import utc_now
from memory_core.errors import (
    AuthorizationError,
    NotFoundError,
    OperationError,
    VersionConflictError,
)
from memory_core.models import Entity, EntityRelation, Record, Revision
from memory_core.schemas import EntityCreate, EntityRead, EntityRelationCreate, EntityUpdate
from memory_core.security import ClientPrincipal
from memory_core.services.audit import add_audit_event


def _snapshot(entity: Entity) -> dict[str, Any]:
    return EntityRead.model_validate(entity).model_dump(mode="json")


def get_entity(
    session: Session,
    entity_id: str,
    *,
    include_deleted: bool = False,
    allow_restricted: bool = False,
) -> Entity:
    statement = select(Entity).where(Entity.id == entity_id)
    if not include_deleted:
        statement = statement.where(Entity.deleted_at.is_(None))
    if not allow_restricted:
        statement = statement.where(
            Entity.sensitivity != "restricted",
            Entity.handling_policy != "company_restricted",
        )
    entity = session.scalar(statement)
    if entity is None:
        raise NotFoundError("entity")
    return entity


def list_entities(
    session: Session,
    *,
    allow_restricted: bool,
    entity_type: str | None = None,
    include_deleted: bool = False,
    limit: int = 50,
    offset: int = 0,
) -> list[Entity]:
    statement = select(Entity)
    if not include_deleted:
        statement = statement.where(Entity.deleted_at.is_(None))
    if not allow_restricted:
        statement = statement.where(
            Entity.sensitivity != "restricted",
            Entity.handling_policy != "company_restricted",
        )
    if entity_type:
        statement = statement.where(Entity.entity_type == entity_type)
    statement = statement.order_by(Entity.updated_at.desc()).offset(offset).limit(limit)
    return list(session.scalars(statement))


def create_entity(
    session: Session,
    principal: ClientPrincipal,
    payload: EntityCreate,
    *,
    request_id: str | None,
    change_reason: str | None = None,
) -> Entity:
    _require_sensitivity_write(principal, payload.sensitivity.value)
    _require_handling_write(principal, payload.handling_policy.value)
    values = payload.model_dump(mode="python")
    values["sensitivity"] = payload.sensitivity.value
    values["handling_policy"] = payload.handling_policy.value
    entity = Entity(**values, created_by_client_id=principal.id)
    session.add(entity)
    session.flush()
    session.add(
        Revision(
            target_type="entity",
            target_id=entity.id,
            revision_no=1,
            old_data=None,
            new_data=_snapshot(entity),
            changed_by_client_id=principal.id,
            change_reason=change_reason or "created",
        )
    )
    add_audit_event(
        session,
        principal,
        action="entity.create",
        outcome="success",
        request_id=request_id,
        target_type="entity",
        target_id=entity.id,
        details={"entity_type": entity.entity_type},
    )
    session.flush()
    return entity


def update_entity(
    session: Session,
    principal: ClientPrincipal,
    entity_id: str,
    payload: EntityUpdate,
    *,
    request_id: str | None,
) -> Entity:
    entity = get_entity(session, entity_id, allow_restricted=True)
    _require_sensitivity_write(principal, entity.sensitivity)
    if entity.version != payload.expected_version:
        raise VersionConflictError(payload.expected_version, entity.version)
    old_data = _snapshot(entity)
    values = payload.model_dump(exclude_unset=True, mode="python")
    values.pop("expected_version", None)
    change_reason = values.pop("change_reason", None)
    for field_name in ("name", "payload"):
        if field_name in values and values[field_name] is None:
            raise OperationError(f"{field_name} cannot be null")
    if "sensitivity" in values and values["sensitivity"] is not None:
        sensitivity = values["sensitivity"].value
        _require_sensitivity_write(principal, sensitivity)
        values["sensitivity"] = sensitivity
    if "handling_policy" in values and values["handling_policy"] is not None:
        values["handling_policy"] = values["handling_policy"].value
    for field_name, value in values.items():
        setattr(entity, field_name, value)
    if entity.handling_policy == "company_restricted" and entity.sensitivity != "restricted":
        raise OperationError("company_restricted entities must use restricted sensitivity")
    _require_handling_write(principal, entity.handling_policy)
    entity.version += 1
    entity.updated_at = utc_now()
    session.flush()
    session.add(
        Revision(
            target_type="entity",
            target_id=entity.id,
            revision_no=entity.version,
            old_data=old_data,
            new_data=_snapshot(entity),
            changed_by_client_id=principal.id,
            change_reason=change_reason,
        )
    )
    add_audit_event(
        session,
        principal,
        action="entity.update",
        outcome="success",
        request_id=request_id,
        target_type="entity",
        target_id=entity.id,
        details={"changed_fields": sorted(values)},
    )
    session.flush()
    return entity


def archive_entity(
    session: Session,
    principal: ClientPrincipal,
    entity_id: str,
    *,
    expected_version: int,
    request_id: str | None,
    change_reason: str | None,
) -> Entity:
    entity = get_entity(session, entity_id, allow_restricted=True)
    _require_sensitivity_write(principal, entity.sensitivity)
    if entity.version != expected_version:
        raise VersionConflictError(expected_version, entity.version)
    old_data = _snapshot(entity)
    entity.deleted_at = utc_now()
    entity.version += 1
    entity.updated_at = utc_now()
    session.flush()
    session.add(
        Revision(
            target_type="entity",
            target_id=entity.id,
            revision_no=entity.version,
            old_data=old_data,
            new_data=_snapshot(entity),
            changed_by_client_id=principal.id,
            change_reason=change_reason or "archived",
        )
    )
    add_audit_event(
        session,
        principal,
        action="entity.archive",
        outcome="success",
        request_id=request_id,
        target_type="entity",
        target_id=entity.id,
    )
    session.flush()
    return entity


def create_relation(
    session: Session,
    principal: ClientPrincipal,
    payload: EntityRelationCreate,
    *,
    request_id: str | None,
) -> EntityRelation:
    subject = get_entity(session, payload.subject_entity_id, allow_restricted=True)
    object_entity = get_entity(session, payload.object_entity_id, allow_restricted=True)
    _require_sensitivity_write(principal, subject.sensitivity)
    _require_sensitivity_write(principal, object_entity.sensitivity)
    if payload.source_record_id:
        source = session.get(Record, payload.source_record_id)
        if source is None or source.deleted_at is not None:
            raise NotFoundError("source record")
    if payload.valid_from and payload.valid_to and payload.valid_to < payload.valid_from:
        raise OperationError("valid_to must not be earlier than valid_from")
    relation = EntityRelation(**payload.model_dump(mode="python"))
    session.add(relation)
    add_audit_event(
        session,
        principal,
        action="entity.relation_create",
        outcome="success",
        request_id=request_id,
        target_type="entity_relation",
        details={
            "subject_entity_id": payload.subject_entity_id,
            "predicate": payload.predicate,
            "object_entity_id": payload.object_entity_id,
        },
    )
    session.flush()
    return relation


def _require_sensitivity_write(principal: ClientPrincipal, sensitivity: str) -> None:
    if sensitivity == "restricted" and not principal.has_scope("restricted:write"):
        raise AuthorizationError("restricted:write scope is required")


def _require_handling_write(principal: ClientPrincipal, handling_policy: str) -> None:
    if handling_policy == "company_restricted" and not principal.has_scope("restricted:write"):
        raise AuthorizationError("restricted:write scope is required")
