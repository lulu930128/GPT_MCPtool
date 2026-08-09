from __future__ import annotations

import uuid
from collections.abc import Callable
from datetime import timedelta

from sqlalchemy import or_, select, update
from sqlalchemy.orm import Session

from memory_core.db_types import utc_now
from memory_core.errors import CandidateConflictError, OperationError
from memory_core.models import (
    BatchApplyAttempt,
    BatchItemResult,
    CandidateBatch,
    CandidateItem,
    CollectionMember,
    Entity,
    MemoryCandidate,
    Record,
    RecordEntity,
)
from memory_core.normalization.canonical import sha256_digest
from memory_core.security import ClientPrincipal
from memory_core.services.audit import add_audit_event
from memory_core.services.batch_candidates import current_batch_revision
from memory_core.services.batch_errors import project_batch_execution_error
from memory_core.services.operation_executor import (
    OperationExecutionResult,
    execute_batch_item_operation,
)

_LEASE_DURATION = timedelta(minutes=5)


def _verify_item_plan(item: CandidateItem) -> None:
    material = {
        "unit_key": item.unit_key,
        "source_index": item.source_index,
        "normalized_snapshot": item.normalized_snapshot,
        "decision": item.decision,
        "operations": [
            {
                "op_id": operation.op_id,
                "position": operation.position,
                "change_type": operation.change_type,
                "change_data": operation.change_data,
            }
            for operation in item.operations
        ],
        "warnings": item.warnings,
        "error_code": item.error_code,
        "error_message": item.error_message,
    }
    if item.plan_hash != sha256_digest(material):
        raise OperationError(
            "Stored batch item no longer matches its reviewed plan.",
            code="batch_item_plan_digest_mismatch",
        )


def _claim_item(
    session_factory: Callable[[], Session],
    item_id: str,
) -> str | None:
    token = str(uuid.uuid4())
    now = utc_now()
    with session_factory() as session:
        result = session.execute(
            update(CandidateItem)
            .where(
                CandidateItem.id == item_id,
                or_(
                    CandidateItem.execution_state == "not_started",
                    (
                        (CandidateItem.execution_state == "failed")
                        & (CandidateItem.retry_policy == "retry_same_plan")
                    ),
                    (
                        (CandidateItem.execution_state == "claimed")
                        & (CandidateItem.claim_expires_at < now)
                    ),
                ),
            )
            .values(
                execution_state="claimed",
                claim_token=token,
                claim_expires_at=now + _LEASE_DURATION,
                attempt_count=CandidateItem.attempt_count + 1,
                updated_at=now,
                execution_error_code=None,
                execution_error_message=None,
                retry_policy="not_applicable",
            )
        )
        session.commit()
        return token if int(getattr(result, "rowcount", 0)) == 1 else None


def _execute_claimed_item(
    session_factory: Callable[[], Session],
    principal: ClientPrincipal,
    item_id: str,
    claim_token: str,
    *,
    request_id: str | None,
) -> None:
    with session_factory() as session:
        item = session.get(CandidateItem, item_id)
        if item is None or item.execution_state != "claimed" or item.claim_token != claim_token:
            raise CandidateConflictError("The batch item claim is no longer valid.")
        _verify_item_plan(item)
        local_results: dict[str, OperationExecutionResult] = {}
        for operation in item.operations:
            execution = execute_batch_item_operation(
                session,
                principal,
                item,
                operation,
                local_results,
                request_id=request_id,
            )
            local_results[operation.op_id] = execution
            session.add(
                BatchItemResult(
                    candidate_item_id=item.id,
                    operation_id=operation.id,
                    op_id=operation.op_id,
                    position=operation.position,
                    operation_outcome=execution.outcome,
                    result_kind=execution.result_kind,
                    result_ref=execution.result_ref,
                    result_locator=execution.result_locator,
                    result_version=execution.result_version,
                    verify_status="pending",
                )
            )
        item.execution_state = "applied"
        item.applied_at = utc_now()
        item.claim_token = None
        item.claim_expires_at = None
        add_audit_event(
            session,
            principal,
            action="candidate.batch_item_apply",
            outcome="success",
            request_id=request_id,
            target_type="candidate_item",
            target_id=item.id,
            details={
                "unit_key": item.unit_key,
                "operation_count": len(item.operations),
            },
        )
        session.commit()


def _result_exists(session: Session, result: BatchItemResult) -> bool:
    locator = result.result_locator
    if result.result_kind == "record":
        record = session.get(Record, locator.get("record_id"))
        return (
            record is not None
            and record.deleted_at is None
            and (result.result_version is None or record.version >= result.result_version)
        )
    if result.result_kind == "entity":
        entity = session.get(Entity, locator.get("entity_id"))
        return (
            entity is not None
            and entity.deleted_at is None
            and (result.result_version is None or entity.version >= result.result_version)
        )
    if result.result_kind == "record_entity_link":
        return (
            session.get(
                RecordEntity,
                {
                    "record_id": locator.get("record_id"),
                    "entity_id": locator.get("entity_id"),
                    "role": locator.get("role"),
                },
            )
            is not None
        )
    if result.result_kind == "collection_member":
        return (
            session.get(
                CollectionMember,
                {
                    "collection_id": locator.get("collection_id"),
                    "record_id": locator.get("record_id"),
                },
            )
            is not None
        )
    return False


