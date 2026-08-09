from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
from mcp.types import CallToolResult
from pydantic import SecretStr

from memory_core.mcp.runtime import build_runtime
from memory_core.mcp.settings import McpSettings

TEST_TOKEN = "test-cocktail-mcp-token"


def mcp_settings() -> McpSettings:
    return McpSettings(
        client_token=SecretStr(TEST_TOKEN),
        max_content_chars=8_000,
    )


def call_tool(runtime: Any, name: str, arguments: dict[str, Any]) -> CallToolResult:
    result = asyncio.run(runtime.server.call_tool(name, arguments))
    assert isinstance(result, CallToolResult)
    return result


def parse_result(result: CallToolResult) -> dict[str, Any]:
    assert len(result.content) == 1
    content = result.content[0]
    assert content.type == "text"
    parsed = json.loads(content.text)
    assert isinstance(parsed, dict)
    assert result.structuredContent == parsed
    return parsed


def recipe_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "recipe_name": "測試氣泡調酒",
        "recipe_origin": "original",
        "status": "tested",
        "ingredients": [
            {"name": "琴酒", "amount": 45, "unit": "ml", "note": None},
            {"name": "氣泡水", "amount": None, "unit": "top_up", "note": None},
        ],
        "method": "build",
        "steps": ["加入冰塊與琴酒", "以氣泡水補滿"],
        "ice": "cubed",
        "glassware": "highball",
        "garnish": [],
        "taste_profile": None,
        "evaluation": None,
        "tags": [" 清爽 ", "清爽", "氣泡"],
        "parent_recipe_ref": None,
    }
    payload.update(overrides)
    return payload


def candidate_response(proposed_content: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": "candidate-cocktail-1",
        "status": "pending",
        "operation": "create",
        "target_type": "record",
        "target_id": None,
        "base_version": None,
        "proposed_content": proposed_content,
        "source_reference": None,
        "confidence": None,
        "risk_flags": [],
        "review_digest": "sha256:v1:" + ("a" * 64),
        "created_at": "2026-07-26T12:00:00Z",
        "expires_at": "2026-08-02T12:00:00Z",
        "review_action": None,
        "review_note": None,
        "result_id": None,
        "result_version": None,
    }


def test_cocktail_tools_expose_typed_payload_schemas() -> None:
    runtime = build_runtime(mcp_settings(), transport=httpx.MockTransport(lambda _: None))
    tools = {tool.name: tool for tool in asyncio.run(runtime.server.list_tools())}

    recipe = tools["memory_propose_cocktail_recipe_create"].inputSchema
    recipe_payload_schema = recipe["properties"]["payload"]
    assert set(recipe["required"]) == {"payload", "idempotency_key"}
    assert set(recipe_payload_schema["required"]) >= {
        "recipe_name",
        "recipe_origin",
        "status",
        "ingredients",
        "method",
        "steps",
    }
    assert recipe_payload_schema["properties"]["recipe_origin"]["enum"] == [
        "classic",
        "adapted",
        "original",
    ]
    assert recipe_payload_schema["properties"]["recipe_name"]["description"]
    ingredient_schema = recipe_payload_schema["properties"]["ingredients"]["items"]
    assert set(ingredient_schema["required"]) == {"name", "amount", "unit"}
    assert ingredient_schema["properties"]["amount"]["description"]
    assert "$ref" not in json.dumps(recipe_payload_schema)

    tasting = tools["memory_propose_cocktail_tasting_create"].inputSchema
    assert set(tasting["required"]) == {
        "payload",
        "occurred_start",
        "timezone_name",
        "idempotency_key",
    }
    assert tasting["properties"]["occurred_start"]["format"] == "date-time"
    tasting_payload_schema = tasting["properties"]["payload"]
    assert "observed_taste_profile" in tasting_payload_schema["properties"]
    assert "$ref" not in json.dumps(tasting_payload_schema)

    preference = tools["memory_propose_cocktail_preference_update"].inputSchema
    assert set(preference["required"]) == {
        "target_ref",
        "base_version",
        "payload",
        "idempotency_key",
    }
    assert "confirmed_favorite_recipe_refs" in preference["properties"]["payload"]["properties"]

    asyncio.run(runtime.api_client.close())


