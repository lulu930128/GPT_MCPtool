from __future__ import annotations

import hashlib
import json
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from hmac import compare_digest
from typing import Any

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from memory_core.db_types import utc_now
from memory_core.errors import (
    CandidateConflictError,
    CandidateDigestMismatchError,
    CandidateExpiredError,
    NotFoundError,
    OperationError,
    ReviewChallengeError,
    ReviewChallengeExpiredError,
    VersionConflictError,
    operation_error_from_temporal,
    operation_error_from_validation,
)
from memory_core.models import Entity, MemoryCandidate, Record
from memory_core.schemas import (
    CandidateCreate,
    CandidateEntityCreate,
    CandidateEntityRelation,
    CandidateEntityUpdatePatch,
    CandidateRecordCreate,
    CandidateRecordEntityLink,
    CandidateRecordUpdatePatch,
    EntityCreate,
    EntityRelationCreate,
    EntityUpdate,
    RecordCreate,
    RecordUpdate,
)
from memory_core.security import ClientPrincipal
from memory_core.services import batch_candidates, change_sets, entities, records
from memory_core.services.audit import add_audit_event
from memory_core.services.record_schema_validation import (
    normalize_record_schema_create,
    normalize_record_schema_update,
    update_uses_registered_schema,
)
from memory_core.temporal import TemporalValidationIssue, validate_record_temporal_state

CANDIDATE_TTL = timedelta(days=7)
REVIEW_CHALLENGE_TTL = timedelta(minutes=10)
REVIEW_DIGEST_VERSION = 1


@dataclass(frozen=True, slots=True)
class PreparedCandidateReview:
    candidate: MemoryCandidate
    approval_challenge: str
    challenge_expires_at: datetime


