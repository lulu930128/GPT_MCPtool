from __future__ import annotations

from typing import Any, Literal

from sqlalchemy import Select, select
from sqlalchemy.orm import Session

from memory_core.db_types import utc_now
from memory_core.errors import (
    AuthorizationError,
    NotFoundError,
    OperationError,
    VersionConflictError,
    operation_error_from_record_schema,
    operation_error_from_temporal,
)
from memory_core.models import Entity, Record, RecordEntity, RecordLink, RecordTag, Revision, Tag
from memory_core.record_schemas import (
    RecordReferenceField,
    RecordSchemaValidationIssue,
    get_record_schema_definition,
)
from memory_core.schemas import RecordCreate, RecordRead, RecordUpdate, RecordUpdatePatch
from memory_core.security import ClientPrincipal
from memory_core.services.audit import add_audit_event
from memory_core.services.record_schema_validation import (
    normalize_record_schema_create,
    normalize_record_schema_update,
    update_uses_registered_schema,
)
from memory_core.temporal import TemporalValidationIssue, validate_record_temporal_state


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
    payload = normalize_record_schema_create(
        session,
        payload,
        allow_restricted=principal.has_scope("restricted:read"),
    )
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
    session.flush()
    _sync_registered_record_links(
        session,
        principal,
        record,
        request_id=request_id,
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

    normalized_payload: RecordUpdatePatch = payload
    if update_uses_registered_schema(record, normalized_payload):
        normalized_payload, _resolved = normalize_record_schema_update(
            session,
            record,
            normalized_payload,
            allow_restricted=principal.has_scope("restricted:read"),
        )
    old_data = _snapshot(record)
    values = normalized_payload.model_dump(exclude_unset=True, mode="python")
    values.pop("expected_version", None)
    change_reason = values.pop("change_reason", None)
    temporal_fields_changed = bool(
        set(values) & {"occurred_start", "occurred_end", "date_precision", "timezone_name"}
    )
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
    if temporal_fields_changed:
        try:
            validate_record_temporal_state(
                occurred_start=record.occurred_start,
                occurred_end=record.occurred_end,
                date_precision=record.date_precision,
            )
        except TemporalValidationIssue as issue:
            raise operation_error_from_temporal(issue) from issue
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
    session.flush()
    _sync_registered_record_links(
        session,
        principal,
        record,
        request_id=request_id,
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
    target_revision_no: int | None = None,
    request_id: str | None,
) -> RecordLink:
    if subject_record_id == object_record_id:
        raise OperationError("A record cannot link to itself")
    subject = get_record(session, subject_record_id, allow_restricted=True)
    object_record = get_record(session, object_record_id, allow_restricted=True)
    _require_record_write(principal, subject)
    _require_record_write(principal, object_record)
    _validate_record_link_contract(
        session,
        subject,
        relation,
        object_record,
        target_revision_no=target_revision_no,
    )
    existing = session.scalar(
        select(RecordLink).where(
            RecordLink.subject_record_id == subject_record_id,
            RecordLink.relation == relation,
            RecordLink.object_record_id == object_record_id,
        )
    )
    if existing is not None:
        if existing.target_revision_no != target_revision_no or existing.removed_at is not None:
            previous_revision = existing.target_revision_no
            was_removed = existing.removed_at is not None
            existing.target_revision_no = target_revision_no
            existing.removed_at = None
            existing.updated_at = utc_now()
            add_audit_event(
                session,
                principal,
                action="record.link_update",
                outcome="success",
                request_id=request_id,
                target_type="record_link",
                target_id=existing.id,
                details={
                    "subject_record_id": subject_record_id,
                    "relation": relation,
                    "object_record_id": object_record_id,
                    "previous_target_revision_no": previous_revision,
                    "target_revision_no": target_revision_no,
                    "reactivated": was_removed,
                },
            )
            session.flush()
        return existing
    link = RecordLink(
        subject_record_id=subject_record_id,
        relation=relation,
        object_record_id=object_record_id,
        target_revision_no=target_revision_no,
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
            "target_revision_no": target_revision_no,
        },
    )
    session.flush()
    return link


def list_links(
    session: Session,
    principal: ClientPrincipal,
    record_id: str,
    *,
    direction: Literal["outbound", "inbound"],
    include_removed: bool = False,
) -> list[RecordLink]:
    allow_restricted = principal.has_scope("restricted:read")
    get_record(
        session,
        record_id,
        include_deleted=True,
        allow_restricted=allow_restricted,
    )
    if direction == "outbound":
        statement = select(RecordLink).where(RecordLink.subject_record_id == record_id)
    else:
        statement = select(RecordLink).where(RecordLink.object_record_id == record_id)
    if not include_removed:
        statement = statement.where(RecordLink.removed_at.is_(None))
    statement = statement.order_by(RecordLink.created_at.asc(), RecordLink.id.asc())
    links = list(session.scalars(statement))
    visible_links: list[RecordLink] = []
    for link in links:
        counterpart_id = (
            link.object_record_id if direction == "outbound" else link.subject_record_id
        )
        counterpart = session.scalar(
            _base_record_query(
                include_deleted=True,
                allow_restricted=allow_restricted,
            ).where(Record.id == counterpart_id)
        )
        if counterpart is not None:
            visible_links.append(link)
    return visible_links


