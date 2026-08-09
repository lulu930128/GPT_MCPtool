from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator


class McpModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ToolErrorDetail(McpModel):
    code: str
    message: str
    field: str | None = None
    received_value: str | int | float | bool | None = None
    example: str | int | float | bool | None = None


class ToolOutput(McpModel):
    ok: bool = True
    error: ToolErrorDetail | None = None

    @classmethod
    def failure(
        cls,
        *,
        code: str,
        message: str,
        field: str | None = None,
        received_value: str | int | float | bool | None = None,
        example: str | int | float | bool | None = None,
    ) -> Self:
        return cls(
            ok=False,
            error=ToolErrorDetail(
                code=code,
                message=message,
                field=field,
                received_value=received_value,
                example=example,
            ),
        )


class SearchItem(McpModel):
    id: str
    result_type: Literal["record", "entity"]
    title: str
    url: str
    snippet: str | None = None
    domain: str | None = None
    kind: str | None = None
    updated_at: datetime | None = None
    score: float = 0
    matched_fields: list[str] = Field(default_factory=list)
    matched_terms: list[str] = Field(default_factory=list)
    query_strategy: str = "backend_default"
    normalized_query: str = ""


class SearchToolOutput(ToolOutput):
    results: list[SearchItem] = Field(default_factory=list)


class FetchToolOutput(ToolOutput):
    id: str | None = None
    title: str | None = None
    text: str | None = None
    url: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class RecordRevisionToolOutput(ToolOutput):
    record_ref: str | None = None
    revision_no: int | None = None
    current_version: int | None = None
    is_current: bool | None = None
    title: str | None = None
    text: str | None = None
    url: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class RecordLinkToolItem(McpModel):
    link_ref: str
    source_ref: str
    role: str
    target_ref: str
    target_revision_no: int | None
    status: Literal["active", "removed"]
    created_at: datetime
    updated_at: datetime
    removed_at: datetime | None


class RecordLinkListToolOutput(ToolOutput):
    record_ref: str | None = None
    direction: Literal["outbound", "inbound"] | None = None
    links: list[RecordLinkToolItem] = Field(default_factory=list)


class MemoryOverviewToolOutput(ToolOutput):
    generated_at: datetime | None = None
    scope: str | None = None
    restricted_included: bool | None = None
    records: dict[str, int] = Field(default_factory=dict)
    entities: dict[str, int] = Field(default_factory=dict)
    domains: dict[str, int] = Field(default_factory=dict)
    domain_taxonomy: dict[str, str] = Field(default_factory=dict)
    schema_versions: dict[str, int] = Field(default_factory=dict)
    index: dict[str, Any] = Field(default_factory=dict)
    candidates: dict[str, int] | None = None
    candidate_counts_available: bool = False
    warnings: list[str] = Field(default_factory=list)


class DuplicateFindingToolItem(McpModel):
    finding_type: str
    refs: list[str]
    confidence: str
    matched_on: list[str]


class DuplicateScanToolOutput(ToolOutput):
    generated_at: datetime | None = None
    scanned_records: int = 0
    scanned_entities: int = 0
    scan_truncated: bool = False
    findings_truncated: bool = False
    findings: list[DuplicateFindingToolItem] = Field(default_factory=list)


class ChangeSetOperationToolInput(McpModel):
    op_id: str = Field(
        min_length=1,
        max_length=64,
        pattern=r"^[a-z][a-z0-9_-]{0,63}$",
        description="Unique operation id used by local references such as op:recipe.",
    )
    action: Literal["record_create", "record_update"]
    content: dict[str, Any] = Field(
        description=(
            "Record create content or update patch. Registered reference fields may use "
            "op:<op_id>; arbitrary text fields may not."
        )
    )
    target_ref: str | None = Field(
        default=None,
        description="Required stable record:<id> only for record_update.",
    )
    base_version: int | None = Field(
        default=None,
        ge=1,
        description="Required exact current version only for record_update.",
    )

    @model_validator(mode="after")
    def validate_action_shape(self) -> ChangeSetOperationToolInput:
        if self.action == "record_create":
            if self.target_ref is not None or self.base_version is not None:
                raise ValueError("record_create must not specify target_ref or base_version")
        elif self.target_ref is None or self.base_version is None:
            raise ValueError("record_update requires target_ref and base_version")
        return self


