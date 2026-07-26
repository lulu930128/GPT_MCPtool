from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, status

from memory_core.api.deps import ClientDep, RequestIdDep, SessionDep, require_scopes
from memory_core.errors import CandidateConflictError, CandidateExpiredError
from memory_core.schemas import (
    CandidateApprove,
    CandidatePrepareReview,
    CandidateProposal,
    CandidateRead,
    CandidateReject,
    CandidateReviewChallenge,
    CandidateStatusCounts,
)
from memory_core.services import candidates
from memory_core.services.overview import get_candidate_status_counts

router = APIRouter(prefix="/candidates", tags=["candidates"])

CandidateCreator = Annotated[ClientDep, Depends(require_scopes("candidates:create"))]
CandidateReviewer = Annotated[ClientDep, Depends(require_scopes("candidates:review"))]


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
    session: SessionDep,
    principal: CandidateReviewer,
    request_id: RequestIdDep,
) -> CandidateRead:
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
