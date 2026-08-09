from __future__ import annotations

import argparse
import asyncio
import json

from mcp import Client

EXPECTED_TOOLS = {
    "get_asset_overview",
    "list_asset_accounts",
    "list_asset_positions",
    "list_recent_asset_transactions",
    "get_pending_financial_events",
    "get_reconciliation_status",
    "get_asset_system_status",
}


async def smoke(url: str) -> dict[str, object]:
    async with Client(url, raise_exceptions=True) as client:
        tools = (await client.list_tools()).tools
        names = {tool.name for tool in tools}
        if names != EXPECTED_TOOLS:
            raise RuntimeError(f"Unexpected MCP tool set: {sorted(names)}")
        if not all(tool.annotations and tool.annotations.read_only_hint for tool in tools):
            raise RuntimeError("Every MCP tool must declare read-only semantics")
        result = await client.call_tool("get_asset_system_status", {})
        if result.is_error or result.structured_content is None:
            raise RuntimeError("MCP status tool failed")
        if result.structured_content.get("mcp_policy") != "private-tunnel-read-only":
            raise RuntimeError("MCP policy mismatch")
        return {
            "ok": True,
            "url": url,
            "tools": sorted(names),
            "buildId": result.structured_content.get("build_id"),
            "policy": result.structured_content.get("mcp_policy"),
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    args = parser.parse_args()
    print(json.dumps(asyncio.run(smoke(args.url)), ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
