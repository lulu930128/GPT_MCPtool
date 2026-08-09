from __future__ import annotations

import hashlib
import heapq
import json
import re
from copy import deepcopy
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from memory_core.db_types import utc_now
from memory_core.errors import (
    CandidateConflictError,
    OperationError,
    VersionConflictError,
    operation_error_from_record_schema,
    operation_error_from_validation,
)
from memory_core.models import (
    CandidateOperation,
    CandidateResult,
    MemoryCandidate,
    Record,
)
from memory_core.record_schemas import (
    RecordReferenceField,
    RecordSchemaDefinition,
    RecordSchemaValidationIssue,
    get_record_schema_definition,
)
from memory_core.schemas import (
    CandidateRecordCreate,
    CandidateRecordUpdatePatch,
    ChangeSetOperationProposal,
    ChangeSetProposal,
    RecordCreate,
    RecordUpdate,
)
from memory_core.security import ClientPrincipal
from memory_core.services import records
from memory_core.services.audit import add_audit_event
from memory_core.services.record_schema_validation import (
    normalize_record_schema_create,
    normalize_record_schema_update,
    update_uses_registered_schema,
)

CHANGE_SET_REVIEW_DIGEST_VERSION = 2
LOCAL_REFERENCE_PREFIX = "op:"
LOCAL_REFERENCE_PATTERN = re.compile(r"^op:([a-z][a-z0-9_-]{0,63})$")
PathPart = str | int
MISSING = object()


@dataclass(frozen=True, slots=True)
class OperationSchema:
    name: str
    version: int
    definition: RecordSchemaDefinition | None


@dataclass(frozen=True, slots=True)
class LocalReferenceUse:
    source_op_id: str
    target_op_id: str
    path: tuple[PathPart, ...]
    field: RecordReferenceField


def _canonical_hash(payload: object) -> str:
    canonical = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _digest_envelope(envelope: dict[str, object]) -> str:
    return f"sha256:v{CHANGE_SET_REVIEW_DIGEST_VERSION}:" + _canonical_hash(envelope)


def _operation_envelope(operation: CandidateOperation) -> dict[str, object]:
    return {
        "op_id": operation.op_id,
        "change": operation.change_data,
    }


def stored_approval_envelope(candidate: MemoryCandidate) -> dict[str, object]:
    return {
        "version": candidate.review_digest_version,
        "candidate_kind": "change_set",
        "summary": candidate.summary,
        "atomic": True,
        "operations": [
            _operation_envelope(operation)
            for operation in sorted(candidate.operations, key=lambda item: item.position)
        ],
        "source_type": candidate.source_type,
        "source_reference": candidate.source_reference,
        "confidence": candidate.confidence,
        "risk_flags": sorted(candidate.risk_flags),
    }


def stored_review_digest(candidate: MemoryCandidate) -> str:
    return _digest_envelope(stored_approval_envelope(candidate))


def _proposal_envelope(
    proposal: ChangeSetProposal,
    operations: list[dict[str, object]],
) -> dict[str, object]:
    return {
        "version": CHANGE_SET_REVIEW_DIGEST_VERSION,
        "candidate_kind": "change_set",
        "summary": proposal.summary,
        "atomic": True,
        "operations": operations,
        "source_type": proposal.source_type,
        "source_reference": proposal.source_reference,
        "confidence": proposal.confidence,
        "risk_flags": sorted(proposal.risk_flags),
    }


def _proposal_content_hash(
    proposal: ChangeSetProposal,
    operations: list[dict[str, object]],
) -> str:
    return _canonical_hash(
        {
            **_proposal_envelope(proposal, operations),
            "idempotency_key": proposal.idempotency_key,
        }
    )


def _field_path(op_id: str, path: tuple[PathPart, ...]) -> str:
    rendered = f"operations.{op_id}.change.content"
    for part in path:
        if isinstance(part, int):
            rendered += f"[{part}]"
        else:
            rendered += f".{part}"
    return rendered


