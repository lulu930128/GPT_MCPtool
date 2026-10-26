"""Real official SDK + ASGI mock tests. No listener or live upstream requests.

Missing SDK skips this file only; SDK_E2E_UNVERIFIED is never an acceptance pass.
"""
import json
import importlib.util
import os
import unittest
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.error import HTTPError

SDK_AVAILABLE = importlib.util.find_spec("mcp") is not None
if SDK_AVAILABLE:
    from mcp import Client
    from mcp.client.streamable_http import streamable_http_client
    import mcp.types as types
    from mcp_types.methods import validate_server_result, serialize_server_result
    from pydantic import ValidationError
    import server
    from test_http_server import app_client, TEST_BASE_URL, MCP_HEADERS, legacy_initialize
from test_runtime_control import ARGS, TOKEN, REQUEST_ID, OWNER_ID, response
from runtime_control_fixture import runtime_status_body, runtime_receipt_body


@unittest.skipUnless(SDK_AVAILABLE, "SDK_E2E_UNVERIFIED: official mcp SDK is unavailable")
class RuntimeControlSdkTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # Both urllib paths are sealed before constructing any SDK server.
        self.opener = Mock()
        for scope in (
            patch.object(server, "urlopen", side_effect=AssertionError("No network in SDK tests")),
            patch.object(server, "build_opener", return_value=self.opener),
            patch.dict(os.environ, {"OMI_SEARCH_RUNTIME_CONTROL_TOKEN": TOKEN}),
        ):
            scope.start()
            self.addCleanup(scope.stop)

    async def test_unprojected_catalog_exact_legacy_validation_failure(self):
        payload = types.ListToolsResult(tools=[types.Tool.model_validate(t) for t in server.PUBLIC_TOOLS]).model_dump(
            mode="json", by_alias=True, exclude_none=True)
        self.assertEqual(payload["tools"][15]["name"], "omi_read_tw_stock_research")
        with self.assertRaises(ValidationError) as failure:
            validate_server_result("tools/list", "2025-06-18", payload)
        self.assertEqual(failure.exception.errors(include_url=False, include_input=False), [
            {"type": "missing", "loc": ("tools", 15, "outputSchema", "type"), "msg": "Field required"},
        ])
        validate_server_result("tools/list", "2026-07-28", payload)
        # Prove the original failure also passes through the real SDK runner.
        with patch.object(server, "_tools_for_client", return_value=server.PUBLIC_TOOLS), \
                patch.object(server, "_mcp_tool", side_effect=lambda tool, **kw: types.Tool.model_validate(tool)), \
                self.assertLogs("mcp.server.runner", level="ERROR"):
            async with app_client() as client:
                initialized = await legacy_initialize(client)
                headers = {**MCP_HEADERS, "MCP-Protocol-Version": "2025-06-18",
                           "Mcp-Session-Id": initialized.headers["Mcp-Session-Id"]}
                await client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "method": "notifications/initialized"})
                reply = await client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        self.assertEqual(reply.status_code, 200)
        self.assertEqual(reply.json()["error"], {"code": -32603, "message": "Handler returned an invalid result"})
        self.assertNotIn("result", reply.json())

    async def test_full_catalog_result_validation_and_projection_preserve_contracts(self):
        before = deepcopy(server.PUBLIC_TOOLS)
        online = {"tools": [server._fallback_ask_source(), server._fallback_refresh_status_source()]}
        for version in ("2025-06-18", "2026-07-28"):
            for kwargs in ({"return_value": online}, {"side_effect": RuntimeError("offline")}):
                with self.subTest(version=version, offline="side_effect" in kwargs), \
                        patch.object(server, "_api_request", **kwargs):
                    result = await server._on_list_tools(SimpleNamespace(protocol_version=version), None)
                    payload = result.model_dump(mode="json", by_alias=True, exclude_none=True)
                    validate_server_result("tools/list", version, payload)
                    wire = serialize_server_result("tools/list", version, payload)
                    self.assertEqual([t["name"] for t in wire["tools"]], [t["name"] for t in before])
                    self.assertEqual(len(wire["tools"]), 20)
                    for source, projected in zip(before, wire["tools"]):
                        self.assertEqual(projected["inputSchema"], source["inputSchema"])
                        expected = deepcopy(source.get("outputSchema"))
                        if version == "2025-06-18" and source["name"] == "omi_read_tw_stock_research":
                            # Guard the reason adding type:object is semantics-preserving.
                            self.assertNotIn("type", expected)
                            self.assertEqual(len(expected["anyOf"]), 2)
                            for branch in expected["anyOf"]:
                                self.assertEqual(set(branch), {"$ref"})
                                self.assertTrue(branch["$ref"].startswith("#/$defs/"))
                                self.assertEqual(expected["$defs"][branch["$ref"].split("/")[-1]]["type"], "object")
                            expected["type"] = "object"
                        self.assertEqual(projected.get("outputSchema"), expected)
                    restart = next(t for t in wire["tools"] if t["name"] == "omi_restart_backend")
                    self.assertFalse(restart["annotations"]["readOnlyHint"])
                    self.assertTrue(restart["annotations"]["destructiveHint"])
                    self.assertEqual(restart["_meta"], {"omi/runtime-control/disruptive": True})
        self.assertEqual(server.PUBLIC_TOOLS, before)

    async def test_modern_online_and_offline_tool_metadata_roundtrip(self):
        online = {"tools": [server._fallback_ask_source(), server._fallback_refresh_status_source()]}
        for kwargs in ({"return_value": online}, {"side_effect": RuntimeError("offline")}):
            with patch.object(server, "_api_request", **kwargs):
                async with app_client() as http_client:
                    transport = streamable_http_client(f"{TEST_BASE_URL}/mcp", http_client=http_client)
                    async with Client(transport, mode="2026-07-28") as client:
                        self.assertEqual(client.protocol_version, "2026-07-28")
                        catalog = await client.list_tools()
                        self.assertEqual(len((await client.list_resources()).resources), 2)
            self.assertEqual(len(catalog.tools), 20)
            tools = {tool.name: tool.model_dump(mode="json", by_alias=True, exclude_none=True) for tool in catalog.tools}
            self.assertNotIn("omi.search", tools)
            for source in server._build_runtime_tools():
                tool = tools[source["name"]]
                self.assertEqual(tool["inputSchema"], source["inputSchema"])
                self.assertEqual(tool["annotations"], source["annotations"])
                if "_meta" in source:
                    self.assertEqual(tool["_meta"], source["_meta"])

    async def test_legacy_metadata_survives_tools_list_wire(self):
        with patch.object(server, "_api_request", side_effect=RuntimeError("offline")):
            async with app_client() as client:
                initialized = await legacy_initialize(client)
                self.assertEqual(initialized.json()["result"]["protocolVersion"], "2025-06-18")
                headers = {**MCP_HEADERS, "MCP-Protocol-Version": "2025-06-18",
                           "Mcp-Session-Id": initialized.headers["Mcp-Session-Id"]}
                await client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "method": "notifications/initialized"})
                reply = await client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
                resources = await client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 3, "method": "resources/list"})
        self.assertEqual(reply.status_code, 200)
        self.assertNotIn("error", reply.json())
        self.assertEqual(len(resources.json()["result"]["resources"]), 2)
        tools = {tool["name"]: tool for tool in reply.json()["result"]["tools"]}
        self.assertEqual(len(tools), 20)
        for source in server._build_runtime_tools():
            self.assertEqual(tools[source["name"]]["annotations"], source["annotations"])
        self.assertEqual(tools["omi_restart_backend"]["_meta"], {"omi/runtime-control/disruptive": True})

    async def test_runtime_fixed_routes_and_nested_bodies_on_both_protocol_wires(self):
        status = runtime_status_body(OWNER_ID)
        unknown_status = deepcopy(status)
        unknown_status["owner_id"] = None
        unknown_status["serving_backend"]["writer_preflight"] = None
        unknown_status["source"]["disk_matches_import"] = None
        cases = [("omi_read_runtime_status", {}, "/status", 200, body) for body in (status, unknown_status)]
        for state in ("accepted", "blocked", "unknown"):
            full = runtime_receipt_body(REQUEST_ID, OWNER_ID, state)
            # New optional evidence can be populated, explicitly null, or absent.
            for presence in ("populated", "null", "absent"):
                receipt = deepcopy(full)
                for key in ("backend_preflight", "backend_preflight_identity", "blockers"):
                    if presence == "null":
                        receipt[key] = None
                    elif presence == "absent":
                        del receipt[key]
                cases.append(("omi_read_runtime_operation", {"request_id": REQUEST_ID},
                              f"/operations/{REQUEST_ID}", 200, receipt))
        for code, state in ((202, "accepted"), (409, "blocked"), (503, "unknown")):
            cases.append(("omi_restart_backend", ARGS, "/restart-backend", code,
                          runtime_receipt_body(REQUEST_ID, OWNER_ID, state)))
        # Explicit replay retains both UUIDs and payload; it is never an automatic retry.
        cases.append(cases[-1])
        # A timeout must perform one POST only, followed by caller-driven same-UUID GET.
        cases.extend([
            ("omi_restart_backend", ARGS, "/restart-backend", None, None),
            ("omi_read_runtime_operation", {"request_id": REQUEST_ID}, f"/operations/{REQUEST_ID}",
             200, runtime_receipt_body(REQUEST_ID, OWNER_ID, "unknown")),
        ])
        for version in ("2025-06-18", "2026-07-28"):
            with self.subTest(version=version), patch.object(server, "_api_request", side_effect=RuntimeError("offline")):
                async with app_client() as http_client:
                    meta = {} if version == "2025-06-18" else {"_meta": {
                        "io.modelcontextprotocol/protocolVersion": version,
                        "io.modelcontextprotocol/clientCapabilities": {},
                    }}
                    if version == "2025-06-18":
                        initialized = await legacy_initialize(http_client)
                        self.assertEqual(initialized.json()["result"]["protocolVersion"], version)
                        headers = {**MCP_HEADERS, "MCP-Protocol-Version": version,
                                   "Mcp-Session-Id": initialized.headers["Mcp-Session-Id"]}
                        await http_client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "method": "notifications/initialized"})
                    else:
                        # Modern MCP uses sessionless discovery, not legacy initialize.
                        headers = {**MCP_HEADERS, "MCP-Protocol-Version": version}
                        discovered = await http_client.post("/mcp", headers={**headers, "Mcp-Method": "server/discover"},
                            json={"jsonrpc": "2.0", "id": 1, "method": "server/discover", "params": meta})
                        self.assertNotIn("error", discovered.json())
                    catalog = await http_client.post("/mcp", headers={**headers, "Mcp-Method": "tools/list"},
                        json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": meta})
                    self.assertNotIn("error", catalog.json())
                    self.assertEqual([t["name"] for t in catalog.json()["result"]["tools"]],
                                     [t["name"] for t in server.PUBLIC_TOOLS])
                    for seq, (name, args, suffix, code, body) in enumerate(cases, start=3):
                        with self.subTest(version=version, case=seq, tool=name, http_status=code):
                            self.opener.open.reset_mock(side_effect=True)
                            self.opener.open.return_value = response(body, code)
                            if code is None:
                                self.opener.open.side_effect = TimeoutError(TOKEN)
                            elif code >= 400:
                                self.opener.open.side_effect = HTTPError("http://fixture", code, TOKEN, {}, response(body))
                            reply = await http_client.post("/mcp", headers={**headers, "Mcp-Method": "tools/call", "Mcp-Name": name}, json={
                                "jsonrpc": "2.0", "id": seq, "method": "tools/call", "params": {**meta, "name": name, "arguments": args}})
                            self.assertEqual(reply.status_code, 200)
                            self.assertNotIn("error", reply.json())
                            result = reply.json()["result"]
                            self.assertEqual(result.get("isError", False), code is None)
                            expected = ({"error": "RUNTIME_TIMEOUT", "transport_status": "error",
                                         "request_id": REQUEST_ID, "outcome": "unknown",
                                         "next_action": "read_runtime_operation_same_request_id"} if code is None else
                                        {"transport_status": "http_response", "http_status": code, "response": body})
                            for value in (result["structuredContent"], json.loads(result["content"][0]["text"])):
                                # JSON comparison also distinguishes false from 0 and null from missing.
                                self.assertEqual(json.dumps(value, sort_keys=True), json.dumps(expected, sort_keys=True))
                            self.assertNotIn(TOKEN, reply.text)
                            self.opener.open.assert_called_once()
                            request = self.opener.open.call_args.args[0]
                            self.assertEqual(request.full_url, server.API_BASE_URL + "/api/system/runtime-control" + suffix)
                            if name == "omi_restart_backend":
                                self.assertEqual(request.method, "POST")
                                self.assertEqual(json.loads(request.data), ARGS)
                                self.assertEqual(request.get_header("X-omi-runtime-control-token"), TOKEN)
                                self.assertIsNone(request.get_header("X-omi-ai-trust-token"))
                            else:
                                self.assertEqual(request.method, "GET")
                                self.assertIsNone(request.data)
                                self.assertFalse(any("token" in key.lower() for key in request.headers))

    async def test_runtime_outcomes_roundtrip_without_success_inference(self):
        with patch.object(server, "_api_request", side_effect=RuntimeError("offline")):
            async with Client(server.build_mcp_server(), mode="auto") as client:
                for code, state in ((202, "accepted"), (403, "unauthorized"), (409, "blocked"), (503, "unavailable")):
                    body = {"status": state, "request_id": REQUEST_ID}
                    self.opener.open.side_effect = None
                    self.opener.open.return_value = response(body, code)
                    if code >= 400:
                        self.opener.open.side_effect = HTTPError("http://fixture", code, TOKEN, {}, response(body))
                    result = await client.call_tool("omi_restart_backend", ARGS)
                    self.assertFalse(result.is_error)
                    self.assertEqual(result.structured_content, {"transport_status": "http_response", "http_status": code, "response": body})
                    self.assertNotIn(TOKEN, json.dumps(result.structured_content))
                self.opener.open.side_effect = TimeoutError(TOKEN)
                result = await client.call_tool("omi_restart_backend", ARGS)
                self.assertTrue(result.is_error)
                self.assertEqual(result.structured_content["outcome"], "unknown")
                self.assertEqual(result.structured_content["request_id"], REQUEST_ID)
                self.assertNotIn(TOKEN, json.dumps(result.structured_content))
                self.opener.open.side_effect = None
                self.opener.open.return_value = response({"status": "unknown", "request_id": REQUEST_ID})
                receipt = await client.call_tool("omi_read_runtime_operation", {"request_id": REQUEST_ID})
                self.assertFalse(receipt.is_error)
                self.assertEqual(receipt.structured_content["response"]["status"], "unknown")


if __name__ == "__main__":
    unittest.main()
