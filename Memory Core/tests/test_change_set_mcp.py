from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
from fastapi.testclient import TestClient
from mcp.types import CallToolResult
from pydantic import SecretStr

from memory_core.mcp.runtime import build_runtime
from memory_core.mcp.settings import McpSettings

CANDIDATE_TOKEN = "test-candidate-token"
REVIEW_TOKEN = "test-review-token"


def call_tool(runtime: Any, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    result = asyncio.run(runtime.server.call_tool(name, arguments))
    assert isinstance(result, CallToolResult)
    assert result.isError is False
    assert len(result.content) == 1
    parsed = json.loads(result.content[0].text)
    assert isinstance(parsed, dict)
    assert result.structuredContent == parsed
    return parsed


def recipe_content() -> dict[str, object]:
    return {
        "kind": "fact",
        "domain": "lifestyle.cocktail",
        "title": "MCP ChangeSet Recipe",
        "schema_name": "cocktail_recipe",
        "schema_version": 1,
        "payload": {
            "recipe_name": "MCP ChangeSet Recipe",
            "recipe_origin": "original",
            "status": "tested",
            "ingredients": [{"name": "Gin", "amount": 45, "unit": "ml"}],
            "method": "shake",
            "steps": ["Shake with ice and strain."],
        },
        "source_type": "conversation",
    }


def tasting_content() -> dict[str, object]:
    return {
        "kind": "event",
        "domain": "lifestyle.cocktail",
        "title": "MCP ChangeSet Tasting",
        "occurred_start": "2026-07-27T20:00:00+08:00",
        "date_precision": "exact",
        "timezone_name": "Asia/Taipei",
        "schema_name": "cocktail_tasting",
        "schema_version": 1,
        "payload": {
            "cocktail_name": "MCP ChangeSet Tasting",
            "recipe_ref": "op:recipe",
            "rating": 9,
            "verdict": "favorite",
        },
        "source_type": "conversation",
    }


def test_change_set_mcp_schema_and_end_to_end_review(client: TestClient) -> None:
    settings = McpSettings(
        client_token=SecretStr(CANDIDATE_TOKEN),
        review_client_token=SecretStr(REVIEW_TOKEN),
        max_content_chars=8_000,
    )
    runtime = build_runtime(
        settings,
        transport=httpx.ASGITransport(app=client.app),
    )

    tools = {tool.name: tool for tool in asyncio.run(runtime.server.list_tools())}
    schema = tools["memory_propose_change_set"].inputSchema
    assert set(schema["required"]) == {"summary", "operations", "idempotency_key"}
    assert "oneOf" not in json.dumps(schema)
    operation_schema = schema["properties"]["operations"]["items"]
    assert set(operation_schema["properties"]) >= {
        "op_id",
        "action",
        "content",
        "target_ref",
        "base_version",
    }

    proposed = call_tool(
        runtime,
        "memory_propose_change_set",
        {
            "summary": "Save a Recipe and its Tasting together",
            "operations": [
                {
                    "op_id": "tasting",
                    "action": "record_create",
                    "content": tasting_content(),
                },
                {
                    "op_id": "recipe",
                    "action": "record_create",
                    "content": recipe_content(),
                },
            ],
            "idempotency_key": "mcp-changeset-recipe-tasting",
            "source_type": "conversation",
        },
    )
    candidate = proposed["candidate"]
    assert candidate["candidate_kind"] == "change_set"
    assert candidate["operation"] is None
    assert [operation["op_id"] for operation in candidate["operations"]] == [
        "tasting",
        "recipe",
    ]

    prepared = call_tool(
        runtime,
        "memory_prepare_candidate_review",
        {
            "candidate_id": candidate["id"],
            "expected_review_digest": candidate["review_digest"],
        },
    )
    approved = call_tool(
        runtime,
        "memory_approve_candidate",
        {
            "candidate_id": candidate["id"],
            "expected_review_digest": candidate["review_digest"],
            "approval_challenge": prepared["approval_challenge"],
            "idempotency_key": "approve-mcp-changeset-recipe-tasting",
        },
    )
    assert approved["transaction_committed"] is True
    assert approved["result_ref"] is None
    assert [result["op_id"] for result in approved["results"]] == [
        "tasting",
        "recipe",
    ]
    results = {result["op_id"]: result for result in approved["results"]}

    fetched_recipe = call_tool(runtime, "fetch", {"id": results["recipe"]["result_ref"]})
    fetched_tasting = call_tool(runtime, "fetch", {"id": results["tasting"]["result_ref"]})
    assert fetched_recipe["metadata"]["schema_name"] == "cocktail_recipe"
    assert fetched_tasting["metadata"]["schema_name"] == "cocktail_tasting"
    assert fetched_tasting["metadata"]["recipe_resolution_status"] == "resolved"
    links = call_tool(
        runtime,
        "memory_list_record_links",
        {
            "record_ref": results["tasting"]["result_ref"],
            "direction": "outbound",
        },
    )
    assert links["links"][0]["role"] == "uses_recipe"
    assert links["links"][0]["target_ref"] == results["recipe"]["result_ref"]
    assert links["links"][0]["target_revision_no"] == 1

    asyncio.run(runtime.api_client.close())
    assert runtime.review_api_client is not None
    asyncio.run(runtime.review_api_client.close())


def test_typed_cocktail_change_set_exposes_fields_and_uses_generic_executor(
    client: TestClient,
) -> None:
    settings = McpSettings(
        client_token=SecretStr(CANDIDATE_TOKEN),
        review_client_token=SecretStr(REVIEW_TOKEN),
        max_content_chars=8_000,
    )
    runtime = build_runtime(
        settings,
        transport=httpx.ASGITransport(app=client.app),
    )
    tools = {tool.name: tool for tool in asyncio.run(runtime.server.list_tools())}
    schema = tools["memory_propose_cocktail_change_set"].inputSchema
    assert set(schema["required"]) == {"summary", "operations", "idempotency_key"}
    assert "oneOf" not in json.dumps(schema)
    operation_schema = schema["properties"]["operations"]["items"]
    operation_properties = operation_schema["properties"]
    assert "content" not in operation_properties
    assert set(operation_properties) >= {
        "op_id",
        "action",
        "recipe_payload",
        "tasting_payload",
        "preference_payload",
        "target_ref",
        "base_version",
    }
    recipe_schema = operation_properties["recipe_payload"]["anyOf"][0]
    tasting_schema = operation_properties["tasting_payload"]["anyOf"][0]
    preference_schema = operation_properties["preference_payload"]["anyOf"][0]
    assert "recipe_name" in recipe_schema["properties"]
    assert "cocktail_name" in tasting_schema["properties"]
    assert "confirmed_favorite_recipe_refs" in preference_schema["properties"]
    recipe_ref_schema = tasting_schema["properties"]["recipe_ref"]["anyOf"][0]
    assert "op:" in recipe_ref_schema["pattern"]
    assert "$ref" not in json.dumps(schema)

    recipe = recipe_content()
    tasting = tasting_content()
    proposed = call_tool(
        runtime,
        "memory_propose_cocktail_change_set",
        {
            "summary": "Save a typed Recipe and Tasting together",
            "operations": [
                {
                    "op_id": "tasting",
                    "action": "tasting_create",
                    "tasting_payload": tasting["payload"],
                    "occurred_start": tasting["occurred_start"],
                    "timezone_name": tasting["timezone_name"],
                },
                {
                    "op_id": "recipe",
                    "action": "recipe_create",
                    "recipe_payload": recipe["payload"],
                },
            ],
            "idempotency_key": "typed-cocktail-changeset-recipe-tasting",
            "source_type": "conversation",
        },
    )
    candidate = proposed["candidate"]
    assert candidate["candidate_kind"] == "change_set"
    assert [operation["op_id"] for operation in candidate["operations"]] == [
        "tasting",
        "recipe",
    ]
    tasting_change = candidate["operations"][0]["change_data"]
    assert tasting_change["content"]["schema_name"] == "cocktail_tasting"
    assert tasting_change["content"]["source_type"] == "conversation"
    assert tasting_change["content"]["payload"]["recipe_ref"] == "op:recipe"
    assert "recipe_version" not in tasting_change["content"]["payload"]

    prepared = call_tool(
        runtime,
        "memory_prepare_candidate_review",
        {
            "candidate_id": candidate["id"],
            "expected_review_digest": candidate["review_digest"],
        },
    )
    approved = call_tool(
        runtime,
        "memory_approve_candidate",
        {
            "candidate_id": candidate["id"],
            "expected_review_digest": candidate["review_digest"],
            "approval_challenge": prepared["approval_challenge"],
            "idempotency_key": "approve-typed-cocktail-changeset",
        },
    )
    assert approved["transaction_committed"] is True
    results = {result["op_id"]: result for result in approved["results"]}
    revision = call_tool(
        runtime,
        "memory_fetch_record_revision",
        {
            "record_ref": results["recipe"]["result_ref"],
            "revision_no": 1,
        },
    )
    assert revision["metadata"]["schema_name"] == "cocktail_recipe"
    assert revision["is_current"] is True

    asyncio.run(runtime.api_client.close())
    assert runtime.review_api_client is not None
    asyncio.run(runtime.review_api_client.close())
