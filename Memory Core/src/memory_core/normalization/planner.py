from __future__ import annotations

from collections import Counter
from typing import Any

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from memory_core.models import (
    CollectionMember,
    Entity,
    MemoryCollection,
    Record,
    RecordEntity,
)
from memory_core.normalization.canonical import (
    json_object,
    normalize_display_text,
    normalize_identity_text,
    sha256_digest,
)
from memory_core.normalization.models import (
    BatchOperationPlan,
    BatchPlan,
    BatchPlanWarning,
    BatchUnitPlan,
    MediaExperienceBatchItemInput,
    MediaExperienceBatchProposal,
)
from memory_core.normalization.profiles import (
    NormalizationProfile,
    get_normalization_profile,
)
from memory_core.record_schemas.media import MediaExperiencePayloadV1
from memory_core.security import ClientPrincipal

_WORK_ENTITY_ROLE = "work"
_WORK_ENTITY_TYPE = "work"


def _ref_id(value: str, prefix: str) -> str:
    expected = f"{prefix}:"
    if not value.startswith(expected):
        raise ValueError(f"Reference must use {expected}<id>.")
    return value[len(expected) :]


def _is_visible(principal: ClientPrincipal, *, sensitivity: str, handling_policy: str) -> bool:
    if sensitivity == "restricted" or handling_policy == "company_restricted":
        return principal.has_scope("restricted:read")
    return True


def _entity_identity_matches(entity: Entity, media_type: str, title_key: str) -> bool:
    payload_type = entity.payload.get("media_type") if isinstance(entity.payload, dict) else None
    if payload_type is not None and payload_type != media_type:
        return False
    names = [entity.name]
    if entity.canonical_name:
        names.append(entity.canonical_name)
    aliases = entity.payload.get("aliases", []) if isinstance(entity.payload, dict) else []
    if isinstance(aliases, list):
        names.extend(value for value in aliases if isinstance(value, str))
    return any(normalize_identity_text(value) == title_key for value in names)


def _resolve_entity(
    session: Session,
    principal: ClientPrincipal,
    item: MediaExperienceBatchItemInput,
    *,
    title_key: str,
) -> tuple[Entity | None, str | None, str | None]:
    resolution = item.resolution
    if resolution is not None and resolution.force_create:
        return None, None, None
    explicit_ref = resolution.target_entity_ref if resolution is not None else None
    if explicit_ref is not None:
        entity = session.get(Entity, _ref_id(explicit_ref, "entity"))
        if (
            entity is None
            or entity.deleted_at is not None
            or entity.entity_type != _WORK_ENTITY_TYPE
            or not _is_visible(
                principal,
                sensitivity=entity.sensitivity,
                handling_policy=entity.handling_policy,
            )
        ):
            return None, "target_entity_not_found", "The selected work entity is unavailable."
        explicit_media_type = (
            entity.payload.get("media_type") if isinstance(entity.payload, dict) else None
        )
        if explicit_media_type not in {None, item.media_type}:
            return (
                None,
                "target_entity_media_type_mismatch",
                "The selected work entity belongs to another media type.",
            )
        return entity, None, None

    all_entities = list(
        session.scalars(
            select(Entity).where(
                Entity.entity_type == _WORK_ENTITY_TYPE,
                Entity.deleted_at.is_(None),
            )
        )
    )
    identity_matches = [
        entity
        for entity in all_entities
        if _entity_identity_matches(entity, item.media_type, title_key)
    ]
    hidden_matches = [
        entity
        for entity in identity_matches
        if not _is_visible(
            principal,
            sensitivity=entity.sensitivity,
            handling_policy=entity.handling_policy,
        )
    ]
    if hidden_matches:
        return (
            None,
            "identity_requires_reviewer",
            "This identity cannot be resolved with the current read scope.",
        )
    visible_matches = [
        entity
        for entity in identity_matches
        if _is_visible(
            principal,
            sensitivity=entity.sensitivity,
            handling_policy=entity.handling_policy,
        )
    ]
    if len(visible_matches) > 1:
        return None, "ambiguous_work_identity", "Multiple work entities match this item."
    return (visible_matches[0] if visible_matches else None), None, None