def _validate_record_link_contract(
    session: Session,
    source: Record,
    relation: str,
    target: Record,
    *,
    target_revision_no: int | None,
) -> None:
    try:
        definition = get_record_schema_definition(
            source.schema_name,
            source.schema_version,
        )
    except RecordSchemaValidationIssue as issue:
        raise operation_error_from_record_schema(issue) from issue
    rule = (
        next(
            (field for field in definition.reference_fields if field.relation == relation),
            None,
        )
        if definition is not None
        else None
    )
    if rule is not None:
        if (
            target.schema_name != rule.target_schema_name
            or target.schema_version != rule.target_schema_version
        ):
            raise OperationError(
                "Record Link target does not match the registered relation schema.",
                code="link_schema_mismatch",
                field="target_ref",
                received_value=f"{target.schema_name}@{target.schema_version}",
                example=f"{rule.target_schema_name}@{rule.target_schema_version}",
            )
        requires_revision = rule.result_version_path is not None
        if requires_revision and target_revision_no is None:
            raise OperationError(
                "This Record Link relation requires a pinned target revision.",
                code="link_revision_required",
                field="target_revision_no",
            )
        if not requires_revision and target_revision_no is not None:
            raise OperationError(
                "This Record Link relation follows stable Record identity and must not pin.",
                code="link_revision_not_allowed",
                field="target_revision_no",
                received_value=target_revision_no,
            )
    if target_revision_no is None:
        return
    revision = session.scalar(
        select(Revision).where(
            Revision.target_type == "record",
            Revision.target_id == target.id,
            Revision.revision_no == target_revision_no,
        )
    )
    if revision is None:
        raise OperationError(
            "Pinned Record Link target revision does not exist.",
            code="invalid_link_target_revision",
            field="target_revision_no",
            received_value=target_revision_no,
            example=target.version,
        )


def _payload_path_value(payload: dict[str, Any], path: tuple[str, ...]) -> object:
    current: object = payload
    for part in path:
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def _record_ref_id(value: str, *, field: RecordReferenceField) -> str:
    result_type, separator, result_id = value.partition(":")
    if separator != ":" or result_type != "record" or not result_id:
        raise OperationError(
            "Registered Record reference must use record:<id>.",
            code="invalid_record_reference",
            field="payload." + ".".join(field.path),
            received_value=value,
            example="record:<id>",
        )
    return result_id


def _desired_registered_links(
    record: Record,
) -> tuple[set[str], dict[tuple[str, str], int | None]]:
    try:
        definition = get_record_schema_definition(
            record.schema_name,
            record.schema_version,
        )
    except RecordSchemaValidationIssue as issue:
        raise operation_error_from_record_schema(issue) from issue
    if definition is None:
        return set(), {}
    managed_relations = {field.relation for field in definition.reference_fields}
    desired: dict[tuple[str, str], int | None] = {}
    for field in definition.reference_fields:
        value = _payload_path_value(record.payload, field.path)
        values = value if field.collection and isinstance(value, list) else [value]
        referenced_values = [item for item in values if item is not None]
        if not referenced_values:
            continue
        target_revision_no: int | None = None
        if field.result_version_path is not None:
            raw_revision = _payload_path_value(
                record.payload,
                field.result_version_path,
            )
            if not isinstance(raw_revision, int):
                raise OperationError(
                    "Registered pinned reference is missing its target revision.",
                    code="link_revision_required",
                    field="payload." + ".".join(field.result_version_path),
                    received_value=raw_revision,
                )
            target_revision_no = raw_revision
        for item in referenced_values:
            if not isinstance(item, str):
                raise OperationError(
                    "Registered Record reference must be a string.",
                    code="invalid_record_reference",
                    field="payload." + ".".join(field.path),
                )
            desired[(field.relation, _record_ref_id(item, field=field))] = target_revision_no
    return managed_relations, desired


def _sync_registered_record_links(
    session: Session,
    principal: ClientPrincipal,
    record: Record,
    *,
    request_id: str | None,
) -> None:
    managed_relations, desired = _desired_registered_links(record)
    if not managed_relations:
        return
    existing = list(
        session.scalars(
            select(RecordLink).where(
                RecordLink.subject_record_id == record.id,
                RecordLink.relation.in_(managed_relations),
            )
        )
    )
    for (relation, target_id), target_revision_no in desired.items():
        create_link(
            session,
            principal,
            record.id,
            relation,
            target_id,
            target_revision_no=target_revision_no,
            request_id=request_id,
        )
    desired_keys = set(desired)
    for link in existing:
        if (link.relation, link.object_record_id) in desired_keys:
            continue
        if link.removed_at is not None:
            continue
        link.removed_at = utc_now()
        link.updated_at = link.removed_at
        add_audit_event(
            session,
            principal,
            action="record.link_remove",
            outcome="success",
            request_id=request_id,
            target_type="record_link",
            target_id=link.id,
            details={
                "subject_record_id": link.subject_record_id,
                "relation": link.relation,
                "object_record_id": link.object_record_id,
                "target_revision_no": link.target_revision_no,
            },
        )
    session.flush()


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
