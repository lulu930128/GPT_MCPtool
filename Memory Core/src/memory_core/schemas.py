from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic_core import PydanticCustomError

from memory_core.normalization.models import MediaExperienceBatchProposal
from memory_core.temporal import (
    IanaTimezoneName,
    TemporalValidationIssue,
    TimezoneAwareDatetime,
    validate_record_temporal_state,
)


def _raise_temporal_validation_error(issue: TemporalValidationIssue) -> None:
    context: dict[str, object] = {"field": issue.field}
    if issue.example is not None:
        context["example"] = issue.example
    raise PydanticCustomError(issue.code, issue.message, context)


class ApiModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class StrictApiModel(ApiModel):
    model_config = ConfigDict(from_attributes=True, extra="forbid")


class RecordKind(StrEnum):
    EVENT = "event"
    REFLECTION = "reflection"
    DECISION = "decision"
    FACT = "fact"
    STATE = "state"
    NOTE = "note"
    IDEA = "idea"


class DatePrecision(StrEnum):
    EXACT = "exact"
    DAY = "day"
    MONTH = "month"
    YEAR = "year"
    APPROXIMATE = "approximate"
    UNKNOWN = "unknown"


class Sensitivity(StrEnum):
    PUBLIC = "public"
    PERSONAL = "personal"
    SENSITIVE = "sensitive"
    RESTRICTED = "restricted"


class HandlingPolicy(StrEnum):
    NORMAL = "normal"
    COMPANY_SANITIZED = "company_sanitized"
    COMPANY_RESTRICTED = "company_restricted"


class RecordCreate(ApiModel):
    kind: RecordKind
    domain: str = Field(default="general", min_length=1, max_length=80)
    title: str = Field(min_length=1, max_length=300)
    summary: str | None = None
    body_markdown: str | None = None
    occurred_start: TimezoneAwareDatetime | None = None
    occurred_end: TimezoneAwareDatetime | None = None
    date_precision: DatePrecision = DatePrecision.UNKNOWN
    timezone_name: IanaTimezoneName | None = None
    importance: int = Field(default=50, ge=0, le=100)
    verification_status: Literal["confirmed", "disputed"] = "confirmed"
    sensitivity: Sensitivity = Sensitivity.PERSONAL
    handling_policy: HandlingPolicy = HandlingPolicy.NORMAL
    schema_name: str = Field(default="generic", min_length=1, max_length=100)
    schema_version: int = Field(default=1, ge=1)
    payload: dict[str, Any] = Field(default_factory=dict)
    source_type: str = Field(default="manual", min_length=1, max_length=40)
    source_reference: str | None = None
    supersedes_id: str | None = None

    @model_validator(mode="after")
    def validate_occurrence_range(self) -> RecordCreate:
        try:
            validate_record_temporal_state(
                occurred_start=self.occurred_start,
                occurred_end=self.occurred_end,
                date_precision=self.date_precision.value,
            )
        except TemporalValidationIssue as issue:
            _raise_temporal_validation_error(issue)
        if (
            self.handling_policy == HandlingPolicy.COMPANY_RESTRICTED
            and self.sensitivity != Sensitivity.RESTRICTED
        ):
            raise ValueError("company_restricted records must use restricted sensitivity")
        return self


class RecordUpdatePatch(ApiModel):
    title: str | None = Field(default=None, min_length=1, max_length=300)
    summary: str | None = None
    body_markdown: str | None = None
    occurred_start: TimezoneAwareDatetime | None = None
    occurred_end: TimezoneAwareDatetime | None = None
    date_precision: DatePrecision = DatePrecision.UNKNOWN
    timezone_name: IanaTimezoneName | None = None
    importance: int | None = Field(default=None, ge=0, le=100)
    lifecycle_status: Literal["active", "superseded"] | None = None
    verification_status: Literal["confirmed", "disputed"] | None = None
    sensitivity: Sensitivity | None = None
    handling_policy: HandlingPolicy | None = None
    schema_name: str | None = Field(default=None, min_length=1, max_length=100)
    schema_version: int | None = Field(default=None, ge=1)
    payload: dict[str, Any] | None = None
    source_reference: str | None = None
    supersedes_id: str | None = None
    change_reason: str | None = None


