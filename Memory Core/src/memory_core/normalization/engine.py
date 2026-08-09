from __future__ import annotations

from collections.abc import Callable

from sqlalchemy.orm import Session

from memory_core.normalization.models import BatchPlan, MediaExperienceBatchProposal
from memory_core.normalization.planner import plan_media_experience_batch
from memory_core.normalization.profiles import (
    NormalizationProfile,
    get_normalization_profile,
)
from memory_core.security import ClientPrincipal

BatchPlanner = Callable[
    [Session, ClientPrincipal, MediaExperienceBatchProposal, NormalizationProfile],
    BatchPlan,
]


def _plan_media(
    session: Session,
    principal: ClientPrincipal,
    proposal: MediaExperienceBatchProposal,
    profile: NormalizationProfile,
) -> BatchPlan:
    return plan_media_experience_batch(
        session,
        principal,
        proposal,
        profile=profile,
    )


_HANDLERS: dict[str, BatchPlanner] = {
    "media_experience_v1": _plan_media,
}


def plan_normalization_batch(
    session: Session,
    principal: ClientPrincipal,
    proposal: MediaExperienceBatchProposal,
) -> BatchPlan:
    profile = get_normalization_profile(proposal.profile_id, proposal.profile_version)
    handler = _HANDLERS.get(profile.handler)
    if handler is None:
        # Profile loading already enforces an allowlist; retain a second dispatch guard so a
        # registry/code mismatch cannot silently fall back to another planner.
        raise ValueError(f"Normalization handler is not registered: {profile.handler}")
    return handler(session, principal, proposal, profile)