def _get_path(root: object, path: tuple[PathPart, ...]) -> object:
    current = root
    for part in path:
        if isinstance(part, int):
            if not isinstance(current, list) or part >= len(current):
                return MISSING
            current = current[part]
        else:
            if not isinstance(current, dict) or part not in current:
                return MISSING
            current = current[part]
    return current


def _set_path(root: object, path: tuple[PathPart, ...], value: object) -> None:
    parent = _get_path(root, path[:-1])
    if parent is MISSING:
        raise RuntimeError(f"Cannot set missing ChangeSet path: {path}")
    final = path[-1]
    if isinstance(final, int):
        if not isinstance(parent, list):
            raise RuntimeError(f"Expected list at ChangeSet path: {path}")
        parent[final] = value
    else:
        if not isinstance(parent, dict):
            raise RuntimeError(f"Expected object at ChangeSet path: {path}")
        parent[final] = value


def _delete_path(root: object, path: tuple[PathPart, ...]) -> None:
    parent = _get_path(root, path[:-1])
    if not isinstance(parent, dict):
        return
    final = path[-1]
    if isinstance(final, str):
        parent.pop(final, None)


def _walk_strings(
    value: object,
    *,
    path: tuple[PathPart, ...] = (),
) -> list[tuple[tuple[PathPart, ...], str]]:
    found: list[tuple[tuple[PathPart, ...], str]] = []
    if isinstance(value, str):
        found.append((path, value))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            found.extend(_walk_strings(item, path=(*path, index)))
    elif isinstance(value, dict):
        for key, item in value.items():
            found.extend(_walk_strings(item, path=(*path, str(key))))
    return found


def _reference_field_for_path(
    definition: RecordSchemaDefinition | None,
    path: tuple[PathPart, ...],
) -> RecordReferenceField | None:
    if definition is None or not path or path[0] != "payload":
        return None
    payload_path = path[1:]
    for field in definition.reference_fields:
        expected: tuple[PathPart, ...] = field.path
        if field.collection:
            if (
                len(payload_path) == len(expected) + 1
                and payload_path[: len(expected)] == expected
                and isinstance(payload_path[-1], int)
            ):
                return field
        elif payload_path == expected:
            return field
    return None


def _normalize_reference_lists(
    content: dict[str, Any],
    definition: RecordSchemaDefinition | None,
) -> None:
    if definition is None:
        return
    for field in definition.reference_fields:
        if not field.collection:
            continue
        path: tuple[PathPart, ...] = ("payload", *field.path)
        value = _get_path(content, path)
        if not isinstance(value, list):
            continue
        normalized: list[object] = []
        seen: set[str] = set()
        for item in value:
            if not isinstance(item, str):
                normalized.append(item)
                continue
            stripped = item.strip()
            if not stripped or stripped in seen:
                continue
            normalized.append(stripped)
            seen.add(stripped)
        _set_path(content, path, normalized)


def _extract_local_references(
    *,
    op_id: str,
    content: dict[str, Any],
    definition: RecordSchemaDefinition | None,
) -> list[LocalReferenceUse]:
    references: list[LocalReferenceUse] = []
    for path, value in _walk_strings(content):
        if not value.startswith(LOCAL_REFERENCE_PREFIX):
            continue
        match = LOCAL_REFERENCE_PATTERN.fullmatch(value)
        if match is None:
            raise OperationError(
                "Local references must use op:<op_id> with a valid operation id.",
                code="unresolved_local_reference",
                field=_field_path(op_id, path),
                received_value=value,
                example="op:recipe",
            )
        field = _reference_field_for_path(definition, path)
        if field is None:
            raise OperationError(
                "Local references are only allowed in registered Record reference fields.",
                code="local_reference_not_allowed",
                field=_field_path(op_id, path),
                received_value=value,
            )
        version_path: tuple[PathPart, ...] | None = None
        if field.result_version_path is not None:
            version_path = ("payload", *field.result_version_path)
            supplied_version = _get_path(content, version_path)
            if supplied_version is not MISSING and supplied_version is not None:
                raise OperationError(
                    "A local reference controls its pinned result version; omit this field.",
                    code="local_reference_version_managed",
                    field=_field_path(op_id, version_path),
                    received_value=supplied_version,
                )
        references.append(
            LocalReferenceUse(
                source_op_id=op_id,
                target_op_id=match.group(1),
                path=path,
                field=field,
            )
        )
    return references