class RecordUpdate(RecordUpdatePatch):
    expected_version: int = Field(ge=1)


class RecordRead(ApiModel):
    id: str
    kind: str
    domain: str
    title: str
    summary: str | None
    body_markdown: str | None
    occurred_start: datetime | None
    occurred_end: datetime | None
    date_precision: str
    timezone_name: str | None
    importance: int
    lifecycle_status: str
    verification_status: str
    sensitivity: str
    handling_policy: str
    schema_name: str
    schema_version: int
    payload: dict[str, Any]
    source_type: str
    source_reference: str | None
    supersedes_id: str | None
    version: int
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None


class EntityCreate(ApiModel):
    entity_type: str = Field(min_length=1, max_length=60)
    name: str = Field(min_length=1, max_length=300)
    canonical_name: str | None = Field(default=None, max_length=300)
    description: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    sensitivity: Sensitivity = Sensitivity.PERSONAL
    handling_policy: HandlingPolicy = HandlingPolicy.NORMAL

    @model_validator(mode="after")
    def validate_handling_policy(self) -> EntityCreate:
        if (
            self.handling_policy == HandlingPolicy.COMPANY_RESTRICTED
            and self.sensitivity != Sensitivity.RESTRICTED
        ):
            raise ValueError("company_restricted entities must use restricted sensitivity")
        return self


class EntityUpdatePatch(ApiModel):
    name: str | None = Field(default=None, min_length=1, max_length=300)
    canonical_name: str | None = Field(default=None, max_length=300)
    description: str | None = None
    payload: dict[str, Any] | None = None
    sensitivity: Sensitivity | None = None
    handling_policy: HandlingPolicy | None = None
    change_reason: str | None = None


class EntityUpdate(EntityUpdatePatch):
    expected_version: int = Field(ge=1)


class EntityRead(ApiModel):
    id: str
    entity_type: str
    name: str
    canonical_name: str | None
    description: str | None
    payload: dict[str, Any]
    sensitivity: str
    handling_policy: str
    version: int
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None


class TagCreate(ApiModel):
    name: str = Field(min_length=1, max_length=120)
    category: str | None = Field(default=None, max_length=80)


class TagRead(ApiModel):
    id: str
    name: str
    category: str | None
    created_at: datetime


class RecordEntityLinkCreate(ApiModel):
    entity_id: str
    role: str = Field(default="related", min_length=1, max_length=80)


class RecordTagLinkCreate(ApiModel):
    tag_id: str


class RecordLinkRead(ApiModel):
    id: str
    link_ref: str
    source_ref: str
    role: str
    target_ref: str
    target_revision_no: int | None
    status: Literal["active", "removed"]
    created_at: datetime
    updated_at: datetime
    removed_at: datetime | None


class EntityRelationCreate(ApiModel):
    subject_entity_id: str
    predicate: str = Field(min_length=1, max_length=120)
    object_entity_id: str
    valid_from: TimezoneAwareDatetime | None = None
    valid_to: TimezoneAwareDatetime | None = None
    source_record_id: str | None = None


class EntityRelationRead(EntityRelationCreate):
    id: str
    created_at: datetime


class CandidateCreate(StrictApiModel):
    operation: Literal["create", "update", "archive"]
    target_type: Literal["record", "entity"]
    target_id: str | None = None
    base_version: int | None = Field(default=None, ge=1)
    proposed_content: dict[str, Any] = Field(default_factory=dict)
    source_type: str = Field(min_length=1, max_length=40)
    source_reference: str | None = None
    idempotency_key: str = Field(min_length=1, max_length=160)
    confidence: float | None = Field(default=None, ge=0, le=1)
    risk_flags: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_target(self) -> CandidateCreate:
        if self.operation == "create":
            if self.target_id is not None or self.base_version is not None:
                raise ValueError("create candidates cannot specify target_id or base_version")
        elif self.target_id is None or self.base_version is None:
            raise ValueError("update/archive candidates require target_id and base_version")
        if self.operation == "archive" and self.proposed_content:
            allowed = {"change_reason", "merged_into_ref"}
            if set(self.proposed_content) - allowed:
                raise ValueError(
                    "archive candidate content may only contain change_reason and merged_into_ref"
                )
            merged_into_ref = self.proposed_content.get("merged_into_ref")
            if merged_into_ref is not None:
                expected_prefix = f"{self.target_type}:"
                if (
                    not isinstance(merged_into_ref, str)
                    or not merged_into_ref.startswith(expected_prefix)
                    or merged_into_ref == f"{expected_prefix}{self.target_id}"
                ):
                    raise ValueError(
                        f"merged_into_ref must reference a different {self.target_type}"
                    )
        return self