def _record_matches_for_entity(
    session: Session,
    principal: ClientPrincipal,
    *,
    entity_id: str,
    domain: str,
) -> list[Record]:
    statement = (
        select(Record)
        .join(RecordEntity, RecordEntity.record_id == Record.id)
        .where(
            RecordEntity.entity_id == entity_id,
            RecordEntity.role == _WORK_ENTITY_ROLE,
            Record.schema_name == "media_experience",
            Record.schema_version == 1,
            Record.domain == domain,
            Record.kind == "state",
            Record.deleted_at.is_(None),
        )
    )
    records = list(session.scalars(statement))
    return [
        record
        for record in records
        if _is_visible(
            principal,
            sensitivity=record.sensitivity,
            handling_policy=record.handling_policy,
        )
    ]


def _resolve_record(
    session: Session,
    principal: ClientPrincipal,
    item: MediaExperienceBatchItemInput,
    *,
    entity: Entity | None,
    domain: str,
) -> tuple[Record | None, Entity | None, str | None, str | None]:
    resolution = item.resolution
    explicit_ref = resolution.target_record_ref if resolution is not None else None
    if explicit_ref is not None:
        record = session.get(Record, _ref_id(explicit_ref, "record"))
        if (
            record is None
            or record.deleted_at is not None
            or not _is_visible(
                principal,
                sensitivity=record.sensitivity,
                handling_policy=record.handling_policy,
            )
            or record.schema_name != "media_experience"
            or record.schema_version != 1
            or record.domain != domain
            or record.kind != "state"
        ):
            return None, entity, "target_record_not_found", "The selected record is unavailable."
        expected_record_version = (
            resolution.expected_record_version if resolution is not None else None
        )
        if expected_record_version is not None and record.version != expected_record_version:
            return (
                None,
                entity,
                "target_record_version_conflict",
                "The selected record changed after the resolution was prepared.",
            )
        linked_entities = list(
            session.scalars(
                select(Entity)
                .join(RecordEntity, RecordEntity.entity_id == Entity.id)
                .where(
                    RecordEntity.record_id == record.id,
                    RecordEntity.role == _WORK_ENTITY_ROLE,
                    Entity.entity_type == _WORK_ENTITY_TYPE,
                    Entity.deleted_at.is_(None),
                )
            )
        )
        if entity is None:
            if len(linked_entities) != 1:
                return (
                    None,
                    None,
                    "record_work_identity_conflict",
                    "The selected record does not resolve to exactly one work entity.",
                )
            entity = linked_entities[0]
        elif not any(linked.id == entity.id for linked in linked_entities):
            return (
                None,
                entity,
                "record_entity_resolution_mismatch",
                "The selected record and work entity do not match.",
            )
        return record, entity, None, None
    if entity is None:
        return None, None, None, None
    matches = _record_matches_for_entity(
        session,
        principal,
        entity_id=entity.id,
        domain=domain,
    )
    if len(matches) > 1:
        return (
            None,
            entity,
            "ambiguous_media_experience",
            "Multiple active experience records match this work.",
        )
    return (matches[0] if matches else None), entity, None, None


def _normalized_item(item: MediaExperienceBatchItemInput) -> dict[str, Any]:
    normalized_title = normalize_display_text(item.work_title)
    aliases = [normalize_display_text(value) for value in item.aliases]
    tags = [normalize_display_text(value) for value in item.tags]
    payload = MediaExperiencePayloadV1.model_validate(
        {
            "work_title": normalized_title,
            "media_type": item.media_type,
            "progress": item.progress,
            "user_category": item.user_category,
            "completed_on": item.completed_on,
            "aliases": aliases,
            "rating": item.rating,
            "evaluation_note": item.evaluation_note,
            "tags": tags,
        }
    ).model_dump(mode="json")
    return {
        "client_item_id": item.client_item_id,
        "payload": payload,
        "source_reference": item.source_reference,
        "resolution": (
            item.resolution.model_dump(mode="json") if item.resolution is not None else None
        ),
    }