def test_cocktail_recipe_tool_rejects_invalid_payload_without_backend_call() -> None:
    backend_calls = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal backend_calls
        backend_calls += 1
        raise AssertionError("Invalid cocktail payload must not reach the backend")

    runtime = build_runtime(mcp_settings(), transport=httpx.MockTransport(handler))
    result = call_tool(
        runtime,
        "memory_propose_cocktail_recipe_create",
        {
            "payload": recipe_payload(ingredients=[{"name": "琴酒", "amount": -1, "unit": "ml"}]),
            "idempotency_key": "cocktail-invalid-amount",
        },
    )
    parsed = parse_result(result)

    assert result.isError is True
    assert parsed["ok"] is False
    assert parsed["candidate"] is None
    assert parsed["error"]["code"] == "invalid_ingredient_amount"
    assert parsed["error"]["field"] == "payload.ingredients[0].amount"
    assert parsed["error"]["received_value"] == -1
    assert backend_calls == 0

    asyncio.run(runtime.api_client.close())


def test_cocktail_recipe_tool_submits_canonical_candidate_envelope() -> None:
    submitted: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/candidates"
        submitted.update(json.loads(request.content))
        content = submitted["change"]["content"]
        return httpx.Response(201, json=candidate_response(content))

    runtime = build_runtime(mcp_settings(), transport=httpx.MockTransport(handler))
    result = call_tool(
        runtime,
        "memory_propose_cocktail_recipe_create",
        {
            "payload": recipe_payload(),
            "idempotency_key": "cocktail-recipe-create-1",
        },
    )
    parsed = parse_result(result)
    content = submitted["change"]["content"]

    assert result.isError is False
    assert parsed["ok"] is True
    assert parsed["candidate"]["status"] == "pending"
    assert submitted["change"]["change_type"] == "record_create"
    assert content["kind"] == "fact"
    assert content["domain"] == "lifestyle.cocktail"
    assert content["schema_name"] == "cocktail_recipe"
    assert content["schema_version"] == 1
    assert content["title"] == "測試氣泡調酒"
    assert content["payload"]["tags"] == ["清爽", "氣泡"]

    asyncio.run(runtime.api_client.close())


def test_cocktail_tasting_tool_returns_structured_naive_time_error() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        raise AssertionError("Invalid tasting time must not reach the backend")

    runtime = build_runtime(mcp_settings(), transport=httpx.MockTransport(handler))
    result = call_tool(
        runtime,
        "memory_propose_cocktail_tasting_create",
        {
            "payload": {
                "cocktail_name": "即興測試",
                "recipe_ref": None,
                "recipe_version": None,
                "ingredients_snapshot": [
                    {"name": "琴酒", "amount": 30, "unit": "ml", "note": None}
                ],
                "recipe_changes": [],
                "servings": 1,
                "rating": 8.5,
                "verdict": "good",
                "tasting_notes": None,
                "repeat_intent": "maybe",
                "rank_note": None,
                "observed_taste_profile": None,
            },
            "occurred_start": "2026-07-26T20:00:00",
            "timezone_name": "Asia/Taipei",
            "idempotency_key": "cocktail-naive-time",
        },
    )
    parsed = parse_result(result)

    assert result.isError is True
    assert parsed["error"]["code"] == "timezone_offset_required"
    assert parsed["error"]["field"] == "occurred_start"

    asyncio.run(runtime.api_client.close())


