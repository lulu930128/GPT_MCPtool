from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

import anyio
from mcp import Client, StdioServerParameters


def _load_server_module():
    server_path = Path(__file__).resolve().parents[1] / "server.py"
    spec = importlib.util.spec_from_file_location("omi_search_server", server_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load OMI_search server module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _dashboard_payload() -> dict:
    return {
        "kind": "omi.tw_market_dashboard",
        "version": "omi.tw_market_dashboard.v1",
        "snapshot_id": "snapshot-1",
        "state_version": 1,
        "trade_date": "2026-08-14",
        "session": {},
        "as_of": "2026-08-14T08:35:00+08:00",
        "indices": [],
        "breadth": {},
        "hot_groups": [],
        "watchlist": {},
        "freshness": {},
        "warnings": [],
        "limitations": [],
    }


class OmiSearchMappingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = _load_server_module()

    def test_application_release_version(self) -> None:
        self.assertEqual(self.server.SERVER_VERSION, "1.2.0")

    def test_minimal_canonical_request_is_read_only_and_not_interpreted(self) -> None:
        question = "TSM intraday live quote"

        payload = self.server._search_payload({"question": question})

        self.assertEqual(payload["question"], question)
        self.assertEqual(payload["contract_version"], "omi.decision.v4")
        self.assertEqual(payload["caller_profile"], "omi_search")
        self.assertEqual(payload["mode"], "data_only")
        self.assertFalse(payload["allow_llm"])
        self.assertFalse(payload["allow_write"])
        self.assertFalse(payload["allow_external_fetch"])
        self.assertNotIn("target", payload)
        self.assertNotIn("analysis_horizon", payload)
        self.assertNotIn("tool_budget", payload)
        self.assertNotIn("refresh_policy", payload)

    def test_question_whitespace_is_preserved(self) -> None:
        payload = self.server._search_payload({"question": "  keep me exact  "})

        self.assertEqual(payload["question"], "  keep me exact  ")

    def test_canonical_ask_does_not_apply_legacy_target_aliases(self) -> None:
        payload = self.server._search_payload(
            {"question": "Read context", "stock_id": "2330", "symbol": "TSM"}
        )

        self.assertNotIn("target", payload)
        with self.assertRaisesRegex(ValueError, "question"):
            self.server._search_payload({"query": "legacy only"})

    def test_legacy_alias_maps_old_question_and_target_fields_only(self) -> None:
        tw_payload = self.server._search_payload(
            {"query": "Read 2330", "stock_id": "2330"},
            allow_legacy_aliases=True,
        )
        us_payload = self.server._search_payload(
            {"query": "Read mixed-case symbol", "symbol": "Brk.B"},
            allow_legacy_aliases=True,
        )

        self.assertEqual(tw_payload["question"], "Read 2330")
        self.assertEqual(tw_payload["target"], {"type": "tw_stock", "id": "2330"})
        self.assertEqual(
            us_payload["target"], {"type": "us_stock", "id": "Brk.B"}
        )

    def test_refresh_is_enabled_only_by_explicit_boolean_alias(self) -> None:
        arguments = {
            "question": "TSM live quote",
            "target": {"type": "us_stock", "id": "TSM"},
        }

        cache_only = self.server._search_payload(arguments)
        refresh = self.server._search_payload(
            {**arguments, "refresh_if_missing": True}
        )

        self.assertFalse(cache_only["allow_external_fetch"])
        self.assertTrue(refresh["allow_external_fetch"])
        self.assertNotIn("tool_budget", refresh)
        with self.assertRaisesRegex(ValueError, "boolean"):
            self.server._search_payload(
                {**arguments, "refresh_if_missing": "true"}
            )

    def test_caller_cannot_override_fixed_trust_boundary_flags(self) -> None:
        payload = self.server._search_payload(
            {
                "question": "Read data",
                "allow_llm": True,
                "allow_write": True,
                "allow_external_fetch": True,
                "caller_profile": "trusted_internal",
            }
        )

        self.assertFalse(payload["allow_llm"])
        self.assertFalse(payload["allow_write"])
        self.assertFalse(payload["allow_external_fetch"])
        self.assertEqual(payload["caller_profile"], "omi_search")

    def test_backend_owned_fields_are_forwarded_without_defaults_or_clamping(self) -> None:
        fields = {
            "intents": ["quote"],
            "output": "evidence_only",
            "realtime_policy": "require_live",
            "selection": {"include": ["quote.snapshot"]},
            "continuation": {"plan_id": "plan-1"},
            "tool_budget": {
                "max_calls": 99,
                "max_external_fetches": 77,
                "max_total_seconds": 123,
            },
            "refresh_policy": {"mode": "off"},
            "strategy_profile": "balanced",
            "analysis_horizon": "auto",
            "branch_days": 999,
            "rank_by": "volume",
            "sort_order": "asc",
            "market_limit": 88,
            "context_limit": 999,
            "include_children": False,
            "enabled_only": False,
            "conversation_context": {"turn": 1},
            "position_context": {"entry_price": 10},
            "market_data_params": {"provider": "example"},
            "payload_level": "standard",
            "diagnostics_level": "basic",
        }

        payload = self.server._search_payload(
            {"question": "Read data", "mode": "full", **fields}
        )

        self.assertEqual(payload["mode"], "full")
        for key, value in fields.items():
            self.assertEqual(payload[key], value, key)

    def test_market_data_aliases_are_mechanically_merged(self) -> None:
        payload = self.server._search_payload(
            {
                "question": "Read data",
                "market_data_params": {
                    "include_intraday": False,
                    "provider": "example",
                },
                "include_intraday": True,
                "intraday_limit": 9999,
            }
        )

        self.assertEqual(
            payload["market_data_params"],
            {
                "include_intraday": False,
                "provider": "example",
                "intraday_limit": 9999,
            },
        )
        self.assertNotIn("include_intraday", payload)
        self.assertNotIn("intraday_limit", payload)

    def test_disallowed_llm_and_write_modes_are_rejected(self) -> None:
        for mode in ("auto", "analysis", "report", "unknown"):
            with self.subTest(mode=mode):
                with self.assertRaisesRegex(ValueError, "mode"):
                    self.server._search_payload(
                        {"question": "Read data", "mode": mode}
                    )

    def test_live_backend_schema_is_projected_only_for_adapter_safety(self) -> None:
        source_schema = self.server.PUBLIC_CONTRACT_SNAPSHOT["ask_input_schema"]
        backend_payload = {
            "tools": [
                {
                    "name": "omi.ask",
                    "title": "Backend Ask OMI",
                    "description": "backend-owned",
                    "input_schema": source_schema,
                },
                {
                    "name": "omi.read_refresh_status",
                    "title": "Backend Refresh Status",
                    "description": "backend-owned status schema",
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "job_id": {"type": "integer", "minimum": 1}
                        },
                        "required": ["job_id"],
                        "additionalProperties": False,
                    },
                },
            ]
        }

        with patch.object(
            self.server, "_api_request", return_value=backend_payload
        ) as request:
            tools = self.server._tools_for_client()

        request.assert_called_once_with(
            "GET",
            "/api/ai/tools",
            timeout_seconds=self.server.SCHEMA_TIMEOUT_SECONDS,
        )
        self.assertEqual(len(tools), 11)
        ask = tools[0]
        self.assertEqual(ask["title"], "Backend Ask OMI")
        properties = ask["inputSchema"]["properties"]
        self.assertEqual(properties["mode"]["enum"], ["brief", "data_only", "full"])
        self.assertFalse(properties["refresh_if_missing"]["default"])
        self.assertIn("include_intraday", properties)
        self.assertNotIn("allow_llm", properties)
        self.assertNotIn("allow_write", properties)
        self.assertNotIn("allow_external_fetch", properties)
        self.assertNotIn("caller_profile", properties)
        self.assertEqual(
            ask["inputSchema"]["x-omi-public-contract-digest"],
            source_schema["x-omi-public-contract-digest"],
        )
        status = tools[1]
        self.assertEqual(status["name"], "omi_read_refresh_status")
        self.assertEqual(status["title"], "Backend Refresh Status")
        self.assertEqual(status["inputSchema"]["required"], ["job_id"])

    def test_tools_list_falls_back_to_generated_snapshot(self) -> None:
        with patch.object(
            self.server, "_api_request", side_effect=RuntimeError("offline")
        ):
            tools = self.server._tools_for_client()

        self.assertIs(tools, self.server.PUBLIC_TOOLS)
        self.assertEqual(tools[0]["name"], "omi_ask")
        self.assertEqual(tools[1]["name"], "omi_read_refresh_status")

    def test_snapshot_contract_metadata_survives_adapter_projection(self) -> None:
        snapshot = self.server.PUBLIC_CONTRACT_SNAPSHOT
        source = snapshot["ask_input_schema"]
        projected = self.server.ASK_TOOL["inputSchema"]

        self.assertEqual(
            snapshot["digest"], source["x-omi-public-contract-digest"]
        )
        self.assertEqual(
            projected["x-omi-public-contract-digest"],
            source["x-omi-public-contract-digest"],
        )
        self.assertEqual(projected["x-omi-targets"], source["x-omi-targets"])
        self.assertEqual(
            projected["x-omi-capabilities"], source["x-omi-capabilities"]
        )

    def test_tools_list_exposes_curated_surface_and_hides_legacy_alias(self) -> None:
        async def scenario() -> list[str]:
            with patch.object(
                self.server,
                "_tools_for_client",
                return_value=self.server.PUBLIC_TOOLS,
            ):
                async with Client(
                    self.server.build_mcp_server(), mode="auto"
                ) as client:
                    result = await client.list_tools()
                    return [tool.name for tool in result.tools]

        names = anyio.run(scenario)
        self.assertEqual(
            names,
            [
                "omi_ask",
                "omi_read_refresh_status",
                "omi_read_market_overview",
                "omi_read_stock_context",
                "omi_read_data_freshness",
                "omi_read_source_health",
                "omi_read_capability_status",
                "omi_read_tw_market_dashboard",
                "omi_open_tw_market_dashboard",
                "omi_search_tw_symbols",
                "omi_read_tw_stock_dashboard_detail",
            ],
        )
        self.assertTrue(all("." not in name for name in names))
        self.assertNotIn("omi.search", names)

    def test_initialize_declares_resources_capability(self) -> None:
        async def scenario() -> tuple[str, object]:
            async with Client(
                self.server.build_mcp_server(), mode="legacy"
            ) as client:
                return client.protocol_version, client.server_capabilities.resources

        protocol_version, resources = anyio.run(scenario)
        self.assertEqual(protocol_version, "2025-11-25")
        self.assertIsNotNone(resources)
        self.assertFalse(resources.subscribe)
        self.assertFalse(resources.list_changed)

    def test_dashboard_tools_use_generated_exact_output_schemas(self) -> None:
        tools = {item["name"]: item for item in self.server.PUBLIC_TOOLS}
        snapshot = self.server.TW_DASHBOARD_CONTRACT_SNAPSHOT

        self.assertTrue(snapshot["digest"])
        self.assertEqual(
            tools["omi_read_tw_market_dashboard"]["outputSchema"],
            snapshot["dashboard_output_schema"],
        )
        self.assertEqual(
            tools["omi_search_tw_symbols"]["outputSchema"],
            snapshot["symbol_search_output_schema"],
        )
        self.assertEqual(
            tools["omi_read_tw_stock_dashboard_detail"]["outputSchema"],
            snapshot["stock_detail_output_schema"],
        )
        render = tools["omi_open_tw_market_dashboard"]
        self.assertEqual(
            render["_meta"]["ui"]["resourceUri"],
            self.server.TW_DASHBOARD_RESOURCE_URI,
        )
        for name, tool in tools.items():
            if name != "omi_open_tw_market_dashboard":
                self.assertNotIn("resourceUri", tool.get("_meta", {}).get("ui", {}))

    def test_dashboard_resource_is_versioned_inline_and_network_closed(self) -> None:
        async def scenario():
            async with Client(
                self.server.build_mcp_server(), mode="auto"
            ) as client:
                listed = await client.list_resources()
                read = await client.read_resource(
                    self.server.TW_DASHBOARD_RESOURCE_URI
                )
                return listed, read

        listed, read = anyio.run(scenario)
        resource = listed.resources[0]
        self.assertEqual(str(resource.uri), self.server.TW_DASHBOARD_RESOURCE_URI)
        self.assertEqual(
            resource.mime_type, self.server.TW_DASHBOARD_RESOURCE_MIME_TYPE
        )
        content = read.contents[0]
        self.assertIn("<div id=\"root\"></div>", content.text)
        self.assertEqual(
            content.meta["ui"]["csp"],
            {"connectDomains": [], "resourceDomains": []},
        )

    def test_dashboard_tools_mechanically_forward_focused_backend_routes(self) -> None:
        dashboard = _dashboard_payload()
        search = {
            "kind": "omi.tw_symbol_search",
            "version": "omi.tw_symbol_search.v1",
            "items": [],
        }
        detail = {
            "kind": "omi.tw_stock_dashboard_detail",
            "version": "omi.tw_stock_dashboard_detail.v2",
        }
        with patch.object(
            self.server,
            "_api_request",
            side_effect=[dashboard, search, detail],
        ) as request:
            read_dashboard = self.server._call_tool(
                "omi_read_tw_market_dashboard",
                {"watchlist_group_id": 7, "watchlist_limit": 20},
            )
            read_search = self.server._call_tool(
                "omi_search_tw_symbols",
                {"keyword": "台積 電", "limit": 12},
            )
            read_detail = self.server._call_tool(
                "omi_read_tw_stock_dashboard_detail",
                {"stock_id": "2330", "timeframe": "weekly", "bars": 60},
            )

        self.assertIs(read_dashboard, dashboard)
        self.assertIs(read_search, search)
        self.assertIs(read_detail, detail)
        self.assertEqual(
            request.call_args_list[0].args,
            (
                "GET",
                "/api/market/tw-dashboard/snapshot?"
                "include_watchlist_children=true&watchlist_limit=20&"
                "group_limit=8&watchlist_group_id=7",
            ),
        )
        self.assertEqual(
            request.call_args_list[1].args,
            (
                "GET",
                "/api/market/tw-dashboard/symbols/search?"
                "keyword=%E5%8F%B0%E7%A9%8D+%E9%9B%BB&limit=12",
            ),
        )
        self.assertEqual(
            request.call_args_list[2].args,
            (
                "GET",
                "/api/market/tw-dashboard/stocks/2330?timeframe=weekly&bars=60",
            ),
        )

    def test_render_dashboard_returns_prepared_snapshot_without_backend_call(self) -> None:
        dashboard = _dashboard_payload()
        with patch.object(self.server, "_api_request") as request:
            rendered = self.server._call_tool(
                "omi_open_tw_market_dashboard", dashboard
            )

        request.assert_not_called()
        self.assertEqual(rendered, dashboard)
        self.assertIsNot(rendered, dashboard)

    def test_refresh_status_maps_to_dedicated_redacted_endpoint(self) -> None:
        backend_response = {
            "job_id": 41,
            "operation": {"status": "completed"},
            "evidence": {"status": "rebuild_required"},
        }
        with patch.object(
            self.server, "_api_request", return_value=backend_response
        ) as request:
            result = self.server._call_tool(
                "omi_read_refresh_status", {"job_id": 41}
            )

        self.assertIs(result, backend_response)
        request.assert_called_once_with("GET", "/api/ai/refresh-status/41")

        for invalid in (None, True, 0, -1, "41"):
            with self.subTest(job_id=invalid):
                with self.assertRaisesRegex(ValueError, "positive integer"):
                    self.server._call_tool(
                        "omi_read_refresh_status", {"job_id": invalid}
                    )

    def test_legacy_omi_search_remains_callable(self) -> None:
        response = {"contract_version": "omi.decision.v4", "answer": "ok"}
        with patch.object(self.server, "_api_post", return_value=response) as post:
            result = self.server._call_tool(
                "omi.search", {"query": "Read 2330", "stock_id": "2330"}
            )

        self.assertIs(result, response)
        sent = post.call_args.args[1]
        self.assertEqual(sent["question"], "Read 2330")
        self.assertEqual(sent["target"], {"type": "tw_stock", "id": "2330"})

    def test_shortcuts_only_map_explicit_tool_fields(self) -> None:
        market = self.server._market_overview_arguments({"market": "us"})
        stock = self.server._stock_context_arguments(
            {"market": "us", "symbol": "Brk.B"}
        )
        freshness = self.server._data_freshness_arguments({"market": "tw"})
        health = self.server._source_health_arguments(
            {"provider": "yahoo", "problems_only": True}
        )
        capability = self.server._capability_status_arguments(
            {"capability_id": "quote.snapshot", "enabled_only": False}
        )

        self.assertEqual(market["target"], {"type": "market", "market": "us"})
        self.assertEqual(
            stock["target"], {"type": "us_stock", "id": "Brk.B"}
        )
        self.assertEqual(
            freshness["target"], {"type": "data_freshness", "market": "tw"}
        )
        self.assertEqual(health["target"], {"type": "source_health"})
        self.assertEqual(health["market_data_params"]["provider"], "yahoo")
        self.assertTrue(health["market_data_params"]["problems_only"])
        self.assertEqual(
            capability["target"],
            {"type": "capability_status", "id": "quote.snapshot"},
        )
        self.assertFalse(capability["enabled_only"])

    def test_shortcuts_keep_fixed_read_only_flags(self) -> None:
        shortcut_arguments = (
            self.server._market_overview_arguments({}),
            self.server._stock_context_arguments({"symbol": "2330"}),
            self.server._data_freshness_arguments({}),
            self.server._source_health_arguments({}),
            self.server._capability_status_arguments({}),
        )

        for arguments in shortcut_arguments:
            with self.subTest(target=arguments["target"]):
                payload = self.server._search_payload(arguments)
                self.assertEqual(payload["mode"], "data_only")
                self.assertFalse(payload["allow_llm"])
                self.assertFalse(payload["allow_write"])
                self.assertFalse(payload["allow_external_fetch"])

    def test_v4_response_is_returned_by_identity(self) -> None:
        backend_response = {
            "contract_version": "omi.decision.v4",
            "status": "TARGET_NOT_FOUND",
            "answer": "No matching target",
            "freshness": {"status": "missing"},
        }
        with patch.object(
            self.server, "_api_post", return_value=backend_response
        ):
            response = self.server._search({"question": "Unknown target"})

        self.assertIs(response, backend_response)

    def test_non_v4_backend_response_is_rejected(self) -> None:
        with patch.object(
            self.server,
            "_api_post",
            return_value={"contract_version": "omi.decision.v3"},
        ):
            with self.assertRaisesRegex(RuntimeError, "non-v4"):
                self.server._search({"question": "Read data"})

    def test_tool_result_contains_same_structured_payload(self) -> None:
        payload = {"contract_version": "omi.decision.v4", "status": "ok"}

        result = self.server._tool_result(payload)

        self.assertFalse(result["isError"])
        self.assertEqual(result["structuredContent"], payload)
        self.assertEqual(json.loads(result["content"][0]["text"]), payload)

    def test_business_rejection_remains_transport_success(self) -> None:
        payload = {
            "contract_version": "omi.decision.v4",
            "status": "TARGET_NOT_FOUND",
        }
        async def scenario():
            with patch.object(self.server, "_call_tool", return_value=payload):
                async with Client(
                    self.server.build_mcp_server(), mode="auto"
                ) as client:
                    return await client.call_tool(
                        "omi_ask", {"question": "x"}
                    )

        response = anyio.run(scenario)
        self.assertFalse(response.is_error)
        self.assertEqual(response.structured_content, payload)

    def test_adapter_failure_is_transport_error(self) -> None:
        async def scenario():
            with patch.object(
                self.server, "_call_tool", side_effect=RuntimeError("offline")
            ):
                async with Client(
                    self.server.build_mcp_server(), mode="auto"
                ) as client:
                    return await client.call_tool(
                        "omi_ask", {"question": "x"}
                    )

        response = anyio.run(scenario)
        self.assertTrue(response.is_error)
        self.assertIn("offline", response.structured_content["error"])

    def test_stdio_subprocess_uses_official_sdk_transport(self) -> None:
        server_path = Path(__file__).resolve().parents[1] / "server.py"

        async def scenario():
            parameters = StdioServerParameters(
                command=sys.executable,
                args=["-B", str(server_path)],
                cwd=server_path.parent,
            )
            async with Client(parameters, mode="auto") as client:
                tools = await client.list_tools()
                resources = await client.list_resources()
                dashboard = await client.read_resource(
                    "ui://omi/tw-market-dashboard/v2.html"
                )
                return tools, resources, dashboard

        try:
            tools, resources, dashboard = anyio.run(scenario)
        except PermissionError as exc:
            self.skipTest(f"Windows sandbox denied subprocess pipes: {exc}")
        self.assertEqual(len(tools.tools), 11)
        self.assertIn(
            "ui://omi/tw-market-dashboard/v2.html",
            {str(resource.uri) for resource in resources.resources},
        )
        self.assertIn("<!doctype html>", dashboard.contents[0].text.lower())


if __name__ == "__main__":
    unittest.main()