def _verify_committed_item(
    session_factory: Callable[[], Session],
    principal: ClientPrincipal,
    item_id: str,
    *,
    request_id: str | None,
) -> bool:
    with session_factory() as session:
        item = session.get(CandidateItem, item_id)
        if item is None:
            return False
        all_verified = True
        now = utc_now()
        for result in item.results:
            verified = _result_exists(session, result)
            result.verify_status = "verified" if verified else "failed"
            result.verify_error_code = None if verified else "postcommit_readback_failed"
            result.verified_at = now
            all_verified = all_verified and verified
        if all_verified:
            item.execution_state = "applied"
            item.verified_at = now
            item.execution_error_code = None
            item.execution_error_message = None
            item.retry_policy = "not_applicable"
        else:
            item.execution_state = "unverified"
            item.execution_error_code = "postcommit_readback_failed"
            item.execution_error_message = "One or more operation results could not be read back."
            item.retry_policy = "verify_only"
        add_audit_event(
            session,
            principal,
            action="candidate.batch_item_verify",
            outcome="success" if all_verified else "failed",
            request_id=request_id,
            target_type="candidate_item",
            target_id=item.id,
        )
        session.commit()
        return all_verified


def _mark_item_failed(
    session_factory: Callable[[], Session],
    principal: ClientPrincipal,
    item_id: str,
    *,
    error: Exception,
    request_id: str | None,
) -> None:
    projected_error = project_batch_execution_error(error)
    with session_factory() as session:
        item = session.get(CandidateItem, item_id)
        if item is None:
            return
        item.execution_state = "failed"
        item.claim_token = None
        item.claim_expires_at = None
        item.execution_error_code = projected_error.code
        item.execution_error_message = projected_error.message
        item.retry_policy = projected_error.retry_policy
        add_audit_event(
            session,
            principal,
            action="candidate.batch_item_apply",
            outcome="failed",
            request_id=request_id,
            target_type="candidate_item",
            target_id=item.id,
            details={
                "error_code": item.execution_error_code,
                "retry_policy": item.retry_policy,
            },
        )
        session.commit()


def _mark_item_unverified(
    session_factory: Callable[[], Session],
    principal: ClientPrincipal,
    item_id: str,
    *,
    request_id: str | None,
) -> None:
    with session_factory() as session:
        item = session.get(CandidateItem, item_id)
        if item is None:
            return
        item.execution_state = "unverified"
        item.claim_token = None
        item.claim_expires_at = None
        item.execution_error_code = "postcommit_readback_failed"
        item.execution_error_message = "Committed results could not be read back."
        item.retry_policy = "verify_only"
        add_audit_event(
            session,
            principal,
            action="candidate.batch_item_verify",
            outcome="failed",
            request_id=request_id,
            target_type="candidate_item",
            target_id=item.id,
            details={"error_code": item.execution_error_code},
        )
        session.commit()


def _load_current_item_ids(
    session: Session,
    candidate_id: str,
) -> tuple[MemoryCandidate, CandidateBatch, list[str]]:
    candidate = session.get(MemoryCandidate, candidate_id)
    if candidate is None or candidate.candidate_kind != "batch" or candidate.batch is None:
        raise CandidateConflictError("Candidate is not a batch.")
    batch = candidate.batch
    if batch.review_state != "approved" or batch.plan_state != "sealed":
        raise CandidateConflictError("Batch must be sealed and approved before execution.")
    revision = current_batch_revision(batch)
    if revision.review_digest != candidate.review_digest:
        raise CandidateConflictError("Sealed batch digest does not match approval.")
    item_ids = list(
        session.scalars(
            select(CandidateItem.id)
            .where(CandidateItem.batch_revision_id == revision.id)
            .order_by(CandidateItem.position)
        )
    )
    return candidate, batch, item_ids


