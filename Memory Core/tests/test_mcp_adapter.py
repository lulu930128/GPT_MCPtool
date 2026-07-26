from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import CallToolResult
from pydantic import SecretStr, ValidationError
from starlette.testclient import TestClient

from memory_core.mcp.client import MemoryCoreApiClient, MemoryCoreApiError
from memory_core.mcp.runtime import build_runtime, create_http_app
from memory_core.mcp.settings import McpSettings

TEST_MCP_TOKEN = "test-memory-core-mcp-token"
TEST_MCP_REVIEW_TOKEN = "test-memory-core-mcp-review-token"
PROPOSAL_TOOL_NAMES = {
    "memory_propose_record_create",
    "memory_propose_record_update",
    "memory_propose_record_archive",
    "memory_propose_entity_create",
    "memory_propose_entity_update",
    "memory_propose_entity_archive",
}


def mcp_settings(**overrides: Any) -> McpSettings:
    values: dict[str, Any] = {
        "client_token": SecretStr(TEST_MCP_TOKEN),
        "max_content_chars": 4_000,
    }
    values.update(overrides)
    return McpSettings(**values)


def parse_result(result: CallToolResult) -> dict[str, Any]:
    assert len(result.content) == 1
    content = result.content[0]
    assert content.type == "text"
    parsed = json.loads(content.text)
    assert isinstance(parsed, dict)
    assert result.structuredContent == parsed
    return parsed


def candidate_response(
    *,
    candidate_id: str = "candidate-1",
    status: str = "pending",
    operation: str = "create",
    target_type: str = "record",
    target_id: str | None = None,
    base_version: int | None = None,
    proposed_content: dict[str, Any] | None = None,
    source_reference: str | None = None,
    risk_flags: list[str] | None = None,
    review_action: str | None = None,
    review_note: str | None = None,
    result_id: str | None = None,
    result_version: int | None = None,
) -> dict[str, Any]:
    return {
        "id": candidate_id,
        "status": status,
        "operation": operation,
        "target_type": target_type,
        "target_id": target_id,
        "base_version": base_version,
        "proposed_content": (
            proposed_content
            if proposed_content is not None
            else {"kind": "idea", "domain": "general", "title": "候選想法"}
        ),
        "source_reference": source_reference,
        "confidence": None,
        "risk_flags": risk_flags or [],
        "review_digest": "sha256:v1:" + ("a" * 64),
        "created_at": "2026-07-22T00:00:00Z",
        "expires_at": "2026-07-29T00:00:00Z",
        "review_action": review_action,
        "review_note": review_note,
        "result_id": result_id,
        "result_version": result_version,
    }


def call_tool(runtime: Any, name: str, arguments: dict[str, Any]) -> CallToolResult:
    result = asyncio.run(runtime.server.call_tool(name, arguments))
    assert isinstance(result, CallToolResult)
    return result


def test_mcp_settings_reject_non_loopback_and_mask_token() -> None:
    settings = mcp_settings(review_client_token=SecretStr(TEST_MCP_REVIEW_TOKEN))
    assert TEST_MCP_TOKEN not in repr(settings)
    assert TEST_MCP_REVIEW_TOKEN not in repr(settings)

    with pytest.raises(ValidationError, match="loopback"):
        mcp_settings(api_base_url="https://memory.example.com")
    with pytest.raises(ValidationError, match="loopback"):
        mcp_settings(host="0.0.0.0")
    with pytest.raises(ValidationError, match="must not contain credentials"):
        mcp_settings(api_base_url="http://user:password@127.0.0.1:8765")


def test_api_error_does_not_expose_token() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["X-Memory-Core-Token"] == TEST_MCP_TOKEN
        return httpx.Response(
            401,
            headers={"X-Request-ID": "request-401"},
            json={"detail": "Invalid client token"},
        )

    client = MemoryCoreApiClient(mcp_settings(), transport=httpx.MockTransport(handler))
    with pytest.raises(MemoryCoreApiError) as captured:
        asyncio.run(client.search("test", 10))
    asyncio.run(client.close())

    public = captured.value.public_message()
    assert TEST_MCP_TOKEN not in public
    assert "HTTP 401" in public
    assert "request-401" in public


