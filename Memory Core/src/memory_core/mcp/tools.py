from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Annotated, Any, Literal, cast

from mcp.server.fastmcp import FastMCP
from mcp.types import CallToolResult, TextContent, ToolAnnotations
from pydantic import Field

from memory_core.mcp.client import MemoryCoreApiClient, MemoryCoreApiError
from memory_core.mcp.projection import (
    contains_machine_local_value,
    project_external_value,
    project_external_value_with_redactions,
    redact_machine_local_text,
    safe_source_reference,
)
from memory_core.mcp.schemas import (
    CandidateApproveToolOutput,
    CandidateGetToolOutput,
    CandidateListToolOutput,
    CandidatePrepareToolOutput,
    CandidateProposalToolOutput,
    CandidateRejectToolOutput,
    CandidateSummaryToolItem,
    CandidateToolItem,
    DuplicateFindingToolItem,
    DuplicateScanToolOutput,
    FetchToolOutput,
    MemoryOverviewToolOutput,
    SearchItem,
    SearchToolOutput,
    ToolOutput,
)
from memory_core.schemas import (
    CandidateChange,
    CandidateEntityCreate,
    CandidateEntityUpdatePatch,
    CandidateProposal,
    CandidateRecordCreate,
    CandidateRecordUpdatePatch,
    EntityArchiveChange,
    EntityCreateChange,
    EntityUpdateChange,
    RecordArchiveChange,
    RecordCreateChange,
    RecordUpdateChange,
)

logger = logging.getLogger(__name__)

READ_ONLY = ToolAnnotations(
    readOnlyHint=True,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=False,
)
CANDIDATE_WRITE = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=False,
)
REVIEW_PREPARE = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=False,
    idempotentHint=False,
    openWorldHint=False,
)
APPROVAL_WRITE = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=True,
    idempotentHint=True,
    openWorldHint=False,
)
REJECTION_WRITE = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=False,
)


def _model_result[OutputT: ToolOutput](
    payload: OutputT,
    *,
    is_error: bool = False,
) -> OutputT:
    structured = payload.model_dump(mode="json")
    result = CallToolResult(
        content=[
            TextContent(
                type="text",
                text=json.dumps(structured, ensure_ascii=False, separators=(",", ":")),
            )
        ],
        structuredContent=structured,
        isError=is_error,
    )
    # FastMCP inspects the declared Pydantic return type to build outputSchema,
    # while CallToolResult lets the adapter retain isError and text fallback.
    return cast(OutputT, result)


def _error_result[OutputT: ToolOutput](
    output_type: type[OutputT],
    message: str,
    *,
    code: str,
) -> OutputT:
    return _model_result(output_type.failure(code=code, message=message), is_error=True)


def _reference_id(result_type: str, item_id: str) -> str:
    return f"{result_type}:{item_id}"


def _candidate_item(candidate: dict[str, Any]) -> CandidateToolItem:
    target_type = str(candidate.get("target_type") or "")
    raw_result_id = candidate.get("result_id")
    result_id = raw_result_id if isinstance(raw_result_id, str) and raw_result_id else None
    result_type: Literal["record", "entity"] | None = None
    if result_id is not None:
        if target_type == "record":
            result_type = "record"
        elif target_type == "entity":
            result_type = "entity"
    result_ref = _reference_id(result_type, result_id) if result_type and result_id else None
    raw_proposed_content = candidate.get("proposed_content") or {}
    proposed_content, content_redactions = project_external_value_with_redactions(
        raw_proposed_content,
        root="proposed_content",
    )
    raw_source_reference = candidate.get("source_reference")
    source_reference = safe_source_reference(raw_source_reference)
    source_redactions = ["source_reference"] if source_reference != raw_source_reference else []
    raw_review_note = candidate.get("review_note")
    review_note, note_redactions = project_external_value_with_redactions(
        raw_review_note,
        root="review_note",
    )
    redacted_fields = [*content_redactions, *source_redactions, *note_redactions]
    approval_redactions = [*content_redactions, *source_redactions]
    remote_approval_allowed = not approval_redactions
    return CandidateToolItem(
        id=str(candidate.get("id") or ""),
        status=str(candidate.get("status") or ""),
        operation=str(candidate.get("operation") or ""),
        target_type=target_type,
        target_id=candidate.get("target_id"),
        base_version=candidate.get("base_version"),
        proposed_content=proposed_content,
        source_reference=source_reference,
        confidence=candidate.get("confidence"),
        risk_flags=project_external_value(candidate.get("risk_flags") or []),
        review_digest=str(candidate.get("review_digest") or ""),
        created_at=candidate.get("created_at"),
        expires_at=candidate.get("expires_at"),
        review_action=candidate.get("review_action"),
        review_note=review_note,
        result_id=result_id,
        result_ref=result_ref,
        result_type=result_type,
        result_version=candidate.get("result_version"),
        display_mode="redacted" if redacted_fields else "exact",
        redacted_fields=redacted_fields,
        remote_approval_allowed=remote_approval_allowed,
        remote_approval_block_reason=(
            None
            if remote_approval_allowed
            else (
                "This candidate contains machine-local provenance that is hidden from the "
                "remote view. Replace it with a logical reference or use a trusted local "
                "review surface."
            )
        ),
    )


