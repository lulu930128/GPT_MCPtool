from __future__ import annotations

from datetime import timedelta
from hmac import compare_digest

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from memory_core.db_types import utc_now
from memory_core.errors import CandidateConflictError, NotFoundError, OperationError
from memory_core.models import (
    BatchItemOperation,
    CandidateBatch,
    CandidateBatchRevision,
    CandidateItem,
    MemoryCandidate,
)
from memory_core.normalization.canonical import sha256_digest
from memory_core.normalization.engine import plan_normalization_batch
from memory_core.normalization.models import BatchPlan, MediaExperienceBatchProposal
from memory_core.security import ClientPrincipal
from memory_core.services.audit import add_audit_event

_BATCH_TTL = timedelta(days=7)
_BATCH_REVIEW_DIGEST_VERSION = 2


def _candidate_content_hash(
    *,
    proposal: MediaExperienceBatchProposal,
    source_type: str,
    source_reference: str | None,
    confidence: float | None,
    risk_flags: list[str],
) -> str:
    digest = sha256_digest(
        {
            "proposal": proposal.model_dump(mode="json"),
            "source_type": source_type,
            "source_reference": source_reference,
            "confidence": confidence,
            "risk_flags": sorted(risk_flags),
        }
    )
    return digest.removeprefix("sha256:")


def _review_material(batch: CandidateBatch, revision: CandidateBatchRevision) -> dict[str, object]:
    return {
        "version": _BATCH_REVIEW_DIGEST_VERSION,
        "candidate_id": batch.candidate_id,
        "batch_id": batch.id,
        "revision_no": revision.revision_no,
        "profile_id": batch.profile_id,
        "profile_version": batch.profile_version,
        "profile_hash": batch.profile_hash,
        "normalizer_version": batch.normalizer_version,
        "input_hash": revision.input_hash,
        "plan_hash": revision.plan_hash,
    }


def batch_review_digest(
    batch: CandidateBatch,
    revision: CandidateBatchRevision,
) -> str:
    digest = sha256_digest(_review_material(batch, revision)).removeprefix("sha256:")
    return f"sha256:v{_BATCH_REVIEW_DIGEST_VERSION}:{digest}"


def current_batch_revision(batch: CandidateBatch) -> CandidateBatchRevision:
    revision = next(
        (
            revision
            for revision in batch.revisions
            if revision.revision_no == batch.current_revision_no
        ),
        None,
    )
    if revision is None:
        raise OperationError(
            "Batch current revision is missing.",
            code="batch_revision_missing",
        )
    return revision


def get_batch_candidate(session: Session, candidate_id: str) -> MemoryCandidate:
    candidate = session.get(MemoryCandidate, candidate_id)
    if candidate is None:
        raise NotFoundError("Candidate")
    if candidate.candidate_kind != "batch" or candidate.batch is None:
        raise CandidateConflictError("Candidate is not a batch.")
    return candidate


def list_current_batch_items(
    session: Session,
    candidate_id: str,
    *,
    limit: int,
    offset: int,
    execution_state: str | None = None,
    decision: str | None = None,
) -> tuple[MemoryCandidate, int, list[CandidateItem]]:
    candidate = get_batch_candidate(session, candidate_id)
    assert candidate.batch is not None
    revision = current_batch_revision(candidate.batch)
    filters = [CandidateItem.batch_revision_id == revision.id]
    if execution_state is not None:
        filters.append(CandidateItem.execution_state == execution_state)
    if decision is not None:
        filters.append(CandidateItem.decision == decision)
    total = session.scalar(select(func.count()).select_from(CandidateItem).where(*filters)) or 0
    items = list(
        session.scalars(
            select(CandidateItem)
            .where(*filters)
            .order_by(CandidateItem.position)
            .limit(limit)
            .offset(offset)
        )
    )
    return candidate, int(total), items


def get_current_batch_item(
    session: Session,
    candidate_id: str,
    item_id: str,
) -> CandidateItem:
    candidate = get_batch_candidate(session, candidate_id)
    assert candidate.batch is not None
    revision = current_batch_revision(candidate.batch)
    item = session.scalar(
        select(CandidateItem).where(
            CandidateItem.id == item_id,
            CandidateItem.batch_revision_id == revision.id,
        )
    )
    if item is None:
        raise NotFoundError("Batch item")
    return item


def stored_review_digest(candidate: MemoryCandidate) -> str:
    batch = candidate.batch
    if batch is None:
        raise OperationError("Batch candidate is missing batch metadata.")
    return batch_review_digest(batch, current_batch_revision(batch))