def test_tools_are_scoped_and_use_backend_http_only() -> None:
    calls: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path))
        assert request.headers["X-Memory-Core-Token"] == TEST_MCP_TOKEN
        if request.url.path == "/api/v1/search":
            assert request.url.params["q"] == "閱讀"
            return httpx.Response(
                200,
                json=[
                    {
                        "result_type": "record",
                        "id": "record-1",
                        "title": "日文閱讀進度",
                        "summary": "完成一章",
                        "domain": "study",
                        "kind": "state",
                        "sensitivity": "personal",
                        "updated_at": "2026-07-22T00:00:00Z",
                        "score": 42,
                        "matched_fields": ["title"],
                        "matched_terms": ["閱讀"],
                        "query_strategy": "fts_or_substring",
                        "normalized_query": "閱讀",
                    },
                    {
                        "result_type": "entity",
                        "id": "entity-1",
                        "title": "作品名稱",
                        "summary": None,
                        "domain": None,
                        "kind": "media",
                        "sensitivity": "personal",
                        "updated_at": "2026-07-22T00:00:00Z",
                        "score": 12,
                        "matched_fields": ["name"],
                        "matched_terms": ["閱讀"],
                        "query_strategy": "fts_or_substring",
                        "normalized_query": "閱讀",
                    },
                ],
            )
        if request.url.path == "/api/v1/records/record-1":
            return httpx.Response(
                200,
                json={
                    "id": "record-1",
                    "title": "日文閱讀進度",
                    "summary": "完成一章",
                    "body_markdown": "今天讀完第一章。",
                    "payload": {"chapter": 1},
                    "kind": "state",
                    "domain": "study",
                    "sensitivity": "personal",
                    "version": 1,
                    "created_at": "2026-07-22T00:00:00Z",
                    "updated_at": "2026-07-22T00:00:00Z",
                },
            )
        if request.url.path == "/api/v1/candidates":
            submitted = json.loads(request.content)
            assert submitted["source_type"] == "mcp"
            assert submitted["idempotency_key"] == "proposal-1"
            assert submitted["change"]["change_type"] == "record_create"
            return httpx.Response(
                201,
                json=candidate_response(),
            )
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    runtime = build_runtime(mcp_settings(), transport=httpx.MockTransport(handler))
    tools = {tool.name: tool for tool in asyncio.run(runtime.server.list_tools())}
    assert set(tools) == {
        "search",
        "fetch",
        "memory_overview",
        "memory_detect_duplicates",
        *PROPOSAL_TOOL_NAMES,
    }
    assert tools["search"].annotations is not None
    assert tools["search"].annotations.readOnlyHint is True
    assert tools["fetch"].annotations is not None
    assert tools["fetch"].annotations.readOnlyHint is True
    for tool_name in PROPOSAL_TOOL_NAMES:
        tool = tools[tool_name]
        assert tool.annotations is not None
        assert tool.annotations.readOnlyHint is False
        assert tool.annotations.destructiveHint is False
        assert tool.annotations.idempotentHint is True
        assert "change" not in tool.inputSchema["properties"]
        assert "oneOf" not in json.dumps(tool.inputSchema)
        assert tool.outputSchema is not None
        assert tool.outputSchema["additionalProperties"] is False
    assert set(tools["memory_propose_record_create"].inputSchema["required"]) == {
        "content",
        "idempotency_key",
    }
    assert set(tools["memory_propose_record_update"].inputSchema["required"]) == {
        "target_ref",
        "base_version",
        "content",
        "idempotency_key",
    }
    assert set(tools["memory_propose_record_archive"].inputSchema["required"]) == {
        "target_ref",
        "base_version",
        "idempotency_key",
    }
    record_create_schema = json.dumps(
        tools["memory_propose_record_create"].inputSchema,
        ensure_ascii=False,
    )
    entity_create_schema = json.dumps(
        tools["memory_propose_entity_create"].inputSchema,
        ensure_ascii=False,
    )
    assert "entity_links" in record_create_schema
    assert "entity_ref" in record_create_schema
    assert "relations" in entity_create_schema
    assert "object_entity_ref" in entity_create_schema
    assert "merged_into_ref" in tools["memory_propose_record_archive"].inputSchema["properties"]
    assert "merged_into_ref" in tools["memory_propose_entity_archive"].inputSchema["properties"]

    search_result = call_tool(runtime, "search", {"query": "閱讀", "limit": 10})
    assert search_result.isError is False
    assert parse_result(search_result) == {
        "ok": True,
        "error": None,
        "results": [
            {
                "id": "record:record-1",
                "result_type": "record",
                "title": "日文閱讀進度",
                "url": "memory-core://record/record-1",
                "snippet": "完成一章",
                "domain": "study",
                "kind": "state",
                "updated_at": "2026-07-22T00:00:00Z",
                "score": 42.0,
                "matched_fields": ["title"],
                "matched_terms": ["閱讀"],
                "query_strategy": "fts_or_substring",
                "normalized_query": "閱讀",
            },
            {
                "id": "entity:entity-1",
                "result_type": "entity",
                "title": "作品名稱",
                "url": "memory-core://entity/entity-1",
                "snippet": None,
                "domain": None,
                "kind": "media",
                "updated_at": "2026-07-22T00:00:00Z",
                "score": 12.0,
                "matched_fields": ["name"],
                "matched_terms": ["閱讀"],
                "query_strategy": "fts_or_substring",
                "normalized_query": "閱讀",
            },
        ],
    }

    fetch_result = call_tool(runtime, "fetch", {"id": "record:record-1"})
    fetched = parse_result(fetch_result)
    assert fetched["id"] == "record:record-1"
    assert "今天讀完第一章" in fetched["text"]
    assert fetched["metadata"]["truncated"] is False

    candidate_result = call_tool(
        runtime,
        "memory_propose_record_create",
        {
            "content": {
                "kind": "idea",
                "domain": "general",
                "title": "候選想法",
            },
            "idempotency_key": "proposal-1",
        },
    )
    candidate = parse_result(candidate_result)
    assert candidate["candidate"]["status"] == "pending"
    assert "explicit review" in candidate["message"]
    assert calls == [
        ("GET", "/api/v1/search"),
        ("GET", "/api/v1/records/record-1"),
        ("POST", "/api/v1/candidates"),
    ]
    asyncio.run(runtime.api_client.close())