class CocktailChangeSetOperationToolInput(McpModel):
    op_id: str = Field(
        min_length=1,
        max_length=64,
        pattern=r"^[a-z][a-z0-9_-]{0,63}$",
        description="Unique operation id used by local references such as op:recipe.",
    )
    action: Literal[
        "recipe_create",
        "recipe_update",
        "tasting_create",
        "tasting_update",
        "preference_create",
        "preference_update",
    ]
    recipe_payload: dict[str, Any] | None = Field(
        default=None,
        description="Complete Cocktail Recipe v1 payload for a recipe action.",
    )
    tasting_payload: dict[str, Any] | None = Field(
        default=None,
        description="Complete Cocktail Tasting v1 payload for a tasting action.",
    )
    preference_payload: dict[str, Any] | None = Field(
        default=None,
        description=(
            "Complete user-confirmed Cocktail Preference v1 payload for a preference action."
        ),
    )
    target_ref: str | None = Field(
        default=None,
        description="Required stable record:<id> only for update actions.",
    )
    base_version: int | None = Field(
        default=None,
        ge=1,
        description="Required exact current Record version only for update actions.",
    )
    title: str | None = Field(default=None, min_length=1, max_length=300)
    summary: str | None = Field(default=None, max_length=2000)
    body_markdown: str | None = None
    importance: int | None = Field(default=None, ge=0, le=100)
    change_reason: str | None = Field(default=None, max_length=1000)
    occurred_start: str | None = Field(
        default=None,
        description="Required timezone-aware RFC 3339 timestamp for tasting_create.",
    )
    occurred_end: str | None = Field(
        default=None,
        description="Optional timezone-aware RFC 3339 tasting end timestamp.",
    )
    date_precision: (
        Literal[
            "exact",
            "day",
            "month",
            "year",
            "approximate",
            "unknown",
        ]
        | None
    ) = None
    timezone_name: str | None = Field(
        default=None,
        min_length=1,
        max_length=80,
        description="IANA timezone for a tasting occurrence, such as Asia/Taipei.",
    )

    @model_validator(mode="after")
    def validate_action_shape(self) -> CocktailChangeSetOperationToolInput:
        domain = self.action.partition("_")[0]
        payloads = {
            "recipe": self.recipe_payload,
            "tasting": self.tasting_payload,
            "preference": self.preference_payload,
        }
        if payloads[domain] is None:
            raise ValueError(f"{self.action} requires {domain}_payload")
        unexpected = [
            name for name, payload in payloads.items() if name != domain and payload is not None
        ]
        if unexpected:
            unexpected_fields = ", ".join(f"{name}_payload" for name in unexpected)
            raise ValueError(f"{self.action} must not include {unexpected_fields}")

        is_update = self.action.endswith("_update")
        if is_update and (self.target_ref is None or self.base_version is None):
            raise ValueError(f"{self.action} requires target_ref and base_version")
        if not is_update and (self.target_ref is not None or self.base_version is not None):
            raise ValueError(f"{self.action} must not include target_ref or base_version")
        if not is_update and self.change_reason is not None:
            raise ValueError(f"{self.action} must not include change_reason")

        occurrence_fields = (
            self.occurred_start,
            self.occurred_end,
            self.date_precision,
            self.timezone_name,
        )
        if domain != "tasting" and any(value is not None for value in occurrence_fields):
            raise ValueError(f"{self.action} must not include tasting occurrence fields")
        if self.action == "tasting_create" and (
            self.occurred_start is None or self.timezone_name is None
        ):
            raise ValueError("tasting_create requires occurred_start and timezone_name")
        return self


class CandidateOperationToolItem(McpModel):
    op_id: str
    position: int
    change_type: str
    change_data: dict[str, Any]


