"""Public discovery and forwarding, with no provider, broker, or Launcher IO."""
from copy import deepcopy
import unittest
from unittest.mock import patch

from jsonschema import Draft202012Validator

import server


class PublicSurfaceTests(unittest.TestCase):
    def test_live_drift_uses_backend_schema_and_reports_actual_content_digest(self):
        ask = server._fallback_ask_source()
        changed = deepcopy(ask)
        changed["input_schema"]["properties"]["question"]["description"] = "Live revision"
        with patch.object(server, "_api_request", side_effect=[{"tools": [changed]}, {}]):
            catalog = server._tools_for_client()
        tool = catalog[0]
        info = tool["_meta"]["omi/schema"]
        self.assertEqual(info["origin"], "backend_live")
        self.assertEqual(info["snapshotComparison"], "drift")
        self.assertNotEqual(info["sourceSchemaSha256"], info["snapshotSchemaSha256"])
        self.assertEqual(tool["inputSchema"]["properties"]["question"]["description"], "Live revision")
        self.assertEqual(catalog[1]["_meta"]["omi/schema"]["origin"], "adapter_status_compatibility")

    def test_invalid_backend_and_missing_snapshot_are_distinguishable(self):
        malformed = {"tools": [{"name": "omi.ask", "input_schema": {"type": "object", "properties": {}}}]}
        with patch.object(server, "_api_request", side_effect=[malformed, {}]):
            tool = server._tools_for_client()[0]
        self.assertEqual(tool["_meta"]["omi/schema"]["fallbackReason"], "ValueError")
        self.assertEqual(tool["_meta"]["omi/schema"]["snapshotComparison"], "unknown")
        ask = server._fallback_ask_source()
        with patch.object(server, "PUBLIC_CONTRACT_SNAPSHOT", {}):
            with patch.object(server, "_api_request", side_effect=OSError):
                names = {t["name"] for t in server._tools_for_client()}
            self.assertNotIn("omi_ask", names)
            self.assertIn("omi_read_runtime_status", names)
            with patch.object(server, "_api_request", side_effect=[{"tools": [ask]}, {}]):
                info = server._tools_for_client()[0]["_meta"]["omi/schema"]
            self.assertEqual(info["origin"], "backend_live")
            self.assertEqual(info["snapshotComparison"], "unknown")

    def test_research_data_refs_and_flat_move_match_backend(self):
        definition = {"type": "string", "enum": ["active"]}
        nested = {"type": "object", "$defs": {"State": definition}, "additionalProperties": False,
                  "properties": {"state": {"$ref": "#/$defs/State"}}, "required": ["state"]}
        move = {"type": "object", "additionalProperties": False, "properties": {
            "expected_revision_id": {"type": "string"}, "origin": {"const": "AI_NOMINATION"}},
            "required": ["expected_revision_id", "origin"]}
        source = {"stage_revision": nested, "move": move}
        before = deepcopy(source)
        with patch.object(server, "_api_request", side_effect=[OSError(), source]):
            tools = {t["name"]: t for t in server._tools_for_client()}
        revise = tools["omi_revise_research_order"]
        validator = Draft202012Validator(revise["inputSchema"])
        self.assertTrue(validator.is_valid({"id": "a", "data": {"state": "active"}}))
        self.assertFalse(validator.is_valid({"id": "a", "data": {"state": False}}))
        self.assertTrue(revise["annotations"]["destructiveHint"])
        self.assertIn("cancels", revise["description"])
        self.assertEqual(revise["_meta"]["omi/schema"]["origin"], "backend_research_live")
        validate_move = Draft202012Validator(tools["omi_move_research_proposal"]["inputSchema"])
        self.assertFalse(validate_move.is_valid({"expected_revision_id": "r", "origin": "AI_NOMINATION"}))
        self.assertTrue(validate_move.is_valid({"id": "a", "expected_revision_id": "r", "origin": "AI_NOMINATION"}))
        self.assertEqual(source, before)
        self.assertEqual(tools["omi_nominate_research_stocks"]["_meta"]["omi/schema"]["origin"], "adapter_envelope")

    def test_inventory_routes_visibility_and_effects(self):
        rows = {r["name"]: r for r in server.public_inventory(server.PUBLIC_TOOLS)}
        for table, base in ((server.CANDIDATE_ROUTES, server.CANDIDATE_BASE_PATH),
                            (server.RESEARCH_ROUTES, server.RESEARCH_BASE_PATH)):
            for name, (method, suffix, _) in table.items():
                row = rows[name]
                with self.subTest(name=name):
                    self.assertEqual((row["method"], row["route"]), (method, base + suffix))
                    self.assertEqual("model" in row["visibility"], table is server.RESEARCH_ROUTES or method == "GET")
                    self.assertEqual(row["annotations"]["readOnlyHint"], method == "GET")
                    self.assertEqual(row["annotations"]["idempotentHint"], method == "GET")
                    if method == "GET":
                        self.assertFalse(row["annotations"]["destructiveHint"])
                    if method == "DELETE":
                        self.assertTrue(row["annotations"]["destructiveHint"])
        for name in ("omi_cancel_desk_order", "omi_revise_order_protection", "omi_confirm_desk_staged"):
            self.assertTrue(rows[name]["annotations"]["destructiveHint"])
            self.assertTrue(rows[name]["annotations"]["openWorldHint"])
            self.assertEqual(rows[name]["visibility"], ["app"])
        self.assertFalse(rows["omi.search"]["listed"])
        self.assertEqual(rows["omi_open_tw_workspace_v4"]["compatibility"], "current")

    def test_all_shortcuts_forward_full_selection_without_implicit_refresh(self):
        selection = {"include": ["quote.auction"], "parameters": {"technical.indicators": {"calculation_limit": 20}}}
        tools = {t["name"]: t for t in server.PUBLIC_TOOLS}
        Draft202012Validator(tools["omi_ask"]["inputSchema"]).validate({"question": "fixture", "selection": selection})
        for name in server.ASK_SHORTCUTS:
            for permission in ({}, {"refresh_if_missing": False}, {"refresh_if_missing": True}):
                args = {"selection": selection, **permission}
                if name == "omi_read_stock_context":
                    args["symbol"] = "2330"
                with self.subTest(name=name, permission=permission):
                    Draft202012Validator(tools[name]["inputSchema"]).validate(args)
                    with patch.object(server, "_api_post", return_value={"contract_version": "omi.decision.v4"}) as post:
                        server._call_tool(name, args)
                    self.assertEqual(post.call_count, 1)
                    route, body = post.call_args.args
                    self.assertEqual(route, "/api/ai/ask")
                    self.assertEqual(body["selection"], selection)
                    self.assertIs(body["allow_external_fetch"], permission.get("refresh_if_missing", False))
                    self.assertFalse(body["allow_write"])