def test_all_proposal_tools_map_to_strict_backend_changes() -> None:
    submitted: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/api/v1/candidates"
        payload = json.loads(request.content)
        submitted.append(payload)
        change = payload["change"]
        return httpx.Response(
            201,
            json=candidate_response(
                candidate_id=f"candidate-{len(submitted)}",
                operation=change["change_type"].rsplit("_", 1)[1],
                target_type=change["change_type"].split("_", 1)[0],
                target_id=change.get("target_id"),
                base_version=change.get("base_version"),
                proposed_content=change.get("content")
                or {
                    key: change[key]
                    for key in ("change_reason", "merged_into_ref")
                    if change.get(key)
                },
            ),
        )

    runtime = build_runtime(mcp_settings(), transport=httpx.MockTransport(handler))
    cases = [
        (
            "memory_propose_record_create",
            {
                "content": {"kind": "idea", "title": "候選想法"},
                "idempotency_key": "record-create",
            },
            {
                "change_type": "record_create",
                "content": {
                    "kind": "idea",
                    "title": "候選想法",
                },
            },
        ),
        (
            "memory_propose_record_update",
            {
                "target_ref": "record:record-1",
                "base_version": 2,
                "content": {"title": "更新標題"},
                "idempotency_key": "record-update",
            },
            {
                "change_type": "record_update",
                "target_id": "record-1",
                "base_version": 2,
                "content": {"title": "更新標題"},
            },
        ),
        (
            "memory_propose_record_archive",
            {
                "target_ref": "record:record-1",
                "base_version": 2,
                "change_reason": "不再適用",
                "merged_into_ref": "record:record-canonical",
                "idempotency_key": "record-archive",
            },
            {
                "change_type": "record_archive",
                "target_id": "record-1",
                "base_version": 2,
                "change_reason": "不再適用",
                "merged_into_ref": "record:record-canonical",
            },
        ),
        (
            "memory_propose_entity_create",
            {
                "content": {"entity_type": "media", "name": "作品名稱"},
                "idempotency_key": "entity-create",
            },
            {
                "change_type": "entity_create",
                "content": {
                    "entity_type": "media",
                    "name": "作品名稱",
                },
            },
        ),
        (
            "memory_propose_entity_update",
            {
                "target_ref": "entity:entity-1",
                "base_version": 3,
                "content": {"description": "更新描述"},
                "idempotency_key": "entity-update",
            },
            {
                "change_type": "entity_update",
                "target_id": "entity-1",
                "base_version": 3,
                "content": {"description": "更新描述"},
            },
        ),
        (
            "memory_propose_entity_archive",
            {
                "target_ref": "entity:entity-1",
                "base_version": 3,
                "merged_into_ref": "entity:entity-canonical",
                "idempotency_key": "entity-archive",
            },
            {
                "change_type": "entity_archive",
                "target_id": "entity-1",
                "base_version": 3,
                "merged_into_ref": "entity:entity-canonical",
            },
        ),
    ]

    for tool_name, arguments, expected_change in cases:
        result = parse_result(call_tool(runtime, tool_name, arguments))
        assert result["candidate"]["status"] == "pending"
        assert submitted[-1]["change"] == expected_change
        assert submitted[-1]["source_type"] == "mcp"
        assert submitted[-1]["idempotency_key"] == arguments["idempotency_key"]
    asyncio.run(runtime.api_client.close())