def _operation_schema(
    session: Session,
    principal: ClientPrincipal,
    operation: ChangeSetOperationProposal,
) -> OperationSchema:
    change = operation.change
    if change.change_type == "record_create":
        schema_name = str(change.content.get("schema_name") or "generic")
        raw_version = change.content.get("schema_version", 1)
        schema_version = raw_version if isinstance(raw_version, int) else 1
    else:
        current = records.get_record(
            session,
            change.target_id,
            allow_restricted=principal.has_scope("restricted:read"),
        )
        if current.version != change.base_version:
            raise VersionConflictError(change.base_version, current.version)
        schema_name = current.schema_name
        schema_version = current.schema_version
    try:
        definition = get_record_schema_definition(schema_name, schema_version)
    except RecordSchemaValidationIssue as issue:
        raise operation_error_from_record_schema(issue) from issue
    return OperationSchema(
        name=schema_name,
        version=schema_version,
        definition=definition,
    )


def _sanitize_local_references(
    content: dict[str, Any],
    references: list[LocalReferenceUse],
) -> tuple[dict[str, Any], dict[str, str]]:
    sanitized = deepcopy(content)
    placeholders: dict[str, str] = {}
    for index, reference in enumerate(references):
        placeholder = f"record:local-{reference.target_op_id}-{index}"
        placeholders[placeholder] = f"op:{reference.target_op_id}"
        _set_path(sanitized, reference.path, placeholder)
        if reference.field.result_version_path is not None:
            version_path: tuple[PathPart, ...] = (
                "payload",
                *reference.field.result_version_path,
            )
            payload = _get_path(sanitized, ("payload",))
            if not isinstance(payload, dict):
                raise OperationError(
                    "Registered Record schema payload must be an object.",
                    code="invalid_record_schema",
                )
            payload[str(version_path[-1])] = 1
    return sanitized, placeholders


def _restore_local_references(
    value: object,
    placeholders: dict[str, str],
) -> object:
    if isinstance(value, str):
        return placeholders.get(value, value)
    if isinstance(value, list):
        return [_restore_local_references(item, placeholders) for item in value]
    if isinstance(value, dict):
        return {key: _restore_local_references(item, placeholders) for key, item in value.items()}
    return value


def _validation_error(exc: ValidationError, *, op_id: str) -> OperationError:
    error = operation_error_from_validation(
        exc.errors(include_url=False),
        fallback_message=f"ChangeSet operation {op_id} failed validation: {exc}",
    )
    if error.field is not None:
        error.field = f"operations.{op_id}.change.content.{error.field}"
    return error


