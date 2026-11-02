"""Versioned workspace contract over the official SDK/ASGI; no live IO."""
from hashlib import sha256
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from mcp import Client
from mcp.client.streamable_http import streamable_http_client
import server
from test_http_server import app_client, TEST_BASE_URL, MCP_HEADERS, legacy_initialize


BINDINGS = {
    "omi_open_tw_market_dashboard": "ui://omi/tw-market-dashboard/v2.html",
    "omi_open_tw_workspace": "ui://omi/tw-workspace/v1.html",
    "omi_open_tw_workspace_v2": "ui://omi/tw-workspace/v2.html",
    "omi_open_tw_workspace_v3": "ui://omi/tw-workspace/v3.html",
}
SELECTIONS = ({}, {"stock_id": "2330", "timeframe": "today", "watchlist_group_id": 7})


class WorkspaceV2SdkTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # An isolated production build can be supplied without publishing dist.
        self.widget_path = Path(os.environ.get("OMI_TEST_WIDGET_PATH", server.TW_DASHBOARD_WIDGET_PATH))
        self.html = self.widget_path.read_text(encoding="utf-8")
        self.workspace_html = self.html.replace('<html ', '<html data-omi-workspace="true" ', 1)
        for scope in (
            patch.object(server, "TW_DASHBOARD_WIDGET_PATH", self.widget_path),
            patch.object(server, "_tools_for_client", return_value=server.PUBLIC_TOOLS),
            patch.object(server, "_api_request", side_effect=AssertionError("No Backend/Native IO")),
        ):
            scope.start()
            self.addCleanup(scope.stop)

    def assert_catalog(self, tools, resources):
        self.assertEqual(len(tools), 48)
        self.assertEqual(len({tool["name"] for tool in tools}), 48)
        self.assertEqual([resource["uri"] for resource in resources], list(BINDINGS.values()))
        bound = {tool["name"]: tool for tool in tools if "ui" in tool.get("_meta", {})}
        self.assertEqual(set(bound), set(BINDINGS))
        for name, uri in BINDINGS.items():
            self.assertEqual(bound[name]["_meta"]["ui"]["resourceUri"], uri)
            self.assertEqual(bound[name]["_meta"]["openai/outputTemplate"], uri)
        old, new = bound["omi_open_tw_workspace"], bound["omi_open_tw_workspace_v2"]
        for key in ("inputSchema", "outputSchema", "annotations"):
            self.assertEqual(new[key], old[key])
        self.assertEqual(new["annotations"], server._read_only_annotations())

    def assert_resource(self, uri, contents):
        self.assertEqual(len(contents), 1)
        content = contents[0]
        self.assertEqual(content["uri"], uri)
        self.assertEqual(content["mimeType"], "text/html;profile=mcp-app")
        is_workspace = uri != BINDINGS["omi_open_tw_market_dashboard"]
        self.assertEqual(content["text"], self.workspace_html if is_workspace else self.html)
        self.assertEqual(content["_meta"]["ui"]["csp"], {"connectDomains": [], "resourceDomains": []})
        self.assertEqual(content["_meta"]["openai/widgetCSP"], {"connect_domains": [], "resource_domains": []})

    def report_hashes(self, protocol):
        print(json.dumps({"protocol": protocol, "tools": 48, "resources": 4,
                          "built_widget_sha256": sha256(self.widget_path.read_bytes()).hexdigest(),
                          "workspace_resource_sha256": sha256(self.workspace_html.encode()).hexdigest(),
                          "workspace_mode": True, "same_built_widget": True}))

    def test_exact_metadata_and_shared_latest_bundle(self):
        resources = server._tw_dashboard_resources_for_client()
        self.assert_catalog(server.PUBLIC_TOOLS, resources)
        self.assertIn('omi_read_desk_staged', self.html)
        for uri in BINDINGS.values():
            self.assert_resource(uri, server._read_tw_dashboard_resource(uri)["contents"])

    def test_all_previous_tools_and_resource_metadata_are_unchanged(self):
        # Pre-v3 source baseline, including all inherited WIP (47 tools/3 resources).
        tools = [tool for tool in server.PUBLIC_TOOLS if tool["name"] != "omi_open_tw_workspace_v3"]
        resources = [resource for resource in server._tw_dashboard_resources_for_client()
                     if resource["uri"] != BINDINGS["omi_open_tw_workspace_v3"]]
        digest = lambda value: sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        self.assertEqual(digest(tools), "1582be90f7edd0f64c52d7b85fc1f0eff4b2c841164f17400e678657812994da")
        self.assertEqual(digest(resources), "bf54ac66d7521d0f54628d58c789bbba1a9c744ec06e2c676f1efc05e3656fca")
        bound = {tool["name"]: tool for tool in server.PUBLIC_TOOLS}
        for key in ("description", "inputSchema", "outputSchema", "annotations"):
            self.assertEqual(bound["omi_open_tw_workspace_v3"][key], bound["omi_open_tw_workspace"][key])

    def test_missing_bundle_and_unknown_resource_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(server, "TW_DASHBOARD_WIDGET_PATH", Path(directory) / "missing.html"):
            for uri in BINDINGS.values():
                with self.subTest(uri=uri), self.assertRaisesRegex(RuntimeError, "production build"):
                    server._read_tw_dashboard_resource(uri)
            with self.assertRaises(KeyError):
                server._read_tw_dashboard_resource("ui://omi/tw-workspace/v4.html")

    async def test_current_sdk_lists_reads_and_calls_all_workspace_versions(self):
        async with app_client() as http_client:
            transport = streamable_http_client(f"{TEST_BASE_URL}/mcp", http_client=http_client)
            async with Client(transport, mode="2026-07-28") as client:
                self.assertEqual(client.protocol_version, "2026-07-28")
                tools = (await client.list_tools()).model_dump(mode="json", by_alias=True, exclude_none=True)["tools"]
                resources = (await client.list_resources()).model_dump(mode="json", by_alias=True, exclude_none=True)["resources"]
                self.assert_catalog(tools, resources)
                for uri in BINDINGS.values():
                    result = (await client.read_resource(uri)).model_dump(mode="json", by_alias=True, exclude_none=True)
                    self.assert_resource(uri, result["contents"])
                for name in ("omi_open_tw_workspace", "omi_open_tw_workspace_v2", "omi_open_tw_workspace_v3"):
                    for selection in SELECTIONS:
                        opened = await client.call_tool(name, selection)
                        self.assertFalse(opened.is_error)
                        self.assertEqual(opened.structured_content, selection)
                        self.assertEqual(json.loads(opened.content[0].text), selection)
                    rejected = await client.call_tool(name, {"refresh": True})
                    self.assertTrue(rejected.is_error)
        server._api_request.assert_not_called()
        self.report_hashes("2026-07-28")

    async def test_exact_legacy_sdk_lists_reads_and_calls_all_workspace_versions(self):
        async with app_client() as http_client:
            initialized = await legacy_initialize(http_client)
            self.assertEqual(initialized.json()["result"]["protocolVersion"], "2025-06-18")
            headers = {**MCP_HEADERS, "MCP-Protocol-Version": "2025-06-18",
                       "Mcp-Session-Id": initialized.headers["Mcp-Session-Id"]}
            acknowledged = await http_client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "method": "notifications/initialized"})
            self.assertIn(acknowledged.status_code, (200, 202))
            sequence = 1

            async def rpc(method, params=None):
                nonlocal sequence
                sequence += 1
                reply = await http_client.post("/mcp", headers=headers, json={
                    "jsonrpc": "2.0", "id": sequence, "method": method, "params": params or {}})
                self.assertEqual(reply.status_code, 200)
                self.assertNotIn("error", reply.json())
                return reply.json()["result"]

            self.assert_catalog((await rpc("tools/list"))["tools"], (await rpc("resources/list"))["resources"])
            for uri in BINDINGS.values():
                self.assert_resource(uri, (await rpc("resources/read", {"uri": uri}))["contents"])
            for name in ("omi_open_tw_workspace", "omi_open_tw_workspace_v2", "omi_open_tw_workspace_v3"):
                for selection in SELECTIONS:
                    opened = await rpc("tools/call", {"name": name, "arguments": selection})
                    self.assertFalse(opened["isError"])
                    self.assertEqual(opened["structuredContent"], selection)
                    self.assertEqual(json.loads(opened["content"][0]["text"]), selection)
                rejected = await rpc("tools/call", {"name": name, "arguments": {"refresh": True}})
                self.assertTrue(rejected["isError"])
        server._api_request.assert_not_called()
        self.report_hashes("2025-06-18")