def _candidate_hash(payload: CandidateCreate) -> str:
    canonical = json.dumps(
        payload.model_dump(mode="json"),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _approval_envelope(payload: CandidateCreate) -> dict[str, object]:
    return {
        "version": REVIEW_DIGEST_VERSION,
        "operation": payload.operation,
        "target_type": payload.target_type,
        "target_id": payload.target_id,
        "base_version": payload.base_version,
        "proposed_content": payload.proposed_content,
        "source_type": payload.source_type,
        "source_reference": payload.source_reference,
        "confidence": payload.confidence,
        "risk_flags": sorted(payload.risk_flags),
    }


def _stored_approval_envelope(candidate: MemoryCandidate) -> dict[str, object]:
    return {
        "version": candidate.review_digest_version,
        "operation": candidate.operation,
        "target_type": candidate.target_type,
        "target_id": candidate.target_id,
        "base_version": candidate.base_version,
        "proposed_content": candidate.proposed_content,
        "source_type": candidate.source_type,
        "source_reference": candidate.source_reference,
        "confidence": candidate.confidence,
        "risk_flags": sorted(candidate.risk_flags),
    }


def _digest_envelope(envelope: dict[str, object]) -> str:
    canonical = json.dumps(
        envelope,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return f"sha256:v{REVIEW_DIGEST_VERSION}:" + hashlib.sha256(canonical).hexdigest()


def _candidate_review_digest(payload: CandidateCreate) -> str:
    return _digest_envelope(_approval_envelope(payload))


def _stored_candidate_review_digest(candidate: MemoryCandidate) -> str:
    if candidate.candidate_kind == "change_set":
        return change_sets.stored_review_digest(candidate)
    if candidate.candidate_kind == "batch":
        return batch_candidates.stored_review_digest(candidate)
    return _digest_envelope(_stored_approval_envelope(candidate))


def _hash_secret(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _review_request_hash(
    *,
    action: str,
    candidate_id: str,
    review_digest: str,
    note: str | None,
) -> str:
    payload = json.dumps(
        {
            "action": action,
            "candidate_id": candidate_id,
            "review_digest": review_digest,
            "note": note,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _validate_candidate_content(
    operation: str,
    target_type: str,
    proposed_content: dict[str, Any],
) -> None:
    try:
        if operation == "create" and target_type == "record":
            CandidateRecordCreate.model_validate(proposed_content)
        elif operation == "create" and target_type == "entity":
            CandidateEntityCreate.model_validate(proposed_content)
        elif operation == "update" and target_type == "record":
            CandidateRecordUpdatePatch.model_validate(proposed_content)
        elif operation == "update" and target_type == "entity":
            CandidateEntityUpdatePatch.model_validate(proposed_content)
    except ValidationError as exc:
        raise operation_error_from_validation(
            exc.errors(include_url=False),
            fallback_message=f"Candidate payload failed validation: {exc}",
        ) from exc


def _validate_proposed_content(payload: CandidateCreate) -> None:
    _validate_candidate_content(
        payload.operation,
        payload.target_type,
        payload.proposed_content,
    )


def _normalize_candidate_record_schema(
    session: Session,
    principal: ClientPrincipal,
    payload: CandidateCreate,
    *,
    validate_references: bool,
) -> CandidateCreate:
    if payload.target_type != "record" or payload.operation == "archive":
        return payload
    allow_restricted = principal.has_scope("restricted:read")
    if payload.operation == "create":
        content = CandidateRecordCreate.model_validate(payload.proposed_content)
        formal = RecordCreate.model_validate(
            content.model_dump(mode="python", exclude={"entity_links"})
        )
        normalized = normalize_record_schema_create(
            session,
            formal,
            allow_restricted=allow_restricted,
            validate_references=validate_references,
        )
        normalized_content = content.model_copy(update={"payload": normalized.payload})
        return payload.model_copy(
            update={
                "proposed_content": normalized_content.model_dump(mode="json"),
            }
        )

    current_record = records.get_record(
        session,
        payload.target_id or "",
        include_deleted=not validate_references,
        allow_restricted=allow_restricted,
    )
    patch = CandidateRecordUpdatePatch.model_validate(payload.proposed_content)
    if not update_uses_registered_schema(current_record, patch):
        return payload
    normalized_patch, _resolved = normalize_record_schema_update(
        session,
        current_record,
        patch,
        allow_restricted=allow_restricted,
        validate_references=validate_references,
    )
    return payload.model_copy(
        update={
            "proposed_content": normalized_patch.model_dump(
                mode="json",
                exclude_unset=True,
            )
        }
    )


def _validate_candidate_target_state(
    session: Session,
    principal: ClientPrincipal,
    payload: CandidateCreate,
) -> None:
    if payload.operation == "create":
        _normalize_candidate_record_schema(
            session,
            principal,
            payload,
            validate_references=True,
        )
        return
    if payload.operation not in {"update", "archive"}:
        return
    if payload.target_type == "record":
        current_record = records.get_record(
            session,
            payload.target_id or "",
            allow_restricted=principal.has_scope("restricted:read"),
        )
        _ensure_result_version(current_record.version, payload.base_version)
        if payload.operation != "update":
            return
        patch = CandidateRecordUpdatePatch.model_validate(payload.proposed_content)
        if update_uses_registered_schema(current_record, patch):
            normalize_record_schema_update(
                session,
                current_record,
                patch,
                allow_restricted=principal.has_scope("restricted:read"),
                validate_references=True,
            )
        fields = patch.model_fields_set
        if not fields & {
            "occurred_start",
            "occurred_end",
            "date_precision",
            "timezone_name",
        }:
            return
        occurred_start = (
            patch.occurred_start if "occurred_start" in fields else current_record.occurred_start
        )
        occurred_end = (
            patch.occurred_end if "occurred_end" in fields else current_record.occurred_end
        )
        date_precision = (
            patch.date_precision.value
            if "date_precision" in fields
            else current_record.date_precision
        )
        try:
            validate_record_temporal_state(
                occurred_start=occurred_start,
                occurred_end=occurred_end,
                date_precision=date_precision,
            )
        except TemporalValidationIssue as issue:
            raise operation_error_from_temporal(issue) from issue
        return

    current_entity = entities.get_entity(
        session,
        payload.target_id or "",
        allow_restricted=principal.has_scope("restricted:read"),
    )
    _ensure_result_version(current_entity.version, payload.base_version)


def create_candidate(
    session: Session,
    principal: ClientPrincipal,
    payload: CandidateCreate,
    *,
    request_id: str | None,
) -> MemoryCandidate:
    _validate_proposed_content(payload)
    payload = _normalize_candidate_record_schema(
        session,
        principal,
        payload,
        validate_references=False,
    )
    content_hash = _candidate_hash(payload)
    existing = session.scalar(
        select(MemoryCandidate).where(
            MemoryCandidate.source_client_id == principal.id,
            MemoryCandidate.idempotency_key == payload.idempotency_key,
        )
    )
    if existing:
        if existing.content_hash != content_hash:
            raise CandidateConflictError(
                "The idempotency key was already used for different candidate content"
            )
        return existing

    _validate_candidate_target_state(session, principal, payload)
    candidate = MemoryCandidate(
        **payload.model_dump(mode="python"),
        candidate_kind="single",
        source_client_id=principal.id,
        content_hash=content_hash,
        review_digest=_candidate_review_digest(payload),
        review_digest_version=REVIEW_DIGEST_VERSION,
        validation_result={"valid": True},
        status="pending",
        expires_at=utc_now() + CANDIDATE_TTL,
    )
    session.add(candidate)
    session.flush()
    add_audit_event(
        session,
        principal,
        action="candidate.create",
        outcome="success",
        request_id=request_id,
        target_type="candidate",
        target_id=candidate.id,
        details={"operation": candidate.operation, "target_type": candidate.target_type},
    )
    return candidate


def list_candidates(
    session: Session,
    *,
    status: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> list[MemoryCandidate]:
    statement = select(MemoryCandidate)
    if status:
        statement = statement.where(MemoryCandidate.status == status)
    statement = statement.order_by(MemoryCandidate.created_at.desc()).offset(offset).limit(limit)
    return list(session.scalars(statement))


def get_candidate(session: Session, candidate_id: str) -> MemoryCandidate:
    candidate = session.get(MemoryCandidate, candidate_id)
    if candidate is None:
        raise NotFoundError("candidate")
    return candidate


def _mark_expired(
    session: Session,
    candidate: MemoryCandidate,
    principal: ClientPrincipal,
    *,
    request_id: str | None,
) -> None:
    candidate.status = "expired"
    candidate.reviewed_at = utc_now()
    candidate.reviewed_by_client_id = principal.id
    candidate.review_action = "expire"
    candidate.review_challenge_hash = None
    candidate.review_challenge_expires_at = None
    if candidate.candidate_kind == "batch" and candidate.batch is not None:
        candidate.batch.review_state = "expired"
    add_audit_event(
        session,
        principal,
        action="candidate.expire",
        outcome="success",
        request_id=request_id,
        target_type="candidate",
        target_id=candidate.id,
    )
    session.flush()


def _ensure_pending_and_current(
    session: Session,
    candidate: MemoryCandidate,
    principal: ClientPrincipal,
    *,
    request_id: str | None,
) -> None:
    if candidate.status != "pending":
        raise CandidateConflictError(f"Candidate is already {candidate.status}")
    if candidate.expires_at is not None and candidate.expires_at <= utc_now():
        _mark_expired(session, candidate, principal, request_id=request_id)
        raise CandidateExpiredError()


def _validate_review_digest(candidate: MemoryCandidate, expected_review_digest: str) -> None:
    current_digest = _stored_candidate_review_digest(candidate)
    if not compare_digest(candidate.review_digest, current_digest):
        raise CandidateDigestMismatchError()
    if not compare_digest(candidate.review_digest, expected_review_digest):
        raise CandidateDigestMismatchError()


def _validate_review_challenge(
    candidate: MemoryCandidate,
    principal: ClientPrincipal,
    approval_challenge: str,
) -> None:
    if (
        candidate.review_prepared_by_client_id != principal.id
        or candidate.review_challenge_hash is None
        or not compare_digest(candidate.review_challenge_hash, _hash_secret(approval_challenge))
    ):
        raise ReviewChallengeError()
    if (
        candidate.review_challenge_expires_at is None
        or candidate.review_challenge_expires_at <= utc_now()
    ):
        raise ReviewChallengeExpiredError()


def prepare_candidate_review(
    session: Session,
    principal: ClientPrincipal,
    candidate_id: str,
    *,
    expected_review_digest: str,
    request_id: str | None,
) -> PreparedCandidateReview:
    candidate = get_candidate(session, candidate_id)
    _ensure_pending_and_current(session, candidate, principal, request_id=request_id)
    _validate_review_digest(candidate, expected_review_digest)
    batch_candidates.prepare_batch_for_review(candidate)

    challenge = secrets.token_urlsafe(32)
    challenge_expires_at = utc_now() + REVIEW_CHALLENGE_TTL
    candidate.review_prepared_by_client_id = principal.id
    candidate.review_challenge_hash = _hash_secret(challenge)
    candidate.review_challenge_expires_at = challenge_expires_at
    add_audit_event(
        session,
        principal,
        action="candidate.review_prepare",
        outcome="success",
        request_id=request_id,
        target_type="candidate",
        target_id=candidate.id,
        details={
            "review_digest": candidate.review_digest,
            "challenge_expires_at": challenge_expires_at.isoformat(),
        },
    )
    session.flush()
    return PreparedCandidateReview(
        candidate=candidate,
        approval_challenge=challenge,
        challenge_expires_at=challenge_expires_at,
    )


def _existing_review_result(
    session: Session,
    principal: ClientPrincipal,
    *,
    candidate_id: str,
    action: str,
    idempotency_key: str,
    request_hash: str,
) -> MemoryCandidate | None:
    existing = session.scalar(
        select(MemoryCandidate).where(
            MemoryCandidate.reviewed_by_client_id == principal.id,
            MemoryCandidate.review_idempotency_key == idempotency_key,
        )
    )
    if existing is None:
        return None
    if (
        existing.id != candidate_id
        or existing.review_action != action
        or existing.review_request_hash != request_hash
    ):
        raise CandidateConflictError(
            "The review idempotency key was already used for a different review action"
        )
    return existing


def _finish_review(
    candidate: MemoryCandidate,
    principal: ClientPrincipal,
    *,
    action: str,
    note: str | None,
    idempotency_key: str,
    request_hash: str,
) -> None:
    candidate.reviewed_at = utc_now()
    candidate.reviewed_by_client_id = principal.id
    candidate.review_action = action
    candidate.review_note = note
    candidate.review_idempotency_key = idempotency_key
    candidate.review_request_hash = request_hash
    candidate.review_challenge_hash = None
    candidate.review_challenge_expires_at = None


def authorize_batch_candidate(
    session: Session,
    principal: ClientPrincipal,
    candidate_id: str,
    *,
    expected_review_digest: str,
    approval_challenge: str,
    idempotency_key: str,
    review_note: str | None,
    request_id: str | None,
) -> MemoryCandidate:
    request_hash = _review_request_hash(
        action="approve",
        candidate_id=candidate_id,
        review_digest=expected_review_digest,
        note=review_note,
    )
    existing = _existing_review_result(
        session,
        principal,
        candidate_id=candidate_id,
        action="approve",
        idempotency_key=idempotency_key,
        request_hash=request_hash,
    )
    if existing is not None:
        if existing.candidate_kind != "batch":
            raise CandidateConflictError(
                "The approval idempotency key belongs to a non-batch candidate."
            )
        return existing

    candidate = get_candidate(session, candidate_id)
    if candidate.candidate_kind != "batch" or candidate.batch is None:
        raise CandidateConflictError("Candidate is not a batch.")
    _ensure_pending_and_current(session, candidate, principal, request_id=request_id)
    _validate_review_digest(candidate, expected_review_digest)
    _validate_review_challenge(candidate, principal, approval_challenge)
    if candidate.batch.plan_state != "sealed" or candidate.batch.review_state != "prepared":
        raise CandidateConflictError("Batch was not prepared for this approval.")
    candidate.batch.review_state = "approved"
    _finish_review(
        candidate,
        principal,
        action="approve",
        note=review_note,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
    )
    add_audit_event(
        session,
        principal,
        action="candidate.batch_approve",
        outcome="success",
        request_id=request_id,
        target_type="candidate",
        target_id=candidate.id,
        details={
            "batch_id": candidate.batch.id,
            "revision_no": candidate.batch.current_revision_no,
            "review_digest": candidate.review_digest,
        },
    )
    session.flush()
    return candidate


def apply_candidate(
    session: Session,
    principal: ClientPrincipal,
    candidate_id: str,
    *,
    expected_review_digest: str,
    approval_challenge: str,
    idempotency_key: str,
    review_note: str | None,
    request_id: str | None,
) -> MemoryCandidate:
    request_hash = _review_request_hash(
        action="approve",
        candidate_id=candidate_id,
        review_digest=expected_review_digest,
        note=review_note,
    )
    existing = _existing_review_result(
        session,
        principal,
        candidate_id=candidate_id,
        action="approve",
        idempotency_key=idempotency_key,
        request_hash=request_hash,
    )
    if existing is not None:
        return existing

    candidate = get_candidate(session, candidate_id)
    if candidate.candidate_kind == "batch":
        raise CandidateConflictError(
            "Batch candidates must use the item-atomic batch apply workflow."
        )
    _ensure_pending_and_current(session, candidate, principal, request_id=request_id)
    _validate_review_digest(candidate, expected_review_digest)
    if candidate.candidate_kind == "single":
        if candidate.operation is None or candidate.target_type is None:
            raise OperationError("Single candidate is missing its operation target")
        _validate_candidate_content(
            candidate.operation,
            candidate.target_type,
            candidate.proposed_content,
        )
    _validate_review_challenge(candidate, principal, approval_challenge)
    if candidate.candidate_kind == "change_set":
        try:
            with session.begin_nested():
                operation_results = change_sets.execute_change_set(
                    session,
                    principal,
                    candidate,
                    request_id=request_id,
                )
        except VersionConflictError as exc:
            session.expire(candidate, ["results"])
            candidate.status = "conflict"
            candidate.validation_result = {
                "valid": False,
                "atomic": True,
                "transaction_committed": False,
                "error": str(exc),
                "error_code": "version_conflict",
            }
            _finish_review(
                candidate,
                principal,
                action="approve",
                note=review_note,
                idempotency_key=idempotency_key,
                request_hash=request_hash,
            )
            add_audit_event(
                session,
                principal,
                action="candidate.change_set_apply",
                outcome="conflict",
                request_id=request_id,
                target_type="candidate",
                target_id=candidate.id,
                details={
                    "error_code": "version_conflict",
                    "review_digest": candidate.review_digest,
                    "transaction_committed": False,
                },
            )
            session.flush()
            return candidate

        candidate.status = "applied"
        candidate.validation_result = {
            "valid": True,
            "atomic": True,
            "transaction_committed": True,
            "operation_count": len(operation_results),
        }
        _finish_review(
            candidate,
            principal,
            action="approve",
            note=review_note,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
        )
        add_audit_event(
            session,
            principal,
            action="candidate.change_set_apply",
            outcome="success",
            request_id=request_id,
            target_type="candidate",
            target_id=candidate.id,
            details={
                "operation_count": len(operation_results),
                "review_digest": candidate.review_digest,
                "transaction_committed": True,
            },
        )
        session.flush()
        return candidate

    change_reason = f"candidate:{candidate.id}"
    result: Record | Entity
    result_id: str
    result_version: int
    try:
        if candidate.operation == "create" and candidate.target_type == "record":
            record_create_content = CandidateRecordCreate.model_validate(candidate.proposed_content)
            result = records.create_record(
                session,
                principal,
                RecordCreate.model_validate(
                    record_create_content.model_dump(
                        mode="python",
                        exclude={"entity_links"},
                    )
                ),
                request_id=request_id,
                change_reason=change_reason,
            )
            _link_record_entities(
                session,
                principal,
                result,
                record_create_content.entity_links,
                request_id=request_id,
            )
        elif candidate.operation == "create" and candidate.target_type == "entity":
            entity_create_content = CandidateEntityCreate.model_validate(candidate.proposed_content)
            result = entities.create_entity(
                session,
                principal,
                EntityCreate.model_validate(
                    entity_create_content.model_dump(
                        mode="python",
                        exclude={"relations"},
                    )
                ),
                request_id=request_id,
                change_reason=change_reason,
            )
            _create_entity_relations(
                session,
                principal,
                result,
                entity_create_content.relations,
                request_id=request_id,
            )
        elif candidate.operation == "update" and candidate.target_type == "record":
            record_update_content = CandidateRecordUpdatePatch.model_validate(
                candidate.proposed_content
            )
            formal_content = record_update_content.model_dump(
                mode="python",
                exclude_unset=True,
                exclude={"entity_links"},
            )
            if set(formal_content) - {"change_reason"}:
                result = records.update_record(
                    session,
                    principal,
                    candidate.target_id or "",
                    RecordUpdate.model_validate(
                        {
                            **formal_content,
                            "expected_version": candidate.base_version,
                        }
                    ),
                    request_id=request_id,
                )
            else:
                result = records.get_record(
                    session,
                    candidate.target_id or "",
                    allow_restricted=True,
                )
                _ensure_result_version(result.version, candidate.base_version)
            _link_record_entities(
                session,
                principal,
                result,
                record_update_content.entity_links,
                request_id=request_id,
            )
        elif candidate.operation == "update" and candidate.target_type == "entity":
            entity_update_content = CandidateEntityUpdatePatch.model_validate(
                candidate.proposed_content
            )
            formal_content = entity_update_content.model_dump(
                mode="python",
                exclude_unset=True,
                exclude={"relations"},
            )
            if set(formal_content) - {"change_reason"}:
                result = entities.update_entity(
                    session,
                    principal,
                    candidate.target_id or "",
                    EntityUpdate.model_validate(
                        {
                            **formal_content,
                            "expected_version": candidate.base_version,
                        }
                    ),
                    request_id=request_id,
                )
            else:
                result = entities.get_entity(
                    session,
                    candidate.target_id or "",
                    allow_restricted=True,
                )
                _ensure_result_version(result.version, candidate.base_version)
            _create_entity_relations(
                session,
                principal,
                result,
                entity_update_content.relations,
                request_id=request_id,
            )
        elif candidate.operation == "archive" and candidate.target_type == "record":
            current_record = records.get_record(
                session,
                candidate.target_id or "",
                allow_restricted=True,
            )
            _ensure_result_version(current_record.version, candidate.base_version)
            merged_into_ref = candidate.proposed_content.get("merged_into_ref")
            if merged_into_ref:
                records.create_link(
                    session,
                    principal,
                    current_record.id,
                    "merged_into",
                    _parse_reference(merged_into_ref, "record"),
                    request_id=request_id,
                )
            result = records.archive_record(
                session,
                principal,
                candidate.target_id or "",
                expected_version=candidate.base_version or 0,
                request_id=request_id,
                change_reason=candidate.proposed_content.get("change_reason") or change_reason,
            )
        elif candidate.operation == "archive" and candidate.target_type == "entity":
            current_entity = entities.get_entity(
                session,
                candidate.target_id or "",
                allow_restricted=True,
            )
            _ensure_result_version(current_entity.version, candidate.base_version)
            merged_into_ref = candidate.proposed_content.get("merged_into_ref")
            if merged_into_ref:
                entities.create_relation(
                    session,
                    principal,
                    EntityRelationCreate(
                        subject_entity_id=current_entity.id,
                        predicate="merged_into",
                        object_entity_id=_parse_reference(merged_into_ref, "entity"),
                    ),
                    request_id=request_id,
                )
            result = entities.archive_entity(
                session,
                principal,
                candidate.target_id or "",
                expected_version=candidate.base_version or 0,
                request_id=request_id,
                change_reason=candidate.proposed_content.get("change_reason") or change_reason,
            )
        else:  # pragma: no cover - protected by schema validation
            raise OperationError("Unsupported candidate operation")
        result_id = result.id
        result_version = result.version
    except VersionConflictError as exc:
        candidate.status = "conflict"
        candidate.validation_result = {"valid": False, "error": str(exc)}
        _finish_review(
            candidate,
            principal,
            action="approve",
            note=review_note,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
        )
        add_audit_event(
            session,
            principal,
            action="candidate.apply",
            outcome="conflict",
            request_id=request_id,
            target_type="candidate",
            target_id=candidate.id,
            details={
                "error_code": "version_conflict",
                "review_digest": candidate.review_digest,
            },
        )
        session.flush()
        return candidate

    candidate.status = "applied"
    candidate.result_id = result_id
    candidate.result_version = result_version
    candidate.validation_result = {"valid": True}
    _finish_review(
        candidate,
        principal,
        action="approve",
        note=review_note,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
    )
    add_audit_event(
        session,
        principal,
        action="candidate.apply",
        outcome="success",
        request_id=request_id,
        target_type="candidate",
        target_id=candidate.id,
        details={
            "applied_target_id": result_id,
            "applied_target_version": result_version,
            "review_digest": candidate.review_digest,
        },
    )
    session.flush()
    return candidate


def _link_record_entities(
    session: Session,
    principal: ClientPrincipal,
    record: Record,
    links: list[CandidateRecordEntityLink],
    *,
    request_id: str | None,
) -> None:
    for link in links:
        records.link_entity(
            session,
            principal,
            record.id,
            _parse_reference(link.entity_ref, "entity"),
            link.role,
            request_id=request_id,
        )


def _create_entity_relations(
    session: Session,
    principal: ClientPrincipal,
    subject: Entity,
    relations: list[CandidateEntityRelation],
    *,
    request_id: str | None,
) -> None:
    for relation in relations:
        entities.create_relation(
            session,
            principal,
            EntityRelationCreate(
                subject_entity_id=subject.id,
                predicate=relation.predicate,
                object_entity_id=_parse_reference(
                    relation.object_entity_ref,
                    "entity",
                ),
                valid_from=relation.valid_from,
                valid_to=relation.valid_to,
                source_record_id=(
                    _parse_reference(relation.source_record_ref, "record")
                    if relation.source_record_ref
                    else None
                ),
            ),
            request_id=request_id,
        )


def _parse_reference(value: str, expected_type: str) -> str:
    result_type, separator, result_id = value.partition(":")
    if separator != ":" or result_type != expected_type or not result_id:
        raise OperationError(f"Expected a stable {expected_type}:<id> reference")
    return result_id


def _ensure_result_version(actual_version: int, expected_version: int | None) -> None:
    if expected_version is None or actual_version != expected_version:
        raise VersionConflictError(expected_version or 0, actual_version)


def reject_candidate(
    session: Session,
    principal: ClientPrincipal,
    candidate_id: str,
    *,
    reason: str,
    expected_review_digest: str,
    approval_challenge: str,
    idempotency_key: str,
    request_id: str | None,
) -> MemoryCandidate:
    request_hash = _review_request_hash(
        action="reject",
        candidate_id=candidate_id,
        review_digest=expected_review_digest,
        note=reason,
    )
    existing = _existing_review_result(
        session,
        principal,
        candidate_id=candidate_id,
        action="reject",
        idempotency_key=idempotency_key,
        request_hash=request_hash,
    )
    if existing is not None:
        return existing

    candidate = get_candidate(session, candidate_id)
    _ensure_pending_and_current(session, candidate, principal, request_id=request_id)
    _validate_review_digest(candidate, expected_review_digest)
    _validate_review_challenge(candidate, principal, approval_challenge)
    candidate.status = "rejected"
    candidate.validation_result = {"valid": True, "review_reason": reason}
    if candidate.candidate_kind == "batch" and candidate.batch is not None:
        candidate.batch.review_state = "rejected"
    _finish_review(
        candidate,
        principal,
        action="reject",
        note=reason,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
    )
    add_audit_event(
        session,
        principal,
        action="candidate.reject",
        outcome="success",
        request_id=request_id,
        target_type="candidate",
        target_id=candidate.id,
        details={"reason": reason, "review_digest": candidate.review_digest},
    )
    session.flush()
    return candidate
