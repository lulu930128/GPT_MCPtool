from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request, status

from memory_core.api.deps import ClientDep, RequestIdDep, SessionDep, require_scopes
from memory_core.errors import CandidateConflictError, CandidateExpiredError
from memory_core.schemas import (
    CandidateApprove,
    CandidateBatchRead,
    CandidateItemPageRead,
    CandidateItemRead,
    CandidatePrepareReview,
    CandidateProposal,
    CandidateRead,
    CandidateReject,
    CandidateReviewChallenge,
    CandidateStatusCounts,
    ChangeSetProposal,
    MediaExperienceBatchCandidateProposal,
    MediaExperienceBatchRevisionProposal,
)
from memory_core.services import batch_apply, batch_candidates, candidates, change_sets
from memory_core.services.overview import get_candidate_status_counts

router = APIRouter(prefix="/candidates", tags=["candidates"])

CandidateCreator = Annotated[ClientDep, Depends(require_scopes("candidates:create"))]
CandidateReviewer = Annotated[ClientDep, Depends(require_scopes("candidates:review"))]


def _execution_summary(items: list[object]) -> dict[str, int]:
    states = [str(getattr(item, "execution_state", "")) for item in items]
    applied = states.count("applied")
    skipped = states.count("skipped")
    failed = states.count("failed")
    unverified = states.count("unverified")
    pending = len(states) - applied - skipped - failed - unverified
    return {
        "item_count": len(states),
        "applied": applied,
        "skipped": skipped,
        "failed": failed,
        "unverified": unverified,
        "pending": pending,
    }


def _batch_read(candidate: object) -> CandidateBatchRead:
    candidate_read = CandidateRead.model_validate(candidate)
    batch = getattr(candidate, "batch", None)
    if batch is None:
        raise CandidateConflictError("Candidate is not a batch.")
    revision = batch_candidates.current_batch_revision(batch)
    current_items = [item for item in batch.items if item.batch_revision_id == revision.id]
    return CandidateBatchRead(
        candidate=candidate_read,
        batch_id=batch.id,
        profile_id=batch.profile_id,
        profile_version=batch.profile_version,
        profile_hash=batch.profile_hash,
        normalizer_version=batch.normalizer_version,
        current_revision_no=batch.current_revision_no,
        plan_state=batch.plan_state,
        review_state=batch.review_state,
        execution_state=batch.execution_state,
        item_count=batch.item_count,
        input_hash=revision.input_hash,
        plan_hash=revision.plan_hash,
        sealed_at=revision.sealed_at,
        execution_summary=_execution_summary(current_items),
        items=[CandidateItemRead.model_validate(item) for item in current_items],
    )


@router.post("", response_model=CandidateRead, status_code=status.HTTP_201_CREATED)
def create_candidate(
    payload: CandidateProposal,
    session: SessionDep,
    principal: CandidateCreator,
    request_id: RequestIdDep,
) -> CandidateRead:
    candidate = candidates.create_candidate(
        session,
        principal,
        payload.to_candidate_create(),
        request_id=request_id,
    )
    session.commit()
    return CandidateRead.model_validate(candidate)


@router.post(
    "/batches/media-experiences",
    response_model=CandidateBatchRead,
    status_code=status.HTTP_201_CREATED,
)
def create_media_experience_batch(
    payload: MediaExperienceBatchCandidateProposal,
    session: SessionDep,
    principal: CandidateCreator,
    request_id: RequestIdDep,
) -> CandidateBatchRead:
    candidate = batch_candidates.create_media_experience_batch(
        session,
        principal,
        payload.to_normalization_proposal(),
        source_type=payload.source_type,
        source_reference=payload.source_reference,
        idempotency_key=payload.idempotency_key,
        confidence=payload.confidence,
        risk_flags=payload.risk_flags,
        request_id=request_id,
    )
    session.commit()
    return _batch_read(candidate)


@router.get("/{candidate_id}/batch", response_model=CandidateBatchRead)
def get_candidate_batch(
    candidate_id: str,
    session: SessionDep,
    _principal: CandidateReviewer,
) -> CandidateBatchRead:
    return _batch_read(candidates.get_candidate(session, candidate_id))


@router.get("/{candidate_id}/items", response_model=CandidateItemPageRead)
def list_candidate_batch_items(
    candidate_id: str,
    session: SessionDep,
    _principal: CandidateReviewer,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
    execution_state: Literal[
        "not_started",
        "claimed",
        "applied",
        "failed",
        "unverified",
        "skipped",
    ]
    | None = None,
    decision: Literal["create", "update", "noop", "conflict", "invalid", "excluded"] | None = None,
) -> CandidateItemPageRead:
    candidate, total, items = batch_candidates.list_current_batch_items(
        session,
        candidate_id,
        limit=limit,
        offset=offset,
        execution_state=execution_state,
        decision=decision,
    )
    assert candidate.batch is not None
    return CandidateItemPageRead(
        candidate_id=candidate.id,
        batch_id=candidate.batch.id,
        revision_no=candidate.batch.current_revision_no,
        total=total,
        limit=limit,
        offset=offset,
        truncated=offset + len(items) < total,
        items=[CandidateItemRead.model_validate(item) for item in items],
    )


@router.get("/{candidate_id}/items/{item_id}", response_model=CandidateItemRead)
def get_candidate_batch_item(
    candidate_id: str,
    item_id: str,
    session: SessionDep,
    _principal: CandidateReviewer,
) -> CandidateItemRead:
    return CandidateItemRead.model_validate(
        batch_candidates.get_current_batch_item(session, candidate_id, item_id)
    )


