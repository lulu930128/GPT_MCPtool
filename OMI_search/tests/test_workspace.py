from copy import deepcopy
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import anyio
from mcp import Client
import server


def sample(schema, root=None):
    """Schema-driven synthetic protocol fixture; never reads market state."""
    root = root or schema
    if "$ref" in schema:
        return sample(root["$defs"][schema["$ref"].split("/")[-1]], root)
    if "const" in schema:
        return schema["const"]
    if "default" in schema:
        return deepcopy(schema["default"])
    if "enum" in schema:
        return schema["enum"][0]
    if "anyOf" in schema:
        return sample(schema["anyOf"][0], root)
    kind = schema.get("type")
    if kind == "object":
        properties = schema.get("properties", {})
        keys = set(schema.get("required", [])) | {
            key for key, value in properties.items() if "const" in value
        }
        return {key: sample(properties[key], root) for key in keys}
    if kind == "array":
        return []
    if kind in {"number", "integer"}:
        return schema.get("minimum", 0)
    if kind == "boolean":
        return False
    if kind == "null":
        return None
    if schema.get("format") == "date-time":
        return "2026-10-07T00:00:00Z"
    if schema.get("format") == "date":
        return "2026-10-07"
    return "fixture"


class WorkspaceTests(unittest.TestCase):
    def test_generated_schemas_are_exact_and_only_open_tools_bind_ui(self):
        self.assertEqual(len(server.TW_WORKSPACE_ROUTES), 5)
        catalog = {tool["name"]: tool for tool in server.PUBLIC_TOOLS}
        self.assertEqual(len(catalog), 20)
        for source in server.TW_DASHBOARD_CONTRACT_SNAPSHOT["workspace_tools"]:
            public = catalog[source["name"].replace(".", "_")]
            for key in ("inputSchema", "outputSchema", "annotations", "description"):
                self.assertEqual(public[key], source[key])
            self.assertNotIn("_meta", public)

    def test_all_routes_forward_only_supplied_parameters_without_semantic_defaults(self):
        for name, route in server.TW_WORKSPACE_ROUTES.items():
            with self.subTest(name=name):
                args = {"stock_id": "23/30 ?"} if route["path_parameters"] else {}
                response = sample(route["outputSchema"])
                response["warnings"] = ["stale", "partial", "missing"]
                with patch.object(server, "_api_request", return_value=response) as request:
                    actual = server._call_tool(name, args)
                self.assertIs(actual, response)
                expected = route["path"].replace("{stock_id}", "23%2F30%20%3F")
                request.assert_called_once_with("GET", expected)

    def test_optional_parameters_are_encoded_without_clamp_or_refresh(self):
        route = server.TW_WORKSPACE_ROUTES["omi_read_tw_workspace_watchlist"]
        with patch.object(server, "_api_request", return_value=sample(route["outputSchema"])) as request:
            server._call_tool("omi_read_tw_workspace_watchlist", {
                "watchlist_group_id": 8, "include_watchlist_children": False, "watchlist_limit": 99,
            })
        self.assertEqual(parse_qs(urlsplit(request.call_args.args[1]).query), {
            "watchlist_group_id": ["8"], "include_watchlist_children": ["false"], "watchlist_limit": ["99"],
        })
        with patch.object(server, "_api_request") as request:
            with self.assertRaises(ValueError):
                server._call_tool("omi_read_tw_workspace_header", {"refresh": True})
            request.assert_not_called()

    def test_open_workspace_needs_no_backend_or_dashboard(self):
        for args in ({}, {"stock_id": "2330", "timeframe": "today"}):
            with patch.object(server, "_api_request") as request:
                result = server._call_tool("omi_open_tw_workspace", args)
            request.assert_not_called()
            self.assertEqual(result, args)
            self.assertIsNot(result, args)

    def test_malformed_response_fails_without_repair(self):
        with patch.object(server, "_api_request", return_value={"kind": "wrong"}) as request:
            with self.assertRaises(RuntimeError):
                server._call_tool("omi_read_tw_workspace_header", {})
            self.assertEqual(request.call_count, 1)

    def test_both_resources_share_bundle_but_select_independent_app_modes(self):
        old = server._read_tw_dashboard_resource(server.TW_DASHBOARD_RESOURCE_URI)["contents"][0]
        new = server._read_tw_dashboard_resource(server.TW_WORKSPACE_RESOURCE_URI)["contents"][0]
        self.assertNotIn('<html data-omi-workspace="true"', old["text"])
        self.assertIn('<html data-omi-workspace="true"', new["text"])
        self.assertEqual(new["uri"], server.TW_WORKSPACE_RESOURCE_URI)
        self.assertEqual(new["_meta"]["ui"]["csp"]["connectDomains"], [])

    def test_offline_sdk_workspace_protocol_smoke(self):
        async def run():
            with patch.object(server, "_tools_for_client", return_value=server.PUBLIC_TOOLS):
                async with Client(server.build_mcp_server(), mode="auto") as client:
                    tools = await client.list_tools()
                    self.assertEqual(len(tools.tools), 20)
                    resources = await client.list_resources()
                    self.assertEqual(len(resources.resources), 2)
                    await client.read_resource(server.TW_WORKSPACE_RESOURCE_URI)
                    with patch.object(server, "_api_request") as request:
                        opened = await client.call_tool("omi_open_tw_workspace", {})
                        self.assertFalse(opened.is_error)
                        request.assert_not_called()
                    for name, route in server.TW_WORKSPACE_ROUTES.items():
                        response = sample(route["outputSchema"])
                        args = {"stock_id": "2330"} if route["path_parameters"] else {}
                        with patch.object(server, "_api_request", return_value=response):
                            result = await client.call_tool(name, args)
                        self.assertFalse(result.is_error, name)
                        self.assertEqual(result.structured_content, response)
        anyio.run(run)
