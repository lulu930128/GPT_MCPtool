from __future__ import annotations

import json
import logging
from copy import deepcopy
from datetime import datetime
from typing import Annotated, Any, Literal, cast

from mcp.server.fastmcp import FastMCP
from mcp.types import CallToolResult, TextContent, ToolAnnotations
from pydantic import Field, ValidationError, WithJsonSchema

from memory_core.errors import (
    operation_error_from_record_schema,
    operation_error_from_validation,
)
from memory_core.mcp.client import MemoryCoreApiClient, MemoryCoreApiError
from memory_core.mcp.projection import (
    contains_machine_local_value,
    project_external_value,
    project_external_value_with_redactions,
    redact_machine_local_text,
    safe_source_reference,
)
from memory_core.mcp.schemas import (
    BatchApprovalFailedItem,
    BatchCandidateToolOutput,
    CandidateApproveToolOutput,
    CandidateGetToolOutput,
    CandidateListToolOutput,
    CandidateOperationToolItem,
    CandidatePrepareToolOutput,
    CandidateProposalToolOutput,
    CandidateRejectToolOutput,
    CandidateResultToolItem,
    CandidateSummaryToolItem,
    CandidateToolItem,
    ChangeSetOperationToolInput,
    CocktailChangeSetOperationToolInput,
    CollectionGetToolOutput,
    CollectionListToolOutput,
    CollectionSummaryToolItem,
    DuplicateFindingToolItem,
    DuplicateScanToolOutput,
    FetchToolOutput,
    MemoryOverviewToolOutput,
    RecordLinkListToolOutput,
    RecordLinkToolItem,
    RecordRevisionToolOutput,
    SearchItem,
    SearchToolOutput,
    ToolOutput,
)
from memory_core.normalization.models import MediaExperienceBatchItemInput
from memory_core.record_schemas import (
    CocktailPreferencePayloadV1,
    CocktailRecipePayloadV1,
    CocktailTastingPayloadV1,
    RecordSchemaValidationIssue,
    normalize_registered_payload,
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
from memory_core.temporal import localize_utc_timestamp

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
RECORD_DATETIME_RULES = (
    " Datetime rules: non-null occurred_start and occurred_end must be RFC 3339 "
    "timezone-aware timestamps containing Z or an explicit numeric UTC offset such as +08:00; "
    "Naive timestamps are invalid. timezone_name is optional, but when provided it must be an "
    "IANA timezone such as Asia/Taipei and does not replace the timestamp offset. Use null "
    'timestamps with date_precision="unknown" when the occurrence date is unknown.'
)


def _inline_json_schema_references(schema: dict[str, Any]) -> dict[str, Any]:
    definitions = schema.get("$defs")
    definitions_by_name = definitions if isinstance(definitions, dict) else {}

    def expand(value: Any, resolving: frozenset[str] = frozenset()) -> Any:
        if isinstance(value, list):
            return [expand(item, resolving) for item in value]
        if not isinstance(value, dict):
            return value
        reference = value.get("$ref")
        if isinstance(reference, str) and reference.startswith("#/$defs/"):
            name = reference.removeprefix("#/$defs/")
            target = definitions_by_name.get(name)
            if isinstance(target, dict) and name not in resolving:
                overlay = {key: item for key, item in value.items() if key != "$ref"}
                return expand({**target, **overlay}, resolving | {name})
        return {key: expand(item, resolving) for key, item in value.items() if key != "$defs"}

    expanded = expand(schema)
    if not isinstance(expanded, dict):  # pragma: no cover - model schemas are objects
        raise TypeError("Expected an object JSON schema")
    return expanded


RECORD_CREATE_TOOL_CONTENT_SCHEMA = _inline_json_schema_references(
    CandidateRecordCreate.model_json_schema()
)
RECORD_UPDATE_TOOL_CONTENT_SCHEMA = _inline_json_schema_references(
    CandidateRecordUpdatePatch.model_json_schema()
)
COCKTAIL_RECIPE_TOOL_PAYLOAD_SCHEMA = _inline_json_schema_references(
    CocktailRecipePayloadV1.model_json_schema()
)
COCKTAIL_TASTING_TOOL_PAYLOAD_SCHEMA = _inline_json_schema_references(
    CocktailTastingPayloadV1.model_json_schema()
)
COCKTAIL_PREFERENCE_TOOL_PAYLOAD_SCHEMA = _inline_json_schema_references(
    CocktailPreferencePayloadV1.model_json_schema()
)
CHANGE_SET_OPERATION_TOOL_SCHEMA = _inline_json_schema_references(
    ChangeSetOperationToolInput.model_json_schema()
)
COCKTAIL_OCCURRED_START_SCHEMA = {
    "type": "string",
    "format": "date-time",
    "description": (
        "Required RFC 3339 tasting time with Z or an explicit numeric UTC offset. "
        "Naive timestamps are invalid."
    ),
    "examples": ["2026-07-26T20:00:00+08:00"],
}
LOCAL_RECORD_OR_OPERATION_REF_PATTERN = r"^(?:record:[^:]+|op:[a-z][a-z0-9_-]{0,63})$"


def _allow_cocktail_local_reference(
    schema: dict[str, Any],
    field_name: str,
    *,
    collection: bool = False,
) -> dict[str, Any]:
    projected = deepcopy(schema)
    properties = projected.get("properties")
    if not isinstance(properties, dict):
        raise TypeError("Cocktail payload schema properties must be an object")
    field_schema = properties.get(field_name)
    if not isinstance(field_schema, dict):
        raise TypeError(f"Cocktail payload schema is missing {field_name}")
    if collection:
        reference_schema = field_schema.get("items")
    else:
        variants = field_schema.get("anyOf")
        reference_schema = (
            next(
                (
                    variant
                    for variant in variants
                    if isinstance(variant, dict) and variant.get("type") == "string"
                ),
                None,
            )
            if isinstance(variants, list)
            else field_schema
        )
    if not isinstance(reference_schema, dict):
        raise TypeError(f"Cocktail reference schema is invalid for {field_name}")
    reference_schema["minLength"] = 4
    reference_schema["pattern"] = LOCAL_RECORD_OR_OPERATION_REF_PATTERN
    field_schema["description"] = (
        f"{field_schema.get('description', '')} Within this ChangeSet, op:<op_id> is also "
        "allowed and is resolved only through the registered reference field."
    ).strip()
    return projected


COCKTAIL_CHANGE_SET_RECIPE_PAYLOAD_SCHEMA = _allow_cocktail_local_reference(
    COCKTAIL_RECIPE_TOOL_PAYLOAD_SCHEMA,
    "parent_recipe_ref",
)
COCKTAIL_CHANGE_SET_TASTING_PAYLOAD_SCHEMA = _allow_cocktail_local_reference(
    COCKTAIL_TASTING_TOOL_PAYLOAD_SCHEMA,
    "recipe_ref",
)
COCKTAIL_CHANGE_SET_PREFERENCE_PAYLOAD_SCHEMA = _allow_cocktail_local_reference(
    COCKTAIL_PREFERENCE_TOOL_PAYLOAD_SCHEMA,
    "confirmed_favorite_recipe_refs",
    collection=True,
)


def _cocktail_change_set_operation_schema() -> dict[str, Any]:
    schema = _inline_json_schema_references(CocktailChangeSetOperationToolInput.model_json_schema())
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        raise TypeError("Cocktail ChangeSet operation properties must be an object")
    for field_name, payload_schema, description in (
        (
            "recipe_payload",
            COCKTAIL_CHANGE_SET_RECIPE_PAYLOAD_SCHEMA,
            "Complete Cocktail Recipe v1 payload for recipe_create or recipe_update.",
        ),
        (
            "tasting_payload",
            COCKTAIL_CHANGE_SET_TASTING_PAYLOAD_SCHEMA,
            "Complete Cocktail Tasting v1 payload for tasting_create or tasting_update.",
        ),
        (
            "preference_payload",
            COCKTAIL_CHANGE_SET_PREFERENCE_PAYLOAD_SCHEMA,
            (
                "Complete user-confirmed Cocktail Preference v1 payload for "
                "preference_create or preference_update."
            ),
        ),
    ):
        properties[field_name] = {
            "anyOf": [deepcopy(payload_schema), {"type": "null"}],
            "default": None,
            "description": description,
        }
    properties["occurred_start"] = {
        "anyOf": [deepcopy(COCKTAIL_OCCURRED_START_SCHEMA), {"type": "null"}],
        "default": None,
        "description": "Required for tasting_create; optional correction for tasting_update.",
    }
    return schema


COCKTAIL_CHANGE_SET_OPERATION_TOOL_SCHEMA = _cocktail_change_set_operation_schema()
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
    field: str | None = None,
    received_value: str | int | float | bool | None = None,
    example: str | int | float | bool | None = None,
) -> OutputT:
    return _model_result(
        output_type.failure(
            code=code,
            message=message,
            field=field,
            received_value=received_value,
            example=example,
        ),
        is_error=True,
    )