def _normalize_operation(
    session: Session,
    principal: ClientPrincipal,
    operation: ChangeSetOperationProposal,
    schema: OperationSchema,
    references: list[LocalReferenceUse],
) -> dict[str, object]:
    content = deepcopy(operation.change.content)
    _normalize_reference_lists(content, schema.definition)
    references = _extract_local_references(
        op_id=operation.op_id,
        content=content,
        definition=schema.definition,
    )
    sanitized, placeholders = _sanitize_local_references(content, references)
    try:
        if operation.change.change_type == "record_create":
            candidate_content = CandidateRecordCreate.model_validate(sanitized)
            formal = RecordCreate.model_validate(
                candidate_content.model_dump(mode="python", exclude={"entity_links"})
            )
            normalized = normalize_record_schema_create(
                session,
                formal,
                allow_restricted=principal.has_scope("restricted:read"),
                validate_references=not references,
            )
            normalized_content = candidate_content.model_copy(
                update={"payload": normalized.payload}
            ).model_dump(mode="json")
            change_data: dict[str, object] = {
                "change_type": "record_create",
                "content": normalized_content,
            }
        else:
            current = records.get_record(
                session,
                operation.change.target_id,
                allow_restricted=principal.has_scope("restricted:read"),
            )
            if current.version != operation.change.base_version:
                raise VersionConflictError(operation.change.base_version, current.version)
            patch = CandidateRecordUpdatePatch.model_validate(sanitized)
            normalized_patch = patch
            if update_uses_registered_schema(current, patch):
                normalized_formal_patch, _resolved = normalize_record_schema_update(
                    session,
                    current,
                    patch,
                    allow_restricted=principal.has_scope("restricted:read"),
                    validate_references=not references,
                )
                if "payload" in patch.model_fields_set:
                    normalized_patch = patch.model_copy(
                        update={"payload": normalized_formal_patch.payload}
                    )
            change_data = {
                "change_type": "record_update",
                "target_id": operation.change.target_id,
                "base_version": operation.change.base_version,
                "content": normalized_patch.model_dump(
                    mode="json",
                    exclude_unset=True,
                ),
            }
    except ValidationError as exc:
        raise _validation_error(exc, op_id=operation.op_id) from exc

    restored = _restore_local_references(change_data, placeholders)
    if not isinstance(restored, dict):  # pragma: no cover - change_data is an object
        raise TypeError("Normalized ChangeSet operation must be an object")
    restored_content = restored.get("content")
    if isinstance(restored_content, dict):
        for reference in references:
            if reference.field.result_version_path is None:
                continue
            _delete_path(
                restored_content,
                ("payload", *reference.field.result_version_path),
            )
    return restored


def _operation_target_schemas(
    session: Session,
    principal: ClientPrincipal,
    operations: list[ChangeSetOperationProposal],
) -> dict[str, OperationSchema]:
    return {
        operation.op_id: _operation_schema(session, principal, operation)
        for operation in operations
    }


def _validate_operation_targets(operations: list[ChangeSetOperationProposal]) -> None:
    update_targets: dict[str, str] = {}
    for operation in operations:
        change = operation.change
        if change.change_type != "record_update":
            continue
        previous = update_targets.get(change.target_id)
        if previous is not None:
            raise OperationError(
                "A ChangeSet may update the same Record only once.",
                code="duplicate_operation_target",
                field=f"operations.{operation.op_id}.change.target_id",
                received_value=change.target_id,
                example=previous,
            )
        update_targets[change.target_id] = operation.op_id


def _validate_graph(
    operations: list[ChangeSetOperationProposal],
    schemas: dict[str, OperationSchema],
    references: list[LocalReferenceUse],
) -> list[str]:
    positions = {operation.op_id: index for index, operation in enumerate(operations)}
    dependencies: dict[str, set[str]] = {operation.op_id: set() for operation in operations}
    dependents: dict[str, set[str]] = {operation.op_id: set() for operation in operations}
    for reference in references:
        if reference.target_op_id not in positions:
            raise OperationError(
                f"Local reference target {reference.target_op_id!r} does not exist.",
                code="unresolved_local_reference",
                field=_field_path(reference.source_op_id, reference.path),
                received_value=f"op:{reference.target_op_id}",
            )
        target_schema = schemas[reference.target_op_id]
        if (
            target_schema.name != reference.field.target_schema_name
            or target_schema.version != reference.field.target_schema_version
        ):
            raise OperationError(
                "The referenced operation does not produce the required Record schema.",
                code="link_schema_mismatch",
                field=_field_path(reference.source_op_id, reference.path),
                received_value=(f"{target_schema.name}@{target_schema.version}"),
                example=(
                    f"{reference.field.target_schema_name}@{reference.field.target_schema_version}"
                ),
            )
        dependencies[reference.source_op_id].add(reference.target_op_id)
        dependents[reference.target_op_id].add(reference.source_op_id)

    ready: list[tuple[int, str]] = [
        (positions[op_id], op_id)
        for op_id, op_dependencies in dependencies.items()
        if not op_dependencies
    ]
    heapq.heapify(ready)
    ordered: list[str] = []
    while ready:
        _position, op_id = heapq.heappop(ready)
        ordered.append(op_id)
        for dependent in sorted(dependents[op_id], key=positions.__getitem__):
            dependencies[dependent].discard(op_id)
            if not dependencies[dependent]:
                heapq.heappush(ready, (positions[dependent], dependent))
    if len(ordered) != len(operations):
        unresolved = [op_id for op_id, op_dependencies in dependencies.items() if op_dependencies]
        raise OperationError(
            "Local references form a cyclic dependency.",
            code="cyclic_dependency",
            field="operations",
            received_value=",".join(sorted(unresolved)),
        )
    return ordered