class CandidateRecordEntityLink(StrictApiModel):
    entity_ref: str = Field(
        min_length=8,
        max_length=200,
        pattern=r"^entity:[^:]+$",
    )
    role: str = Field(default="related", min_length=1, max_length=80)


class CandidateEntityRelation(StrictApiModel):
    predicate: str = Field(min_length=1, max_length=120)
    object_entity_ref: str = Field(
        min_length=8,
        max_length=200,
        pattern=r"^entity:[^:]+$",
    )
    valid_from: TimezoneAwareDatetime | None = None
    valid_to: TimezoneAwareDatetime | None = None
    source_record_ref: str | None = Field(
        default=None,
        min_length=8,
        max_length=200,
        pattern=r"^record:[^:]+$",
    )

    @model_validator(mode="after")
    def validate_relation_range(self) -> CandidateEntityRelation:
        if self.valid_from and self.valid_to and self.valid_to < self.valid_from:
            raise ValueError("valid_to must not be earlier than valid_from")
        return self


class CandidateRecordCreate(RecordCreate):
    model_config = ConfigDict(from_attributes=True, extra="forbid")
    entity_links: list[CandidateRecordEntityLink] = Field(
        default_factory=list,
        max_length=50,
    )


class CandidateRecordUpdatePatch(RecordUpdatePatch):
    model_config = ConfigDict(from_attributes=True, extra="forbid")
    entity_links: list[CandidateRecordEntityLink] = Field(
        default_factory=list,
        max_length=50,
    )

    @model_validator(mode="after")
    def require_data_change(self) -> CandidateRecordUpdatePatch:
        if not (self.model_fields_set - {"change_reason"}):
            raise ValueError("record update candidate must change at least one data field")
        return self


class CandidateEntityCreate(EntityCreate):
    model_config = ConfigDict(from_attributes=True, extra="forbid")
    relations: list[CandidateEntityRelation] = Field(
        default_factory=list,
        max_length=50,
    )


class CandidateEntityUpdatePatch(EntityUpdatePatch):
    model_config = ConfigDict(from_attributes=True, extra="forbid")
    relations: list[CandidateEntityRelation] = Field(
        default_factory=list,
        max_length=50,
    )

    @model_validator(mode="after")
    def require_data_change(self) -> CandidateEntityUpdatePatch:
        if not (self.model_fields_set - {"change_reason"}):
            raise ValueError("entity update candidate must change at least one data field")
        return self


class RecordCreateChange(StrictApiModel):
    change_type: Literal["record_create"]
    content: CandidateRecordCreate


class RecordUpdateChange(StrictApiModel):
    change_type: Literal["record_update"]
    target_id: str = Field(min_length=1, max_length=36)
    base_version: int = Field(ge=1)
    content: CandidateRecordUpdatePatch


class RecordArchiveChange(StrictApiModel):
    change_type: Literal["record_archive"]
    target_id: str = Field(min_length=1, max_length=36)
    base_version: int = Field(ge=1)
    change_reason: str | None = Field(default=None, max_length=1000)
    merged_into_ref: str | None = Field(
        default=None,
        min_length=8,
        max_length=200,
        pattern=r"^record:[^:]+$",
    )

    @model_validator(mode="after")
    def validate_merge_target(self) -> RecordArchiveChange:
        if self.merged_into_ref == f"record:{self.target_id}":
            raise ValueError("merged_into_ref must reference a different record")
        return self


class EntityCreateChange(StrictApiModel):
    change_type: Literal["entity_create"]
    content: CandidateEntityCreate


class EntityUpdateChange(StrictApiModel):
    change_type: Literal["entity_update"]
    target_id: str = Field(min_length=1, max_length=36)
    base_version: int = Field(ge=1)
    content: CandidateEntityUpdatePatch