def _validation_result(plan: BatchPlan) -> dict[str, object]:
    counts = {
        decision: sum(item.decision == decision for item in plan.items)
        for decision in ("create", "update", "noop", "conflict", "invalid", "excluded")
    }
    return {
        "valid": plan.state == "ready",
        "plan_state": plan.state,
        "item_count": len(plan.items),
        "counts": counts,
    }


def _candidate_summary(proposal: MediaExperienceBatchProposal, plan: BatchPlan) -> str:
    return proposal.summary or f"Media experience batch · {len(plan.items)} items"


def _candidate_proposed_content(
    proposal: MediaExperienceBatchProposal,
    plan: BatchPlan,
    *,
    revision_no: int,
) -> dict[str, object]:
    return {
        "profile_id": plan.profile_id,
        "profile_version": plan.profile_version,
        "revision_no": revision_no,
        "item_count": len(plan.items),
        "plan_state": plan.state,
        "summary": _candidate_summary(proposal, plan),
        "input_hash": plan.input_hash,
        "plan_hash": plan.plan_hash,
    }


def _persist_revision(
    session: Session,
    batch: CandidateBatch,
    proposal: MediaExperienceBatchProposal,
    plan: BatchPlan,
    *,
    revision_no: int,
) -> CandidateBatchRevision:
    input_snapshot = proposal.model_dump(mode="json")
    plan_snapshot = plan.model_dump(mode="json")
    revision = CandidateBatchRevision(
        batch=batch,
        revision_no=revision_no,
        input_snapshot=input_snapshot,
        input_hash=plan.input_hash,
        plan_snapshot=plan_snapshot,
        plan_hash=plan.plan_hash,
    )
    session.add(revision)
    session.flush()
    for position, item_plan in enumerate(plan.items):
        item = CandidateItem(
            batch=batch,
            batch_revision=revision,
            unit_key=item_plan.unit_key,
            position=position,
            source_index=item_plan.source_index,
            input_snapshot=item_plan.input_snapshot,
            normalized_snapshot=item_plan.normalized_snapshot,
            input_hash=item_plan.input_hash,
            plan_hash=item_plan.plan_hash,
            decision=item_plan.decision,
            execution_state=(
                "skipped" if item_plan.decision in {"noop", "excluded"} else "not_started"
            ),
            warnings=[warning.model_dump(mode="json") for warning in item_plan.warnings],
            error_code=item_plan.error_code,
            error_message=item_plan.error_message,
        )
        session.add(item)
        session.flush()
        for operation in item_plan.operations:
            session.add(
                BatchItemOperation(
                    candidate_item_id=item.id,
                    op_id=operation.op_id,
                    position=operation.position,
                    change_type=operation.change_type,
                    change_data=operation.change_data,
                )
            )
    session.flush()
    return revision


def create_media_experience_batch(
    session: Session,
    principal: ClientPrincipal,
    proposal: MediaExperienceBatchProposal,
    *,
    source_type: str,
    source_reference: str | None,
    idempotency_key: str,
    confidence: float | None,
    risk_flags: list[str],
    request_id: str | None,
) -> MemoryCandidate:
    if not source_type or len(source_type) > 40:
        raise OperationError(
            "source_type must contain between 1 and 40 characters.",
            field="source_type",
        )
    if not idempotency_key or len(idempotency_key) > 160:
        raise OperationError(
            "idempotency_key must contain between 1 and 160 characters.",
            field="idempotency_key",
        )
    if confidence is not None and not 0 <= confidence <= 1:
        raise OperationError("confidence must be between 0 and 1.", field="confidence")
    content_hash = _candidate_content_hash(
        proposal=proposal,
        source_type=source_type,
        source_reference=source_reference,
        confidence=confidence,
        risk_flags=risk_flags,
    )
    existing = session.scalar(
        select(MemoryCandidate).where(
            MemoryCandidate.source_client_id == principal.id,
            MemoryCandidate.idempotency_key == idempotency_key,
        )
    )
    if existing is not None:
        if existing.content_hash != content_hash:
            raise CandidateConflictError(
                "The idempotency key was already used for different candidate content"
            )
        if existing.candidate_kind != "batch":
            raise CandidateConflictError(
                "The idempotency key belongs to a different candidate kind"
            )
        return existing

    plan = plan_normalization_batch(session, principal, proposal)
    candidate = MemoryCandidate(
        candidate_kind="batch",
        summary=_candidate_summary(proposal, plan),
        operation=None,
        target_type=None,
        target_id=None,
        base_version=None,
        proposed_content={},
        source_type=source_type,
        source_reference=source_reference,
        source_client_id=principal.id,
        idempotency_key=idempotency_key,
        content_hash=content_hash,
        review_digest="pending",
        review_digest_version=_BATCH_REVIEW_DIGEST_VERSION,
        confidence=confidence,
        validation_result=_validation_result(plan),
        risk_flags=sorted(set(risk_flags)),
        status="pending",
        expires_at=utc_now() + _BATCH_TTL,
    )
    session.add(candidate)
    session.flush()
    batch = CandidateBatch(
        candidate_id=candidate.id,
        profile_id=plan.profile_id,
        profile_version=plan.profile_version,
        profile_hash=plan.profile_hash,
        normalizer_version=plan.normalizer_version,
        input_hash=plan.input_hash,
        current_revision_no=1,
        plan_state=plan.state,
        review_state="pending",
        execution_state="not_started",
        item_count=len(plan.items),
    )
    session.add(batch)
    session.flush()
    revision = _persist_revision(session, batch, proposal, plan, revision_no=1)
    candidate.proposed_content = _candidate_proposed_content(proposal, plan, revision_no=1)
    candidate.review_digest = batch_review_digest(batch, revision)
    add_audit_event(
        session,
        principal,
        action="candidate.batch_create",
        outcome="success",
        request_id=request_id,
        target_type="candidate",
        target_id=candidate.id,
        details={
            "batch_id": batch.id,
            "profile_id": batch.profile_id,
            "profile_version": batch.profile_version,
            "item_count": batch.item_count,
            "plan_state": batch.plan_state,
            "plan_hash": revision.plan_hash,
        },
    )
    session.flush()
    return candidate