def _start_attempt(
    session_factory: Callable[[], Session],
    principal: ClientPrincipal,
    candidate_id: str,
    *,
    request_id: str | None,
) -> tuple[str, list[str]]:
    with session_factory() as session:
        candidate, batch, item_ids = _load_current_item_ids(session, candidate_id)
        if candidate.review_idempotency_key is None or candidate.review_request_hash is None:
            raise CandidateConflictError("Batch approval metadata is incomplete.")
        existing = session.scalar(
            select(BatchApplyAttempt).where(
                BatchApplyAttempt.reviewer_client_id == principal.id,
                BatchApplyAttempt.approval_idempotency_key == candidate.review_idempotency_key,
            )
        )
        lease_token = str(uuid.uuid4())
        now = utc_now()
        revision = current_batch_revision(batch)
        if existing is None:
            attempt = BatchApplyAttempt(
                batch_id=batch.id,
                batch_revision_id=revision.id,
                reviewer_client_id=principal.id,
                approval_idempotency_key=candidate.review_idempotency_key,
                approval_request_hash=candidate.review_request_hash,
                status="running",
                lease_token=lease_token,
                lease_expires_at=now + _LEASE_DURATION,
            )
            session.add(attempt)
            session.flush()
        else:
            if (
                existing.batch_id != batch.id
                or existing.batch_revision_id != revision.id
                or existing.approval_request_hash != candidate.review_request_hash
            ):
                raise CandidateConflictError(
                    "Approval idempotency key belongs to another batch execution."
                )
            existing.status = "running"
            existing.lease_token = lease_token
            existing.lease_expires_at = now + _LEASE_DURATION
            existing.error_code = None
            attempt = existing
        batch.execution_state = "applying"
        if batch.started_at is None:
            batch.started_at = now
        add_audit_event(
            session,
            principal,
            action="candidate.batch_apply_start",
            outcome="success",
            request_id=request_id,
            target_type="candidate",
            target_id=candidate.id,
            details={"attempt_id": attempt.id, "item_count": len(item_ids)},
        )
        session.commit()
        return attempt.id, item_ids


def _finish_attempt(
    session_factory: Callable[[], Session],
    principal: ClientPrincipal,
    candidate_id: str,
    attempt_id: str,
    *,
    request_id: str | None,
) -> MemoryCandidate:
    with session_factory() as session:
        candidate, batch, item_ids = _load_current_item_ids(session, candidate_id)
        states = list(
            session.execute(
                select(CandidateItem.execution_state, CandidateItem.decision).where(
                    CandidateItem.id.in_(item_ids)
                )
            )
        )
        applied = sum(state == "applied" for state, _decision in states)
        skipped = sum(state == "skipped" for state, _decision in states)
        failed = sum(state == "failed" for state, _decision in states)
        unverified = sum(state == "unverified" for state, _decision in states)
        pending = len(states) - applied - skipped - failed - unverified
        summary = {
            "item_count": len(states),
            "applied": applied,
            "skipped": skipped,
            "failed": failed,
            "unverified": unverified,
            "pending": pending,
        }
        attempt = session.get(BatchApplyAttempt, attempt_id)
        if attempt is None:
            raise CandidateConflictError("Batch apply attempt disappeared.")
        attempt.status = "completed"
        attempt.summary = summary
        attempt.completed_at = utc_now()
        if failed or unverified or pending:
            batch.execution_state = "partially_applied" if applied or skipped else "failed"
        else:
            batch.execution_state = "applied"
            batch.completed_at = utc_now()
            candidate.status = "applied"
        candidate.validation_result = {
            **candidate.validation_result,
            "execution": summary,
            "transaction_scope": "item",
            "postcommit_verified": failed == 0 and unverified == 0 and pending == 0,
        }
        add_audit_event(
            session,
            principal,
            action="candidate.batch_apply_finish",
            outcome="success" if failed == 0 and unverified == 0 and pending == 0 else "partial",
            request_id=request_id,
            target_type="candidate",
            target_id=candidate.id,
            details=summary,
        )
        session.commit()
        session.refresh(candidate)
        return candidate


def apply_approved_batch(
    session_factory: Callable[[], Session],
    principal: ClientPrincipal,
    candidate_id: str,
    *,
    request_id: str | None,
) -> MemoryCandidate:
    attempt_id, item_ids = _start_attempt(
        session_factory,
        principal,
        candidate_id,
        request_id=request_id,
    )
    for item_id in item_ids:
        with session_factory() as inspection:
            item = inspection.get(CandidateItem, item_id)
            if item is None:
                continue
            if item.execution_state == "applied":
                if item.verified_at is None:
                    try:
                        _verify_committed_item(
                            session_factory,
                            principal,
                            item_id,
                            request_id=request_id,
                        )
                    except Exception:
                        _mark_item_unverified(
                            session_factory,
                            principal,
                            item_id,
                            request_id=request_id,
                        )
                continue
            if item.execution_state == "skipped":
                continue
            if item.execution_state == "unverified":
                try:
                    _verify_committed_item(
                        session_factory,
                        principal,
                        item_id,
                        request_id=request_id,
                    )
                except Exception:
                    _mark_item_unverified(
                        session_factory,
                        principal,
                        item_id,
                        request_id=request_id,
                    )
                continue
        claim_token = _claim_item(session_factory, item_id)
        if claim_token is None:
            continue
        try:
            _execute_claimed_item(
                session_factory,
                principal,
                item_id,
                claim_token,
                request_id=request_id,
            )
        except Exception as exc:
            _mark_item_failed(
                session_factory,
                principal,
                item_id,
                error=exc,
                request_id=request_id,
            )
            continue
        try:
            _verify_committed_item(
                session_factory,
                principal,
                item_id,
                request_id=request_id,
            )
        except Exception:
            _mark_item_unverified(
                session_factory,
                principal,
                item_id,
                request_id=request_id,
            )
    return _finish_attempt(
        session_factory,
        principal,
        candidate_id,
        attempt_id,
        request_id=request_id,
    )