class CandidateResultToolItem(McpModel):
    op_id: str
    position: int
    change_type: str
    result_id: str
    result_ref: str
    result_type: Literal["record", "entity"]
    result_version: int


class CandidateToolItem(McpModel):
    id: str
    status: str
    candidate_kind: Literal["single", "change_set", "batch"] = "single"
    summary: str | None = None
    operation: str | None
    target_type: Literal["record", "entity"] | None
    target_id: str | None
    base_version: int | None
    proposed_content: dict[str, Any]
    source_reference: str | None
    confidence: float | None
    risk_flags: list[str]
    review_digest: str
    created_at: datetime
    expires_at: datetime | None
    review_action: str | None
    review_note: str | None
    result_id: str | None
    result_ref: str | None
    result_type: Literal["record", "entity"] | None
    result_version: int | None
    operations: list[CandidateOperationToolItem] = Field(default_factory=list)
    results: list[CandidateResultToolItem] = Field(default_factory=list)
    validation_result: dict[str, Any] = Field(default_factory=dict)
    display_mode: Literal["exact", "redacted"] = "exact"
    redacted_fields: list[str] = Field(default_factory=list)
    remote_approval_allowed: bool = True
    remote_approval_block_reason: str | None = None


class CandidateSummaryToolItem(McpModel):
    id: str
    status: str
    candidate_kind: Literal["single", "change_set", "batch"] = "single"
    operation: str | None
    target_type: Literal["record", "entity"] | None
    target_ref: str | None
    base_version: int | None
    title: str
    risk_flags: list[str]
    review_digest: str
    created_at: datetime
    expires_at: datetime | None
    result_ref: str | None
    result_type: Literal["record", "entity"] | None
    result_version: int | None
    operation_count: int = 1


class CandidateProposalToolOutput(ToolOutput):
    candidate: CandidateToolItem | None = None
    message: str | None = None


class BatchCandidateToolOutput(ToolOutput):
    candidate: CandidateToolItem | None = None
    batch: dict[str, Any] | None = None
    message: str | None = None


class CollectionSummaryToolItem(McpModel):
    key: str
    name: str
    domain: str | None
    member_count: int = 0
    version: int = 1


class CollectionListToolOutput(ToolOutput):
    collections: list[CollectionSummaryToolItem] = Field(default_factory=list)


class CollectionGetToolOutput(ToolOutput):
    key: str | None = None
    name: str | None = None
    domain: str | None = None
    member_count: int = 0
    records: list[dict[str, Any]] = Field(default_factory=list)


class CandidateListToolOutput(ToolOutput):
    candidates: list[CandidateSummaryToolItem] = Field(default_factory=list)


class CandidateGetToolOutput(ToolOutput):
    candidate: CandidateToolItem | None = None


class CandidatePrepareToolOutput(ToolOutput):
    candidate: CandidateToolItem | None = None
    approval_challenge: str | None = None
    challenge_expires_at: datetime | None = None
    message: str | None = None


class BatchApprovalFailedItem(McpModel):
    item_id: str
    unit_key: str
    decision: str
    execution_state: str
    error_code: str | None = None
    error_message: str | None = None
    retry_policy: str = "not_applicable"


class CandidateApproveToolOutput(ToolOutput):
    candidate: CandidateToolItem | None = None
    result_id: str | None = None
    result_ref: str | None = None
    result_type: Literal["record", "entity"] | None = None
    result_version: int | None = None
    results: list[CandidateResultToolItem] = Field(default_factory=list)
    transaction_committed: bool = False
    batch_execution_state: str | None = None
    item_count: int = 0
    applied_count: int = 0
    failed_count: int = 0
    unverified_count: int = 0
    skipped_count: int = 0
    pending_count: int = 0
    any_item_committed: bool = False
    all_items_completed: bool = False
    failed_items: list[BatchApprovalFailedItem] = Field(default_factory=list)
    failed_items_truncated: bool = False
    message: str | None = None


class CandidateRejectToolOutput(ToolOutput):
    candidate: CandidateToolItem | None = None
    message: str | None = None