def revise_media_experience_batch(
    session: Session,
    principal: ClientPrincipal,
    candidate_id: str,
    proposal: MediaExperienceBatchProposal,
    *,
    expected_revision_no: int,
    request_id: str | None,
) -> MemoryCandidate:
    candidate = session.get(MemoryCandidate, candidate_id)
    if candidate is None or candidate.candidate_kind != "batch" or candidate.batch is None:
        raise NotFoundError("batch candidate")
    batch = candidate.batch
    if candidate.status != "pending" or batch.review_state != "pending":
        raise CandidateConflictError("Only an unprepared pending batch can be revised.")
    if batch.plan_state == "sealed":
        raise CandidateConflictError("A sealed batch cannot be revised.")
    if batch.current_revision_no != expected_revision_no:
        raise CandidateConflictError(
            f"Expected batch revision {expected_revision_no}, "
            f"but current revision is {batch.current_revision_no}."
        )
    if proposal.profile_id != batch.profile_id or proposal.profile_version != batch.profile_version:
        raise OperationError(
            "A batch revision cannot change its normalization profile.",
            code="batch_profile_change_forbidden",
        )
    plan = plan_normalization_batch(session, principal, proposal)
    revision_no = batch.current_revision_no + 1
    revision = _persist_revision(
        session,
        batch,
        proposal,
        plan,
        revision_no=revision_no,
    )
    batch.current_revision_no = revision_no
    batch.input_hash = plan.input_hash
    batch.plan_state = plan.state
    batch.item_count = len(plan.items)
    batch.updated_at = utc_now()
    candidate.summary = _candidate_summary(proposal, plan)
    candidate.proposed_content = _candidate_proposed_content(
        proposal,
        plan,
        revision_no=revision_no,
    )
    candidate.review_digest = batch_review_digest(batch, revision)
    candidate.validation_result = _validation_result(plan)
    candidate.review_challenge_hash = None
    candidate.review_challenge_expires_at = None
    add_audit_event(
        session,
        principal,
        action="candidate.batch_revise",
        outcome="success",
        request_id=request_id,
        target_type="candidate",
        target_id=candidate.id,
        details={
            "batch_id": batch.id,
            "revision_no": revision_no,
            "plan_state": batch.plan_state,
            "plan_hash": revision.plan_hash,
        },
    )
    session.flush()
    return candidate


def prepare_batch_for_review(candidate: MemoryCandidate) -> None:
    if candidate.candidate_kind != "batch" or candidate.batch is None:
        return
    batch = candidate.batch
    if batch.plan_state == "blocked":
        raise CandidateConflictError(
            "Blocked batch items must be resolved or excluded before review."
        )
    if batch.plan_state not in {"ready", "sealed"}:
        raise CandidateConflictError("Batch plan is not ready for review.")
    revision = current_batch_revision(batch)
    current_digest = batch_review_digest(batch, revision)
    if not compare_digest(candidate.review_digest, current_digest):
        raise CandidateConflictError("Batch plan changed before review preparation.")
    if revision.sealed_at is None:
        revision.review_digest = current_digest
        revision.sealed_at = utc_now()
    batch.plan_state = "sealed"
    batch.review_state = "prepared"
    batch.updated_at = utc_now()
