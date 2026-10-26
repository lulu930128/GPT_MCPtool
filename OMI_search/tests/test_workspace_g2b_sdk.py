"""G2b SDK/ASGI regression. Requires a working isolated official SDK environment.

No listener/backend/provider is used. Import failure is BLOCKED, not a skip/pass.
"""
import io
import json
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from mcp import Client
from mcp.client.streamable_http import streamable_http_client
import server
from test_http_server import app_client, TEST_BASE_URL, MCP_HEADERS, legacy_initialize
from test_workspace_g2b_core import research_variant


class WorkspaceG2bSdkTests(unittest.IsolatedAsyncioTestCase):
    async def test_current_sdk_discovery_and_both_research_variants(self):
        with patch.object(server, "urlopen", side_effect=AssertionError("Unexpected network IO")), \
                patch.object(server, "_tools_for_client", return_value=server.PUBLIC_TOOLS):
            async with app_client() as http_client:
                transport = streamable_http_client(f"{TEST_BASE_URL}/mcp", http_client=http_client)
                async with Client(transport, mode="2026-07-28") as client:
                    self.assertEqual(client.protocol_version, "2026-07-28")
                    resources = await client.list_resources()
                    self.assertEqual(len(resources.resources), 2)
                    for resource in resources.resources:
                        await client.read_resource(resource.uri)
                    tools = await client.list_tools()
                    self.assertEqual(len(tools.tools), 20)
                    research = next(t for t in tools.tools if t.name == "omi_read_tw_stock_research")
                    self.assertEqual(research.output_schema, server.TW_WORKSPACE_ROUTES[research.name]["outputSchema"])
                    for projection in (None, "full", "workspace"):
                        for frame in ("today", "daily", "weekly", "monthly"):
                            expected = research_variant(projection, frame)
                            args = {"stock_id": "2330", "timeframe": frame}
                            if projection is not None:
                                args["projection"] = projection
                            with patch.object(server, "_api_request", return_value=expected) as request:
                                result = await client.call_tool(research.name, args)
                            self.assertFalse(result.is_error)
                            self.assertEqual(result.structured_content, expected)
                            self.assertEqual(json.loads(result.content[0].text), expected)
                            request.assert_called_once_with("GET", f"/api/market/tw-dashboard/stocks/2330/research?timeframe={frame}"
                                                            + (f"&projection={projection}" if projection else ""))

    async def test_exact_legacy_protocol_discovery_variants_and_http_errors(self):
        with patch.object(server, "urlopen", side_effect=AssertionError("Unexpected network IO")), \
                patch.object(server, "_tools_for_client", return_value=server.PUBLIC_TOOLS):
            async with app_client() as http_client:
                initialized = await legacy_initialize(http_client)
                self.assertEqual(initialized.json()["result"]["protocolVersion"], "2025-06-18")
                headers = {**MCP_HEADERS, "MCP-Protocol-Version": "2025-06-18",
                           "Mcp-Session-Id": initialized.headers["Mcp-Session-Id"]}
                response = await http_client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "method": "notifications/initialized"})
                self.assertIn(response.status_code, (200, 202))
                sequence = 1

                async def rpc(method, params=None):
                    nonlocal sequence
                    sequence += 1
                    reply = await http_client.post("/mcp", headers=headers, json={
                        "jsonrpc": "2.0", "id": sequence, "method": method, "params": params or {}})
                    self.assertEqual(reply.status_code, 200)
                    return reply.json()["result"]

                resources = await rpc("resources/list")
                self.assertEqual(len(resources["resources"]), 2)
                for resource in resources["resources"]:
                    await rpc("resources/read", {"uri": resource["uri"]})
                tools = (await rpc("tools/list"))["tools"]
                self.assertEqual(len(tools), 20)
                for name, route in server.TW_WORKSPACE_ROUTES.items():
                    tool = next(t for t in tools if t["name"] == name)
                    self.assertEqual(tool["inputSchema"], route["inputSchema"])
                    expected_schema = route["outputSchema"]
                    if name == "omi_read_tw_stock_research":
                        expected_schema = {**expected_schema, "type": "object"}
                    self.assertEqual(tool["outputSchema"], expected_schema)
                for projection in (None, "full", "workspace"):
                    for frame in ("today", "daily", "weekly", "monthly"):
                        expected = research_variant(projection, frame)
                        args = {"stock_id": "2330", "timeframe": frame}
                        if projection is not None:
                            args["projection"] = projection
                        with patch.object(server, "_api_request", return_value=expected) as request:
                            result = await rpc("tools/call", {"name": "omi_read_tw_stock_research", "arguments": args})
                        self.assertFalse(result["isError"])
                        self.assertEqual(result["structuredContent"], expected)
                        self.assertEqual(json.loads(result["content"][0]["text"]), expected)
                        request.assert_called_once()
                for status in (413, 422, 503):
                    body = json.dumps({"detail": "SYNTHETIC limit", "warnings": ["KEEP"], "limitations": ["END"]})
                    error = HTTPError("http://fixture", status, "synthetic", {}, io.BytesIO(body.encode()))
                    with patch.object(server, "urlopen", side_effect=error) as opened:
                        result = await rpc("tools/call", {"name": "omi_read_tw_stock_research", "arguments": {"stock_id": "2330", "projection": "workspace"}})
                    self.assertTrue(result["isError"])
                    self.assertEqual(json.loads(result["content"][0]["text"])["error"], f"OMI API HTTP {status}: {body}")
                    opened.assert_called_once()


if __name__ == "__main__":
    unittest.main()
