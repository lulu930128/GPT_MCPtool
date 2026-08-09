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


def call_tool(runtime: Any, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    result = asyncio.run(runtime.server.call_tool(name, arguments))
    assert isinstance(result, CallToolResult)
    assert result.isError is False
    parsed = json.loads(result.content[0].text)
    assert isinstance(parsed, dict)
    assert result.structuredContent == parsed
    return parsed


def test_revision_tool_reads_exact_snapshot_with_external_redaction(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    created = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json={
            "kind": "fact",
            "domain": "general",
            "title": r"Original file C:\Users\ExampleUser\private.txt",
            "body_markdown": r"Stored under C:\project\private",
            "payload": {"workspace_path": r"C:\project\private"},
            "source_type": "manual",
            "source_reference": r"C:\Users\ExampleUser\source.txt",
        },
    ).json()
    updated = client.patch(
        f"/api/v1/records/{created['id']}",
        headers=admin_headers,
        json={"expected_version": 1, "title": "Current safe title"},
    )
    assert updated.status_code == 200

    runtime = build_runtime(
        McpSettings(
            client_token=SecretStr(CANDIDATE_TOKEN),
            max_content_chars=8_000,
        ),
        transport=httpx.ASGITransport(app=client.app),
    )
    tools = {tool.name: tool for tool in asyncio.run(runtime.server.list_tools())}
    revision_tool = tools["memory_fetch_record_revision"]
    assert set(revision_tool.inputSchema["required"]) == {"record_ref", "revision_no"}
    assert revision_tool.annotations is not None
    assert revision_tool.annotations.readOnlyHint is True

    result = call_tool(
        runtime,
        "memory_fetch_record_revision",
        {
            "record_ref": f"record:{created['id']}",
            "revision_no": 1,
        },
    )
    assert result["record_ref"] == f"record:{created['id']}"
    assert result["revision_no"] == 1
    assert result["current_version"] == 2
    assert result["is_current"] is False
    assert result["metadata"]["version"] == 1
    assert result["metadata"]["requested_revision_no"] == 1
    assert result["metadata"]["truncated"] is False
    rendered = json.dumps(result, ensure_ascii=False)
    assert r"C:\Users\ExampleUser" not in rendered
    assert r"C:\project" not in rendered
    assert "[local-user-home]" in rendered
    assert "[local path hidden]" in rendered
    assert result["metadata"]["source_reference"] == "local source (path hidden)"

    asyncio.run(runtime.api_client.close())


def test_revision_tool_does_not_expose_historical_restricted_snapshot(
    client: TestClient,
    admin_headers: dict[str, str],
) -> None:
    created = client.post(
        "/api/v1/records",
        headers=admin_headers,
        json={
            "kind": "fact",
            "domain": "general",
            "title": "Historical secret",
            "sensitivity": "restricted",
        },
    ).json()
    updated = client.patch(
        f"/api/v1/records/{created['id']}",
        headers=admin_headers,
        json={
            "expected_version": 1,
            "title": "Current visible summary",
            "sensitivity": "personal",
        },
    )
    assert updated.status_code == 200

    runtime = build_runtime(
        McpSettings(
            client_token=SecretStr(CANDIDATE_TOKEN),
            max_content_chars=8_000,
        ),
        transport=httpx.ASGITransport(app=client.app),
    )
    raw_result = asyncio.run(
        runtime.server.call_tool(
            "memory_fetch_record_revision",
            {
                "record_ref": f"record:{created['id']}",
                "revision_no": 1,
            },
        )
    )
    assert isinstance(raw_result, CallToolResult)
    assert raw_result.isError is True
    parsed = json.loads(raw_result.content[0].text)
    assert parsed["ok"] is False
    assert parsed["error"]["code"] == "not_found"
    assert "Historical secret" not in json.dumps(parsed)

    asyncio.run(runtime.api_client.close())
