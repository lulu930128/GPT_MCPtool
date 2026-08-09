from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy.orm import Session

from memory_core.errors import OperationError
from memory_core.models import BatchItemOperation, CandidateItem
from memory_core.schemas import EntityCreate, EntityUpdate, RecordCreate, RecordUpdate
from memory_core.security import ClientPrincipal
from memory_core.services import collections, entities, records


@dataclass(frozen=True, slots=True)
class OperationExecutionResult:
    outcome: str
    result_kind: str
    result_ref: str | None
    result_locator: dict[str, Any]
    result_version: int | None


def _resolve_ref(value: object, local_results: dict[str, OperationExecutionResult]) -> str:
    if not isinstance(value, str):
        raise OperationError("Operation reference must be a string.")
    if not value.startswith("op:"):
        return value
    op_id = value.removeprefix("op:")
    result = local_results.get(op_id)
    if result is None or result.result_ref is None:
        raise OperationError(
            f"Operation reference {value} is unresolved.",
            code="unresolved_batch_operation_reference",
        )
    return result.result_ref


def _stable_id(
    value: object, prefix: str, local_results: dict[str, OperationExecutionResult]
) -> str:
    resolved = _resolve_ref(value, local_results)
    expected = f"{prefix}:"
    if not resolved.startswith(expected):
        raise OperationError(
            f"Expected {expected}<id> reference.",
            code="invalid_batch_operation_reference",
        )
    return resolved.removeprefix(expected)


def execute_batch_item_operation(
    session: Session,
    principal: ClientPrincipal,
    item: CandidateItem,
    operation: BatchItemOperation,
    local_results: dict[str, OperationExecutionResult],
    *,
    request_id: str | None,
) -> OperationExecutionResult:
    data = operation.change_data
    if operation.change_type == "entity_create":
        entity = entities.create_entity(
            session,
            principal,
            EntityCreate.model_validate(data),
            request_id=request_id,
            change_reason=f"batch-item:{item.id}",
        )
        return OperationExecutionResult(
            outcome="created",
            result_kind="entity",
            result_ref=f"entity:{entity.id}",
            result_locator={"entity_id": entity.id},
            result_version=entity.version,
        )
    if operation.change_type == "entity_update":
        entity_id = _stable_id(data.get("entity_ref"), "entity", local_results)
        entity = entities.update_entity(
            session,
            principal,
            entity_id,
            EntityUpdate.model_validate(data.get("patch")),
            request_id=request_id,
        )
        return OperationExecutionResult(
            outcome="updated",
            result_kind="entity",
            result_ref=f"entity:{entity.id}",
            result_locator={"entity_id": entity.id},
            result_version=entity.version,
        )
    if operation.change_type == "record_create":
        record = records.create_record(
            session,
            principal,
            RecordCreate.model_validate(data),
            request_id=request_id,
            change_reason=f"batch-item:{item.id}",
        )
        return OperationExecutionResult(
            outcome="created",
            result_kind="record",
            result_ref=f"record:{record.id}",
            result_locator={"record_id": record.id},
            result_version=record.version,
        )
    if operation.change_type == "record_update":
        record_id = _stable_id(data.get("record_ref"), "record", local_results)
        record = records.update_record(
            session,
            principal,
            record_id,
            RecordUpdate.model_validate(data.get("patch")),
            request_id=request_id,
        )
        return OperationExecutionResult(
            outcome="updated",
            result_kind="record",
            result_ref=f"record:{record.id}",
            result_locator={"record_id": record.id},
            result_version=record.version,
        )
    if operation.change_type == "record_entity_link_upsert":
        record_id = _stable_id(data.get("record_ref"), "record", local_results)
        entity_id = _stable_id(data.get("entity_ref"), "entity", local_results)
        role = data.get("role")
        if not isinstance(role, str) or not role:
            raise OperationError("record_entity_link_upsert requires role.")
        records.link_entity(
            session,
            principal,
            record_id,
            entity_id,
            role,
            request_id=request_id,
        )
        return OperationExecutionResult(
            outcome="created",
            result_kind="record_entity_link",
            result_ref=None,
            result_locator={
                "record_id": record_id,
                "entity_id": entity_id,
                "role": role,
            },
            result_version=None,
        )
    if operation.change_type == "collection_member_upsert":
        record_id = _stable_id(data.get("record_ref"), "record", local_results)
        collection_key = data.get("collection_key")
        collection_name = data.get("collection_name")
        domain = data.get("domain")
        if not isinstance(collection_key, str) or not collection_key:
            raise OperationError("collection_member_upsert requires collection_key.")
        if not isinstance(collection_name, str) or not collection_name:
            raise OperationError("collection_member_upsert requires collection_name.")
        if domain is not None and not isinstance(domain, str):
            raise OperationError("collection_member_upsert domain must be a string or null.")
        member, created = collections.upsert_collection_member(
            session,
            principal,
            collection_key=collection_key,
            collection_name=collection_name,
            domain=domain,
            record_id=record_id,
            source_candidate_item_id=item.id,
            position=None,
            request_id=request_id,
        )
        return OperationExecutionResult(
            outcome="created" if created else "noop",
            result_kind="collection_member",
            result_ref=None,
            result_locator={
                "collection_id": member.collection_id,
                "record_id": member.record_id,
            },
            result_version=None,
        )
    raise OperationError(
        f"Unsupported batch operation: {operation.change_type}",
        code="unsupported_batch_operation",
    )