def _candidate_validation_error(exc: ValidationError) -> CandidateProposalToolOutput:
    error = operation_error_from_validation(
        exc.errors(include_url=False),
        fallback_message="Candidate content failed validation",
    )
    received_value = (
        error.received_value if isinstance(error.received_value, (str, int, float, bool)) else None
    )
    example = error.example if isinstance(error.example, (str, int, float, bool)) else None
    return _error_result(
        CandidateProposalToolOutput,
        error.message,
        code=error.code,
        field=error.field,
        received_value=received_value,
        example=example,
    )


def _cocktail_schema_error(
    issue: RecordSchemaValidationIssue,
) -> CandidateProposalToolOutput:
    error = operation_error_from_record_schema(issue)
    received_value = (
        error.received_value if isinstance(error.received_value, (str, int, float, bool)) else None
    )
    example = error.example if isinstance(error.example, (str, int, float, bool)) else None
    return _error_result(
        CandidateProposalToolOutput,
        error.message,
        code=error.code,
        field=error.field,
        received_value=received_value,
        example=example,
    )


def _normalize_cocktail_tool_payload(
    payload: dict[str, Any],
    *,
    schema_name: Literal["cocktail_recipe", "cocktail_tasting", "cocktail_preference"],
    kind: Literal["fact", "event", "state"],
) -> tuple[dict[str, Any] | None, CandidateProposalToolOutput | None]:
    try:
        normalized = normalize_registered_payload(
            schema_name=schema_name,
            schema_version=1,
            domain="lifestyle.cocktail",
            kind=kind,
            payload=payload,
        )
    except RecordSchemaValidationIssue as issue:
        return None, _cocktail_schema_error(issue)
    return normalized, None


def _cocktail_record_create_change(
    *,
    schema_name: Literal["cocktail_recipe", "cocktail_tasting", "cocktail_preference"],
    kind: Literal["fact", "event", "state"],
    title: str,
    payload: dict[str, Any],
    summary: str | None,
    body_markdown: str | None,
    importance: int,
    source_reference: str | None,
    occurred_start: str | None = None,
    occurred_end: str | None = None,
    date_precision: str = "unknown",
    timezone_name: str | None = None,
) -> tuple[RecordCreateChange | None, CandidateProposalToolOutput | None]:
    normalized_payload, payload_error = _normalize_cocktail_tool_payload(
        payload,
        schema_name=schema_name,
        kind=kind,
    )
    if payload_error is not None:
        return None, payload_error
    try:
        content = CandidateRecordCreate.model_validate(
            {
                "kind": kind,
                "domain": "lifestyle.cocktail",
                "title": title,
                "summary": summary,
                "body_markdown": body_markdown,
                "occurred_start": occurred_start,
                "occurred_end": occurred_end,
                "date_precision": date_precision,
                "timezone_name": timezone_name,
                "importance": importance,
                "schema_name": schema_name,
                "schema_version": 1,
                "payload": normalized_payload,
                "source_type": "mcp",
                "source_reference": source_reference,
            }
        )
    except ValidationError as exc:
        return None, _candidate_validation_error(exc)
    return RecordCreateChange(change_type="record_create", content=content), None


def _cocktail_record_update_change(
    *,
    target_ref: str,
    base_version: int,
    payload: dict[str, Any],
    schema_name: Literal["cocktail_recipe", "cocktail_tasting", "cocktail_preference"],
    kind: Literal["fact", "event", "state"],
    title: str | None,
    summary: str | None,
    body_markdown: str | None,
    importance: int | None,
    change_reason: str | None,
    occurred_start: str | None = None,
    occurred_end: str | None = None,
    date_precision: str | None = None,
    timezone_name: str | None = None,
) -> tuple[RecordUpdateChange | None, CandidateProposalToolOutput | None]:
    try:
        target_id = _parse_target_ref(target_ref, "record")
    except ValueError as exc:
        return None, _error_result(
            CandidateProposalToolOutput,
            str(exc),
            code="invalid_reference_id",
        )
    normalized_payload, payload_error = _normalize_cocktail_tool_payload(
        payload,
        schema_name=schema_name,
        kind=kind,
    )
    if payload_error is not None:
        return None, payload_error
    content_values: dict[str, Any] = {
        "schema_name": schema_name,
        "schema_version": 1,
        "payload": normalized_payload,
    }
    for field_name, value in {
        "title": title,
        "summary": summary,
        "body_markdown": body_markdown,
        "importance": importance,
        "change_reason": change_reason,
        "occurred_start": occurred_start,
        "occurred_end": occurred_end,
        "date_precision": date_precision,
        "timezone_name": timezone_name,
    }.items():
        if value is not None:
            content_values[field_name] = value
    try:
        content = CandidateRecordUpdatePatch.model_validate(content_values)
    except ValidationError as exc:
        return None, _candidate_validation_error(exc)
    return (
        RecordUpdateChange(
            change_type="record_update",
            target_id=target_id,
            base_version=base_version,
            content=content,
        ),
        None,
    )


def _cocktail_change_set_operation(
    operation: CocktailChangeSetOperationToolInput,
    *,
    source_type: Literal["conversation", "file", "manual", "tool_result", "import"],
    source_reference: str | None,
) -> ChangeSetOperationToolInput:
    domain = operation.action.partition("_")[0]
    if domain == "recipe":
        payload = operation.recipe_payload
        schema_name = "cocktail_recipe"
        kind = "fact"
        payload_title = payload.get("recipe_name") if payload is not None else None
        fallback_title = "Cocktail recipe"
        default_importance = 50
    elif domain == "tasting":
        payload = operation.tasting_payload
        schema_name = "cocktail_tasting"
        kind = "event"
        payload_title = payload.get("cocktail_name") if payload is not None else None
        fallback_title = "Cocktail tasting"
        default_importance = 50
    else:
        payload = operation.preference_payload
        schema_name = "cocktail_preference"
        kind = "state"
        payload_title = None
        fallback_title = "調酒口味偏好"
        default_importance = 70
    if payload is None:  # pragma: no cover - model validator enforces the action payload
        raise ValueError(f"{operation.action} is missing its typed payload")

    resolved_title = operation.title
    if resolved_title is None and isinstance(payload_title, str) and payload_title.strip():
        resolved_title = payload_title.strip()
    if resolved_title is None:
        resolved_title = fallback_title

    if operation.action.endswith("_create"):
        content: dict[str, Any] = {
            "kind": kind,
            "domain": "lifestyle.cocktail",
            "title": resolved_title,
            "importance": (
                operation.importance if operation.importance is not None else default_importance
            ),
            "schema_name": schema_name,
            "schema_version": 1,
            "payload": payload,
            "source_type": source_type,
            "source_reference": source_reference,
        }
        if operation.summary is not None:
            content["summary"] = operation.summary
        if operation.body_markdown is not None:
            content["body_markdown"] = operation.body_markdown
        if domain == "tasting":
            content.update(
                {
                    "occurred_start": operation.occurred_start,
                    "occurred_end": operation.occurred_end,
                    "date_precision": operation.date_precision or "exact",
                    "timezone_name": operation.timezone_name,
                }
            )
        return ChangeSetOperationToolInput(
            op_id=operation.op_id,
            action="record_create",
            content=content,
        )

    update_content: dict[str, Any] = {
        "schema_name": schema_name,
        "schema_version": 1,
        "payload": payload,
        "title": resolved_title,
    }
    for field_name, value in (
        ("summary", operation.summary),
        ("body_markdown", operation.body_markdown),
        ("importance", operation.importance),
        ("change_reason", operation.change_reason),
    ):
        if value is not None:
            update_content[field_name] = value
    if domain == "tasting":
        for field_name, value in (
            ("occurred_start", operation.occurred_start),
            ("occurred_end", operation.occurred_end),
            ("date_precision", operation.date_precision),
            ("timezone_name", operation.timezone_name),
        ):
            if value is not None:
                update_content[field_name] = value
    return ChangeSetOperationToolInput(
        op_id=operation.op_id,
        action="record_update",
        content=update_content,
        target_ref=operation.target_ref,
        base_version=operation.base_version,
    )


def _reference_id(result_type: str, item_id: str) -> str:
    return f"{result_type}:{item_id}"