class EntityArchiveChange(StrictApiModel):
    change_type: Literal["entity_archive"]
    target_id: str = Field(min_length=1, max_length=36)
    base_version: int = Field(ge=1)
    change_reason: str | None = Field(default=None, max_length=1000)
    merged_into_ref: str | None = Field(
        default=None,
        min_length=8,
        max_length=200,
        pattern=r"^entity:[^:]+$",
    )

    @model_validator(mode="after")
    def validate_merge_target(self) -> EntityArchiveChange:
        if self.merged_into_ref == f"entity:{self.target_id}":
            raise ValueError("merged_into_ref must reference a different entity")
        return self


CandidateChange = Annotated[
    RecordCreateChange
    | RecordUpdateChange
    | RecordArchiveChange
    | EntityCreateChange
    | EntityUpdateChange
    | EntityArchiveChange,
    Field(discriminator="change_type"),
]


class CandidateProposal(StrictApiModel):
    change: CandidateChange
    source_type: str = Field(min_length=1, max_length=40)
    source_reference: str | None = Field(default=None, max_length=1000)
    idempotency_key: str = Field(min_length=1, max_length=160)
    confidence: float | None = Field(default=None, ge=0, le=1)
    risk_flags: list[str] = Field(default_factory=list, max_length=20)

    def to_candidate_create(self) -> CandidateCreate:
        change = self.change
        common = {
            "source_type": self.source_type,
            "source_reference": self.source_reference,
            "idempotency_key": self.idempotency_key,
            "confidence": self.confidence,
            "risk_flags": self.risk_flags,
        }
        if isinstance(change, RecordCreateChange):
            return CandidateCreate(
                operation="create",
                target_type="record",
                proposed_content=change.content.model_dump(mode="json"),
                **common,
            )
        if isinstance(change, RecordUpdateChange):
            return CandidateCreate(
                operation="update",
                target_type="record",
                target_id=change.target_id,
                base_version=change.base_version,
                proposed_content=change.content.model_dump(exclude_unset=True, mode="json"),
                **common,
            )
        if isinstance(change, RecordArchiveChange):
            content = change.model_dump(
                mode="json",
                exclude={"change_type", "target_id", "base_version"},
                exclude_none=True,
            )
            return CandidateCreate(
                operation="archive",
                target_type="record",
                target_id=change.target_id,
                base_version=change.base_version,
                proposed_content=content,
                **common,
            )
        if isinstance(change, EntityCreateChange):
            return CandidateCreate(
                operation="create",
                target_type="entity",
                proposed_content=change.content.model_dump(mode="json"),
                **common,
            )
        if isinstance(change, EntityUpdateChange):
            return CandidateCreate(
                operation="update",
                target_type="entity",
                target_id=change.target_id,
                base_version=change.base_version,
                proposed_content=change.content.model_dump(exclude_unset=True, mode="json"),
                **common,
            )
        content = change.model_dump(
            mode="json",
            exclude={"change_type", "target_id", "base_version"},
            exclude_none=True,
        )
        return CandidateCreate(
            operation="archive",
            target_type="entity",
            target_id=change.target_id,
            base_version=change.base_version,
            proposed_content=content,
            **common,
        )


class ChangeSetRecordCreateChange(StrictApiModel):
    change_type: Literal["record_create"]
    content: dict[str, Any]


class ChangeSetRecordUpdateChange(StrictApiModel):
    change_type: Literal["record_update"]
    target_id: str = Field(min_length=1, max_length=36)
    base_version: int = Field(ge=1)
    content: dict[str, Any]


ChangeSetChange = Annotated[
    ChangeSetRecordCreateChange | ChangeSetRecordUpdateChange,
    Field(discriminator="change_type"),
]


class ChangeSetOperationProposal(StrictApiModel):
    op_id: str = Field(
        min_length=1,
        max_length=64,
        pattern=r"^[a-z][a-z0-9_-]{0,63}$",
    )
    change: ChangeSetChange


class ChangeSetProposal(StrictApiModel):
    summary: str = Field(min_length=1, max_length=500)
    atomic: Literal[True] = True
    operations: list[ChangeSetOperationProposal] = Field(min_length=1, max_length=20)
    source_type: str = Field(min_length=1, max_length=40)
    source_reference: str | None = Field(default=None, max_length=1000)
    idempotency_key: str = Field(min_length=1, max_length=160)
    confidence: float | None = Field(default=None, ge=0, le=1)
    risk_flags: list[str] = Field(default_factory=list, max_length=20)