def _normalized_operations(
    session: Session,
    principal: ClientPrincipal,
    proposal: ChangeSetProposal,
) -> list[dict[str, object]]:
    op_ids = [operation.op_id for operation in proposal.operations]
    if len(op_ids) != len(set(op_ids)):
        duplicate = next(op_id for op_id in op_ids if op_ids.count(op_id) > 1)
        raise OperationError(
            f"Operation id {duplicate!r} is duplicated.",
            code="duplicate_operation_id",
            field="operations",
            received_value=duplicate,
        )
    _validate_operation_targets(proposal.operations)
    schemas = _operation_target_schemas(session, principal, proposal.operations)

    normalized: list[dict[str, object]] = []
    all_references: list[LocalReferenceUse] = []
    for operation in proposal.operations:
        content = deepcopy(operation.change.content)
        _normalize_reference_lists(content, schemas[operation.op_id].definition)
        references = _extract_local_references(
            op_id=operation.op_id,
            content=content,
            definition=schemas[operation.op_id].definition,
        )
        all_references.extend(references)
        normalized_change = _normalize_operation(
            session,
            principal,
            operation,
            schemas[operation.op_id],
            references,
        )
        normalized.append(
            {
                "op_id": operation.op_id,
                "change": normalized_change,
            }
        )
    _validate_graph(proposal.operations, schemas, all_references)
    return normalized


def create_change_set(
    session: Session,
    principal: ClientPrincipal,
    proposal: ChangeSetProposal,
    *,
    request_id: str | None,
    candidate_ttl_seconds: int,
) -> MemoryCandidate:
    normalized_operations = _normalized_operations(session, principal, proposal)
    content_hash = _proposal_content_hash(proposal, normalized_operations)
    existing = session.scalar(
        select(MemoryCandidate).where(
            MemoryCandidate.source_client_id == principal.id,
            MemoryCandidate.idempotency_key == proposal.idempotency_key,
        )
    )
    if existing is not None:
        if existing.content_hash != content_hash:
            raise CandidateConflictError(
                "The idempotency key was already used for different candidate content"
            )
        return existing

    envelope = _proposal_envelope(proposal, normalized_operations)
    candidate = MemoryCandidate(
        candidate_kind="change_set",
        summary=proposal.summary,
        operation=None,
        target_type=None,
        target_id=None,
        base_version=None,
        proposed_content={},
        source_type=proposal.source_type,
        source_reference=proposal.source_reference,
        source_client_id=principal.id,
        idempotency_key=proposal.idempotency_key,
        content_hash=content_hash,
        review_digest=_digest_envelope(envelope),
        review_digest_version=CHANGE_SET_REVIEW_DIGEST_VERSION,
        confidence=proposal.confidence,
        validation_result={
            "valid": True,
            "atomic": True,
            "operation_count": len(normalized_operations),
        },
        risk_flags=proposal.risk_flags,
        status="pending",
        expires_at=utc_now() + timedelta(seconds=candidate_ttl_seconds),
    )
    for position, operation in enumerate(normalized_operations):
        change = operation["change"]
        if not isinstance(change, dict):  # pragma: no cover - built above
            raise TypeError("ChangeSet operation change must be an object")
        candidate.operations.append(
            CandidateOperation(
                op_id=str(operation["op_id"]),
                position=position,
                change_type=str(change["change_type"]),
                change_data=change,
            )
        )
    session.add(candidate)
    session.flush()
    add_audit_event(
        session,
        principal,
        action="candidate.change_set_create",
        outcome="success",
        request_id=request_id,
        target_type="candidate",
        target_id=candidate.id,
        details={
            "candidate_kind": "change_set",
            "operation_count": len(candidate.operations),
            "atomic": True,
        },
    )
    session.flush()
    return candidate