def _summary(payload: dict[str, Any]) -> str:
    progress = str(payload["progress"]).replace("_", " ")
    return f"{payload['work_title']} · {payload['media_type']} · {progress}"


def _operation(
    *,
    op_id: str,
    position: int,
    change_type: str,
    change_data: dict[str, Any],
) -> BatchOperationPlan:
    return BatchOperationPlan.model_validate(
        {
            "op_id": op_id,
            "position": position,
            "change_type": change_type,
            "change_data": change_data,
        }
    )


def _collection_membership_exists(
    session: Session,
    *,
    collection_key: str,
    record_id: str,
) -> bool:
    collection_id = session.scalar(
        select(MemoryCollection.id).where(
            MemoryCollection.key == collection_key,
            MemoryCollection.deleted_at.is_(None),
        )
    )
    if collection_id is None:
        return False
    return (
        session.get(
            CollectionMember,
            {"collection_id": collection_id, "record_id": record_id},
        )
        is not None
    )


def _plan_item(
    session: Session,
    principal: ClientPrincipal,
    item: MediaExperienceBatchItemInput,
    *,
    source_index: int,
    duplicate: bool,
) -> BatchUnitPlan:
    input_snapshot = item.model_dump(mode="json")
    input_hash = sha256_digest(input_snapshot)
    title_key = normalize_identity_text(item.work_title)
    unit_key = f"{item.media_type}:{title_key}"
    if duplicate:
        return _finalize_unit(
            unit_key=unit_key,
            source_index=source_index,
            input_snapshot=input_snapshot,
            normalized_snapshot={},
            input_hash=input_hash,
            decision="conflict",
            error_code="duplicate_batch_identity",
            error_message="The same media identity appears more than once in this batch revision.",
        )
    if item.resolution is not None and item.resolution.exclude:
        return _finalize_unit(
            unit_key=unit_key,
            source_index=source_index,
            input_snapshot=input_snapshot,
            normalized_snapshot=_normalized_item(item),
            input_hash=input_hash,
            decision="excluded",
        )

    try:
        normalized = _normalized_item(item)
    except ValidationError as exc:
        return _finalize_unit(
            unit_key=unit_key,
            source_index=source_index,
            input_snapshot=input_snapshot,
            normalized_snapshot={},
            input_hash=input_hash,
            decision="invalid",
            error_code="invalid_media_experience",
            error_message=str(exc.errors(include_url=False)[0].get("msg") or "Invalid item."),
        )
    payload = json_object(normalized["payload"])
    domain = f"media.{item.media_type}"
    entity, error_code, error_message = _resolve_entity(
        session,
        principal,
        item,
        title_key=title_key,
    )
    if error_code is not None:
        return _finalize_unit(
            unit_key=unit_key,
            source_index=source_index,
            input_snapshot=input_snapshot,
            normalized_snapshot=normalized,
            input_hash=input_hash,
            decision="conflict",
            error_code=error_code,
            error_message=error_message,
        )
    record, entity, error_code, error_message = _resolve_record(
        session,
        principal,
        item,
        entity=entity,
        domain=domain,
    )
    if error_code is not None:
        return _finalize_unit(
            unit_key=unit_key,
            source_index=source_index,
            input_snapshot=input_snapshot,
            normalized_snapshot=normalized,
            input_hash=input_hash,
            decision="conflict",
            error_code=error_code,
            error_message=error_message,
        )

    operations: list[BatchOperationPlan] = []
    warnings: list[BatchPlanWarning] = []
    if item.resolution is not None and item.resolution.force_create:
        warnings.append(
            BatchPlanWarning(
                code="forced_duplicate_identity",
                message="Reviewer explicitly requested creation without identity reuse.",
                field="resolution.force_create",
            )
        )
    entity_ref: str
    if entity is None:
        entity_ref = "op:work"
        operations.append(
            _operation(
                op_id="work",
                position=len(operations),
                change_type="entity_create",
                change_data={
                    "entity_type": _WORK_ENTITY_TYPE,
                    "name": payload["work_title"],
                    "canonical_name": normalize_display_text(str(payload["work_title"])),
                    "description": f"{item.media_type} work",
                    "payload": {
                        "media_type": item.media_type,
                        "aliases": payload["aliases"],
                        "identity_key": unit_key,
                    },
                    "sensitivity": "personal",
                    "handling_policy": "normal",
                },
            )
        )
    else:
        entity_ref = f"entity:{entity.id}"
        existing_aliases = (
            entity.payload.get("aliases", []) if isinstance(entity.payload, dict) else []
        )
        alias_candidates = [
            *(value for value in existing_aliases if isinstance(value, str)),
            str(payload["work_title"]),
            *(value for value in payload["aliases"] if isinstance(value, str)),
        ]
        normalized_aliases: list[str] = []
        seen_aliases = {normalize_identity_text(entity.name)}
        for alias in alias_candidates:
            display_alias = normalize_display_text(alias)
            identity_alias = normalize_identity_text(display_alias)
            if not display_alias or identity_alias in seen_aliases:
                continue
            normalized_aliases.append(display_alias)
            seen_aliases.add(identity_alias)
        desired_entity_payload = {
            **(entity.payload if isinstance(entity.payload, dict) else {}),
            "media_type": item.media_type,
            "aliases": normalized_aliases,
            "identity_key": unit_key,
        }
        if entity.payload != desired_entity_payload:
            operations.append(
                _operation(
                    op_id="work",
                    position=len(operations),
                    change_type="entity_update",
                    change_data={
                        "entity_ref": entity_ref,
                        "patch": {
                            "expected_version": entity.version,
                            "payload": desired_entity_payload,
                            "change_reason": "normalized media work identity",
                        },
                    },
                )
            )
            entity_ref = "op:work"

    desired_record = {
        "kind": "state",
        "domain": domain,
        "title": payload["work_title"],
        "summary": _summary(payload),
        "body_markdown": payload["evaluation_note"],
        "occurred_start": None,
        "occurred_end": None,
        "date_precision": "unknown",
        "timezone_name": None,
        "importance": 50,
        "verification_status": "confirmed",
        "sensitivity": "personal",
        "handling_policy": "normal",
        "schema_name": "media_experience",
        "schema_version": 1,
        "payload": payload,
        "source_type": "batch",
        "source_reference": item.source_reference,
        "supersedes_id": None,
    }
    record_ref: str
    record_changed = False
    if record is None:
        record_ref = "op:record"
        operations.append(
            _operation(
                op_id="record",
                position=len(operations),
                change_type="record_create",
                change_data=desired_record,
            )
        )
        record_changed = True
    else:
        record_ref = f"record:{record.id}"
        desired_update_fields = {
            "title": desired_record["title"],
            "summary": desired_record["summary"],
            "body_markdown": desired_record["body_markdown"],
            "payload": desired_record["payload"],
        }
        if item.source_reference is not None:
            desired_update_fields["source_reference"] = item.source_reference
        patch = {
            key: value
            for key, value in desired_update_fields.items()
            if getattr(record, key) != value
        }
        if patch:
            patch["expected_version"] = record.version
            patch["change_reason"] = "normalized media experience batch"
            operations.append(
                _operation(
                    op_id="record",
                    position=len(operations),
                    change_type="record_update",
                    change_data={"record_ref": record_ref, "patch": patch},
                )
            )
            record_changed = True

    needs_link = (
        record is None
        or entity is None
        or session.get(
            RecordEntity,
            {
                "record_id": record.id,
                "entity_id": entity.id,
                "role": _WORK_ENTITY_ROLE,
            },
        )
        is None
    )
    if needs_link:
        operations.append(
            _operation(
                op_id="work_link",
                position=len(operations),
                change_type="record_entity_link_upsert",
                change_data={
                    "record_ref": record_ref,
                    "entity_ref": entity_ref,
                    "role": _WORK_ENTITY_ROLE,
                },
            )
        )

    if item.progress == "completed":
        collection_key = f"media.{item.media_type}.completed"
        needs_membership = record is None or not _collection_membership_exists(
            session,
            collection_key=collection_key,
            record_id=record.id,
        )
        if needs_membership:
            operations.append(
                _operation(
                    op_id="completed_collection",
                    position=len(operations),
                    change_type="collection_member_upsert",
                    change_data={
                        "collection_key": collection_key,
                        "collection_name": f"Completed {item.media_type}",
                        "domain": domain,
                        "record_ref": record_ref,
                    },
                )
            )

    decision = "create" if record is None else ("update" if operations else "noop")
    if record is not None and record_changed:
        decision = "update"
    return _finalize_unit(
        unit_key=unit_key,
        source_index=source_index,
        input_snapshot=input_snapshot,
        normalized_snapshot=normalized,
        input_hash=input_hash,
        decision=decision,
        operations=operations,
        warnings=warnings,
    )