class CandidateOperationRead(ApiModel):
    op_id: str
    position: int
    change_type: str
    change_data: dict[str, Any]


class CandidateResultRead(ApiModel):
    op_id: str
    position: int
    change_type: str
    result_type: Literal["record", "entity"]
    result_id: str
    result_ref: str
    result_version: int


class CandidateRead(ApiModel):
    id: str
    candidate_kind: Literal["single", "change_set", "batch"] = "single"
    summary: str | None = None
    operation: str | None
    target_type: str | None
    target_id: str | None
    base_version: int | None
    proposed_content: dict[str, Any]
    source_type: str
    source_reference: str | None
    source_client_id: str
    idempotency_key: str
    content_hash: str
    review_digest: str
    review_digest_version: int
    confidence: float | None
    validation_result: dict[str, Any]
    risk_flags: list[str]
    status: str
    created_at: datetime
    expires_at: datetime | None
    reviewed_at: datetime | None
    reviewed_by_client_id: str | None
    review_prepared_by_client_id: str | None
    review_challenge_expires_at: datetime | None
    review_action: str | None
    review_note: str | None
    review_idempotency_key: str | None
    result_id: str | None
    result_version: int | None
    operations: list[CandidateOperationRead] = Field(default_factory=list)
    results: list[CandidateResultRead] = Field(default_factory=list)


class MediaExperienceBatchCandidateProposal(MediaExperienceBatchProposal):
    source_type: str = Field(min_length=1, max_length=40)
    source_reference: str | None = Field(default=None, max_length=1000)
    idempotency_key: str = Field(min_length=1, max_length=160)
    confidence: float | None = Field(default=None, ge=0, le=1)
    risk_flags: list[str] = Field(default_factory=list, max_length=20)

    def to_normalization_proposal(self) -> MediaExperienceBatchProposal:
        return MediaExperienceBatchProposal.model_validate(
            self.model_dump(
                mode="python",
                include={"profile_id", "profile_version", "summary", "items"},
            )
        )


class MediaExperienceBatchRevisionProposal(MediaExperienceBatchProposal):
    expected_revision_no: int = Field(ge=1)

    def to_normalization_proposal(self) -> MediaExperienceBatchProposal:
        return MediaExperienceBatchProposal(
            profile_id=self.profile_id,
            profile_version=self.profile_version,
            summary=self.summary,
            items=self.items,
        )


class BatchItemOperationRead(ApiModel):
    op_id: str
    position: int
    change_type: str
    change_data: dict[str, Any]


class BatchItemResultRead(ApiModel):
    op_id: str
    position: int
    operation_outcome: str
    result_kind: str
    result_ref: str | None
    result_locator: dict[str, Any]
    result_version: int | None
    verify_status: str
    verify_error_code: str | None
    verified_at: datetime | None


class CandidateItemRead(ApiModel):
    id: str
    unit_key: str
    position: int
    source_index: int
    input_snapshot: dict[str, Any]
    normalized_snapshot: dict[str, Any]
    input_hash: str
    plan_hash: str
    decision: str
    execution_state: str
    warnings: list[dict[str, Any]]
    error_code: str | None
    error_message: str | None
    execution_error_code: str | None
    execution_error_message: str | None
    retry_policy: str
    attempt_count: int
    applied_at: datetime | None
    verified_at: datetime | None
    operations: list[BatchItemOperationRead]
    results: list[BatchItemResultRead]


class BatchExecutionSummaryRead(ApiModel):
    item_count: int = Field(ge=0)
    applied: int = Field(ge=0)
    skipped: int = Field(ge=0)
    failed: int = Field(ge=0)
    unverified: int = Field(ge=0)
    pending: int = Field(ge=0)


class CandidateItemPageRead(ApiModel):
    candidate_id: str
    batch_id: str
    revision_no: int = Field(ge=1)
    total: int = Field(ge=0)
    limit: int = Field(ge=1)
    offset: int = Field(ge=0)
    truncated: bool
    items: list[CandidateItemRead]