def _candidate_summary_item(candidate: dict[str, Any]) -> CandidateSummaryToolItem:
    target_type = str(candidate.get("target_type") or "")
    target_id = candidate.get("target_id")
    target_ref = (
        _reference_id(target_type, target_id)
        if target_type in {"record", "entity"} and isinstance(target_id, str) and target_id
        else None
    )
    raw_result_id = candidate.get("result_id")
    result_id = raw_result_id if isinstance(raw_result_id, str) and raw_result_id else None
    result_type: Literal["record", "entity"] | None = None
    if result_id is not None and target_type in {"record", "entity"}:
        result_type = cast(Literal["record", "entity"], target_type)
    proposed_content = candidate.get("proposed_content")
    title: Any = None
    if isinstance(proposed_content, dict):
        title = proposed_content.get("title") or proposed_content.get("name")
    if not isinstance(title, str) or not title.strip():
        title = target_ref or f"{target_type or 'memory'} {candidate.get('operation') or 'change'}"
    return CandidateSummaryToolItem(
        id=str(candidate.get("id") or ""),
        status=str(candidate.get("status") or ""),
        operation=str(candidate.get("operation") or ""),
        target_type=target_type,
        target_ref=target_ref,
        base_version=candidate.get("base_version"),
        title=redact_machine_local_text(title),
        risk_flags=project_external_value(candidate.get("risk_flags") or []),
        review_digest=str(candidate.get("review_digest") or ""),
        created_at=candidate.get("created_at"),
        expires_at=candidate.get("expires_at"),
        result_ref=_reference_id(result_type, result_id) if result_type and result_id else None,
        result_type=result_type,
        result_version=candidate.get("result_version"),
    )


def _candidate_requires_local_review(candidate: dict[str, Any]) -> CandidateToolItem | None:
    candidate_item = _candidate_item(candidate)
    return None if candidate_item.remote_approval_allowed else candidate_item


def _memory_url(result_type: str, item_id: str) -> str:
    return f"memory-core://{result_type}/{item_id}"


def _parse_reference_id(value: str) -> tuple[Literal["record", "entity"], str]:
    result_type, separator, item_id = value.partition(":")
    if separator != ":" or result_type not in {"record", "entity"} or not item_id:
        raise ValueError("id must be a search result id such as record:<id> or entity:<id>")
    return result_type, item_id  # type: ignore[return-value]


def _parse_target_ref(value: str, expected_type: Literal["record", "entity"]) -> str:
    result_type, item_id = _parse_reference_id(value)
    if result_type != expected_type:
        raise ValueError(f"target_ref must use the {expected_type}:<id> reference type")
    return item_id


def _bounded(text: str, max_chars: int) -> tuple[str, bool]:
    if len(text) <= max_chars:
        return text, False
    return f"{text[: max_chars - 1]}…", True


