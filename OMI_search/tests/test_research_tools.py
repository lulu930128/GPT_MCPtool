"""Scope is Backend-owned; execution mutations are MCP Apps-only."""
import unittest
from unittest.mock import patch
import server


class ResearchToolsTests(unittest.TestCase):
    def test_list_projection_is_backend_owned_and_forwarded_unchanged(self):
        for args, query in [({}, ""), ({"view": "summary"}, "?view=summary"), ({"view": "full"}, "?view=full")]:
            payload = {"projection": "research.proposal_list.summary.v1", "items": []}
            with patch.object(server, "_api_request", return_value=payload) as api:
                self.assertIs(server._call_research_tool("omi_list_research_proposals", args), payload)
                api.assert_called_once_with("GET", server.RESEARCH_BASE_PATH + query)

    def test_all_execution_mutations_are_app_only_and_research_is_model_visible(self):
        tools = {tool["name"]: tool for tool in server.PUBLIC_TOOLS}
        for name, (method, _, _) in server.CANDIDATE_ROUTES.items():
            if method != "GET":
                self.assertEqual(tools[name]["_meta"]["ui"]["visibility"], ["app"])
        for name in server.RESEARCH_ROUTES:
            self.assertNotIn("_meta", tools[name])
            self.assertFalse(any(word in name for word in ("confirm", "approve", "protection", "broker")))

    def test_research_mutations_forward_once_to_fixed_scoped_routes(self):
        for name, (method, suffix, fields) in server.RESEARCH_ROUTES.items():
            if method == "GET":
                continue
            body = {"expected_revision_id": "fixture-revision", "origin": "AI_NOMINATION"}
            args = {"data": body} if fields == ("data",) else {key: body[key] for key in fields}
            if "{id}" in suffix:
                args["id"] = "test/id"
            with self.subTest(name=name), patch.object(server, "_api_request", return_value={"ok": True}) as api:
                server._call_research_tool(name, args)
                api.assert_called_once_with(method, server.RESEARCH_BASE_PATH + suffix.replace("{id}", "test%2Fid"), payload=body if "data" in args else {k: body[k] for k in fields})

    def test_manual_us_fields_are_optional_for_legacy_tw_and_preserved(self):
        args = {"client_intent_id": "fixture", "symbol": "NVDA", "action": "Buy", "condition": "CASH", "lot": "Shares", "quantity_shares": 1, "price": "10", "market": "US", "settlement_mode": "MUT", "protection": {"enabled": True}}
        with patch.object(server, "_api_request", return_value={}) as api:
            server._call_candidate_tool("omi_create_desk_draft", args)
            api.assert_called_once_with("POST", server.CANDIDATE_BASE_PATH + "/desk/draft", payload=args)