def test_legacy_candidate_tool_requires_explicit_compatibility_switch() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("No backend call expected")

    default_runtime = build_runtime(mcp_settings(), transport=httpx.MockTransport(handler))
    default_names = {tool.name for tool in asyncio.run(default_runtime.server.list_tools())}
    assert "memory_create_candidate" not in default_names
    asyncio.run(default_runtime.api_client.close())

    legacy_runtime = build_runtime(
        mcp_settings(expose_legacy_candidate_tool=True),
        transport=httpx.MockTransport(handler),
    )
    legacy_names = {tool.name for tool in asyncio.run(legacy_runtime.server.list_tools())}
    assert "memory_create_candidate" in legacy_names
    asyncio.run(legacy_runtime.api_client.close())


def test_fetch_rejects_unknown_reference_without_backend_call() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("Backend must not be called for an invalid reference")

    runtime = build_runtime(mcp_settings(), transport=httpx.MockTransport(handler))
    result = call_tool(runtime, "fetch", {"id": "unknown"})
    assert result.isError is True
    assert parse_result(result)["error"]["code"] == "invalid_reference_id"
    asyncio.run(runtime.api_client.close())


def test_fetch_redacts_machine_local_paths_from_record_projection() -> None:
    local_path = r"C:\Users\example\Documents\completed-games"

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/records/record-path"
        return httpx.Response(
            200,
            json={
                "id": "record-path",
                "title": "本機來源紀錄",
                "summary": f"由 {local_path} 匯入。",
                "body_markdown": f"原始資料夾：{local_path}",
                "payload": {
                    "source_path": local_path,
                    "nested": {
                        "workspace_path": r"D:\private\memory",
                        "note": r"可從 C:\project\Memory Core 重新掃描",
                    },
                },
                "kind": "state",
                "domain": "media",
                "source_type": "local_scan",
                "source_reference": local_path,
                "sensitivity": "personal",
                "version": 1,
                "created_at": "2026-07-22T00:00:00Z",
                "updated_at": "2026-07-22T00:00:00Z",
            },
        )

    runtime = build_runtime(mcp_settings(), transport=httpx.MockTransport(handler))
    fetched = parse_result(call_tool(runtime, "fetch", {"id": "record:record-path"}))
    serialized = json.dumps(fetched, ensure_ascii=False)
    assert "C:\\" not in serialized
    assert "D:\\" not in serialized
    assert "thoma" not in serialized
    assert "[local path hidden]" in serialized
    assert fetched["metadata"]["source_reference"] == "local source (path hidden)"
    asyncio.run(runtime.api_client.close())


def test_fetch_redacts_machine_local_paths_from_entity_projection() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/entities/entity-path"
        return httpx.Response(
            200,
            json={
                "id": "entity-path",
                "entity_type": "project",
                "name": "本機專案",
                "description": r"工作目錄位於 C:\GPT_MCPtool\Memory Core",
                "payload": {
                    "root_path": r"C:\GPT_MCPtool\Memory Core",
                    "documentation": r"請查看 C:/Users/thoma/Documents/notes.md",
                },
                "sensitivity": "personal",
                "handling_policy": "normal",
                "version": 1,
                "created_at": "2026-07-22T00:00:00Z",
                "updated_at": "2026-07-22T00:00:00Z",
            },
        )

    runtime = build_runtime(mcp_settings(), transport=httpx.MockTransport(handler))
    fetched = parse_result(call_tool(runtime, "fetch", {"id": "entity:entity-path"}))
    serialized = json.dumps(fetched, ensure_ascii=False)
    assert "C:\\" not in serialized
    assert "C:/" not in serialized
    assert "thoma" not in serialized
    assert "[local path hidden]" in serialized
    asyncio.run(runtime.api_client.close())