def test_fetch_tasting_resolves_historical_recipe_revision() -> None:
    tasting = {
        "id": "tasting-1",
        "kind": "event",
        "domain": "lifestyle.cocktail",
        "title": "歷史品飲",
        "summary": None,
        "body_markdown": None,
        "occurred_start": "2026-07-26T12:00:00Z",
        "occurred_end": None,
        "date_precision": "exact",
        "timezone_name": "Asia/Taipei",
        "importance": 50,
        "verification_status": "confirmed",
        "sensitivity": "personal",
        "handling_policy": "normal",
        "schema_name": "cocktail_tasting",
        "schema_version": 1,
        "payload": {"recipe_ref": "record:recipe-1", "recipe_version": 1},
        "source_type": "mcp",
        "source_reference": None,
        "lifecycle_status": "active",
        "version": 1,
        "deleted_at": None,
        "created_at": "2026-07-26T12:00:00Z",
        "updated_at": "2026-07-26T12:00:00Z",
    }
    current_recipe = {
        **tasting,
        "id": "recipe-1",
        "kind": "fact",
        "title": "目前配方名稱",
        "schema_name": "cocktail_recipe",
        "payload": {},
        "version": 2,
    }
    recipe_revision = {
        **current_recipe,
        "title": "第一版配方名稱",
        "version": 1,
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/records/tasting-1":
            return httpx.Response(200, json=tasting)
        if request.url.path == "/api/v1/records/recipe-1":
            assert request.url.params["include_deleted"] == "true"
            return httpx.Response(200, json=current_recipe)
        if request.url.path == "/api/v1/records/recipe-1/revisions/1":
            return httpx.Response(200, json=recipe_revision)
        raise AssertionError(f"Unexpected backend request: {request.url}")

    runtime = build_runtime(mcp_settings(), transport=httpx.MockTransport(handler))
    result = call_tool(runtime, "fetch", {"id": "record:tasting-1"})
    parsed = parse_result(result)
    metadata = parsed["metadata"]

    assert result.isError is False
    assert metadata["occurred_start_local"] == "2026-07-26T20:00:00+08:00"
    assert metadata["recipe_resolution_status"] == "resolved"
    assert metadata["recipe_title"] == "第一版配方名稱"
    assert metadata["recipe_version_available"] is True

    asyncio.run(runtime.api_client.close())


def test_mcp_search_forwards_schema_name_filter() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/search"
        assert request.url.params["schema_name"] == "cocktail_recipe"
        return httpx.Response(200, json=[])

    runtime = build_runtime(mcp_settings(), transport=httpx.MockTransport(handler))
    result = call_tool(
        runtime,
        "search",
        {"query": "琴酒", "schema_name": "cocktail_recipe"},
    )

    assert result.isError is False
    assert parse_result(result)["results"] == []

    asyncio.run(runtime.api_client.close())


def test_fetch_tasting_reports_missing_recipe_version_without_failing() -> None:
    tasting = {
        "title": "版本缺失品飲",
        "schema_name": "cocktail_tasting",
        "schema_version": 1,
        "payload": {"recipe_ref": "record:recipe-1", "recipe_version": 9},
    }
    current_recipe = {
        "title": "目前配方",
        "schema_name": "cocktail_recipe",
        "schema_version": 1,
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/records/tasting-1":
            return httpx.Response(200, json=tasting)
        if request.url.path == "/api/v1/records/recipe-1":
            return httpx.Response(200, json=current_recipe)
        if request.url.path == "/api/v1/records/recipe-1/revisions/9":
            return httpx.Response(
                404,
                json={
                    "error": {
                        "code": "not_found",
                        "message": "record revision not found",
                    }
                },
            )
        raise AssertionError(f"Unexpected backend request: {request.url}")

    runtime = build_runtime(mcp_settings(), transport=httpx.MockTransport(handler))
    result = call_tool(runtime, "fetch", {"id": "record:tasting-1"})
    parsed = parse_result(result)

    assert result.isError is False
    assert parsed["metadata"]["recipe_resolution_status"] == "version_missing"
    assert parsed["metadata"]["recipe_title"] == "目前配方"
    assert parsed["metadata"]["recipe_version_available"] is False

    asyncio.run(runtime.api_client.close())