def _finalize_unit(
    *,
    unit_key: str,
    source_index: int,
    input_snapshot: dict[str, Any],
    normalized_snapshot: dict[str, Any],
    input_hash: str,
    decision: str,
    operations: list[BatchOperationPlan] | None = None,
    warnings: list[BatchPlanWarning] | None = None,
    error_code: str | None = None,
    error_message: str | None = None,
) -> BatchUnitPlan:
    operation_list = operations or []
    warning_list = warnings or []
    plan_material = {
        "unit_key": unit_key,
        "source_index": source_index,
        "normalized_snapshot": normalized_snapshot,
        "decision": decision,
        "operations": [operation.model_dump(mode="json") for operation in operation_list],
        "warnings": [warning.model_dump(mode="json") for warning in warning_list],
        "error_code": error_code,
        "error_message": error_message,
    }
    return BatchUnitPlan.model_validate(
        {
            **plan_material,
            "input_snapshot": input_snapshot,
            "input_hash": input_hash,
            "plan_hash": sha256_digest(plan_material),
        }
    )


def plan_media_experience_batch(
    session: Session,
    principal: ClientPrincipal,
    proposal: MediaExperienceBatchProposal,
    *,
    profile: NormalizationProfile | None = None,
) -> BatchPlan:
    resolved_profile = profile or get_normalization_profile(
        proposal.profile_id,
        proposal.profile_version,
    )
    if resolved_profile.handler != "media_experience_v1":
        raise ValueError("Media planner received an incompatible normalization profile.")
    input_snapshot = proposal.model_dump(mode="json")
    input_hash = sha256_digest(input_snapshot)
    unit_keys = [
        f"{item.media_type}:{normalize_identity_text(item.work_title)}" for item in proposal.items
    ]
    active_unit_keys = [
        unit_key
        for unit_key, item in zip(unit_keys, proposal.items, strict=True)
        if item.resolution is None or not item.resolution.exclude
    ]
    duplicate_keys = {
        unit_key for unit_key, count in Counter(active_unit_keys).items() if count > 1
    }
    items = [
        _plan_item(
            session,
            principal,
            item,
            source_index=index,
            duplicate=unit_keys[index] in duplicate_keys,
        )
        for index, item in enumerate(proposal.items)
    ]
    state = (
        "blocked" if any(item.decision in {"conflict", "invalid"} for item in items) else "ready"
    )
    plan_material = {
        "profile_id": resolved_profile.profile_id,
        "profile_version": resolved_profile.profile_version,
        "profile_hash": resolved_profile.profile_hash,
        "normalizer_version": resolved_profile.normalizer_version,
        "input_hash": input_hash,
        "state": state,
        "items": [item.model_dump(mode="json") for item in items],
    }
    return BatchPlan.model_validate(
        {
            **plan_material,
            "plan_hash": sha256_digest(plan_material),
        }
    )