def test_fetch_can_verify_archived_result_state() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/records/archived-record"
        assert request.url.params["include_deleted"] == "true"
        return httpx.Response(
            200,
            json={
                "id": "archived-record",
                "title": "Archived record",
                "summary": None,
                "body_markdown": "Preserved for audit.",
                "payload": {},
                "kind": "state",
                "domain": "general",
                "lifecycle_status": "archived",
                "sensitivity": "personal",
                "version": 2,
                "deleted_at": "2026-07-26T00:00:00Z",
                "created_at": "2026-07-25T00:00:00Z",
                "updated_at": "2026-07-26T00:00:00Z",
            },
        )

    runtime = build_runtime(mcp_settings(), transport=httpx.MockTransport(handler))
    fetched = parse_result(call_tool(runtime, "fetch", {"id": "record:archived-record"}))
    assert fetched["id"] == "record:archived-record"
    assert fetched["metadata"]["state"] == "archived"
    assert fetched["metadata"]["lifecycle_status"] == "archived"
    assert fetched["metadata"]["deleted_at"] == "2026-07-26T00:00:00Z"
    asyncio.run(runtime.api_client.close())


def test_candidate_list_returns_bounded_redacted_summaries() -> None:
    local_path = r"C:\Users\example\Documents\completed-games"

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        assert request.url.path == "/api/v1/candidates"
        assert request.headers["X-Memory-Core-Token"] == TEST_MCP_REVIEW_TOKEN
        return httpx.Response(
            200,
            json=[
                candidate_response(
                    proposed_content={
                        "kind": "fact",
                        "title": "Galgame 完食紀錄",
                        "body_markdown": f"完整內容來自 {local_path}",
                        "payload": {"source_path": local_path},
                    },
                    source_reference=local_path,
                    review_note=f"曾由 {local_path} 匯入",
                )
            ],
        )

    runtime = build_runtime(
        mcp_settings(review_client_token=SecretStr(TEST_MCP_REVIEW_TOKEN)),
        transport=httpx.MockTransport(handler),
    )
    listed = parse_result(
        call_tool(runtime, "memory_list_candidates", {"status": "pending", "limit": 100})
    )

    serialized = json.dumps(listed, ensure_ascii=False)
    assert "C:\\" not in serialized
    assert "thoma" not in serialized
    assert "完整內容來自" not in serialized
    assert "proposed_content" not in listed["candidates"][0]
    assert "source_reference" not in listed["candidates"][0]
    assert "review_note" not in listed["candidates"][0]
    assert listed["candidates"][0]["title"] == "Galgame 完食紀錄"
    assert listed["candidates"][0]["review_digest"].startswith("sha256:v1:")
    asyncio.run(runtime.api_client.close())
    assert runtime.review_api_client is not None
    asyncio.run(runtime.review_api_client.close())


def test_memory_overview_merges_formal_and_candidate_stats() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        token = request.headers["X-Memory-Core-Token"]
        if token == TEST_MCP_TOKEN:
            assert request.url.path == "/api/v1/overview"
            return httpx.Response(
                200,
                json={
                    "generated_at": "2026-07-26T00:00:00Z",
                    "scope": "visible",
                    "restricted_included": False,
                    "records": {"active": 3, "superseded": 0, "archived": 0},
                    "entities": {"active": 0, "archived": 0},
                    "domains": {"media.galgame": 2, "entertainment": 1},
                    "domain_taxonomy": {
                        "media.galgame": "canonical",
                        "entertainment": "legacy",
                    },
                    "schema_versions": {
                        "media_experience@1": 2,
                        "media_experience_catalog@1": 1,
                    },
                    "index": {
                        "status": "healthy",
                        "engine": "sqlite_fts5",
                        "searchable_records": 3,
                        "indexed_records": 3,
                        "last_indexed_at": "2026-07-25T00:00:00Z",
                    },
                },
            )
        assert token == TEST_MCP_REVIEW_TOKEN
        assert request.url.path == "/api/v1/candidates/stats"
        return httpx.Response(
            200,
            json={
                "pending": 0,
                "applied": 3,
                "rejected": 1,
                "conflict": 0,
                "expired": 0,
            },
        )

    runtime = build_runtime(
        mcp_settings(review_client_token=SecretStr(TEST_MCP_REVIEW_TOKEN)),
        transport=httpx.MockTransport(handler),
    )
    overview = parse_result(call_tool(runtime, "memory_overview", {}))
    assert overview["records"]["active"] == 3
    assert overview["entities"]["active"] == 0
    assert overview["domain_taxonomy"]["entertainment"] == "legacy"
    assert overview["candidates"] == {
        "pending": 0,
        "applied": 3,
        "rejected": 1,
        "conflict": 0,
        "expired": 0,
    }
    assert overview["candidate_counts_available"] is True
    assert overview["index"]["status"] == "healthy"
    assert overview["warnings"] == []
    asyncio.run(runtime.api_client.close())
    assert runtime.review_api_client is not None
    asyncio.run(runtime.review_api_client.close())


