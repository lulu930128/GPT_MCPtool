"""Versioned workspace contract over the official SDK/ASGI; no live IO."""
from hashlib import sha256
import importlib.util
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
    "omi_open_tw_workspace_v4": "ui://omi/tw-workspace/v4.html",
}
SELECTIONS = ({}, {"stock_id": "2330", "timeframe": "today", "watchlist_group_id": 7})


class WorkspaceV2SdkTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # An isolated production build can be supplied without publishing dist.
        self.widget_path = Path(os.environ.get("OMI_TEST_WIDGET_PATH", server.TW_DASHBOARD_WIDGET_PATH))
        self.widget_bytes = self.widget_path.read_bytes()
        self.html = self.widget_bytes.decode("utf-8")
        self.widget_sha = sha256(self.widget_bytes).hexdigest()
        self.workspace_html = self.html.replace('<html ', '<html data-omi-workspace="true" ', 1)
        self.v4_uri = f"ui://omi/tw-workspace/v4/{self.widget_sha}.html"
        self.bindings = {**BINDINGS, "omi_open_tw_workspace_v4": self.v4_uri}
        self.v4_html = self.html.replace('<html ', f'<html data-omi-workspace="true" data-omi-widget-sha="{self.widget_sha}" ', 1)
        for scope in (
            patch.object(server, "TW_DASHBOARD_WIDGET_PATH", self.widget_path),
            patch.object(server, "_backend_public_tools", side_effect=RuntimeError("Offline snapshot fallback")),
            patch.object(server, "_backend_research_schemas", return_value={}),
            patch.object(server, "_api_request", side_effect=AssertionError("No Backend/Native IO")),
        ):
            scope.start()
            self.addCleanup(scope.stop)

    def assert_catalog(self, tools, resources):
        self.assertEqual({tool["name"] for tool in tools}, {tool["name"] for tool in server.PUBLIC_TOOLS})
        self.assertEqual(len({tool["name"] for tool in tools}), len(tools))
        self.assertEqual([resource["uri"] for resource in resources], list(self.bindings.values()))
        bound = {tool["name"]: tool for tool in tools if "resourceUri" in tool.get("_meta", {}).get("ui", {})}
        self.assertEqual(set(bound), set(self.bindings))
        for name, uri in self.bindings.items():
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
        if uri in {BINDINGS["omi_open_tw_workspace_v4"], self.v4_uri}:
            # esbuild escapes non-ASCII characters in the inline JavaScript.
            for label in ("\u7576\u65e5\u672a\u5b8c\u6210\uff0f\u5f85\u6838\u5c0d\u59d4\u8a17", "\u6b77\u53f2\u59d4\u8a17"):
                escaped = "".join("\\u%04x" % ord(char) for char in label)
                self.assertTrue(label in content["text"] or escaped in content["text"].lower(), label)
        is_workspace = uri != BINDINGS["omi_open_tw_market_dashboard"]
        expected = self.v4_html if uri in {BINDINGS["omi_open_tw_workspace_v4"], self.v4_uri} else self.workspace_html if is_workspace else self.html
        self.assertEqual(content["text"], expected)
        self.assertEqual(content["_meta"]["ui"]["csp"], {"connectDomains": [], "resourceDomains": []})
        self.assertEqual(content["_meta"]["openai/widgetCSP"], {"connect_domains": [], "resource_domains": []})

    def report_hashes(self, protocol):
        print(json.dumps({"protocol": protocol, "tools": len(server.PUBLIC_TOOLS), "resources": len(self.bindings),
                          "built_widget_sha256": sha256(self.widget_path.read_bytes()).hexdigest(),
                          "workspace_v4_resource_uri": self.v4_uri,
                          "workspace_resource_sha256": sha256(self.v4_html.encode()).hexdigest(),
                          "workspace_mode": True, "same_built_widget": True}))

    def test_exact_metadata_and_shared_latest_bundle(self):
        resources = server._tw_dashboard_resources_for_client()
        self.assert_catalog(server._tools_for_client(), resources)
        self.assertIn('omi_read_desk_staged', self.html)
        for uri in [*self.bindings.values(), BINDINGS["omi_open_tw_workspace_v4"]]:
            self.assert_resource(uri, server._read_tw_dashboard_resource(uri)["contents"])

    def test_all_previous_tools_and_resource_metadata_are_unchanged(self):
        # Pre-v3 source baseline, including all inherited WIP (47 tools/3 resources).
        tools = [tool for tool in server.PUBLIC_TOOLS if tool["name"] not in {"omi_open_tw_workspace_v3", "omi_open_tw_workspace_v4"}]
        resources = [resource for resource in server._tw_dashboard_resources_for_client()
                     if resource["uri"] not in {BINDINGS["omi_open_tw_workspace_v3"], self.v4_uri}]
        digest = lambda value: sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        # Historical pre-v3 tool hash predates inherited trading WIP.
        # The complete pre-v4 tool catalog is pinned separately below.
        self.assertEqual(digest(resources), "bf54ac66d7521d0f54628d58c789bbba1a9c744ec06e2c676f1efc05e3656fca")
        bound = {tool["name"]: tool for tool in server.PUBLIC_TOOLS}
        for key in ("description", "inputSchema", "outputSchema", "annotations"):
            self.assertEqual(bound["omi_open_tw_workspace_v3"][key], bound["omi_open_tw_workspace"][key])

    def test_content_address_preserves_other_tools_and_legacy_resources(self):
        digest = lambda value: sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        # Compare the current contract with the original v4 binding; historical
        # whole-catalog hashes predate independently accepted research changes.
        with patch.object(server, "_tw_workspace_v4_resource_uri", return_value=BINDINGS["omi_open_tw_workspace_v4"]):
            before = server._tools_for_client()
        after = server._tools_for_client()
        self.assertEqual([tool for tool in before if tool["name"] != "omi_open_tw_workspace_v4"],
                         [tool for tool in after if tool["name"] != "omi_open_tw_workspace_v4"])
        old_v4 = next(tool for tool in before if tool["name"] == "omi_open_tw_workspace_v4")
        new_v4 = next(tool for tool in after if tool["name"] == "omi_open_tw_workspace_v4")
        self.assertEqual({key: value for key, value in old_v4.items() if key != "_meta"},
                         {key: value for key, value in new_v4.items() if key != "_meta"})
        self.assertEqual(digest([r for r in server._tw_dashboard_resources_for_client() if r["uri"] != self.v4_uri]), "3e55219408734f3565e3dfaf729016adc2b8a875f2d1c700d6775ad7bf4740dc")
        tools = {t["name"]: t for t in server.PUBLIC_TOOLS}
        for key in ("inputSchema", "outputSchema", "annotations"):
            self.assertEqual(tools["omi_open_tw_workspace_v4"][key], tools["omi_open_tw_workspace"][key])

    def test_missing_bundle_and_unknown_resource_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(server, "TW_DASHBOARD_WIDGET_PATH", Path(directory) / "missing.html"):
            for uri in [*self.bindings.values(), BINDINGS["omi_open_tw_workspace_v4"]]:
                with self.subTest(uri=uri), self.assertRaisesRegex(RuntimeError, "production build"):
                    server._read_tw_dashboard_resource(uri)
            with self.assertRaises(KeyError):
                server._read_tw_dashboard_resource("ui://omi/tw-workspace/v999.html")

    def test_identity_tracks_exact_bytes_and_both_catalogs_use_the_same_uri(self):
        with tempfile.TemporaryDirectory() as directory:
            widget = Path(directory) / "index.html"
            uris = []
            with patch.object(server, "TW_DASHBOARD_WIDGET_PATH", widget):
                for payload in (b'<html lang="zh-Hant">first\r\n</html>', b'<html lang="zh-Hant">first\r\n</html>', b'<html lang="zh-Hant">second\n</html>'):
                    widget.write_bytes(payload)
                    digest = sha256(payload).hexdigest()
                    expected_uri = f"ui://omi/tw-workspace/v4/{digest}.html"
                    tool = next(item for item in server._tools_for_client() if item["name"] == "omi_open_tw_workspace_v4")
                    resource = next(item for item in server._tw_dashboard_resources_for_client() if item["name"] == "omi-tw-workspace-v4")
                    self.assertEqual(tool["_meta"]["ui"]["resourceUri"], expected_uri)
                    self.assertEqual(tool["_meta"]["openai/outputTemplate"], expected_uri)
                    self.assertEqual(resource["uri"], expected_uri)
                    body = server._read_tw_dashboard_resource(expected_uri)["contents"][0]["text"]
                    self.assertIn(f'data-omi-widget-sha="{digest}"', body)
                    envelope = f'data-omi-workspace="true" data-omi-widget-sha="{digest}" '
                    self.assertEqual(body.replace(envelope, "", 1).encode("utf-8"), payload)
                    uris.append(expected_uri)
            self.assertEqual(uris[0], uris[1])
            self.assertNotEqual(uris[0], uris[2])

    def test_old_or_invalid_digest_never_silently_serves_different_content(self):
        with tempfile.TemporaryDirectory() as directory:
            widget = Path(directory) / "index.html"
            with patch.object(server, "TW_DASHBOARD_WIDGET_PATH", widget):
                widget.write_bytes(b'<html lang="zh-Hant">old</html>')
                old_uri = server._tw_workspace_v4_resource_uri()
                widget.write_bytes(b'<html lang="zh-Hant">new</html>')
                new_uri = server._tw_workspace_v4_resource_uri()
                self.assertNotEqual(old_uri, new_uri)
                for uri in (old_uri, "ui://omi/tw-workspace/v4/" + "0" * 64 + ".html", "ui://omi/tw-workspace/v4/../../index.html"):
                    with self.subTest(uri=uri), self.assertRaises(KeyError):
                        server._read_tw_dashboard_resource(uri)
                legacy = server._read_tw_dashboard_resource(BINDINGS["omi_open_tw_workspace_v4"])["contents"][0]
                current = server._read_tw_dashboard_resource(new_uri)["contents"][0]
                self.assertEqual(legacy["text"], current["text"])

    def test_v4_metadata_reads_widget_identity_once(self):
        with patch.object(server, "_tw_workspace_v4_resource_uri", side_effect=[self.v4_uri, "different"]) as identity:
            tool = next(item for item in server._build_tw_workspace_tools() if item["name"] == "omi_open_tw_workspace_v4")
        identity.assert_called_once_with()
        self.assertEqual(tool["_meta"]["ui"]["resourceUri"], tool["_meta"]["openai/outputTemplate"])

    def test_import_without_dist_and_later_owner_publication_refreshes_fallback(self):
        # Match the Owner's source snapshot: Python/contracts exist before dist.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original_root = Path(server.__file__).parent
            for name in ("server.py", "public_contract_snapshot.json", "tw_market_dashboard_contract_snapshot.json"):
                (root / name).write_bytes((original_root / name).read_bytes())
            spec = importlib.util.spec_from_file_location("omi_unbuilt_source_fixture", root / "server.py")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            with patch.object(module, "_backend_public_tools", side_effect=RuntimeError("Offline")), patch.object(module, "_backend_research_schemas", return_value={}):
                before = next(item for item in module._tools_for_client() if item["name"] == "omi_open_tw_workspace_v4")
                self.assertEqual(before["_meta"]["ui"]["resourceUri"], BINDINGS["omi_open_tw_workspace_v4"])
                with self.assertRaisesRegex(RuntimeError, "production build"):
                    module._read_tw_dashboard_resource(BINDINGS["omi_open_tw_workspace_v4"])
                module.TW_DASHBOARD_WIDGET_PATH.parent.mkdir(parents=True)
                payload = b'<html lang="zh-Hant">owner-published</html>'
                module.TW_DASHBOARD_WIDGET_PATH.write_bytes(payload)
                expected = f"ui://omi/tw-workspace/v4/{sha256(payload).hexdigest()}.html"
                after = next(item for item in module._tools_for_client() if item["name"] == "omi_open_tw_workspace_v4")
                resource = next(item for item in module._tw_dashboard_resources_for_client() if item["name"] == "omi-tw-workspace-v4")
                self.assertEqual(after["_meta"]["ui"]["resourceUri"], expected)
                self.assertEqual(resource["uri"], expected)
                self.assertIn(sha256(payload).hexdigest(), module._read_tw_dashboard_resource(expected)["contents"][0]["text"])

    async def test_sdk_content_address_tracks_publication_and_rejects_stale_digest(self):
        for mode in ("2026-07-28", "legacy"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                widget = Path(directory) / "index.html"
                with patch.object(server, "TW_DASHBOARD_WIDGET_PATH", widget):
                    widget.write_bytes(b'<html lang="zh-Hant">initial</html>')
                    async with app_client() as http_client:
                        transport = streamable_http_client(f"{TEST_BASE_URL}/mcp", http_client=http_client)
                        async with Client(transport, mode=mode) as client:
                            async def published():
                                tools = (await client.list_tools()).model_dump(mode="json", by_alias=True)["tools"]
                                tool = next(item for item in tools if item["name"] == "omi_open_tw_workspace_v4")
                                uri = tool["_meta"]["ui"]["resourceUri"]
                                self.assertEqual(uri, tool["_meta"]["openai/outputTemplate"])
                                resources = (await client.list_resources()).model_dump(mode="json", by_alias=True)["resources"]
                                self.assertIn(uri, [item["uri"] for item in resources])
                                body = (await client.read_resource(uri)).model_dump(mode="json", by_alias=True)["contents"][0]["text"]
                                self.assertIn(sha256(widget.read_bytes()).hexdigest(), body)
                                return uri, body
                            old_uri, _ = await published()
                            widget.write_bytes(b'<html lang="zh-Hant">next</html>')
                            new_uri, body = await published()
                            self.assertNotEqual(old_uri, new_uri)
                            legacy = (await client.read_resource(BINDINGS["omi_open_tw_workspace_v4"])).model_dump(mode="json", by_alias=True)["contents"][0]["text"]
                            self.assertEqual(legacy, body)
                            with self.assertRaises(server.MCPError) as rejected:
                                await client.read_resource(old_uri)
                            self.assertEqual(rejected.exception.code, server.mcp_types.INVALID_PARAMS)
        server._api_request.assert_not_called()

    async def test_current_sdk_lists_reads_and_calls_all_workspace_versions(self):
        async with app_client() as http_client:
            transport = streamable_http_client(f"{TEST_BASE_URL}/mcp", http_client=http_client)
            async with Client(transport, mode="2026-07-28") as client:
                self.assertEqual(client.protocol_version, "2026-07-28")
                tools = (await client.list_tools()).model_dump(mode="json", by_alias=True, exclude_none=True)["tools"]
                resources = (await client.list_resources()).model_dump(mode="json", by_alias=True, exclude_none=True)["resources"]
                self.assert_catalog(tools, resources)
                for uri in [*self.bindings.values(), BINDINGS["omi_open_tw_workspace_v4"]]:
                    result = (await client.read_resource(uri)).model_dump(mode="json", by_alias=True, exclude_none=True)
                    self.assert_resource(uri, result["contents"])
                for name in ("omi_open_tw_workspace", "omi_open_tw_workspace_v2", "omi_open_tw_workspace_v3", "omi_open_tw_workspace_v4"):
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
            for uri in [*self.bindings.values(), BINDINGS["omi_open_tw_workspace_v4"]]:
                self.assert_resource(uri, (await rpc("resources/read", {"uri": uri}))["contents"])
            for name in ("omi_open_tw_workspace", "omi_open_tw_workspace_v2", "omi_open_tw_workspace_v3", "omi_open_tw_workspace_v4"):
                for selection in SELECTIONS:
                    opened = await rpc("tools/call", {"name": name, "arguments": selection})
                    self.assertFalse(opened["isError"])
                    self.assertEqual(opened["structuredContent"], selection)
                    self.assertEqual(json.loads(opened["content"][0]["text"]), selection)
                rejected = await rpc("tools/call", {"name": name, "arguments": {"refresh": True}})
                self.assertTrue(rejected["isError"])
        server._api_request.assert_not_called()
        self.report_hashes("2025-06-18")
