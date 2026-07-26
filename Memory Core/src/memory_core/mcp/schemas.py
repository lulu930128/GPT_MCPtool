from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field


class McpModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ToolErrorDetail(McpModel):
    code: str
    message: str


class ToolOutput(McpModel):
    ok: bool = True
    error: ToolErrorDetail | None = None

    @classmethod
    def failure(cls, *, code: str, message: str) -> Self:
        return cls(ok=False, error=ToolErrorDetail(code=code, message=message))


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


class CandidateToolItem(McpModel):
    id: str
    status: str
    operation: str
    target_type: str
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
    display_mode: Literal["exact", "redacted"] = "exact"
    redacted_fields: list[str] = Field(default_factory=list)
    remote_approval_allowed: bool = True
    remote_approval_block_reason: str | None = None


class CandidateSummaryToolItem(McpModel):
    id: str
    status: str
    operation: str
    target_type: str
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


class CandidateProposalToolOutput(ToolOutput):
    candidate: CandidateToolItem | None = None
    message: str | None = None


class CandidateListToolOutput(ToolOutput):
    candidates: list[CandidateSummaryToolItem] = Field(default_factory=list)


class CandidateGetToolOutput(ToolOutput):
    candidate: CandidateToolItem | None = None


class CandidatePrepareToolOutput(ToolOutput):
    candidate: CandidateToolItem | None = None
    approval_challenge: str | None = None
    challenge_expires_at: datetime | None = None
    message: str | None = None


class CandidateApproveToolOutput(ToolOutput):
    candidate: CandidateToolItem | None = None
    result_id: str | None = None
    result_ref: str | None = None
    result_type: Literal["record", "entity"] | None = None
    result_version: int | None = None
    message: str | None = None


class CandidateRejectToolOutput(ToolOutput):
    candidate: CandidateToolItem | None = None
    message: str | None = None