def test_candidate_detail_redacts_paths_and_blocks_remote_review() -> None:
    local_path = r"C:\Users\example\Documents\completed-games"
    candidate = candidate_response(
        candidate_id="candidate-sensitive",
        proposed_content={
            "kind": "fact",
            "title": "敏感來源候選",
            "body_markdown": f"來源：{local_path}",
            "payload": {"source_path": local_path},
        },
        source_reference=local_path,
    )
    calls: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path))
        assert request.method == "GET"
        assert request.url.path == "/api/v1/candidates/candidate-sensitive"
        assert request.headers["X-Memory-Core-Token"] == TEST_MCP_REVIEW_TOKEN
        return httpx.Response(200, json=candidate)

    runtime = build_runtime(
        mcp_settings(review_client_token=SecretStr(TEST_MCP_REVIEW_TOKEN)),
        transport=httpx.MockTransport(handler),
    )

    detail = parse_result(
        call_tool(runtime, "memory_get_candidate", {"candidate_id": "candidate-sensitive"})
    )
    serialized = json.dumps(detail, ensure_ascii=False)
    assert "C:\\" not in serialized
    assert "thoma" not in serialized
    assert detail["candidate"]["display_mode"] == "redacted"
    assert detail["candidate"]["remote_approval_allowed"] is False
    assert detail["candidate"]["redacted_fields"]

    prepared = call_tool(
        runtime,
        "memory_prepare_candidate_review",
        {
            "candidate_id": "candidate-sensitive",
            "expected_review_digest": candidate["review_digest"],
        },
    )
    assert prepared.isError is True
    assert parse_result(prepared)["error"]["code"] == "candidate_requires_local_review"

    approved = call_tool(
        runtime,
        "memory_approve_candidate",
        {
            "candidate_id": "candidate-sensitive",
            "expected_review_digest": candidate["review_digest"],
            "approval_challenge": "challenge-" + ("a" * 32),
            "idempotency_key": "approve-sensitive",
        },
    )
    assert approved.isError is True
    assert parse_result(approved)["error"]["code"] == "candidate_requires_local_review"
    assert calls == [
        ("GET", "/api/v1/candidates/candidate-sensitive"),
        ("GET", "/api/v1/candidates/candidate-sensitive"),
        ("GET", "/api/v1/candidates/candidate-sensitive"),
    ]
    asyncio.run(runtime.api_client.close())
    assert runtime.review_api_client is not None
    asyncio.run(runtime.review_api_client.close())


def test_proposal_rejects_machine_local_paths_before_backend_call() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("Backend must not receive machine-local paths from an MCP proposal")

    runtime = build_runtime(mcp_settings(), transport=httpx.MockTransport(handler))
    proposed = call_tool(
        runtime,
        "memory_propose_record_create",
        {
            "content": {
                "kind": "fact",
                "title": "不安全來源",
                "body_markdown": r"來源位於 C:\Users\example\private\memory.txt",
            },
            "idempotency_key": "unsafe-local-path",
        },
    )

    assert proposed.isError is True
    parsed = parse_result(proposed)
    assert parsed["error"]["code"] == "machine_local_path_not_allowed"
    assert "C:\\" not in json.dumps(parsed, ensure_ascii=False)
    asyncio.run(runtime.api_client.close())


