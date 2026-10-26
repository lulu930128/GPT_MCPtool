"""Actual SDK regression; requires the existing valid project environment."""
import json
import unittest
from unittest.mock import patch

import anyio
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
import server
from test_http_server import app_client, TEST_BASE_URL
from workspace_transport_fixture import research_fixture


class WorkspaceTransportSdkTests(unittest.TestCase):
    def test_four_timeframes_including_large_complete_sdk_result(self):
        async def run():
            with patch.object(server, "urlopen", side_effect=AssertionError("Unexpected network IO")), \
                    patch.object(server, "_tools_for_client", return_value=server.PUBLIC_TOOLS):
                async with Client(server.build_mcp_server(), mode="auto") as client:
                    for timeframe in ("today", "daily", "weekly", "monthly"):
                        expected = research_fixture(timeframe, large=timeframe == "monthly")
                        with patch.object(server, "_api_request", return_value=expected) as request:
                            result = await client.call_tool("omi_read_tw_stock_research", {"stock_id": "2330", "timeframe": timeframe})
                        request.assert_called_once_with("GET", f"/api/market/tw-dashboard/stocks/2330/research?timeframe={timeframe}")
                        self.assertFalse(result.is_error)
                        self.assertEqual(result.structured_content, expected)
                        self.assertEqual(json.loads(result.content[0].text), expected)
        anyio.run(run)


class WorkspaceTransportHttpSdkTests(unittest.IsolatedAsyncioTestCase):
    async def test_large_response_is_not_limited_by_inbound_request_cap(self):
        expected = research_fixture("monthly", large=True)
        self.assertGreaterEqual(len(json.dumps(expected, ensure_ascii=False).encode()), 10 * 1024 * 1024)
        # ASGI only: neither an HTTP listener nor a backend is started.
        with patch.object(server, "urlopen", side_effect=AssertionError("Unexpected network IO")), \
                patch.object(server, "_tools_for_client", return_value=server.PUBLIC_TOOLS):
            async with app_client() as http_client:
                transport = streamable_http_client(f"{TEST_BASE_URL}/mcp", http_client=http_client)
                async with Client(transport, mode="2026-07-28") as client:
                    with patch.object(server, "_api_request", return_value=expected) as request:
                        result = await client.call_tool("omi_read_tw_stock_research", {"stock_id": "2330", "timeframe": "monthly"})
                    request.assert_called_once_with("GET", "/api/market/tw-dashboard/stocks/2330/research?timeframe=monthly")
                    self.assertFalse(result.is_error)
                    self.assertEqual(result.structured_content, expected)
                    self.assertEqual(json.loads(result.content[0].text), expected)