def _operation_proposals(candidate: MemoryCandidate) -> list[ChangeSetOperationProposal]:
    proposals: list[ChangeSetOperationProposal] = []
    for operation in sorted(candidate.operations, key=lambda item: item.position):
        proposals.append(
            ChangeSetOperationProposal.model_validate(
                {
                    "op_id": operation.op_id,
                    "change": operation.change_data,
                }
            )
        )
    return proposals


def _references_for_operations(
    session: Session,
    principal: ClientPrincipal,
    operations: list[ChangeSetOperationProposal],
) -> tuple[dict[str, OperationSchema], list[LocalReferenceUse], list[str]]:
    schemas = _operation_target_schemas(session, principal, operations)
    references: list[LocalReferenceUse] = []
    for operation in operations:
        references.extend(
            _extract_local_references(
                op_id=operation.op_id,
                content=operation.change.content,
                definition=schemas[operation.op_id].definition,
            )
        )
    order = _validate_graph(operations, schemas, references)
    return schemas, references, order


def _resolve_operation_change(
    operation: ChangeSetOperationProposal,
    references: list[LocalReferenceUse],
    results: dict[str, CandidateResult],
) -> dict[str, Any]:
    change_data = operation.change.model_dump(mode="python")
    content = change_data["content"]
    if not isinstance(content, dict):  # pragma: no cover - Pydantic enforces object
        raise TypeError("ChangeSet operation content must be an object")
    for reference in references:
        if reference.source_op_id != operation.op_id:
            continue
        target = results.get(reference.target_op_id)
        if target is None:
            raise OperationError(
                "A local reference dependency did not produce a result.",
                code="unresolved_local_reference",
                field=_field_path(operation.op_id, reference.path),
                received_value=f"op:{reference.target_op_id}",
            )
        if target.result_type != "record":
            raise OperationError(
                "A Record reference must resolve to a Record result.",
                code="link_schema_mismatch",
                field=_field_path(operation.op_id, reference.path),
                received_value=target.result_type,
                example="record",
            )
        _set_path(content, reference.path, target.result_ref)
        if reference.field.result_version_path is not None:
            version_path: tuple[PathPart, ...] = (
                "payload",
                *reference.field.result_version_path,
            )
            payload = _get_path(content, ("payload",))
            if not isinstance(payload, dict):
                raise OperationError(
                    "Registered Record schema payload must be an object.",
                    code="invalid_record_schema",
                )
            payload[str(version_path[-1])] = target.result_version
    return change_data


def _parse_stable_ref(value: str, expected_type: str) -> str:
    result_type, separator, result_id = value.partition(":")
    if separator != ":" or result_type != expected_type or not result_id:
        raise OperationError(
            f"Expected a stable {expected_type}:<id> reference.",
            field=f"{expected_type}_ref",
            received_value=value,
        )
    return result_id