@router.patch("/{candidate_id}/batch", response_model=CandidateBatchRead)
def revise_candidate_batch(
    candidate_id: str,
    payload: MediaExperienceBatchRevisionProposal,
    session: SessionDep,
    principal: CandidateReviewer,
    request_id: RequestIdDep,
) -> CandidateBatchRead:
    candidate = batch_candidates.revise_media_experience_batch(
        session,
        principal,
        candidate_id,
        payload.to_normalization_proposal(),
        expected_revision_no=payload.expected_revision_no,
        request_id=request_id,
    )
    session.commit()
    return _batch_read(candidate)


@router.post(
    "/change-sets",
    response_model=CandidateRead,
    status_code=status.HTTP_201_CREATED,
)
def create_change_set(
    payload: ChangeSetProposal,
    session: SessionDep,
    principal: CandidateCreator,
    request_id: RequestIdDep,
) -> CandidateRead:
    candidate = change_sets.create_change_set(
        session,
        principal,
        payload,
        request_id=request_id,
        candidate_ttl_seconds=int(candidates.CANDIDATE_TTL.total_seconds()),
    )
    session.commit()
    return CandidateRead.model_validate(candidate)


@router.get("", response_model=list[CandidateRead])
def list_candidates(
    session: SessionDep,
    _principal: CandidateReviewer,
    candidate_status: Annotated[
        Literal["pending", "applied", "rejected", "conflict", "expired"] | None,
        Query(alias="status"),
    ] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[CandidateRead]:
    items = candidates.list_candidates(
        session,
        status=candidate_status,
        limit=limit,
        offset=offset,
    )
    return [CandidateRead.model_validate(item) for item in items]


@router.get("/stats", response_model=CandidateStatusCounts)
def candidate_stats(
    session: SessionDep,
    _principal: CandidateReviewer,
) -> CandidateStatusCounts:
    return get_candidate_status_counts(session)


@router.get("/{candidate_id}", response_model=CandidateRead)
def get_candidate(
    candidate_id: str,
    session: SessionDep,
    _principal: CandidateReviewer,
) -> CandidateRead:
    candidate = candidates.get_candidate(session, candidate_id)
    return CandidateRead.model_validate(candidate)


@router.post("/{candidate_id}/prepare-review", response_model=CandidateReviewChallenge)
def prepare_candidate_review(
    candidate_id: str,
    payload: CandidatePrepareReview,
    session: SessionDep,
    principal: CandidateReviewer,
    request_id: RequestIdDep,
) -> CandidateReviewChallenge:
    try:
        prepared = candidates.prepare_candidate_review(
            session,
            principal,
            candidate_id,
            expected_review_digest=payload.expected_review_digest,
            request_id=request_id,
        )
    except CandidateExpiredError:
        session.commit()
        raise
    session.commit()
    return CandidateReviewChallenge(
        candidate=CandidateRead.model_validate(prepared.candidate),
        approval_challenge=prepared.approval_challenge,
        challenge_expires_at=prepared.challenge_expires_at,
    )


@router.post("/{candidate_id}/apply", response_model=CandidateRead)
def apply_candidate(
    candidate_id: str,
    payload: CandidateApprove,
    request: Request,
    session: SessionDep,
    principal: CandidateReviewer,
    request_id: RequestIdDep,
) -> CandidateRead:
    current = candidates.get_candidate(session, candidate_id)
    if current.candidate_kind == "batch":
        try:
            candidates.authorize_batch_candidate(
                session,
                principal,
                candidate_id,
                expected_review_digest=payload.expected_review_digest,
                approval_challenge=payload.approval_challenge,
                idempotency_key=payload.idempotency_key,
                review_note=payload.review_note,
                request_id=request_id,
            )
        except CandidateExpiredError:
            session.commit()
            raise
        session.commit()
        session_factory = request.app.state.database.session_factory
        batch_apply.apply_approved_batch(
            session_factory,
            principal,
            candidate_id,
            request_id=request_id,
        )
        with session_factory() as read_session:
            refreshed = candidates.get_candidate(read_session, candidate_id)
            return CandidateRead.model_validate(refreshed)
    try:
        candidate = candidates.apply_candidate(
            session,
            principal,
            candidate_id,
            expected_review_digest=payload.expected_review_digest,
            approval_challenge=payload.approval_challenge,
            idempotency_key=payload.idempotency_key,
            review_note=payload.review_note,
            request_id=request_id,
        )
    except CandidateExpiredError:
        session.commit()
        raise
    session.commit()
    if candidate.status == "conflict":
        raise CandidateConflictError(candidate.validation_result.get("error", "Version conflict"))
    return CandidateRead.model_validate(candidate)


@router.post("/{candidate_id}/reject", response_model=CandidateRead)
def reject_candidate(
    candidate_id: str,
    payload: CandidateReject,
    session: SessionDep,
    principal: CandidateReviewer,
    request_id: RequestIdDep,
) -> CandidateRead:
    try:
        candidate = candidates.reject_candidate(
            session,
            principal,
            candidate_id,
            reason=payload.reason,
            expected_review_digest=payload.expected_review_digest,
            approval_challenge=payload.approval_challenge,
            idempotency_key=payload.idempotency_key,
            request_id=request_id,
        )
    except CandidateExpiredError:
        session.commit()
        raise
    session.commit()
    return CandidateRead.model_validate(candidate)