def test_approve_exposes_entity_result_reference() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["X-Memory-Core-Token"] == TEST_MCP_REVIEW_TOKEN
        if request.method == "GET":
            assert request.url.path == "/api/v1/candidates/candidate-entity"
            return httpx.Response(
                200,
                json=candidate_response(
                    candidate_id="candidate-entity",
                    target_type="entity",
                ),
            )
        assert request.method == "POST"
        assert request.url.path == "/api/v1/candidates/candidate-entity/apply"
        return httpx.Response(
            200,
            json=candidate_response(
                candidate_id="candidate-entity",
                status="applied",
                target_type="entity",
                result_id="entity-1",
                result_version=1,
            ),
        )

    runtime = build_runtime(
        mcp_settings(review_client_token=SecretStr(TEST_MCP_REVIEW_TOKEN)),
        transport=httpx.MockTransport(handler),
    )
    approved = parse_result(
        call_tool(
            runtime,
            "memory_approve_candidate",
            {
                "candidate_id": "candidate-entity",
                "expected_review_digest": "sha256:v1:" + ("a" * 64),
                "approval_challenge": "challenge-" + ("a" * 32),
                "idempotency_key": "approve-entity-1",
            },
        )
    )

    assert approved["candidate"]["result_ref"] == "entity:entity-1"
    assert approved["candidate"]["result_type"] == "entity"
    assert approved["result_ref"] == "entity:entity-1"
    assert approved["result_type"] == "entity"
    asyncio.run(runtime.api_client.close())
    assert runtime.review_api_client is not None
    asyncio.run(runtime.review_api_client.close())


def test_candidate_validation_fails_before_backend_call() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("Backend must not be called for an invalid candidate")

    runtime = build_runtime(mcp_settings(), transport=httpx.MockTransport(handler))
    with pytest.raises(ToolError, match="target_ref"):
        call_tool(
            runtime,
            "memory_propose_record_update",
            {
                "base_version": 1,
                "content": {"title": "missing target"},
                "idempotency_key": "invalid-proposal",
            },
        )
    with pytest.raises(ToolError, match="timezone"):
        call_tool(
            runtime,
            "memory_propose_record_create",
            {
                "content": {
                    "kind": "fact",
                    "title": "缺少時區的候選",
                    "occurred_start": "2025-07-16T00:00:00",
                    "timezone_name": "Asia/Taipei",
                },
                "idempotency_key": "naive-datetime-proposal",
            },
        )
    asyncio.run(runtime.api_client.close())


def test_http_transport_initializes_lists_and_calls_tools() -> None:
    def backend_handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/health":
            return httpx.Response(200, json={"status": "ok"})
        if request.url.path == "/api/v1/search":
            return httpx.Response(200, json=[])
        raise AssertionError(f"Unexpected backend request: {request.url}")

    runtime = build_runtime(mcp_settings(), transport=httpx.MockTransport(backend_handler))
    app = create_http_app(runtime)
    headers = {
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
    }
    with TestClient(app, base_url="http://127.0.0.1:8818") as client:
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json()["backend"] == "ok"

        initialize = client.post(
            "/mcp",
            headers=headers,
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-11-25",
                    "capabilities": {},
                    "clientInfo": {"name": "memory-core-test", "version": "1.0"},
                },
            },
        )
        assert initialize.status_code == 200
        assert initialize.json()["result"]["serverInfo"]["name"] == "memory-core-mcp"

        listed = client.post(
            "/mcp",
            headers={**headers, "MCP-Protocol-Version": "2025-11-25"},
            json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        )
        assert listed.status_code == 200
        assert {tool["name"] for tool in listed.json()["result"]["tools"]} == {
            "search",
            "fetch",
            "memory_overview",
            "memory_detect_duplicates",
            *PROPOSAL_TOOL_NAMES,
        }

        called = client.post(
            "/mcp",
            headers={**headers, "MCP-Protocol-Version": "2025-11-25"},
            json={
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "search", "arguments": {"query": "nothing"}},
            },
        )
        assert called.status_code == 200
        assert called.json()["result"]["isError"] is False
        expected = {"ok": True, "error": None, "results": []}
        assert called.json()["result"]["structuredContent"] == expected
        assert json.loads(called.json()["result"]["content"][0]["text"]) == expected