def _render_record(item: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    title = redact_machine_local_text(str(item.get("title") or "Untitled record"))
    parts = [f"# {title}"]
    summary = item.get("summary")
    body = item.get("body_markdown")
    if isinstance(summary, str) and summary:
        parts.extend(["", "## Summary", redact_machine_local_text(summary)])
    if isinstance(body, str) and body:
        parts.extend(["", "## Content", redact_machine_local_text(body)])
    payload = item.get("payload")
    if isinstance(payload, dict) and payload:
        projected_payload = project_external_value(payload)
        parts.extend(
            [
                "",
                "## Structured data",
                "```json",
                json.dumps(projected_payload, ensure_ascii=False, indent=2, sort_keys=True),
                "```",
            ]
        )
    metadata = project_external_value(
        {
            key: item.get(key)
            for key in (
                "kind",
                "domain",
                "occurred_start",
                "occurred_end",
                "date_precision",
                "timezone_name",
                "importance",
                "verification_status",
                "sensitivity",
                "handling_policy",
                "schema_name",
                "schema_version",
                "source_type",
                "lifecycle_status",
                "version",
                "deleted_at",
                "created_at",
                "updated_at",
            )
        }
    )
    lifecycle_status = item.get("lifecycle_status")
    if item.get("deleted_at") is not None or lifecycle_status == "archived":
        metadata["state"] = "archived"
    elif lifecycle_status == "superseded":
        metadata["state"] = "superseded"
    else:
        metadata["state"] = "active"
    metadata["source_reference"] = safe_source_reference(item.get("source_reference"))
    return "\n".join(parts), metadata


def _render_entity(item: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    title = redact_machine_local_text(str(item.get("name") or "Unnamed entity"))
    parts = [f"# {title}"]
    description = item.get("description")
    if isinstance(description, str) and description:
        parts.extend(["", redact_machine_local_text(description)])
    payload = item.get("payload")
    if isinstance(payload, dict) and payload:
        projected_payload = project_external_value(payload)
        parts.extend(
            [
                "",
                "## Structured data",
                "```json",
                json.dumps(projected_payload, ensure_ascii=False, indent=2, sort_keys=True),
                "```",
            ]
        )
    metadata = project_external_value(
        {
            key: item.get(key)
            for key in (
                "entity_type",
                "canonical_name",
                "sensitivity",
                "handling_policy",
                "version",
                "deleted_at",
                "created_at",
                "updated_at",
            )
        }
    )
    metadata["state"] = "archived" if item.get("deleted_at") is not None else "active"
    return "\n".join(parts), metadata


async def _propose_change(
    client: MemoryCoreApiClient,
    change: CandidateChange,
    *,
    idempotency_key: str,
    source_reference: str | None,
    confidence: float | None,
    risk_flags: tuple[str, ...],
) -> CandidateProposalToolOutput:
    try:
        proposal = CandidateProposal(
            change=change,
            source_type="mcp",
            source_reference=source_reference,
            idempotency_key=idempotency_key,
            confidence=confidence,
            risk_flags=list(risk_flags),
        )
        proposal_payload = proposal.model_dump(mode="json", exclude_unset=True)
        if contains_machine_local_value(proposal_payload):
            return _error_result(
                CandidateProposalToolOutput,
                (
                    "Machine-local paths cannot be submitted through the remote MCP proposal "
                    "surface. Use a non-secret logical reference such as workspace:<name>/..."
                ),
                code="machine_local_path_not_allowed",
            )
        candidate = await client.create_candidate(proposal_payload)
        return _model_result(
            CandidateProposalToolOutput(
                candidate=_candidate_item(candidate),
                message="Pending candidate created; a separate explicit review is required.",
            )
        )
    except MemoryCoreApiError as exc:
        return _error_result(
            CandidateProposalToolOutput,
            exc.public_message(),
            code=exc.code,
        )
    except Exception:
        logger.exception("Unexpected candidate proposal tool failure")
        return _error_result(
            CandidateProposalToolOutput,
            "Unexpected adapter failure",
            code="adapter_error",
        )


def register_tools(
    server: FastMCP,
    client: MemoryCoreApiClient,
    *,
    review_client: MemoryCoreApiClient | None,
    max_content_chars: int,
    expose_legacy_candidate_tool: bool,
) -> None:
    @server.tool(
        name="search",
        title="Search Memory Core",
        description=(
            "Use this when the user wants to find records or entities in their Memory Core. "
            "Returns stable result ids for the fetch tool and never changes stored data."
        ),
        annotations=READ_ONLY,
        structured_output=True,
    )
    async def search(
        query: Annotated[
            str,
            Field(min_length=1, max_length=500, description="Text to search for."),
        ],
        limit: Annotated[
            int,
            Field(ge=1, le=100, description="Maximum number of results."),
        ] = 20,
        result_type: Annotated[
            Literal["record", "entity"] | None,
            Field(description="Optionally return only records or only entities."),
        ] = None,
        domain: Annotated[
            str | None,
            Field(
                min_length=1,
                max_length=80,
                description="Optional exact record domain filter; entities have no domain.",
            ),
        ] = None,
        kind: Annotated[
            str | None,
            Field(
                min_length=1,
                max_length=60,
                description="Optional exact record kind or entity_type filter.",
            ),
        ] = None,
        sensitivity: Annotated[
            Literal["public", "personal", "sensitive", "restricted"] | None,
            Field(description="Optional exact sensitivity filter within the caller's scope."),
        ] = None,
        updated_after: Annotated[
            datetime | None,
            Field(description="Optional inclusive timezone-aware updated-at lower bound."),
        ] = None,
        updated_before: Annotated[
            datetime | None,
            Field(description="Optional inclusive timezone-aware updated-at upper bound."),
        ] = None,
    ) -> SearchToolOutput:
        try:
            filters = {
                key: value
                for key, value in {
                    "result_type": result_type,
                    "domain": domain,
                    "kind": kind,
                    "sensitivity": sensitivity,
                    "updated_after": (
                        updated_after.isoformat() if updated_after is not None else None
                    ),
                    "updated_before": (
                        updated_before.isoformat() if updated_before is not None else None
                    ),
                }.items()
                if isinstance(value, str)
            }
            matches = await client.search(query, limit, filters=filters)
            results: list[SearchItem] = []
            for item in matches:
                result_type = item.get("result_type")
                item_id = item.get("id")
                title = item.get("title")
                if result_type not in {"record", "entity"}:
                    continue
                if not isinstance(item_id, str) or not isinstance(title, str):
                    continue
                summary = item.get("summary")
                domain = item.get("domain")
                kind = item.get("kind")
                score = item.get("score")
                matched_fields = item.get("matched_fields")
                matched_terms = item.get("matched_terms")
                query_strategy = item.get("query_strategy")
                normalized_query = item.get("normalized_query")
                results.append(
                    SearchItem(
                        id=_reference_id(result_type, item_id),
                        result_type=result_type,
                        title=redact_machine_local_text(title),
                        url=_memory_url(result_type, item_id),
                        snippet=(
                            redact_machine_local_text(summary) if isinstance(summary, str) else None
                        ),
                        domain=(
                            redact_machine_local_text(domain) if isinstance(domain, str) else None
                        ),
                        kind=(redact_machine_local_text(kind) if isinstance(kind, str) else None),
                        updated_at=item.get("updated_at"),
                        score=(
                            float(score)
                            if isinstance(score, (int, float)) and not isinstance(score, bool)
                            else 0
                        ),
                        matched_fields=(
                            [field for field in matched_fields if isinstance(field, str)]
                            if isinstance(matched_fields, list)
                            else []
                        ),
                        matched_terms=(
                            [
                                redact_machine_local_text(term)
                                for term in matched_terms
                                if isinstance(term, str)
                            ]
                            if isinstance(matched_terms, list)
                            else []
                        ),
                        query_strategy=(
                            query_strategy if isinstance(query_strategy, str) else "backend_default"
                        ),
                        normalized_query=(
                            redact_machine_local_text(normalized_query)
                            if isinstance(normalized_query, str)
                            else ""
                        ),
                    )
                )
            return _model_result(SearchToolOutput(results=results))
        except MemoryCoreApiError as exc:
            return _error_result(SearchToolOutput, exc.public_message(), code=exc.code)
        except Exception:
            logger.exception("Unexpected search tool failure")
            return _error_result(
                SearchToolOutput,
                "Unexpected adapter failure",
                code="adapter_error",
            )

    @server.tool(
        name="fetch",
        title="Fetch Memory Core Item",
        description=(
            "Use this after search to retrieve one Memory Core record or entity by its stable "
            "result id. This tool never changes stored data."
        ),
        annotations=READ_ONLY,
        structured_output=True,
    )
    async def fetch(
        id: Annotated[
            str,
            Field(
                min_length=1,
                max_length=200,
                description="A stable id returned by search, such as record:<id>.",
            ),
        ],
    ) -> FetchToolOutput:
        try:
            result_type, item_id = _parse_reference_id(id)
            if result_type == "record":
                item = await client.get_record(item_id, include_deleted=True)
                text, metadata = _render_record(item)
                title = redact_machine_local_text(str(item.get("title") or "Untitled record"))
            else:
                item = await client.get_entity(item_id, include_deleted=True)
                text, metadata = _render_entity(item)
                title = redact_machine_local_text(str(item.get("name") or "Unnamed entity"))
            text, truncated = _bounded(text, max_content_chars)
            metadata["truncated"] = truncated
            return _model_result(
                FetchToolOutput(
                    id=id,
                    title=title,
                    text=text,
                    url=_memory_url(result_type, item_id),
                    metadata=metadata,
                )
            )
        except ValueError as exc:
            return _error_result(FetchToolOutput, str(exc), code="invalid_reference_id")
        except MemoryCoreApiError as exc:
            return _error_result(FetchToolOutput, exc.public_message(), code=exc.code)
        except Exception:
            logger.exception("Unexpected fetch tool failure")
            return _error_result(
                FetchToolOutput,
                "Unexpected adapter failure",
                code="adapter_error",
            )

    @server.tool(
        name="memory_overview",
        title="Inspect Memory Core Overview",
        description=(
            "Read bounded counts and health metadata for the visible Memory Core records, "
            "entities, domains, schemas, search index, and candidate statuses when reviewer "
            "access is configured. This never returns memory content or changes data."
        ),
        annotations=READ_ONLY,
        structured_output=True,
    )
    async def memory_overview() -> MemoryOverviewToolOutput:
        try:
            overview = await client.overview()
            candidate_counts: dict[str, int] | None = None
            warnings: list[str] = []
            if review_client is None:
                warnings.append(
                    "Candidate counts are unavailable because reviewer access is not configured."
                )
            else:
                try:
                    raw_candidate_counts = await review_client.candidate_stats()
                    candidate_counts = {
                        str(key): int(value)
                        for key, value in raw_candidate_counts.items()
                        if isinstance(value, int)
                    }
                except MemoryCoreApiError as exc:
                    warnings.append(f"Candidate counts are unavailable ({exc.code}).")
            return _model_result(
                MemoryOverviewToolOutput(
                    generated_at=overview.get("generated_at"),
                    scope=overview.get("scope"),
                    restricted_included=overview.get("restricted_included"),
                    records=overview.get("records") or {},
                    entities=overview.get("entities") or {},
                    domains=overview.get("domains") or {},
                    domain_taxonomy=overview.get("domain_taxonomy") or {},
                    schema_versions=overview.get("schema_versions") or {},
                    index=overview.get("index") or {},
                    candidates=candidate_counts,
                    candidate_counts_available=candidate_counts is not None,
                    warnings=warnings,
                )
            )
        except MemoryCoreApiError as exc:
            return _error_result(
                MemoryOverviewToolOutput,
                exc.public_message(),
                code=exc.code,
            )
        except Exception:
            logger.exception("Unexpected memory overview tool failure")
            return _error_result(
                MemoryOverviewToolOutput,
                "Unexpected adapter failure",
                code="adapter_error",
            )

    @server.tool(
        name="memory_detect_duplicates",
        title="Detect Memory Core Duplicates",
        description=(
            "Scan a bounded visible set for Entity name/alias overlap and Record canonical/title "
            "overlap. This returns findings only; it never merges, archives, or changes data."
        ),
        annotations=READ_ONLY,
        structured_output=True,
    )
    async def memory_detect_duplicates(
        limit: Annotated[
            int,
            Field(ge=1, le=100, description="Maximum duplicate findings to return."),
        ] = 50,
    ) -> DuplicateScanToolOutput:
        try:
            scan = await client.detect_duplicates(limit)
            raw_findings = scan.get("findings")
            findings = (
                [
                    DuplicateFindingToolItem.model_validate(item)
                    for item in raw_findings
                    if isinstance(item, dict)
                ]
                if isinstance(raw_findings, list)
                else []
            )
            return _model_result(
                DuplicateScanToolOutput(
                    generated_at=scan.get("generated_at"),
                    scanned_records=int(scan.get("scanned_records") or 0),
                    scanned_entities=int(scan.get("scanned_entities") or 0),
                    scan_truncated=bool(scan.get("scan_truncated")),
                    findings_truncated=bool(scan.get("findings_truncated")),
                    findings=findings,
                )
            )
        except MemoryCoreApiError as exc:
            return _error_result(
                DuplicateScanToolOutput,
                exc.public_message(),
                code=exc.code,
            )
        except Exception:
            logger.exception("Unexpected duplicate detection tool failure")
            return _error_result(
                DuplicateScanToolOutput,
                "Unexpected adapter failure",
                code="adapter_error",
            )

    @server.tool(
        name="memory_propose_record_create",
        title="Propose Creating a Memory Core Record",
        description=(
            "Create a pending proposal for one new record only after the user explicitly asks "
            "to save it. This never creates a formal record and never approves the candidate."
        ),
        annotations=CANDIDATE_WRITE,
        structured_output=True,
    )
    async def memory_propose_record_create(
        content: Annotated[
            CandidateRecordCreate,
            Field(description="Complete content for the proposed new record."),
        ],
        idempotency_key: Annotated[
            str,
            Field(
                min_length=1,
                max_length=160,
                description="Stable key reused only when retrying this exact proposal.",
            ),
        ],
        source_reference: Annotated[
            str | None,
            Field(max_length=1000, description="Optional non-secret provenance reference."),
        ] = None,
        confidence: Annotated[
            float | None,
            Field(ge=0, le=1, description="Optional extraction confidence from 0 to 1."),
        ] = None,
        risk_flags: Annotated[
            tuple[str, ...],
            Field(max_length=20, description="Non-secret review warnings for this proposal."),
        ] = (),
    ) -> CandidateProposalToolOutput:
        return await _propose_change(
            client,
            RecordCreateChange(change_type="record_create", content=content),
            idempotency_key=idempotency_key,
            source_reference=source_reference,
            confidence=confidence,
            risk_flags=risk_flags,
        )

    @server.tool(
        name="memory_propose_record_update",
        title="Propose Updating a Memory Core Record",
        description=(
            "Create a pending proposal to update one existing record. Use the record reference "
            "and version returned by fetch. This never changes the formal record or approves "
            "the candidate."
        ),
        annotations=CANDIDATE_WRITE,
        structured_output=True,
    )
    async def memory_propose_record_update(
        target_ref: Annotated[
            str,
            Field(
                min_length=1,
                max_length=200,
                description="Stable record reference such as record:<id>.",
            ),
        ],
        base_version: Annotated[
            int,
            Field(ge=1, description="Exact current record version returned by fetch."),
        ],
        content: Annotated[
            CandidateRecordUpdatePatch,
            Field(description="Only the record fields that should change."),
        ],
        idempotency_key: Annotated[
            str,
            Field(
                min_length=1,
                max_length=160,
                description="Stable key reused only when retrying this exact proposal.",
            ),
        ],
        source_reference: Annotated[
            str | None,
            Field(max_length=1000, description="Optional non-secret provenance reference."),
        ] = None,
        confidence: Annotated[
            float | None,
            Field(ge=0, le=1, description="Optional extraction confidence from 0 to 1."),
        ] = None,
        risk_flags: Annotated[
            tuple[str, ...],
            Field(max_length=20, description="Non-secret review warnings for this proposal."),
        ] = (),
    ) -> CandidateProposalToolOutput:
        try:
            target_id = _parse_target_ref(target_ref, "record")
        except ValueError as exc:
            return _error_result(
                CandidateProposalToolOutput,
                str(exc),
                code="invalid_reference_id",
            )
        return await _propose_change(
            client,
            RecordUpdateChange(
                change_type="record_update",
                target_id=target_id,
                base_version=base_version,
                content=content,
            ),
            idempotency_key=idempotency_key,
            source_reference=source_reference,
            confidence=confidence,
            risk_flags=risk_flags,
        )

    @server.tool(
        name="memory_propose_record_archive",
        title="Propose Archiving a Memory Core Record",
        description=(
            "Create a pending proposal to soft-archive one existing record. Use the record "
            "reference and version returned by fetch. This does not archive the formal record "
            "until a separate explicit approval."
        ),
        annotations=CANDIDATE_WRITE,
        structured_output=True,
    )
    async def memory_propose_record_archive(
        target_ref: Annotated[
            str,
            Field(
                min_length=1,
                max_length=200,
                description="Stable record reference such as record:<id>.",
            ),
        ],
        base_version: Annotated[
            int,
            Field(ge=1, description="Exact current record version returned by fetch."),
        ],
        idempotency_key: Annotated[
            str,
            Field(
                min_length=1,
                max_length=160,
                description="Stable key reused only when retrying this exact proposal.",
            ),
        ],
        change_reason: Annotated[
            str | None,
            Field(max_length=1000, description="Optional reason shown during review."),
        ] = None,
        merged_into_ref: Annotated[
            str | None,
            Field(
                min_length=1,
                max_length=200,
                description=(
                    "Optional canonical record reference. When approved, Memory Core creates "
                    "a merged_into link and archives the source in one transaction."
                ),
            ),
        ] = None,
        source_reference: Annotated[
            str | None,
            Field(max_length=1000, description="Optional non-secret provenance reference."),
        ] = None,
        confidence: Annotated[
            float | None,
            Field(ge=0, le=1, description="Optional extraction confidence from 0 to 1."),
        ] = None,
        risk_flags: Annotated[
            tuple[str, ...],
            Field(max_length=20, description="Non-secret review warnings for this proposal."),
        ] = (),
    ) -> CandidateProposalToolOutput:
        try:
            target_id = _parse_target_ref(target_ref, "record")
        except ValueError as exc:
            return _error_result(
                CandidateProposalToolOutput,
                str(exc),
                code="invalid_reference_id",
            )
        change_payload: dict[str, Any] = {
            "change_type": "record_archive",
            "target_id": target_id,
            "base_version": base_version,
        }
        if change_reason is not None:
            change_payload["change_reason"] = change_reason
        if merged_into_ref is not None:
            try:
                _parse_target_ref(merged_into_ref, "record")
            except ValueError as exc:
                return _error_result(
                    CandidateProposalToolOutput,
                    str(exc),
                    code="invalid_reference_id",
                )
            change_payload["merged_into_ref"] = merged_into_ref
        return await _propose_change(
            client,
            RecordArchiveChange.model_validate(change_payload),
            idempotency_key=idempotency_key,
            source_reference=source_reference,
            confidence=confidence,
            risk_flags=risk_flags,
        )

    @server.tool(
        name="memory_propose_entity_create",
        title="Propose Creating a Memory Core Entity",
        description=(
            "Create a pending proposal for one new entity only after the user explicitly asks "
            "to save it. This never creates a formal entity and never approves the candidate."
        ),
        annotations=CANDIDATE_WRITE,
        structured_output=True,
    )
    async def memory_propose_entity_create(
        content: Annotated[
            CandidateEntityCreate,
            Field(description="Complete content for the proposed new entity."),
        ],
        idempotency_key: Annotated[
            str,
            Field(
                min_length=1,
                max_length=160,
                description="Stable key reused only when retrying this exact proposal.",
            ),
        ],
        source_reference: Annotated[
            str | None,
            Field(max_length=1000, description="Optional non-secret provenance reference."),
        ] = None,
        confidence: Annotated[
            float | None,
            Field(ge=0, le=1, description="Optional extraction confidence from 0 to 1."),
        ] = None,
        risk_flags: Annotated[
            tuple[str, ...],
            Field(max_length=20, description="Non-secret review warnings for this proposal."),
        ] = (),
    ) -> CandidateProposalToolOutput:
        return await _propose_change(
            client,
            EntityCreateChange(change_type="entity_create", content=content),
            idempotency_key=idempotency_key,
            source_reference=source_reference,
            confidence=confidence,
            risk_flags=risk_flags,
        )

    @server.tool(
        name="memory_propose_entity_update",
        title="Propose Updating a Memory Core Entity",
        description=(
            "Create a pending proposal to update one existing entity. Use the entity reference "
            "and version returned by fetch. This never changes the formal entity or approves "
            "the candidate."
        ),
        annotations=CANDIDATE_WRITE,
        structured_output=True,
    )
    async def memory_propose_entity_update(
        target_ref: Annotated[
            str,
            Field(
                min_length=1,
                max_length=200,
                description="Stable entity reference such as entity:<id>.",
            ),
        ],
        base_version: Annotated[
            int,
            Field(ge=1, description="Exact current entity version returned by fetch."),
        ],
        content: Annotated[
            CandidateEntityUpdatePatch,
            Field(description="Only the entity fields that should change."),
        ],
        idempotency_key: Annotated[
            str,
            Field(
                min_length=1,
                max_length=160,
                description="Stable key reused only when retrying this exact proposal.",
            ),
        ],
        source_reference: Annotated[
            str | None,
            Field(max_length=1000, description="Optional non-secret provenance reference."),
        ] = None,
        confidence: Annotated[
            float | None,
            Field(ge=0, le=1, description="Optional extraction confidence from 0 to 1."),
        ] = None,
        risk_flags: Annotated[
            tuple[str, ...],
            Field(max_length=20, description="Non-secret review warnings for this proposal."),
        ] = (),
    ) -> CandidateProposalToolOutput:
        try:
            target_id = _parse_target_ref(target_ref, "entity")
        except ValueError as exc:
            return _error_result(
                CandidateProposalToolOutput,
                str(exc),
                code="invalid_reference_id",
            )
        return await _propose_change(
            client,
            EntityUpdateChange(
                change_type="entity_update",
                target_id=target_id,
                base_version=base_version,
                content=content,
            ),
            idempotency_key=idempotency_key,
            source_reference=source_reference,
            confidence=confidence,
            risk_flags=risk_flags,
        )

    @server.tool(
        name="memory_propose_entity_archive",
        title="Propose Archiving a Memory Core Entity",
        description=(
            "Create a pending proposal to soft-archive one existing entity. Use the entity "
            "reference and version returned by fetch. This does not archive the formal entity "
            "until a separate explicit approval."
        ),
        annotations=CANDIDATE_WRITE,
        structured_output=True,
    )
    async def memory_propose_entity_archive(
        target_ref: Annotated[
            str,
            Field(
                min_length=1,
                max_length=200,
                description="Stable entity reference such as entity:<id>.",
            ),
        ],
        base_version: Annotated[
            int,
            Field(ge=1, description="Exact current entity version returned by fetch."),
        ],
        idempotency_key: Annotated[
            str,
            Field(
                min_length=1,
                max_length=160,
                description="Stable key reused only when retrying this exact proposal.",
            ),
        ],
        change_reason: Annotated[
            str | None,
            Field(max_length=1000, description="Optional reason shown during review."),
        ] = None,
        merged_into_ref: Annotated[
            str | None,
            Field(
                min_length=1,
                max_length=200,
                description=(
                    "Optional canonical entity reference. When approved, Memory Core creates "
                    "a merged_into relation and archives the source in one transaction."
                ),
            ),
        ] = None,
        source_reference: Annotated[
            str | None,
            Field(max_length=1000, description="Optional non-secret provenance reference."),
        ] = None,
        confidence: Annotated[
            float | None,
            Field(ge=0, le=1, description="Optional extraction confidence from 0 to 1."),
        ] = None,
        risk_flags: Annotated[
            tuple[str, ...],
            Field(max_length=20, description="Non-secret review warnings for this proposal."),
        ] = (),
    ) -> CandidateProposalToolOutput:
        try:
            target_id = _parse_target_ref(target_ref, "entity")
        except ValueError as exc:
            return _error_result(
                CandidateProposalToolOutput,
                str(exc),
                code="invalid_reference_id",
            )
        change_payload: dict[str, Any] = {
            "change_type": "entity_archive",
            "target_id": target_id,
            "base_version": base_version,
        }
        if change_reason is not None:
            change_payload["change_reason"] = change_reason
        if merged_into_ref is not None:
            try:
                _parse_target_ref(merged_into_ref, "entity")
            except ValueError as exc:
                return _error_result(
                    CandidateProposalToolOutput,
                    str(exc),
                    code="invalid_reference_id",
                )
            change_payload["merged_into_ref"] = merged_into_ref
        return await _propose_change(
            client,
            EntityArchiveChange.model_validate(change_payload),
            idempotency_key=idempotency_key,
            source_reference=source_reference,
            confidence=confidence,
            risk_flags=risk_flags,
        )

    if expose_legacy_candidate_tool:

        @server.tool(
            name="memory_create_candidate",
            title="Legacy: Propose a Memory Core Change",
            description=(
                "Temporary compatibility tool. Prefer the matching memory_propose_* tool. "
                "This creates a pending candidate and never applies or approves it."
            ),
            annotations=CANDIDATE_WRITE,
            structured_output=True,
        )
        async def memory_create_candidate(
            change: Annotated[
                CandidateChange,
                Field(description="Legacy six-variant proposed change."),
            ],
            idempotency_key: Annotated[
                str,
                Field(min_length=1, max_length=160),
            ],
            source_reference: Annotated[
                str | None,
                Field(max_length=1000),
            ] = None,
            confidence: Annotated[
                float | None,
                Field(ge=0, le=1),
            ] = None,
            risk_flags: Annotated[
                tuple[str, ...],
                Field(max_length=20),
            ] = (),
        ) -> CandidateProposalToolOutput:
            return await _propose_change(
                client,
                change,
                idempotency_key=idempotency_key,
                source_reference=source_reference,
                confidence=confidence,
                risk_flags=risk_flags,
            )

    if review_client is None:
        return

    @server.tool(
        name="memory_list_candidates",
        title="List Memory Core Candidates",
        description=(
            "List bounded summaries of reviewable Memory Core candidates. Use "
            "memory_get_candidate for one candidate's projected detail. This never applies or "
            "rejects anything."
        ),
        annotations=READ_ONLY,
        structured_output=True,
    )
    async def memory_list_candidates(
        status: Annotated[
            Literal["pending", "applied", "rejected", "conflict", "expired"] | None,
            Field(description="Optional candidate status filter."),
        ] = "pending",
        limit: Annotated[int, Field(ge=1, le=100)] = 20,
    ) -> CandidateListToolOutput:
        try:
            items = await review_client.list_candidates(status=status, limit=limit)
            return _model_result(
                CandidateListToolOutput(
                    candidates=[_candidate_summary_item(item) for item in items]
                )
            )
        except MemoryCoreApiError as exc:
            return _error_result(
                CandidateListToolOutput,
                exc.public_message(),
                code=exc.code,
            )
        except Exception:
            logger.exception("Unexpected candidate list tool failure")
            return _error_result(
                CandidateListToolOutput,
                "Unexpected adapter failure",
                code="adapter_error",
            )

    @server.tool(
        name="memory_get_candidate",
        title="Get Memory Core Candidate",
        description=(
            "Read one immutable candidate through the external safety projection. Check "
            "display_mode and remote_approval_allowed before review; a redacted display is not "
            "the exact digest input. Viewing a candidate is not approval."
        ),
        annotations=READ_ONLY,
        structured_output=True,
    )
    async def memory_get_candidate(
        candidate_id: Annotated[str, Field(min_length=1, max_length=36)],
    ) -> CandidateGetToolOutput:
        try:
            candidate = await review_client.get_candidate(candidate_id)
            return _model_result(CandidateGetToolOutput(candidate=_candidate_item(candidate)))
        except MemoryCoreApiError as exc:
            return _error_result(
                CandidateGetToolOutput,
                exc.public_message(),
                code=exc.code,
            )
        except Exception:
            logger.exception("Unexpected candidate get tool failure")
            return _error_result(
                CandidateGetToolOutput,
                "Unexpected adapter failure",
                code="adapter_error",
            )

    @server.tool(
        name="memory_prepare_candidate_review",
        title="Prepare Memory Core Candidate Review",
        description=(
            "Prepare a short-lived challenge for one exact pending candidate after its full "
            "content and digest have been shown for review. Preparing is not approval and does "
            "not apply data."
        ),
        annotations=REVIEW_PREPARE,
        structured_output=True,
    )
    async def memory_prepare_candidate_review(
        candidate_id: Annotated[str, Field(min_length=1, max_length=36)],
        expected_review_digest: Annotated[
            str,
            Field(
                min_length=1,
                max_length=100,
                description="Exact review digest returned with the displayed candidate.",
            ),
        ],
    ) -> CandidatePrepareToolOutput:
        try:
            current_candidate = await review_client.get_candidate(candidate_id)
            blocked_candidate = _candidate_requires_local_review(current_candidate)
            if blocked_candidate is not None:
                return _error_result(
                    CandidatePrepareToolOutput,
                    blocked_candidate.remote_approval_block_reason
                    or "Candidate requires trusted local review",
                    code="candidate_requires_local_review",
                )
            prepared = await review_client.prepare_candidate_review(
                candidate_id,
                expected_review_digest=expected_review_digest,
            )
            candidate = prepared.get("candidate")
            if not isinstance(candidate, dict):
                raise ValueError("Backend returned an invalid prepared candidate")
            return _model_result(
                CandidatePrepareToolOutput(
                    candidate=_candidate_item(candidate),
                    approval_challenge=prepared.get("approval_challenge"),
                    challenge_expires_at=prepared.get("challenge_expires_at"),
                    message=(
                        "Review prepared. Wait for a separate explicit user approval before "
                        "calling memory_approve_candidate."
                    ),
                )
            )
        except MemoryCoreApiError as exc:
            return _error_result(
                CandidatePrepareToolOutput,
                exc.public_message(),
                code=exc.code,
            )
        except Exception:
            logger.exception("Unexpected candidate prepare tool failure")
            return _error_result(
                CandidatePrepareToolOutput,
                "Unexpected adapter failure",
                code="adapter_error",
            )

    @server.tool(
        name="memory_approve_candidate",
        title="Approve Memory Core Candidate",
        description=(
            "Apply exactly one prepared pending candidate. Use only after the user separately "
            "and explicitly approves this candidate after seeing its complete content, target, "
            "operation, risk flags, and review digest. Creating, viewing, preparing, editing, "
            "summarizing, or saying to remember something is not approval. This tool cannot "
            "accept replacement content."
        ),
        annotations=APPROVAL_WRITE,
        structured_output=True,
    )
    async def memory_approve_candidate(
        candidate_id: Annotated[str, Field(min_length=1, max_length=36)],
        expected_review_digest: Annotated[str, Field(min_length=1, max_length=100)],
        approval_challenge: Annotated[
            str,
            Field(min_length=32, max_length=200, description="Short-lived prepared challenge."),
        ],
        idempotency_key: Annotated[
            str,
            Field(
                min_length=1,
                max_length=160,
                description="Stable key reused only when retrying this exact approval.",
            ),
        ],
        review_note: Annotated[str | None, Field(max_length=1000)] = None,
    ) -> CandidateApproveToolOutput:
        try:
            current_candidate = await review_client.get_candidate(candidate_id)
            blocked_candidate = _candidate_requires_local_review(current_candidate)
            if blocked_candidate is not None:
                return _error_result(
                    CandidateApproveToolOutput,
                    blocked_candidate.remote_approval_block_reason
                    or "Candidate requires trusted local review",
                    code="candidate_requires_local_review",
                )
            candidate = await review_client.approve_candidate(
                candidate_id,
                {
                    "expected_review_digest": expected_review_digest,
                    "approval_challenge": approval_challenge,
                    "idempotency_key": idempotency_key,
                    "review_note": review_note,
                },
            )
            candidate_item = _candidate_item(candidate)
            return _model_result(
                CandidateApproveToolOutput(
                    candidate=candidate_item,
                    result_id=candidate_item.result_id,
                    result_ref=candidate_item.result_ref,
                    result_type=candidate_item.result_type,
                    result_version=candidate_item.result_version,
                    message=(
                        "Candidate applied. Fetch result_ref to verify the formal record or entity."
                    ),
                )
            )
        except MemoryCoreApiError as exc:
            return _error_result(
                CandidateApproveToolOutput,
                exc.public_message(),
                code=exc.code,
            )
        except Exception:
            logger.exception("Unexpected candidate approval tool failure")
            return _error_result(
                CandidateApproveToolOutput,
                "Unexpected adapter failure",
                code="adapter_error",
            )

    @server.tool(
        name="memory_reject_candidate",
        title="Reject Memory Core Candidate",
        description=(
            "Reject exactly one prepared pending candidate after the user explicitly chooses "
            "not to apply it. Rejection never writes formal record or entity data."
        ),
        annotations=REJECTION_WRITE,
        structured_output=True,
    )
    async def memory_reject_candidate(
        candidate_id: Annotated[str, Field(min_length=1, max_length=36)],
        expected_review_digest: Annotated[str, Field(min_length=1, max_length=100)],
        approval_challenge: Annotated[str, Field(min_length=32, max_length=200)],
        idempotency_key: Annotated[
            str,
            Field(
                min_length=1,
                max_length=160,
                description="Stable key reused only when retrying this exact rejection.",
            ),
        ],
        reason: Annotated[str, Field(min_length=1, max_length=1000)],
    ) -> CandidateRejectToolOutput:
        try:
            candidate = await review_client.reject_candidate(
                candidate_id,
                {
                    "reason": reason,
                    "expected_review_digest": expected_review_digest,
                    "approval_challenge": approval_challenge,
                    "idempotency_key": idempotency_key,
                },
            )
            return _model_result(
                CandidateRejectToolOutput(
                    candidate=_candidate_item(candidate),
                    message="Candidate rejected; no formal memory was written.",
                )
            )
        except MemoryCoreApiError as exc:
            return _error_result(
                CandidateRejectToolOutput,
                exc.public_message(),
                code=exc.code,
            )
        except Exception:
            logger.exception("Unexpected candidate rejection tool failure")
            return _error_result(
                CandidateRejectToolOutput,
                "Unexpected adapter failure",
                code="adapter_error",
            )