class CandidateBatchRead(ApiModel):
    candidate: CandidateRead
    batch_id: str
    profile_id: str
    profile_version: int
    profile_hash: str
    normalizer_version: str
    current_revision_no: int
    plan_state: str
    review_state: str
    execution_state: str
    item_count: int
    input_hash: str
    plan_hash: str
    sealed_at: datetime | None
    execution_summary: BatchExecutionSummaryRead
    items: list[CandidateItemRead]


class CandidatePrepareReview(StrictApiModel):
    expected_review_digest: str = Field(min_length=1, max_length=100)


class CandidateReviewChallenge(ApiModel):
    candidate: CandidateRead
    approval_challenge: str = Field(min_length=32, max_length=200)
    challenge_expires_at: datetime


class CandidateApprove(StrictApiModel):
    expected_review_digest: str = Field(min_length=1, max_length=100)
    approval_challenge: str = Field(min_length=32, max_length=200)
    idempotency_key: str = Field(min_length=1, max_length=160)
    review_note: str | None = Field(default=None, max_length=1000)


class CandidateReject(StrictApiModel):
    reason: str = Field(min_length=1, max_length=1000)
    expected_review_digest: str = Field(min_length=1, max_length=100)
    approval_challenge: str = Field(min_length=32, max_length=200)
    idempotency_key: str = Field(min_length=1, max_length=160)


class CollectionRead(ApiModel):
    id: str
    key: str
    name: str
    description: str | None
    domain: str | None
    lifecycle_status: str
    version: int
    member_count: int = Field(ge=0)
    created_at: datetime
    updated_at: datetime


class CollectionMemberRead(ApiModel):
    record: RecordRead
    position: int | None
    created_at: datetime
    updated_at: datetime


class CollectionDetailRead(CollectionRead):
    members: list[CollectionMemberRead]


class SearchResult(ApiModel):
    result_type: Literal["record", "entity"]
    id: str
    title: str
    summary: str | None
    domain: str | None
    kind: str | None
    sensitivity: str
    updated_at: datetime
    score: float
    matched_fields: list[str]
    matched_terms: list[str]
    query_strategy: Literal[
        "exact_title",
        "token_coverage",
        "token_fallback",
        "fts_or_substring",
    ]
    normalized_query: str


class RecordOverviewCounts(ApiModel):
    active: int = Field(ge=0)
    superseded: int = Field(ge=0)
    archived: int = Field(ge=0)


class EntityOverviewCounts(ApiModel):
    active: int = Field(ge=0)
    archived: int = Field(ge=0)


class MemoryIndexOverview(ApiModel):
    status: Literal["healthy", "out_of_sync", "unavailable"]
    engine: Literal["sqlite_fts5"]
    searchable_records: int = Field(ge=0)
    indexed_records: int = Field(ge=0)
    last_indexed_at: datetime | None


class MemoryOverview(ApiModel):
    generated_at: datetime
    scope: Literal["visible"]
    restricted_included: bool
    records: RecordOverviewCounts
    entities: EntityOverviewCounts
    domains: dict[str, int]
    domain_taxonomy: dict[str, Literal["canonical", "legacy", "custom"]]
    schema_versions: dict[str, int]
    index: MemoryIndexOverview


class CandidateStatusCounts(ApiModel):
    pending: int = Field(ge=0)
    applied: int = Field(ge=0)
    rejected: int = Field(ge=0)
    conflict: int = Field(ge=0)
    expired: int = Field(ge=0)


class DuplicateFinding(ApiModel):
    finding_type: Literal[
        "entity_identity_overlap",
        "record_canonical_overlap",
        "record_catalog_item_overlap",
        "record_title_overlap",
    ]
    refs: list[str] = Field(min_length=2)
    confidence: Literal["high", "medium"]
    matched_on: list[str] = Field(min_length=1)


class DuplicateScanResult(ApiModel):
    generated_at: datetime
    scanned_records: int = Field(ge=0)
    scanned_entities: int = Field(ge=0)
    scan_truncated: bool
    findings_truncated: bool
    findings: list[DuplicateFinding]


class OperationResult(ApiModel):
    id: str
    operation_type: str
    file_path: str
    content_hash: str
    counts: dict[str, int]
    created_at: datetime


class HealthResponse(ApiModel):
    status: Literal["ok", "degraded"]
    database: Literal["ok", "error"]
    version: str
    environment: str


class VersionResponse(ApiModel):
    name: str
    version: str
