from __future__ import annotations

import argparse
import json

import anyio
import httpx2
from mcp import Client


MCP_HEADERS = {
    "Accept": "application/json, text/event-stream",
    "Content-Type": "application/json",
}
LEGACY_PROTOCOL_VERSION = "2025-06-18"
DASHBOARD_URI = "ui://omi/tw-market-dashboard/v2.html"


async def _modern_smoke(mcp_url: str) -> dict[str, object]:
    async with Client(mcp_url, mode="auto") as client:
        tools = await client.list_tools()
        resources = await client.list_resources()
        dashboard = await client.read_resource(DASHBOARD_URI)
        result = await client.call_tool(
            "omi_read_capability_status",
            {"capability_id": "quote.snapshot"},
        )
        return {
            "protocolVersion": client.protocol_version,
            "toolCount": len(tools.tools),
            "resourceUris": sorted(str(item.uri) for item in resources.resources),
            "dashboardBytes": len(dashboard.contents[0].text.encode("utf-8")),
            "businessCallIsError": result.is_error,
            "businessContractVersion": (
                result.structured_content or {}
            ).get("contract_version"),
        }


async def _legacy_smoke(mcp_url: str) -> dict[str, object]:
    async with httpx2.AsyncClient(timeout=20) as client:
        initialized = await client.post(
            mcp_url,
            headers=MCP_HEADERS,
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": LEGACY_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {
                        "name": "omi-search-runtime-smoke",
                        "version": "1",
                    },
                },
            },
        )
        initialized.raise_for_status()
        session_id = initialized.headers.get("Mcp-Session-Id", "")
        if not session_id:
            raise RuntimeError("Legacy initialize did not return Mcp-Session-Id")
        result = initialized.json()["result"]
        if result["protocolVersion"] != LEGACY_PROTOCOL_VERSION:
            raise RuntimeError("Legacy protocol version was not preserved")

        headers = {
            **MCP_HEADERS,
            "MCP-Protocol-Version": LEGACY_PROTOCOL_VERSION,
            "Mcp-Session-Id": session_id,
        }
        acknowledged = await client.post(
            mcp_url,
            headers=headers,
            json={"jsonrpc": "2.0", "method": "notifications/initialized"},
        )
        if acknowledged.status_code not in {200, 202}:
            acknowledged.raise_for_status()

        tools = await client.post(
            mcp_url,
            headers=headers,
            json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        )
        resources = await client.post(
            mcp_url,
            headers=headers,
            json={"jsonrpc": "2.0", "id": 3, "method": "resources/list"},
        )
        dashboard = await client.post(
            mcp_url,
            headers=headers,
            json={
                "jsonrpc": "2.0",
                "id": 4,
                "method": "resources/read",
                "params": {"uri": DASHBOARD_URI},
            },
        )
        business = await client.post(
            mcp_url,
            headers=headers,
            json={
                "jsonrpc": "2.0",
                "id": 5,
                "method": "tools/call",
                "params": {
                    "name": "omi_read_capability_status",
                    "arguments": {"capability_id": "quote.snapshot"},
                },
            },
        )
        for response in (tools, resources, dashboard, business):
            response.raise_for_status()

        tool_items = tools.json()["result"]["tools"]
        resource_items = resources.json()["result"]["resources"]
        dashboard_text = dashboard.json()["result"]["contents"][0]["text"]
        business_result = business.json()["result"]
        return {
            "protocolVersion": result["protocolVersion"],
            "sessionEstablished": True,
            "toolCount": len(tool_items),
            "resourceUris": sorted(item["uri"] for item in resource_items),
            "dashboardBytes": len(dashboard_text.encode("utf-8")),
            "businessCallIsError": business_result.get("isError", False),
            "businessContractVersion": (
                business_result.get("structuredContent") or {}
            ).get("contract_version"),
        }


async def _run(mcp_url: str) -> dict[str, object]:
    modern = await _modern_smoke(mcp_url)
    legacy = await _legacy_smoke(mcp_url)
    for label, result in (("modern", modern), ("legacy", legacy)):
        if result["toolCount"] != 11:
            raise RuntimeError(f"{label} tool count mismatch")
        if DASHBOARD_URI not in result["resourceUris"]:
            raise RuntimeError(f"{label} dashboard resource missing")
        if result["dashboardBytes"] <= 0:
            raise RuntimeError(f"{label} dashboard resource is empty")
        if result["businessCallIsError"]:
            raise RuntimeError(f"{label} representative business call failed")
        if result["businessContractVersion"] != "omi.decision.v4":
            raise RuntimeError(f"{label} business contract mismatch")
    return {"ok": True, "mcpUrl": mcp_url, "modern": modern, "legacy": legacy}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--mcp-url",
        default="http://127.0.0.1:18797/mcp",
    )
    args = parser.parse_args()
    print(json.dumps(anyio.run(_run, args.mcp_url), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