def _candidate_result_items(
    candidate: dict[str, Any],
    *,
    scalar_result_id: str | None,
    scalar_result_type: Literal["record", "entity"] | None,
) -> list[CandidateResultToolItem]:
    items: list[CandidateResultToolItem] = []
    raw_results = candidate.get("results")
    if isinstance(raw_results, list):
        for raw in raw_results:
            if not isinstance(raw, dict):
                continue
            result_type = raw.get("result_type")
            result_id = raw.get("result_id")
            result_version = raw.get("result_version")
            if (
                result_type not in {"record", "entity"}
                or not isinstance(result_id, str)
                or not isinstance(result_version, int)
            ):
                continue
            items.append(
                CandidateResultToolItem(
                    op_id=str(raw.get("op_id") or ""),
                    position=int(raw.get("position") or 0),
                    change_type=str(raw.get("change_type") or ""),
                    result_id=result_id,
                    result_ref=_reference_id(result_type, result_id),
                    result_type=result_type,
                    result_version=result_version,
                )
            )
    if items or scalar_result_id is None or scalar_result_type is None:
        return items
    scalar_version = candidate.get("result_version")
    if not isinstance(scalar_version, int):
        return items
    operation = str(candidate.get("operation") or "change")
    return [
        CandidateResultToolItem(
            op_id="single",
            position=0,
            change_type=f"{scalar_result_type}_{operation}",
            result_id=scalar_result_id,
            result_ref=_reference_id(scalar_result_type, scalar_result_id),
            result_type=scalar_result_type,
            result_version=scalar_version,
        )
    ]


def _batch_candidate_result_items(batch: dict[str, Any]) -> list[CandidateResultToolItem]:
    output: list[CandidateResultToolItem] = []
    raw_items = batch.get("items")
    if not isinstance(raw_items, list):
        return output
    for raw_item in raw_items:
        if not isinstance(raw_item, dict):
            continue
        operation_types = {
            str(operation.get("op_id") or ""): str(operation.get("change_type") or "")
            for operation in raw_item.get("operations", [])
            if isinstance(operation, dict)
        }
        raw_results = raw_item.get("results")
        if not isinstance(raw_results, list):
            continue
        for raw_result in raw_results:
            if not isinstance(raw_result, dict):
                continue
            result_kind = raw_result.get("result_kind")
            result_ref = raw_result.get("result_ref")
            result_version = raw_result.get("result_version")
            if (
                result_kind not in {"record", "entity"}
                or not isinstance(result_ref, str)
                or not result_ref.startswith(f"{result_kind}:")
                or not isinstance(result_version, int)
            ):
                continue
            op_id = str(raw_result.get("op_id") or "")
            output.append(
                CandidateResultToolItem(
                    op_id=op_id,
                    position=len(output),
                    change_type=operation_types.get(op_id, f"{result_kind}_change"),
                    result_id=result_ref.removeprefix(f"{result_kind}:"),
                    result_ref=result_ref,
                    result_type=result_kind,
                    result_version=result_version,
                )
            )
    return output


def _batch_execution_counts(batch: dict[str, Any]) -> dict[str, int]:
    summary = batch.get("execution_summary")
    if isinstance(summary, dict):
        return {
            "item_count": int(summary.get("item_count") or 0),
            "applied": int(summary.get("applied") or 0),
            "failed": int(summary.get("failed") or 0),
            "unverified": int(summary.get("unverified") or 0),
            "skipped": int(summary.get("skipped") or 0),
            "pending": int(summary.get("pending") or 0),
        }
    raw_items = batch.get("items")
    items = (
        [item for item in raw_items if isinstance(item, dict)]
        if isinstance(raw_items, list)
        else []
    )
    states = [str(item.get("execution_state") or "") for item in items]
    applied = states.count("applied")
    failed = states.count("failed")
    unverified = states.count("unverified")
    skipped = states.count("skipped")
    return {
        "item_count": len(states),
        "applied": applied,
        "failed": failed,
        "unverified": unverified,
        "skipped": skipped,
        "pending": len(states) - applied - failed - unverified - skipped,
    }


def _batch_failed_items(
    batch: dict[str, Any],
    *,
    limit: int = 20,
) -> tuple[list[BatchApprovalFailedItem], bool]:
    raw_items = batch.get("items")
    if not isinstance(raw_items, list):
        return [], False
    failed = [
        item
        for item in raw_items
        if isinstance(item, dict) and item.get("execution_state") in {"failed", "unverified"}
    ]
    output = [
        BatchApprovalFailedItem(
            item_id=str(item.get("id") or ""),
            unit_key=redact_machine_local_text(str(item.get("unit_key") or "")),
            decision=str(item.get("decision") or ""),
            execution_state=str(item.get("execution_state") or ""),
            error_code=(
                str(item.get("execution_error_code") or item.get("error_code"))
                if item.get("execution_error_code") or item.get("error_code")
                else None
            ),
            error_message=(
                redact_machine_local_text(
                    str(item.get("execution_error_message") or item.get("error_message"))
                )
                if item.get("execution_error_message") or item.get("error_message")
                else None
            ),
            retry_policy=str(item.get("retry_policy") or "not_applicable"),
        )
        for item in failed[:limit]
    ]
    return output, len(failed) > limit


