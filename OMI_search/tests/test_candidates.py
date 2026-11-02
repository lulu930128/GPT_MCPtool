"""Candidate transport/schema tests. All HTTP is mocked; no Backend/DB/Native IO."""
from copy import deepcopy
from io import BytesIO
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from urllib.error import HTTPError

import anyio
import mcp.types as types
from mcp import Client
from mcp_types.methods import validate_server_result
from jsonschema import Draft202012Validator
import server


BASE = "/api/research/conditional-candidates"
RAW = {"symbol": "3481", "space_id": "AGENT_SPACE", "source": "AGENT_PROPOSAL",
       "direction": "short", "action": "Sell", "condition": "SHORT_SELLING", "lot": "Common",
       "quantity": 1000, "proposed_limit": None, "reference_notes": {"borrow": "UNKNOWN", "price_assumption": "upper"}}


class CandidateToolsTests(unittest.TestCase):
    def test_exact_additive_surface_and_schemas(self):
        tools = {item["name"]: item for item in server.PUBLIC_TOOLS}
        self.assertEqual(len(tools), 48)
        self.assertEqual(len(server.CANDIDATE_ROUTES), 23)
        for name, (method, _, _) in server.CANDIDATE_ROUTES.items():
            item = tools[name]
            types.Tool.model_validate(item)
            Draft202012Validator.check_schema(item["inputSchema"])
            self.assertNotIn("_meta", item)
            self.assertNotIn("outputSchema", item)
            self.assertEqual(item["annotations"]["readOnlyHint"], method == "GET")
            self.assertEqual(item["annotations"]["destructiveHint"], name in {"omi_cancel_candidate", "omi_cancel_candidate_pending", "omi_approve_candidate_pending", "omi_confirm_desk_review", "omi_confirm_desk_staged"})
            self.assertEqual(item["annotations"]["idempotentHint"], method == "GET")
            self.assertFalse(item["inputSchema"]["additionalProperties"])
        self.assertIn("omi_prepare_candidate_pending", tools)
        self.assertIn("omi_approve_candidate_pending", tools)

    def test_fixed_routes_methods_and_bodies(self):
        cases = [
            ("omi_list_candidates", {}, "GET", BASE, None),
            ("omi_list_candidates", {"after": "a/b ?", "limit": 17}, "GET", BASE + "?after=a%2Fb+%3F&limit=17", None),
            ("omi_read_candidate_monitor_status", {}, "GET", BASE + "/monitor-status", None),
            ("omi_create_candidate", {"owner_id": "MCP", "raw": RAW}, "POST", BASE, {"owner_id": "MCP", "raw": RAW}),
        ]
        for name, suffix in (("omi_read_candidate", ""), ("omi_read_candidate_revisions", "/revisions"), ("omi_read_candidate_pending", "/pending")):
            cases.append((name, {"id": "a/b ?"}, "GET", BASE + "/a%2Fb%20%3F" + suffix, None))
        for operation in ("pause", "resume", "cancel"):
            cases.append((f"omi_{operation}_candidate", {"id": "fixture", "expected_revision": 7}, "POST", BASE + f"/fixture/{operation}", {"expected_revision": 7}))
        cases.extend([
            ("omi_read_desk_staged", {}, "GET", BASE + "/desk/staged", None),
            ("omi_read_desk_staged", {"after": "a/b ?", "limit": 100}, "GET", BASE + "/desk/staged?after=a%2Fb+%3F&limit=100", None),
            ("omi_read_desk_stage", {"id": "stage/a ?"}, "GET", BASE + "/desk/staged/stage%2Fa%20%3F", None),
            ("omi_confirm_desk_staged", {"id": "stage/a ?", "expected_revision": 7, "expected_digest": "c" * 64}, "POST", BASE + "/desk/staged/stage%2Fa%20%3F/confirm", {"expected_revision": 7, "expected_digest": "c" * 64}),
            ("omi_prepare_candidate_pending", {"id": "p"}, "POST", BASE + "/pending/p/prepare", None),
            ("omi_approve_candidate_pending", {"id": "p", "expected_revision": 7, "expected_digest": "a" * 64}, "POST", BASE + "/pending/p/approve", {"expected_revision": 7, "expected_digest": "a" * 64}),
            ("omi_confirm_desk_review", {"id": "review/a ?", "expected_revision": 3, "expected_digest": "b" * 64}, "POST", BASE + "/desk/reviews/review%2Fa%20%3F/confirm", {"expected_revision": 3, "expected_digest": "b" * 64}),
            ("omi_revise_candidate", {"id": "fixture", "expected_revision": 7, "raw": RAW}, "POST", BASE + "/fixture/revisions", {"expected_revision": 7, "raw": RAW}),
            ("omi_revise_candidate_pending", {"id": "p", "expected_revision": 4, "price": "12.35", "quantity": 1000}, "POST", BASE + "/pending/p/revise", {"expected_revision": 4, "price": "12.35", "quantity": 1000}),
            ("omi_cancel_candidate_pending", {"id": "p", "expected_revision": 4}, "POST", BASE + "/pending/p/cancel", {"expected_revision": 4}),
        ])
        for name, args, method, path, body in cases:
            with self.subTest(name=name, args=args), patch.object(server, "_api_request", return_value={"validation_reasons": ["INCOMPLETE_DATE"], "raw": RAW}) as request:
                before = deepcopy(args)
                result = server._call_tool(name, args)
                self.assertEqual(result, {"validation_reasons": ["INCOMPLETE_DATE"], "raw": RAW})
                request.assert_called_once_with(method, path, **({"payload": body} if body is not None else {}))
                self.assertEqual(args, before)

    def test_desk_draft_stable_identity_fixed_owner_and_all_read_routes(self):
        body = {"client_intent_id": "83771cec-bd72-4dd9-bb65-132ea523997b", "symbol": "2330", "action": "Buy", "condition": "CASH", "lot": "Common", "quantity_shares": 1000, "price": "100.25"}
        with patch.object(server, "_api_request", return_value={"state": "PREVIEW"}) as request:
            server._call_tool("omi_create_desk_draft", body)
            request.assert_called_once_with("POST", BASE + "/desk/draft", payload=body)
        for name in ("orders", "fills", "inventory", "status"):
            with patch.object(server, "_api_request", return_value={"status": "unknown", "items": []}) as request:
                server._call_tool(f"omi_read_desk_{name}", {})
                request.assert_called_once_with("GET", BASE + "/desk/" + ("order-reports" if name == "orders" else name))
        with patch.object(server, "_api_request") as request:
            server._call_tool("omi_create_candidate", {"raw": {**RAW, "space_id": "USER_SPACE", "source": "MANUAL"}})
            self.assertEqual(request.call_args.kwargs["payload"]["owner_id"], "MCP")
        for patch_body in ({"client_intent_id": "bad/id"}, {"quantity_shares": True}, {"expected_digest": "x"}, {"owner_id": "other"}):
            with self.subTest(patch_body=patch_body), patch.object(server, "_api_request") as request, self.assertRaises(ValueError):
                server._call_tool("omi_create_desk_draft", {**body, **patch_body})
            request.assert_not_called()

    def test_invalid_structural_input_does_not_reach_backend(self):
        cases = [("omi_create_candidate", {"owner_id": "x", "raw": [], "approve": True}),
                 ("omi_list_candidates", {"limit": 101}), ("omi_list_candidates", {"limit": True}),
                 ("omi_pause_candidate", {"id": "x", "expected_revision": True}),
                 ("omi_pause_candidate", {"id": "x", "expected_revision": 0}),
                 ("omi_read_candidate", {"id": ""}), ("omi_read_candidate", {"id": "x", "url": "other"})]
        with patch.object(server, "_api_request") as request:
            for name, args in cases:
                with self.subTest(name=name, args=args), self.assertRaises(ValueError): server._call_tool(name, args)
            request.assert_not_called()

    def test_staged_confirm_unknown_timeout_and_503_never_retry(self):
        async def run():
            args = {"id": "fixture-stage", "expected_revision": 7, "expected_digest": "d" * 64}
            for error in (TimeoutError("timed out"), HTTPError("http://fixture.invalid", 503, "unknown", {}, BytesIO(b'{"detail":"EXECUTOR_RESPONSE_UNKNOWN"}'))):
                with patch.object(server, "urlopen", side_effect=error) as http:
                    result = await server._on_call_tool(None, types.CallToolRequestParams(name="omi_confirm_desk_staged", arguments=args))
                    self.assertTrue(result.is_error)
                    http.assert_called_once()
            row = {"id": "fixture-stage", "revision": 8, "kind": "manual_stage", "manual_stage": {"state": "SUBMISSION_UNKNOWN"}}
            with patch.object(server, "_api_request", return_value=row) as request:
                result = await server._on_call_tool(None, types.CallToolRequestParams(name="omi_confirm_desk_staged", arguments=args))
                self.assertEqual(result.structured_content, row)
                request.assert_called_once_with("POST", BASE + "/desk/staged/fixture-stage/confirm", payload={"expected_revision": 7, "expected_digest": "d" * 64})
        anyio.run(run)

    def test_http_wire_and_validation_preserved_without_semantic_defaults(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return json.dumps({"raw": RAW, "validation_reasons": ["INCOMPLETE_CONDITION"], "spec": None}).encode()
        with patch.object(server, "urlopen", return_value=Response()) as http, patch.object(server, "API_BASE_URL", "http://fixture.invalid"), patch.object(server, "AI_TRUST_TOKEN", ""):
            result = server._call_tool("omi_create_candidate", {"owner_id": "MCP", "raw": RAW})
            request = http.call_args.args[0]
            self.assertEqual(request.full_url, "http://fixture.invalid" + BASE)
            self.assertEqual(request.method, "POST")
            self.assertEqual(json.loads(request.data), {"owner_id": "MCP", "raw": RAW})
            self.assertEqual(result["validation_reasons"], ["INCOMPLETE_CONDITION"])
            self.assertIsNone(result["raw"]["proposed_limit"])
            http.assert_called_once()

    def test_errors_are_inspectable_and_never_retried(self):
        async def run():
            args = {"id": "fixture", "expected_revision": 7, "raw": RAW}
            for error in (TimeoutError("timed out"), HTTPError("http://fixture.invalid", 409, "conflict", {}, BytesIO(b'{"detail":{"code":"STALE_CANDIDATE_REVISION"}}'))):
                with patch.object(server, "urlopen", side_effect=error) as http:
                    result = await server._on_call_tool(None, types.CallToolRequestParams(name="omi_revise_candidate", arguments=args))
                    self.assertTrue(result.is_error)
                    self.assertIn("error", result.structured_content)
                    self.assertTrue("timed out" in result.structured_content["error"] or "STALE_CANDIDATE_REVISION" in result.structured_content["error"])
                    http.assert_called_once()
            with patch.object(server, "_api_request", return_value=[]) as request:
                result = await server._on_call_tool(None, types.CallToolRequestParams(name="omi_list_candidates", arguments={}))
                self.assertFalse(result.is_error)
                self.assertEqual(result.structured_content, {"result": []})
                request.assert_called_once_with("GET", BASE)
        anyio.run(run)

    def test_official_sdk_registration_call_and_legacy_catalog(self):
        async def run():
            with patch.object(server, "_tools_for_client", return_value=server.PUBLIC_TOOLS):
                for version in ("2025-06-18", "2026-07-28"):
                    result = await server._on_list_tools(SimpleNamespace(protocol_version=version), None)
                    wire = result.model_dump(mode="json", by_alias=True, exclude_none=True)
                    validate_server_result("tools/list", version, wire)
                    self.assertEqual(len(wire["tools"]), 48)
                async with Client(server.build_mcp_server(), mode="auto") as client:
                    self.assertEqual(len((await client.list_tools()).tools), 48)
                    saved = {"id": "fixture", "revision": 1, "raw": RAW, "validation_reasons": ["INCOMPLETE_DATE"]}
                    with patch.object(server, "_api_request", return_value=saved) as request:
                        result = await client.call_tool("omi_create_candidate", {"owner_id": "MCP", "raw": RAW})
                        self.assertFalse(result.is_error)
                        self.assertEqual(result.structured_content, saved)
                        request.assert_called_once_with("POST", BASE, payload={"owner_id": "MCP", "raw": RAW})
                    reports = {"contract": "omi.execution-desk.v1", "reviews": [], "broker_orders": [{"ownership": "EXTERNAL"}], "quality": "PARTIAL"}
                    with patch.object(server, "_api_request", return_value=reports) as request:
                        result = await client.call_tool("omi_read_desk_orders", {})
                        self.assertFalse(result.is_error)
                        self.assertEqual(result.structured_content, reports)
                        request.assert_called_once_with("GET", BASE + "/desk/order-reports")
                    for name, args, value, method, path, body in [
                        ("omi_read_desk_staged", {"limit": 100}, [saved], "GET", "/desk/staged?limit=100", None),
                        ("omi_read_desk_stage", {"id": "fixture"}, saved, "GET", "/desk/staged/fixture", None),
                        ("omi_confirm_desk_staged", {"id": "fixture", "expected_revision": 1, "expected_digest": "a" * 64}, saved, "POST", "/desk/staged/fixture/confirm", {"expected_revision": 1, "expected_digest": "a" * 64}),
                    ]:
                        with patch.object(server, "_api_request", return_value=value) as request:
                            result = await client.call_tool(name, args)
                            self.assertFalse(result.is_error)
                            self.assertEqual(result.structured_content, {"result": value} if isinstance(value, list) else value)
                            request.assert_called_once_with(method, BASE + path, **({"payload": body} if body else {}))
        anyio.run(run)


if __name__ == "__main__": unittest.main()