def _apply_record_change(
    session: Session,
    principal: ClientPrincipal,
    *,
    candidate: MemoryCandidate,
    operation: CandidateOperation,
    change_data: dict[str, Any],
    request_id: str | None,
) -> Record:
    change_type = change_data.get("change_type")
    raw_content = change_data.get("content")
    if not isinstance(raw_content, dict):
        raise OperationError(
            "ChangeSet operation content must be an object.",
            field=f"operations.{operation.op_id}.change.content",
        )
    change_reason = f"candidate:{candidate.id}/op:{operation.op_id}"
    try:
        if change_type == "record_create":
            create_content = CandidateRecordCreate.model_validate(raw_content)
            result = records.create_record(
                session,
                principal,
                RecordCreate.model_validate(
                    create_content.model_dump(mode="python", exclude={"entity_links"})
                ),
                request_id=request_id,
                change_reason=change_reason,
            )
            for link in create_content.entity_links:
                records.link_entity(
                    session,
                    principal,
                    result.id,
                    _parse_stable_ref(link.entity_ref, "entity"),
                    link.role,
                    request_id=request_id,
                )
            return result
        if change_type == "record_update":
            target_id = change_data.get("target_id")
            base_version = change_data.get("base_version")
            if not isinstance(target_id, str) or not isinstance(base_version, int):
                raise OperationError(
                    "Record update requires target_id and base_version.",
                    field=f"operations.{operation.op_id}.change",
                )
            update_content = CandidateRecordUpdatePatch.model_validate(raw_content)
            formal_content = update_content.model_dump(
                mode="python",
                exclude_unset=True,
                exclude={"entity_links"},
            )
            if set(formal_content) - {"change_reason"}:
                result = records.update_record(
                    session,
                    principal,
                    target_id,
                    RecordUpdate.model_validate(
                        {
                            **formal_content,
                            "expected_version": base_version,
                        }
                    ),
                    request_id=request_id,
                )
            else:
                result = records.get_record(
                    session,
                    target_id,
                    allow_restricted=True,
                )
                if result.version != base_version:
                    raise VersionConflictError(base_version, result.version)
            for link in update_content.entity_links:
                records.link_entity(
                    session,
                    principal,
                    result.id,
                    _parse_stable_ref(link.entity_ref, "entity"),
                    link.role,
                    request_id=request_id,
                )
            return result
    except ValidationError as exc:
        raise _validation_error(exc, op_id=operation.op_id) from exc
    raise OperationError(
        f"Unsupported ChangeSet operation: {change_type}",
        code="invalid_operation",
        field=f"operations.{operation.op_id}.change.change_type",
        received_value=str(change_type),
    )


def execute_change_set(
    session: Session,
    principal: ClientPrincipal,
    candidate: MemoryCandidate,
    *,
    request_id: str | None,
) -> list[CandidateResult]:
    if candidate.candidate_kind != "change_set":
        raise OperationError("Candidate is not a ChangeSet.")
    if candidate.results:
        raise CandidateConflictError("ChangeSet already has persisted operation results")

    proposals = _operation_proposals(candidate)
    _schemas, references, execution_order = _references_for_operations(
        session,
        principal,
        proposals,
    )
    proposals_by_id = {proposal.op_id: proposal for proposal in proposals}
    operations_by_id = {operation.op_id: operation for operation in candidate.operations}
    results_by_op_id: dict[str, CandidateResult] = {}
    for op_id in execution_order:
        operation = operations_by_id[op_id]
        change_data = _resolve_operation_change(
            proposals_by_id[op_id],
            references,
            results_by_op_id,
        )
        record = _apply_record_change(
            session,
            principal,
            candidate=candidate,
            operation=operation,
            change_data=change_data,
            request_id=request_id,
        )
        result = CandidateResult(
            operation_id=operation.id,
            op_id=operation.op_id,
            position=operation.position,
            change_type=operation.change_type,
            result_type="record",
            result_id=record.id,
            result_version=record.version,
        )
        candidate.results.append(result)
        results_by_op_id[op_id] = result
        session.flush()
    candidate.results.sort(key=lambda item: item.position)
    return list(candidate.results)