def test_mcp_tools_integrate_with_memory_core_api(
    client: TestClient,
    admin_headers: dict[str, str],
    candidate_headers: dict[str, str],
    review_headers: dict[str, str],
) -> None:
    created = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json={
            "kind": "state",
            "domain": "study",
            "title": "MCP 整合測試記憶",
            "body_markdown": "這筆資料只能經由 HTTP API 被 MCP 讀取。",
        },
    )
    assert created.status_code == 201
    record_id = created.json()["id"]

    token = candidate_headers["X-Memory-Core-Token"]
    review_token = review_headers["X-Memory-Core-Token"]
    runtime = build_runtime(
        mcp_settings(
            client_token=SecretStr(token),
            review_client_token=SecretStr(review_token),
        ),
        transport=httpx.ASGITransport(app=client.app),
    )
    tools = {tool.name: tool for tool in asyncio.run(runtime.server.list_tools())}
    assert set(tools) == {
        "search",
        "fetch",
        "memory_overview",
        "memory_detect_duplicates",
        *PROPOSAL_TOOL_NAMES,
        "memory_list_candidates",
        "memory_get_candidate",
        "memory_prepare_candidate_review",
        "memory_approve_candidate",
        "memory_reject_candidate",
    }
    approve_output_schema = tools["memory_approve_candidate"].outputSchema
    assert approve_output_schema is not None
    assert "result_ref" in approve_output_schema["properties"]
    candidate_schema = approve_output_schema["$defs"]["CandidateToolItem"]
    assert "result_ref" in candidate_schema["properties"]

    overview = parse_result(call_tool(runtime, "memory_overview", {}))
    assert overview["records"]["active"] == 1
    assert overview["candidates"]["pending"] == 0

    duplicate_scan = parse_result(call_tool(runtime, "memory_detect_duplicates", {"limit": 10}))
    assert duplicate_scan["scanned_records"] == 1
    assert duplicate_scan["findings"] == []

    searched = parse_result(call_tool(runtime, "search", {"query": "整合測試"}))
    assert searched["results"][0]["id"] == f"record:{record_id}"

    fetched = parse_result(call_tool(runtime, "fetch", {"id": f"record:{record_id}"}))
    assert "只能經由 HTTP API" in fetched["text"]

    proposed = parse_result(
        call_tool(
            runtime,
            "memory_propose_record_update",
            {
                "target_ref": f"record:{record_id}",
                "base_version": 1,
                "content": {"title": "尚待人工核准的標題"},
                "idempotency_key": "mcp-integration-proposal",
            },
        )
    )
    assert proposed["candidate"]["status"] == "pending"

    pending = client.get(
        "/api/v1/candidates",
        headers=admin_headers,
        params={"status": "pending"},
    )
    assert pending.status_code == 200
    assert pending.json()[0]["id"] == proposed["candidate"]["id"]

    unchanged = client.get(f"/api/v1/records/{record_id}", headers=admin_headers)
    assert unchanged.json()["title"] == "MCP 整合測試記憶"

    candidate_id = proposed["candidate"]["id"]
    digest = proposed["candidate"]["review_digest"]
    prepared = parse_result(
        call_tool(
            runtime,
            "memory_prepare_candidate_review",
            {
                "candidate_id": candidate_id,
                "expected_review_digest": digest,
            },
        )
    )
    assert prepared["candidate"]["id"] == candidate_id
    assert prepared["approval_challenge"]

    approved = parse_result(
        call_tool(
            runtime,
            "memory_approve_candidate",
            {
                "candidate_id": candidate_id,
                "expected_review_digest": digest,
                "approval_challenge": prepared["approval_challenge"],
                "idempotency_key": "mcp-integration-approval",
            },
        )
    )
    assert approved["ok"] is True, approved
    assert approved["candidate"]["status"] == "applied"
    assert approved["candidate"]["result_id"] == record_id
    assert approved["candidate"]["result_ref"] == f"record:{record_id}"
    assert approved["candidate"]["result_type"] == "record"
    assert approved["candidate"]["result_version"] == 2
    assert approved["result_id"] == record_id
    assert approved["result_ref"] == f"record:{record_id}"
    assert approved["result_type"] == "record"
    assert approved["result_version"] == 2
    assert "Fetch result_ref" in approved["message"]

    verified = parse_result(call_tool(runtime, "fetch", {"id": approved["result_ref"]}))
    assert verified["id"] == approved["result_ref"]
    assert "尚待人工核准的標題" in verified["text"]

    changed = client.get(f"/api/v1/records/{record_id}", headers=admin_headers)
    assert changed.json()["title"] == "尚待人工核准的標題"
    asyncio.run(runtime.api_client.close())
    assert runtime.review_api_client is not None
    asyncio.run(runtime.review_api_client.close())


def test_adapter_source_does_not_import_persistence_layers() -> None:
    source_dir = Path(__file__).parents[1] / "src" / "memory_core" / "mcp"
    source = "\n".join(path.read_text(encoding="utf-8") for path in source_dir.glob("*.py"))
    assert "memory_core.db" not in source
    assert "memory_core.models" not in source
    assert "memory_core.services" not in source