def _candidate_item(candidate: dict[str, Any]) -> CandidateToolItem:
    raw_target_type = candidate.get("target_type")
    target_type: Literal["record", "entity"] | None = (
        raw_target_type if raw_target_type in {"record", "entity"} else None
    )
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
    raw_operations = candidate.get("operations") or []
    projected_operations, operation_redactions = project_external_value_with_redactions(
        raw_operations,
        root="operations",
    )
    operation_items: list[CandidateOperationToolItem] = []
    if isinstance(projected_operations, list):
        for raw_operation in projected_operations:
            if not isinstance(raw_operation, dict):
                continue
            change_data = raw_operation.get("change_data")
            if not isinstance(change_data, dict):
                continue
            operation_items.append(
                CandidateOperationToolItem(
                    op_id=str(raw_operation.get("op_id") or ""),
                    position=int(raw_operation.get("position") or 0),
                    change_type=str(raw_operation.get("change_type") or ""),
                    change_data=change_data,
                )
            )
    raw_source_reference = candidate.get("source_reference")
    source_reference = safe_source_reference(raw_source_reference)
    source_redactions = ["source_reference"] if source_reference != raw_source_reference else []
    raw_review_note = candidate.get("review_note")
    review_note, note_redactions = project_external_value_with_redactions(
        raw_review_note,
        root="review_note",
    )
    redacted_fields = [
        *content_redactions,
        *operation_redactions,
        *source_redactions,
        *note_redactions,
    ]
    approval_redactions = [*content_redactions, *operation_redactions, *source_redactions]
    remote_approval_allowed = not approval_redactions
    result_items = _candidate_result_items(
        candidate,
        scalar_result_id=result_id,
        scalar_result_type=result_type,
    )
    raw_operation = candidate.get("operation")
    return CandidateToolItem(
        id=str(candidate.get("id") or ""),
        status=str(candidate.get("status") or ""),
        candidate_kind=(
            candidate.get("candidate_kind")
            if candidate.get("candidate_kind") in {"single", "change_set", "batch"}
            else "single"
        ),
        summary=(
            redact_machine_local_text(str(candidate["summary"]))
            if candidate.get("summary")
            else None
        ),
        operation=str(raw_operation) if isinstance(raw_operation, str) else None,
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
        operations=operation_items,
        results=result_items,
        validation_result=project_external_value(candidate.get("validation_result") or {}),
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
    raw_candidate_kind = candidate.get("candidate_kind")
    candidate_kind: Literal["single", "change_set", "batch"] = (
        cast(
            Literal["single", "change_set", "batch"],
            raw_candidate_kind,
        )
        if raw_candidate_kind in {"single", "change_set", "batch"}
        else "single"
    )
    raw_target_type = candidate.get("target_type")
    target_type: Literal["record", "entity"] | None = (
        raw_target_type if raw_target_type in {"record", "entity"} else None
    )
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
        result_type = target_type
    proposed_content = candidate.get("proposed_content")
    title: Any = None
    if candidate_kind in {"change_set", "batch"}:
        title = candidate.get("summary")
    if isinstance(proposed_content, dict):
        title = title or proposed_content.get("title") or proposed_content.get("name")
    if not isinstance(title, str) or not title.strip():
        title = target_ref or (
            "Memory ChangeSet"
            if candidate_kind == "change_set"
            else (
                "Memory Batch"
                if candidate_kind == "batch"
                else f"{target_type or 'memory'} {candidate.get('operation') or 'change'}"
            )
        )
    raw_operation = candidate.get("operation")
    raw_operations = candidate.get("operations")
    return CandidateSummaryToolItem(
        id=str(candidate.get("id") or ""),
        status=str(candidate.get("status") or ""),
        candidate_kind=candidate_kind,
        operation=(
            str(raw_operation)
            if isinstance(raw_operation, str)
            else (candidate_kind if candidate_kind in {"change_set", "batch"} else None)
        ),
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
        operation_count=(
            len(raw_operations)
            if isinstance(raw_operations, list)
            else (
                int(proposed_content.get("item_count") or 0)
                if candidate_kind == "batch" and isinstance(proposed_content, dict)
                else 1
            )
        ),
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
    timezone_name = item.get("timezone_name")
    occurred_start_local = localize_utc_timestamp(item.get("occurred_start"), timezone_name)
    occurred_end_local = localize_utc_timestamp(item.get("occurred_end"), timezone_name)
    if occurred_start_local is not None:
        metadata["occurred_start_local"] = occurred_start_local
    if occurred_end_local is not None:
        metadata["occurred_end_local"] = occurred_end_local
    lifecycle_status = item.get("lifecycle_status")
    if item.get("deleted_at") is not None or lifecycle_status == "archived":
        metadata["state"] = "archived"
    elif lifecycle_status == "superseded":
        metadata["state"] = "superseded"
    else:
        metadata["state"] = "active"
    metadata["source_reference"] = safe_source_reference(item.get("source_reference"))
    return "\n".join(parts), metadata


async def _cocktail_tasting_projection(
    client: MemoryCoreApiClient,
    item: dict[str, Any],
) -> dict[str, Any]:
    if item.get("schema_name") != "cocktail_tasting" or item.get("schema_version") != 1:
        return {}
    payload = item.get("payload")
    if not isinstance(payload, dict):
        return {
            "recipe_resolution_status": "schema_mismatch",
            "recipe_version_available": False,
        }
    recipe_ref = payload.get("recipe_ref")
    recipe_version = payload.get("recipe_version")
    if recipe_ref is None and recipe_version is None:
        return {
            "recipe_resolution_status": "not_applicable",
            "recipe_version_available": False,
        }
    if not isinstance(recipe_ref, str) or not isinstance(recipe_version, int):
        return {
            "recipe_resolution_status": "schema_mismatch",
            "recipe_version_available": False,
        }
    try:
        recipe_id = _parse_target_ref(recipe_ref, "record")
    except ValueError:
        return {
            "recipe_resolution_status": "schema_mismatch",
            "recipe_version_available": False,
        }
    try:
        current_recipe = await client.get_record(recipe_id, include_deleted=True)
    except MemoryCoreApiError as exc:
        return {
            "recipe_resolution_status": ("missing" if exc.code == "not_found" else "unavailable"),
            "recipe_version_available": False,
        }
    if (
        current_recipe.get("schema_name") != "cocktail_recipe"
        or current_recipe.get("schema_version") != 1
    ):
        return {
            "recipe_resolution_status": "schema_mismatch",
            "recipe_version_available": False,
        }
    try:
        recipe_revision = await client.get_record_revision(recipe_id, recipe_version)
    except MemoryCoreApiError as exc:
        return {
            "recipe_resolution_status": (
                "version_missing" if exc.code == "not_found" else "unavailable"
            ),
            "recipe_title": redact_machine_local_text(
                str(current_recipe.get("title") or "Untitled recipe")
            ),
            "recipe_version_available": False,
        }
    if (
        recipe_revision.get("schema_name") != "cocktail_recipe"
        or recipe_revision.get("schema_version") != 1
    ):
        return {
            "recipe_resolution_status": "schema_mismatch",
            "recipe_version_available": False,
        }
    return {
        "recipe_resolution_status": "resolved",
        "recipe_title": redact_machine_local_text(
            str(recipe_revision.get("title") or "Untitled recipe")
        ),
        "recipe_version_available": True,
    }


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
            field=exc.field,
            received_value=exc.received_value,
            example=exc.example,
        )
    except Exception:
        logger.exception("Unexpected candidate proposal tool failure")
        return _error_result(
            CandidateProposalToolOutput,
            "Unexpected adapter failure",
            code="adapter_error",
        )


async def _propose_change_set(
    client: MemoryCoreApiClient,
    *,
    summary: str,
    operations: list[ChangeSetOperationToolInput],
    idempotency_key: str,
    source_type: Literal["conversation", "file", "manual", "tool_result", "import"],
    source_reference: str | None,
    confidence: float | None,
    risk_flags: tuple[str, ...],
) -> CandidateProposalToolOutput:
    operation_payloads: list[dict[str, Any]] = []
    try:
        for operation in operations:
            if operation.action == "record_create":
                change: dict[str, Any] = {
                    "change_type": "record_create",
                    "content": operation.content,
                }
            else:
                if operation.target_ref is None or operation.base_version is None:
                    raise ValueError("record_update requires target_ref and base_version")
                target_id = _parse_target_ref(operation.target_ref, "record")
                change = {
                    "change_type": "record_update",
                    "target_id": target_id,
                    "base_version": operation.base_version,
                    "content": operation.content,
                }
            operation_payloads.append(
                {
                    "op_id": operation.op_id,
                    "change": change,
                }
            )
        proposal_payload: dict[str, Any] = {
            "summary": summary,
            "atomic": True,
            "operations": operation_payloads,
            "source_type": source_type,
            "source_reference": source_reference,
            "idempotency_key": idempotency_key,
            "confidence": confidence,
            "risk_flags": list(risk_flags),
        }
        if contains_machine_local_value(proposal_payload):
            return _error_result(
                CandidateProposalToolOutput,
                (
                    "Machine-local paths cannot be submitted through the remote MCP proposal "
                    "surface. Use a non-secret logical reference such as workspace:<name>/..."
                ),
                code="machine_local_path_not_allowed",
            )
        candidate = await client.create_change_set(proposal_payload)
        return _model_result(
            CandidateProposalToolOutput(
                candidate=_candidate_item(candidate),
                message=(
                    "Pending atomic ChangeSet created; show every operation and the review "
                    "digest before a separate explicit approval."
                ),
            )
        )
    except ValueError as exc:
        return _error_result(
            CandidateProposalToolOutput,
            str(exc),
            code="invalid_reference_id",
        )
    except MemoryCoreApiError as exc:
        return _error_result(
            CandidateProposalToolOutput,
            exc.public_message(),
            code=exc.code,
            field=exc.field,
            received_value=exc.received_value,
            example=exc.example,
        )
    except Exception:
        logger.exception("Unexpected ChangeSet proposal tool failure")
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
        schema_name: Annotated[
            str | None,
            Field(
                min_length=1,
                max_length=100,
                description="Optional exact Record schema_name filter; entities have no schema.",
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
                    "schema_name": schema_name,
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
                metadata.update(await _cocktail_tasting_projection(client, item))
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
        name="memory_fetch_record_revision",
        title="Fetch a Memory Core Record Revision",
        description=(
            "Read one immutable historical Record snapshot by stable record_ref and revision_no. "
            "Use this when a Record Link pins target_revision_no or when comparing historical "
            "content. The output uses the same external redaction and size limit as fetch. "
            "This tool never changes stored data."
        ),
        annotations=READ_ONLY,
        structured_output=True,
    )
    async def memory_fetch_record_revision(
        record_ref: Annotated[
            str,
            Field(
                min_length=8,
                max_length=200,
                description="Stable record:<id> whose immutable revision should be read.",
            ),
        ],
        revision_no: Annotated[
            int,
            Field(ge=1, description="Exact positive Record revision number to read."),
        ],
    ) -> RecordRevisionToolOutput:
        try:
            record_id = _parse_target_ref(record_ref, "record")
            current = await client.get_record(record_id, include_deleted=True)
            snapshot = await client.get_record_revision(record_id, revision_no)
            current_version = current.get("version")
            if not isinstance(current_version, int):
                return _error_result(
                    RecordRevisionToolOutput,
                    "Backend returned an invalid current Record version",
                    code="invalid_backend_response",
                )
            text, metadata = _render_record(snapshot)
            metadata.update(await _cocktail_tasting_projection(client, snapshot))
            metadata.update(
                {
                    "requested_revision_no": revision_no,
                    "current_version": current_version,
                    "is_current": revision_no == current_version,
                }
            )
            text, truncated = _bounded(text, max_content_chars)
            metadata["truncated"] = truncated
            return _model_result(
                RecordRevisionToolOutput(
                    record_ref=record_ref,
                    revision_no=revision_no,
                    current_version=current_version,
                    is_current=revision_no == current_version,
                    title=redact_machine_local_text(
                        str(snapshot.get("title") or "Untitled record")
                    ),
                    text=text,
                    url=f"{_memory_url('record', record_id)}/revisions/{revision_no}",
                    metadata=metadata,
                )
            )
        except ValueError as exc:
            return _error_result(
                RecordRevisionToolOutput,
                str(exc),
                code="invalid_reference_id",
            )
        except MemoryCoreApiError as exc:
            return _error_result(
                RecordRevisionToolOutput,
                exc.public_message(),
                code=exc.code,
                field=exc.field,
                received_value=exc.received_value,
                example=exc.example,
            )
        except Exception:
            logger.exception("Unexpected Record revision fetch failure")
            return _error_result(
                RecordRevisionToolOutput,
                "Unexpected adapter failure",
                code="adapter_error",
            )

    @server.tool(
        name="memory_list_record_links",
        title="List Memory Core Record Links",
        description=(
            "Read current schema-aware Record relationships in the outbound or inbound "
            "direction. A null target_revision_no follows stable Record identity; a positive "
            "value pins an exact revision. Removed links are hidden unless explicitly requested. "
            "This tool never changes data."
        ),
        annotations=READ_ONLY,
        structured_output=True,
    )
    async def memory_list_record_links(
        record_ref: Annotated[
            str,
            Field(
                min_length=8,
                max_length=200,
                description="Stable record:<id> whose links should be listed.",
            ),
        ],
        direction: Annotated[
            Literal["outbound", "inbound"],
            Field(description="Relationship direction relative to record_ref."),
        ] = "outbound",
        include_removed: Annotated[
            bool,
            Field(description="Include soft-removed historical current-projection links."),
        ] = False,
    ) -> RecordLinkListToolOutput:
        try:
            record_id = _parse_target_ref(record_ref, "record")
            raw_links = await client.list_record_links(
                record_id,
                direction=direction,
                include_removed=include_removed,
            )
            return _model_result(
                RecordLinkListToolOutput(
                    record_ref=record_ref,
                    direction=direction,
                    links=[
                        RecordLinkToolItem.model_validate(
                            {
                                field_name: link.get(field_name)
                                for field_name in RecordLinkToolItem.model_fields
                            }
                        )
                        for link in raw_links
                    ],
                )
            )
        except ValueError as exc:
            return _error_result(
                RecordLinkListToolOutput,
                str(exc),
                code="invalid_reference_id",
            )
        except MemoryCoreApiError as exc:
            return _error_result(
                RecordLinkListToolOutput,
                exc.public_message(),
                code=exc.code,
                field=exc.field,
                received_value=exc.received_value,
                example=exc.example,
            )
        except Exception:
            logger.exception("Unexpected Record Link list tool failure")
            return _error_result(
                RecordLinkListToolOutput,
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
        name="memory_propose_change_set",
        title="Propose an Atomic Memory Core ChangeSet",
        description=(
            "Create one pending, atomic Candidate containing 1 to 20 Record create/update "
            "operations. Use op:<op_id> only in registered Record reference fields, such as "
            "cocktail_tasting.payload.recipe_ref; the backend resolves it to the referenced "
            "operation result and pins the result version where required. Group operations "
            "only when the user wants all of them to succeed or all of them to be cancelled. "
            "Do not infer a long-term Cocktail Preference from one tasting. This tool never "
            "applies formal data and still requires the normal separate review and approval."
        ),
        annotations=CANDIDATE_WRITE,
        structured_output=True,
    )
    async def memory_propose_change_set(
        summary: Annotated[
            str,
            Field(
                min_length=1,
                max_length=500,
                description="Short description of why these operations are one atomic unit.",
            ),
        ],
        operations: Annotated[
            list[ChangeSetOperationToolInput],
            WithJsonSchema(
                {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 20,
                    "items": CHANGE_SET_OPERATION_TOOL_SCHEMA,
                },
                mode="validation",
            ),
            Field(
                min_length=1,
                max_length=20,
                description=(
                    "Ordered operations. Forward op:<op_id> references are allowed when the "
                    "dependency graph is acyclic."
                ),
            ),
        ],
        idempotency_key: Annotated[
            str,
            Field(
                min_length=1,
                max_length=160,
                description="Stable key reused only when retrying this exact ChangeSet.",
            ),
        ],
        source_type: Annotated[
            Literal["conversation", "file", "manual", "tool_result", "import"],
            Field(description="True information origin, not the MCP transport."),
        ] = "conversation",
        source_reference: Annotated[
            str | None,
            Field(max_length=1000, description="Optional non-secret logical provenance."),
        ] = None,
        confidence: Annotated[
            float | None,
            Field(ge=0, le=1, description="Optional extraction confidence from 0 to 1."),
        ] = None,
        risk_flags: Annotated[
            tuple[str, ...],
            Field(max_length=20, description="Non-secret warnings shown during review."),
        ] = (),
    ) -> CandidateProposalToolOutput:
        return await _propose_change_set(
            client,
            summary=summary,
            operations=operations,
            idempotency_key=idempotency_key,
            source_type=source_type,
            source_reference=source_reference,
            confidence=confidence,
            risk_flags=risk_flags,
        )

    @server.tool(
        name="memory_propose_cocktail_change_set",
        title="Propose an Atomic Typed Cocktail ChangeSet",
        description=(
            "Create one pending atomic ChangeSet from typed Cocktail Recipe, Tasting, or "
            "user-confirmed Preference operations. Each operation uses the matching named "
            "payload field rather than an unknown content object. Use op:<op_id> only in "
            "registered recipe reference fields and omit recipe_version when a Tasting "
            "recipe_ref uses op:<op_id>; Memory Core pins the produced version automatically. "
            "Do not infer a long-term Preference from one Tasting. This never applies formal "
            "data and still requires the normal separate review and approval."
        ),
        annotations=CANDIDATE_WRITE,
        structured_output=True,
    )
    async def memory_propose_cocktail_change_set(
        summary: Annotated[
            str,
            Field(
                min_length=1,
                max_length=500,
                description="Why these Cocktail operations must succeed or roll back together.",
            ),
        ],
        operations: Annotated[
            list[CocktailChangeSetOperationToolInput],
            WithJsonSchema(
                {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 20,
                    "items": COCKTAIL_CHANGE_SET_OPERATION_TOOL_SCHEMA,
                },
                mode="validation",
            ),
            Field(
                min_length=1,
                max_length=20,
                description=(
                    "Typed Cocktail operations. Forward op:<op_id> references are allowed "
                    "when the dependency graph is acyclic."
                ),
            ),
        ],
        idempotency_key: Annotated[
            str,
            Field(
                min_length=1,
                max_length=160,
                description="Stable key reused only when retrying this exact typed ChangeSet.",
            ),
        ],
        source_type: Annotated[
            Literal["conversation", "file", "manual", "tool_result", "import"],
            Field(description="True information origin, not the MCP transport."),
        ] = "conversation",
        source_reference: Annotated[
            str | None,
            Field(max_length=1000, description="Optional non-secret logical provenance."),
        ] = None,
        confidence: Annotated[
            float | None,
            Field(ge=0, le=1, description="Optional extraction confidence from 0 to 1."),
        ] = None,
        risk_flags: Annotated[
            tuple[str, ...],
            Field(max_length=20, description="Non-secret warnings shown during review."),
        ] = (),
    ) -> CandidateProposalToolOutput:
        generic_operations = [
            _cocktail_change_set_operation(
                operation,
                source_type=source_type,
                source_reference=source_reference,
            )
            for operation in operations
        ]
        return await _propose_change_set(
            client,
            summary=summary,
            operations=generic_operations,
            idempotency_key=idempotency_key,
            source_type=source_type,
            source_reference=source_reference,
            confidence=confidence,
            risk_flags=risk_flags,
        )

    @server.tool(
        name="memory_propose_cocktail_recipe_create",
        title="Propose Creating a Cocktail Recipe",
        description=(
            "Create a pending Cocktail Recipe v1 proposal. Use this for a reusable recipe, "
            "not for one tasting event. This never creates or approves a formal record."
        ),
        annotations=CANDIDATE_WRITE,
        structured_output=True,
    )
    async def memory_propose_cocktail_recipe_create(
        payload: Annotated[
            dict[str, Any],
            WithJsonSchema(COCKTAIL_RECIPE_TOOL_PAYLOAD_SCHEMA, mode="validation"),
            Field(description="Complete Cocktail Recipe v1 payload."),
        ],
        idempotency_key: Annotated[
            str,
            Field(min_length=1, max_length=160),
        ],
        summary: Annotated[str | None, Field(max_length=2000)] = None,
        body_markdown: str | None = None,
        importance: Annotated[int, Field(ge=0, le=100)] = 50,
        source_reference: Annotated[str | None, Field(max_length=1000)] = None,
        confidence: Annotated[float | None, Field(ge=0, le=1)] = None,
        risk_flags: Annotated[tuple[str, ...], Field(max_length=20)] = (),
    ) -> CandidateProposalToolOutput:
        recipe_name = payload.get("recipe_name")
        change, validation_error = _cocktail_record_create_change(
            schema_name="cocktail_recipe",
            kind="fact",
            title=recipe_name.strip() if isinstance(recipe_name, str) else "Cocktail recipe",
            payload=payload,
            summary=summary,
            body_markdown=body_markdown,
            importance=importance,
            source_reference=source_reference,
        )
        if validation_error is not None:
            return validation_error
        assert change is not None
        return await _propose_change(
            client,
            change,
            idempotency_key=idempotency_key,
            source_reference=source_reference,
            confidence=confidence,
            risk_flags=risk_flags,
        )

    @server.tool(
        name="memory_propose_cocktail_recipe_update",
        title="Propose Updating a Cocktail Recipe",
        description=(
            "Create a pending update for one Cocktail Recipe v1. Supply the complete payload "
            "and the exact record version returned by fetch. This never applies the update."
        ),
        annotations=CANDIDATE_WRITE,
        structured_output=True,
    )
    async def memory_propose_cocktail_recipe_update(
        target_ref: Annotated[str, Field(min_length=1, max_length=200)],
        base_version: Annotated[int, Field(ge=1)],
        payload: Annotated[
            dict[str, Any],
            WithJsonSchema(COCKTAIL_RECIPE_TOOL_PAYLOAD_SCHEMA, mode="validation"),
            Field(description="Complete replacement Cocktail Recipe v1 payload."),
        ],
        idempotency_key: Annotated[str, Field(min_length=1, max_length=160)],
        title: Annotated[str | None, Field(min_length=1, max_length=300)] = None,
        summary: Annotated[str | None, Field(max_length=2000)] = None,
        body_markdown: str | None = None,
        importance: Annotated[int | None, Field(ge=0, le=100)] = None,
        change_reason: Annotated[str | None, Field(max_length=1000)] = None,
        source_reference: Annotated[str | None, Field(max_length=1000)] = None,
        confidence: Annotated[float | None, Field(ge=0, le=1)] = None,
        risk_flags: Annotated[tuple[str, ...], Field(max_length=20)] = (),
    ) -> CandidateProposalToolOutput:
        recipe_name = payload.get("recipe_name")
        resolved_title = (
            title
            if title is not None
            else recipe_name.strip()
            if isinstance(recipe_name, str)
            else None
        )
        change, validation_error = _cocktail_record_update_change(
            target_ref=target_ref,
            base_version=base_version,
            payload=payload,
            schema_name="cocktail_recipe",
            kind="fact",
            title=resolved_title,
            summary=summary,
            body_markdown=body_markdown,
            importance=importance,
            change_reason=change_reason,
        )
        if validation_error is not None:
            return validation_error
        assert change is not None
        return await _propose_change(
            client,
            change,
            idempotency_key=idempotency_key,
            source_reference=source_reference,
            confidence=confidence,
            risk_flags=risk_flags,
        )

    @server.tool(
        name="memory_propose_cocktail_tasting_create",
        title="Propose Creating a Cocktail Tasting",
        description=(
            "Create a pending Cocktail Tasting v1 event for one actual preparation or drink. "
            "occurred_start and timezone_name are required. This never creates or approves a "
            "formal record." + RECORD_DATETIME_RULES
        ),
        annotations=CANDIDATE_WRITE,
        structured_output=True,
    )
    async def memory_propose_cocktail_tasting_create(
        payload: Annotated[
            dict[str, Any],
            WithJsonSchema(COCKTAIL_TASTING_TOOL_PAYLOAD_SCHEMA, mode="validation"),
            Field(description="Complete Cocktail Tasting v1 payload."),
        ],
        occurred_start: Annotated[
            str,
            WithJsonSchema(COCKTAIL_OCCURRED_START_SCHEMA, mode="validation"),
        ],
        timezone_name: Annotated[
            str,
            Field(
                min_length=1,
                max_length=80,
                description="Required IANA timezone, such as Asia/Taipei.",
            ),
        ],
        idempotency_key: Annotated[str, Field(min_length=1, max_length=160)],
        occurred_end: Annotated[
            str | None,
            Field(description="Optional RFC 3339 timestamp with an explicit UTC offset."),
        ] = None,
        date_precision: Literal[
            "exact", "day", "month", "year", "approximate", "unknown"
        ] = "exact",
        summary: Annotated[str | None, Field(max_length=2000)] = None,
        body_markdown: str | None = None,
        importance: Annotated[int, Field(ge=0, le=100)] = 50,
        source_reference: Annotated[str | None, Field(max_length=1000)] = None,
        confidence: Annotated[float | None, Field(ge=0, le=1)] = None,
        risk_flags: Annotated[tuple[str, ...], Field(max_length=20)] = (),
    ) -> CandidateProposalToolOutput:
        cocktail_name = payload.get("cocktail_name")
        change, validation_error = _cocktail_record_create_change(
            schema_name="cocktail_tasting",
            kind="event",
            title=(cocktail_name.strip() if isinstance(cocktail_name, str) else "Cocktail tasting"),
            payload=payload,
            summary=summary,
            body_markdown=body_markdown,
            importance=importance,
            source_reference=source_reference,
            occurred_start=occurred_start,
            occurred_end=occurred_end,
            date_precision=date_precision,
            timezone_name=timezone_name,
        )
        if validation_error is not None:
            return validation_error
        assert change is not None
        return await _propose_change(
            client,
            change,
            idempotency_key=idempotency_key,
            source_reference=source_reference,
            confidence=confidence,
            risk_flags=risk_flags,
        )

    @server.tool(
        name="memory_propose_cocktail_tasting_update",
        title="Propose Updating a Cocktail Tasting",
        description=(
            "Create a pending correction for one Cocktail Tasting v1. Supply the complete "
            "payload and exact record version. A new drinking occasion should use create."
            + RECORD_DATETIME_RULES
        ),
        annotations=CANDIDATE_WRITE,
        structured_output=True,
    )
    async def memory_propose_cocktail_tasting_update(
        target_ref: Annotated[str, Field(min_length=1, max_length=200)],
        base_version: Annotated[int, Field(ge=1)],
        payload: Annotated[
            dict[str, Any],
            WithJsonSchema(COCKTAIL_TASTING_TOOL_PAYLOAD_SCHEMA, mode="validation"),
            Field(description="Complete replacement Cocktail Tasting v1 payload."),
        ],
        idempotency_key: Annotated[str, Field(min_length=1, max_length=160)],
        occurred_start: Annotated[
            str | None,
            Field(description="Optional corrected RFC 3339 timestamp with a UTC offset."),
        ] = None,
        occurred_end: Annotated[
            str | None,
            Field(description="Optional corrected RFC 3339 timestamp with a UTC offset."),
        ] = None,
        date_precision: Literal["exact", "day", "month", "year", "approximate", "unknown"]
        | None = None,
        timezone_name: Annotated[
            str | None,
            Field(min_length=1, max_length=80, description="Optional corrected IANA timezone."),
        ] = None,
        title: Annotated[str | None, Field(min_length=1, max_length=300)] = None,
        summary: Annotated[str | None, Field(max_length=2000)] = None,
        body_markdown: str | None = None,
        importance: Annotated[int | None, Field(ge=0, le=100)] = None,
        change_reason: Annotated[str | None, Field(max_length=1000)] = None,
        source_reference: Annotated[str | None, Field(max_length=1000)] = None,
        confidence: Annotated[float | None, Field(ge=0, le=1)] = None,
        risk_flags: Annotated[tuple[str, ...], Field(max_length=20)] = (),
    ) -> CandidateProposalToolOutput:
        cocktail_name = payload.get("cocktail_name")
        resolved_title = (
            title
            if title is not None
            else cocktail_name.strip()
            if isinstance(cocktail_name, str)
            else None
        )
        change, validation_error = _cocktail_record_update_change(
            target_ref=target_ref,
            base_version=base_version,
            payload=payload,
            schema_name="cocktail_tasting",
            kind="event",
            title=resolved_title,
            summary=summary,
            body_markdown=body_markdown,
            importance=importance,
            change_reason=change_reason,
            occurred_start=occurred_start,
            occurred_end=occurred_end,
            date_precision=date_precision,
            timezone_name=timezone_name,
        )
        if validation_error is not None:
            return validation_error
        assert change is not None
        return await _propose_change(
            client,
            change,
            idempotency_key=idempotency_key,
            source_reference=source_reference,
            confidence=confidence,
            risk_flags=risk_flags,
        )

    @server.tool(
        name="memory_propose_cocktail_preference_create",
        title="Propose Creating Cocktail Preferences",
        description=(
            "Create the pending singleton Cocktail Preference v1 state only from user-confirmed "
            "long-term preferences. One tasting must not auto-create this state. This never "
            "creates or approves a formal record."
        ),
        annotations=CANDIDATE_WRITE,
        structured_output=True,
    )
    async def memory_propose_cocktail_preference_create(
        payload: Annotated[
            dict[str, Any],
            WithJsonSchema(COCKTAIL_PREFERENCE_TOOL_PAYLOAD_SCHEMA, mode="validation"),
            Field(description="Complete Cocktail Preference v1 payload."),
        ],
        idempotency_key: Annotated[str, Field(min_length=1, max_length=160)],
        summary: Annotated[str | None, Field(max_length=2000)] = None,
        body_markdown: str | None = None,
        importance: Annotated[int, Field(ge=0, le=100)] = 70,
        source_reference: Annotated[str | None, Field(max_length=1000)] = None,
        confidence: Annotated[float | None, Field(ge=0, le=1)] = None,
        risk_flags: Annotated[tuple[str, ...], Field(max_length=20)] = (),
    ) -> CandidateProposalToolOutput:
        change, validation_error = _cocktail_record_create_change(
            schema_name="cocktail_preference",
            kind="state",
            title="調酒口味偏好",
            payload=payload,
            summary=summary,
            body_markdown=body_markdown,
            importance=importance,
            source_reference=source_reference,
        )
        if validation_error is not None:
            return validation_error
        assert change is not None
        return await _propose_change(
            client,
            change,
            idempotency_key=idempotency_key,
            source_reference=source_reference,
            confidence=confidence,
            risk_flags=risk_flags,
        )

    @server.tool(
        name="memory_propose_cocktail_preference_update",
        title="Propose Updating Cocktail Preferences",
        description=(
            "Create a pending update for the existing singleton Cocktail Preference v1 state. "
            "Supply the complete payload and exact version returned by fetch."
        ),
        annotations=CANDIDATE_WRITE,
        structured_output=True,
    )
    async def memory_propose_cocktail_preference_update(
        target_ref: Annotated[str, Field(min_length=1, max_length=200)],
        base_version: Annotated[int, Field(ge=1)],
        payload: Annotated[
            dict[str, Any],
            WithJsonSchema(COCKTAIL_PREFERENCE_TOOL_PAYLOAD_SCHEMA, mode="validation"),
            Field(description="Complete replacement Cocktail Preference v1 payload."),
        ],
        idempotency_key: Annotated[str, Field(min_length=1, max_length=160)],
        summary: Annotated[str | None, Field(max_length=2000)] = None,
        body_markdown: str | None = None,
        importance: Annotated[int | None, Field(ge=0, le=100)] = None,
        change_reason: Annotated[str | None, Field(max_length=1000)] = None,
        source_reference: Annotated[str | None, Field(max_length=1000)] = None,
        confidence: Annotated[float | None, Field(ge=0, le=1)] = None,
        risk_flags: Annotated[tuple[str, ...], Field(max_length=20)] = (),
    ) -> CandidateProposalToolOutput:
        change, validation_error = _cocktail_record_update_change(
            target_ref=target_ref,
            base_version=base_version,
            payload=payload,
            schema_name="cocktail_preference",
            kind="state",
            title="調酒口味偏好",
            summary=summary,
            body_markdown=body_markdown,
            importance=importance,
            change_reason=change_reason,
        )
        if validation_error is not None:
            return validation_error
        assert change is not None
        return await _propose_change(
            client,
            change,
            idempotency_key=idempotency_key,
            source_reference=source_reference,
            confidence=confidence,
            risk_flags=risk_flags,
        )

    @server.tool(
        name="memory_propose_record_create",
        title="Propose Creating a Memory Core Record",
        description=(
            "Create a pending proposal for one new record only after the user explicitly asks "
            "to save it. This never creates a formal record and never approves the candidate."
            + RECORD_DATETIME_RULES
        ),
        annotations=CANDIDATE_WRITE,
        structured_output=True,
    )
    async def memory_propose_record_create(
        content: Annotated[
            dict[str, Any],
            WithJsonSchema(RECORD_CREATE_TOOL_CONTENT_SCHEMA, mode="validation"),
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
        try:
            validated_content = CandidateRecordCreate.model_validate(content)
        except ValidationError as exc:
            return _candidate_validation_error(exc)
        return await _propose_change(
            client,
            RecordCreateChange(change_type="record_create", content=validated_content),
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
            "the candidate." + RECORD_DATETIME_RULES
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
            dict[str, Any],
            WithJsonSchema(RECORD_UPDATE_TOOL_CONTENT_SCHEMA, mode="validation"),
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
        try:
            validated_content = CandidateRecordUpdatePatch.model_validate(content)
        except ValidationError as exc:
            return _candidate_validation_error(exc)
        return await _propose_change(
            client,
            RecordUpdateChange(
                change_type="record_update",
                target_id=target_id,
                base_version=base_version,
                content=validated_content,
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

    @server.tool(
        name="memory_propose_media_experience_batch",
        title="Propose Media Experiences as a Batch",
        description=(
            "Submit 1 to 50 typed media-experience items in one reviewable Batch. "
            "Each item is normalized and planned independently; this only creates a pending "
            "candidate and never writes formal records."
        ),
        annotations=CANDIDATE_WRITE,
        structured_output=True,
    )
    async def memory_propose_media_experience_batch(
        items: Annotated[
            tuple[MediaExperienceBatchItemInput, ...],
            Field(
                min_length=1,
                max_length=50,
                description="Typed media experiences; each becomes one independently stored item.",
            ),
        ],
        idempotency_key: Annotated[str, Field(min_length=1, max_length=160)],
        summary: Annotated[str | None, Field(max_length=500)] = None,
        source_reference: Annotated[str | None, Field(max_length=1000)] = None,
        confidence: Annotated[float | None, Field(ge=0, le=1)] = None,
        risk_flags: Annotated[tuple[str, ...], Field(max_length=20)] = (),
    ) -> BatchCandidateToolOutput:
        try:
            response = await client.create_media_experience_batch(
                {
                    "profile_id": "media.experience.v1",
                    "profile_version": 1,
                    "summary": summary,
                    "items": [item.model_dump(mode="json") for item in items],
                    "source_type": "mcp",
                    "source_reference": source_reference,
                    "idempotency_key": idempotency_key,
                    "confidence": confidence,
                    "risk_flags": list(risk_flags),
                }
            )
            raw_candidate = response.get("candidate")
            if not isinstance(raw_candidate, dict):
                raise MemoryCoreApiError(
                    "Backend returned an invalid batch candidate",
                    code="invalid_backend_response",
                )
            projected_batch = project_external_value(
                {key: value for key, value in response.items() if key != "candidate"}
            )
            if not isinstance(projected_batch, dict):
                raise MemoryCoreApiError(
                    "Backend returned an invalid batch projection",
                    code="invalid_backend_response",
                )
            return _model_result(
                BatchCandidateToolOutput(
                    candidate=_candidate_item(raw_candidate),
                    batch=projected_batch,
                    message=(
                        "Pending Batch created. Formal memory is unchanged until reviewer approval."
                    ),
                )
            )
        except MemoryCoreApiError as exc:
            return _error_result(
                BatchCandidateToolOutput,
                exc.public_message(),
                code=exc.code,
                field=exc.field,
                received_value=exc.received_value,
                example=exc.example,
            )
        except Exception:
            logger.exception("Unexpected media Batch proposal tool failure")
            return _error_result(
                BatchCandidateToolOutput,
                "Unexpected adapter failure",
                code="adapter_error",
            )

    @server.tool(
        name="memory_list_collections",
        title="List Memory Core Collections",
        description=(
            "List logical memory groups with visible member counts. Use "
            "memory_get_collection to browse one group; this never changes stored data."
        ),
        annotations=READ_ONLY,
        structured_output=True,
    )
    async def memory_list_collections(
        domain: Annotated[str | None, Field(min_length=1, max_length=80)] = None,
        limit: Annotated[int, Field(ge=1, le=100)] = 50,
    ) -> CollectionListToolOutput:
        try:
            raw_items = await client.list_collections(domain=domain, limit=limit)
            items = [
                CollectionSummaryToolItem(
                    key=str(item.get("key") or ""),
                    name=redact_machine_local_text(str(item.get("name") or "")),
                    domain=(
                        redact_machine_local_text(str(item["domain"]))
                        if item.get("domain") is not None
                        else None
                    ),
                    member_count=int(item.get("member_count") or 0),
                    version=int(item.get("version") or 1),
                )
                for item in raw_items
            ]
            return _model_result(CollectionListToolOutput(collections=items))
        except MemoryCoreApiError as exc:
            return _error_result(
                CollectionListToolOutput,
                exc.public_message(),
                code=exc.code,
            )
        except Exception:
            logger.exception("Unexpected collection list tool failure")
            return _error_result(
                CollectionListToolOutput,
                "Unexpected adapter failure",
                code="adapter_error",
            )

    @server.tool(
        name="memory_get_collection",
        title="Browse a Memory Core Collection",
        description=(
            "Return one Collection as a bounded list of independently fetchable record refs. "
            "Use fetch(record_ref) for the complete canonical item."
        ),
        annotations=READ_ONLY,
        structured_output=True,
    )
    async def memory_get_collection(
        collection_key: Annotated[
            str,
            Field(
                min_length=1,
                max_length=160,
                pattern=r"^[A-Za-z0-9_.-]+$",
            ),
        ],
        limit: Annotated[int, Field(ge=1, le=500)] = 100,
    ) -> CollectionGetToolOutput:
        try:
            collection = await client.get_collection(collection_key, limit=limit)
            raw_members = collection.get("members")
            records_out: list[dict[str, Any]] = []
            if isinstance(raw_members, list):
                for member in raw_members:
                    if not isinstance(member, dict):
                        continue
                    record = member.get("record")
                    if not isinstance(record, dict):
                        continue
                    record_id = record.get("id")
                    if not isinstance(record_id, str):
                        continue
                    records_out.append(
                        {
                            "record_ref": f"record:{record_id}",
                            "title": redact_machine_local_text(
                                str(record.get("title") or "Untitled record")
                            ),
                            "domain": record.get("domain"),
                            "kind": record.get("kind"),
                            "schema_name": record.get("schema_name"),
                            "version": record.get("version"),
                            "position": member.get("position"),
                        }
                    )
            return _model_result(
                CollectionGetToolOutput(
                    key=str(collection.get("key") or collection_key),
                    name=redact_machine_local_text(str(collection.get("name") or "")),
                    domain=(
                        redact_machine_local_text(str(collection["domain"]))
                        if collection.get("domain") is not None
                        else None
                    ),
                    member_count=int(collection.get("member_count") or len(records_out)),
                    records=records_out,
                )
            )
        except MemoryCoreApiError as exc:
            return _error_result(
                CollectionGetToolOutput,
                exc.public_message(),
                code=exc.code,
            )
        except Exception:
            logger.exception("Unexpected collection get tool failure")
            return _error_result(
                CollectionGetToolOutput,
                "Unexpected adapter failure",
                code="adapter_error",
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
        name="memory_get_batch_candidate",
        title="Get Memory Core Batch Candidate",
        description=(
            "Read the current immutable Batch revision including each normalized item, "
            "decision, operation plan, and execution result. Viewing is not approval."
        ),
        annotations=READ_ONLY,
        structured_output=True,
    )
    async def memory_get_batch_candidate(
        candidate_id: Annotated[str, Field(min_length=1, max_length=36)],
        limit: Annotated[int, Field(ge=1, le=50)] = 50,
        offset: Annotated[int, Field(ge=0)] = 0,
    ) -> BatchCandidateToolOutput:
        try:
            response = await review_client.get_candidate_batch(candidate_id)
            page = await review_client.list_candidate_batch_items(
                candidate_id,
                limit=limit,
                offset=offset,
            )
            response["items"] = page.get("items", [])
            response["items_page"] = {
                "total": page.get("total", 0),
                "limit": page.get("limit", limit),
                "offset": page.get("offset", offset),
                "truncated": bool(page.get("truncated")),
            }
            raw_candidate = response.get("candidate")
            if not isinstance(raw_candidate, dict):
                raise MemoryCoreApiError(
                    "Backend returned an invalid batch candidate",
                    code="invalid_backend_response",
                )
            projected_batch, redactions = project_external_value_with_redactions(
                {key: value for key, value in response.items() if key != "candidate"},
                root="batch",
            )
            if not isinstance(projected_batch, dict):
                raise MemoryCoreApiError(
                    "Backend returned an invalid batch projection",
                    code="invalid_backend_response",
                )
            candidate_item = _candidate_item(raw_candidate)
            incomplete_page = offset != 0 or bool(page.get("truncated"))
            if redactions:
                candidate_item = candidate_item.model_copy(
                    update={
                        "display_mode": "redacted",
                        "redacted_fields": sorted(
                            set([*candidate_item.redacted_fields, *redactions])
                        ),
                        "remote_approval_allowed": False,
                        "remote_approval_block_reason": (
                            "This Batch contains machine-local values hidden from the remote "
                            "view. Use the trusted local reviewer."
                        ),
                    }
                )
            if incomplete_page:
                candidate_item = candidate_item.model_copy(
                    update={
                        "remote_approval_allowed": False,
                        "remote_approval_block_reason": (
                            "This response is only a partial Batch page. Read the complete "
                            "revision before approval."
                        ),
                    }
                )
            return _model_result(
                BatchCandidateToolOutput(
                    candidate=candidate_item,
                    batch=projected_batch,
                )
            )
        except MemoryCoreApiError as exc:
            return _error_result(
                BatchCandidateToolOutput,
                exc.public_message(),
                code=exc.code,
            )
        except Exception:
            logger.exception("Unexpected batch candidate get tool failure")
            return _error_result(
                BatchCandidateToolOutput,
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
            if candidate_item.candidate_kind == "batch":
                batch = await review_client.get_candidate_batch(candidate_id)
                counts = _batch_execution_counts(batch)
                failed_items, failed_items_truncated = _batch_failed_items(batch)
                batch_state = str(batch.get("execution_state") or "not_started")
                any_item_committed = counts["applied"] > 0
                all_items_completed = (
                    counts["pending"] == 0 and counts["unverified"] == 0 and counts["failed"] == 0
                )
                if batch_state == "applied":
                    message = (
                        "Batch applied. Fetch every results[].result_ref to verify each formal "
                        "Record or Entity."
                    )
                elif batch_state == "partially_applied":
                    message = (
                        "Batch partially applied. Successful Items are committed and were not "
                        "rolled back. Items marked new_batch_required need a new Batch."
                    )
                elif batch_state == "failed":
                    message = (
                        "Batch execution failed without a complete result. Inspect failed_items "
                        "and retry_policy before taking further action."
                    )
                else:
                    message = (
                        "Batch execution has not reached a terminal state. Refresh the Batch "
                        "detail before retrying or reporting success."
                    )
                return _model_result(
                    CandidateApproveToolOutput(
                        candidate=candidate_item,
                        results=_batch_candidate_result_items(batch),
                        transaction_committed=any_item_committed,
                        batch_execution_state=batch_state,
                        item_count=counts["item_count"],
                        applied_count=counts["applied"],
                        failed_count=counts["failed"],
                        unverified_count=counts["unverified"],
                        skipped_count=counts["skipped"],
                        pending_count=counts["pending"],
                        any_item_committed=any_item_committed,
                        all_items_completed=all_items_completed,
                        failed_items=failed_items,
                        failed_items_truncated=failed_items_truncated,
                        message=message,
                    )
                )
            validation_result = candidate.get("validation_result")
            transaction_committed = (
                bool(validation_result.get("transaction_committed"))
                if isinstance(validation_result, dict)
                and candidate_item.candidate_kind == "change_set"
                else candidate_item.status == "applied"
            )
            return _model_result(
                CandidateApproveToolOutput(
                    candidate=candidate_item,
                    result_id=candidate_item.result_id,
                    result_ref=candidate_item.result_ref,
                    result_type=candidate_item.result_type,
                    result_version=candidate_item.result_version,
                    results=candidate_item.results,
                    transaction_committed=transaction_committed,
                    message=(
                        (
                            "ChangeSet applied atomically. Fetch every results[].result_ref "
                            "to verify each formal Record."
                        )
                        if candidate_item.candidate_kind == "change_set"
                        else (
                            "Candidate applied. Fetch result_ref to verify the formal "
                            "record or entity."
                        )
                    ),
                )
            )
        except MemoryCoreApiError as exc:
            return _error_result(
                CandidateApproveToolOutput,
                exc.public_message(),
                code=exc.code,
                field=exc.field,
                received_value=exc.received_value,
                example=exc.example,
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
