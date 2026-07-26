from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch


def load_server_module():
    server_path = Path(__file__).resolve().parents[1] / "server.py"
    spec = importlib.util.spec_from_file_location("omi_search_server_test_module", server_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load server module from {server_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class OmiSearchPayloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = load_server_module()

    def setUp(self) -> None:
        self._old_default_refresh = self.server.DEFAULT_REFRESH_IF_MISSING

    def tearDown(self) -> None:
        self.server.DEFAULT_REFRESH_IF_MISSING = self._old_default_refresh

    def test_minimal_search_is_read_only_data_only(self) -> None:
        payload = self.server._search_payload(
            {
                "query": "2330 latest context",
                "target": {"type": "tw_stock", "id": "2330"},
            }
        )

        self.assertEqual(payload["question"], "2330 latest context")
        self.assertEqual(payload["contract_version"], "omi.decision.v4")
        self.assertEqual(payload["target"], {"type": "tw_stock", "id": "2330"})
        self.assertEqual(payload["mode"], "data_only")
        self.assertEqual(payload["caller_profile"], "omi_search")
        self.assertFalse(payload["allow_llm"])
        self.assertFalse(payload["allow_write"])
        self.assertFalse(payload["allow_external_fetch"])
        self.assertEqual(payload["tool_budget"], {})

    def test_canonical_question_is_preferred_over_legacy_query_alias(self) -> None:
        payload = self.server._search_payload(
            {
                "question": "canonical question",
                "query": "legacy query",
                "target": {"type": "market", "market": "tw"},
            }
        )

        self.assertEqual(payload["question"], "canonical question")

    def test_refresh_if_missing_enables_bounded_external_fetch_request(self) -> None:
        payload = self.server._search_payload(
            {
                "query": "MU latest context",
                "symbol": "mu",
                "refresh_if_missing": True,
            }
        )

        self.assertEqual(payload["target"], {"type": "us_stock", "id": "MU"})
        self.assertTrue(payload["allow_external_fetch"])
        self.assertEqual(payload["tool_budget"], self.server.DEFAULT_TOOL_BUDGET)
        self.assertFalse(payload["allow_llm"])
        self.assertFalse(payload["allow_write"])

    def test_us_live_intent_infers_intraday_refresh_when_missing(self) -> None:
        payload = self.server._search_payload(
            {
                "query": "TSM 即時報價與 route_hint exposure confirmation",
                "symbol": "TSM",
            }
        )

        self.assertEqual(payload["target"], {"type": "us_stock", "id": "TSM"})
        self.assertIn("intraday live quote compact", payload["question"])
        self.assertEqual(payload["analysis_horizon"], "intraday")
        self.assertTrue(payload["allow_external_fetch"])
        self.assertEqual(payload["tool_budget"], self.server.DEFAULT_TOOL_BUDGET)

    def test_explicit_refresh_false_is_respected_for_live_intent(self) -> None:
        payload = self.server._search_payload(
            {
                "query": "TSM 即時報價",
                "symbol": "TSM",
                "refresh_if_missing": False,
            }
        )

        self.assertEqual(payload["analysis_horizon"], "intraday")
        self.assertIn("intraday live quote compact", payload["question"])
        self.assertFalse(payload["allow_external_fetch"])
        self.assertEqual(payload["tool_budget"], {})

    def test_explicit_budget_is_clamped(self) -> None:
        payload = self.server._search_payload(
            {
                "query": "2330 refresh",
                "stock_id": "2330",
                "refresh_if_missing": True,
                "tool_budget": {
                    "max_calls": 99,
                    "max_external_fetches": 99,
                    "max_total_seconds": 999,
                },
            }
        )

        self.assertEqual(payload["tool_budget"]["max_calls"], 12)
        self.assertEqual(payload["tool_budget"]["max_external_fetches"], 8)
        self.assertEqual(payload["tool_budget"]["max_total_seconds"], 90)

    def test_search_schema_supports_current_public_ask_targets_and_controls(self) -> None:
        properties = self.server.SEARCH_TOOL["inputSchema"]["properties"]
        target_enum = properties["target"]["properties"]["type"]["enum"]

        self.assertEqual(target_enum, self.server.TARGET_TYPES)
        self.assertEqual(
            set(target_enum),
            {
                "auto",
                "market",
                "data_freshness",
                "tw_stock",
                "tw_watchlist",
                "tw_index",
                "tw_futures",
                "us_stock",
                "jp_stock",
                "jp_index",
                "kr_stock",
                "kr_index",
                "crypto_market",
                "crypto_asset",
                "resource_asset",
                "portfolio",
                "us_macro",
                "us_watchlist",
                "jp_watchlist",
                "kr_watchlist",
                "source_health",
                "capability_status",
            },
        )

        self.assertIn("full", properties["mode"]["enum"])
        self.assertIn("market_data_params", properties)
        self.assertEqual(
            properties["contract_version"]["enum"],
            ["omi.decision.v4"],
        )
        self.assertIn("selection", properties)
        self.assertIn("output", properties)
        self.assertIn("realtime_policy", properties)
        self.assertIn("payload_level", properties)
        self.assertIn("intraday_limit", properties)
        self.assertIn("include_intraday", properties)
        self.assertEqual(
            properties["market_data_params"]["properties"]["payload_level"]["enum"],
            ["summary", "compact", "standard", "full"],
        )

    def test_full_mode_is_allowed_as_read_only_mode(self) -> None:
        payload = self.server._search_payload(
            {
                "query": "2330 full read-mode evidence",
                "target": {"type": "tw_stock", "id": "2330"},
                "mode": "full",
            }
        )

        self.assertEqual(payload["mode"], "full")
        self.assertFalse(payload["allow_llm"])
        self.assertFalse(payload["allow_write"])

    def test_rejects_analysis_and_report_modes(self) -> None:
        with self.assertRaises(ValueError):
            self.server._search_payload({"query": "2330 report", "mode": "report"})
        with self.assertRaises(ValueError):
            self.server._search_payload({"query": "2330 analysis", "mode": "analysis"})

    def test_payload_forwards_market_data_params_and_top_level_controls(self) -> None:
        payload = self.server._search_payload(
            {
                "query": "BTCUSDT compact intraday context",
                "target": {"type": "crypto_asset", "id": "BTC"},
                "mode": "data_only",
                "market_data_params": {
                    "provider": "binance",
                    "symbol": "BTCUSDT",
                    "interval": "1m",
                },
                "include_intraday": True,
                "payload_level": "summary",
                "intraday_limit": 999,
            }
        )

        self.assertEqual(payload["target"], {"type": "crypto_asset", "id": "BTC"})
        self.assertEqual(payload["market_data_params"]["provider"], "binance")
        self.assertEqual(payload["market_data_params"]["symbol"], "BTCUSDT")
        self.assertEqual(payload["market_data_params"]["interval"], "1m")
        self.assertTrue(payload["market_data_params"]["include_intraday"])
        self.assertEqual(payload["market_data_params"]["payload_level"], "summary")
        self.assertEqual(payload["market_data_params"]["intraday_limit"], 500)

    def test_payload_forwards_v4_selection_and_realtime_controls(self) -> None:
        selection = {
            "include": ["quote.snapshot"],
            "fields": {
                "quote.snapshot": ["price", "quote_time", "provider"],
            },
            "max_response_bytes": 12_000,
        }
        payload = self.server._search_payload(
            {
                "query": "只要 2330 即時價",
                "target": {"type": "tw_stock", "id": "2330"},
                "intents": ["quote", "data_freshness"],
                "output": "evidence_only",
                "realtime_policy": "require_live",
                "selection": selection,
            }
        )

        self.assertEqual(payload["contract_version"], "omi.decision.v4")
        self.assertEqual(payload["intents"], ["quote", "data_freshness"])
        self.assertEqual(payload["output"], "evidence_only")
        self.assertEqual(payload["realtime_policy"], "require_live")
        self.assertEqual(payload["selection"], selection)

    def test_payload_preserves_nested_market_data_params_precedence(self) -> None:
        payload = self.server._search_payload(
            {
                "query": "KOSPI weekly evidence",
                "target": {"type": "kr_index", "id": "KOSPI"},
                "market_data_params": {
                    "payload_level": "standard",
                    "intraday_limit": 10,
                    "timeframe": "weekly",
                },
                "payload_level": "summary",
                "intraday_limit": 1,
            }
        )

        self.assertEqual(payload["target"], {"type": "kr_index", "id": "KOSPI"})
        self.assertEqual(payload["market_data_params"]["payload_level"], "standard")
        self.assertEqual(payload["market_data_params"]["intraday_limit"], 10)
        self.assertEqual(payload["market_data_params"]["timeframe"], "weekly")

    def test_payload_forwards_conversation_context(self) -> None:
        context = {
            "last_omi_resolution": {
                "target": {"type": "tw_stock", "id": "2330"},
            }
        }
        payload = self.server._search_payload(
            {
                "query": "那 ADR 呢？",
                "target": {"type": "auto"},
                "conversation_context": context,
            }
        )

        self.assertEqual(payload["conversation_context"], context)

    def test_tool_list_exposes_curated_read_only_surface(self) -> None:
        response = self.server._handle_request(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        )

        tools = response["result"]["tools"]
        tool_names = [tool["name"] for tool in tools]

        self.assertEqual(
            tool_names,
            [
                "omi.ask",
                "omi.read_market_overview",
                "omi.read_stock_context",
                "omi.read_data_freshness",
                "omi.read_source_health",
                "omi.read_capability_status",
            ],
        )
        self.assertNotIn("omi.search", tool_names)
        self.assertFalse(
            any(
                unsafe_term in name
                for name in tool_names
                for unsafe_term in ("write", "update", "archive", "save", "llm_report")
            )
        )

        ask_schema = tools[0]["inputSchema"]
        self.assertEqual(ask_schema["required"], ["question"])
        self.assertNotIn("query", ask_schema["properties"])
        self.assertIn("selection", ask_schema["properties"])
        self.assertEqual(
            ask_schema["properties"]["contract_version"]["enum"],
            ["omi.decision.v4"],
        )

    def test_legacy_omi_search_remains_callable_but_hidden(self) -> None:
        response = self.server._handle_request(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        )
        tool_names = [tool["name"] for tool in response["result"]["tools"]]
        self.assertNotIn("omi.search", tool_names)

        v4_response = {
            "kind": "omi_decision",
            "contract_version": "omi.decision.v4",
            "ok": True,
        }
        with patch.object(self.server, "_api_post", return_value=v4_response):
            result = self.server._call_tool("omi.search", {"query": "2330"})

        self.assertIs(result, v4_response)

    def test_public_shortcuts_map_to_canonical_v4_targets(self) -> None:
        market = self.server._market_overview_arguments({"market": "us"})
        stock = self.server._stock_context_arguments(
            {"market": "jp", "symbol": "7203"}
        )
        freshness = self.server._data_freshness_arguments({"market": "tw"})
        source_health = self.server._source_health_arguments(
            {
                "market": "tw",
                "provider": "twse",
                "problems_only": True,
                "limit": 25,
            }
        )
        capability = self.server._capability_status_arguments(
            {
                "capability_id": "quote.snapshot",
                "enabled_only": True,
                "include_children": False,
            }
        )

        self.assertEqual(market["target"], {"type": "market", "market": "us"})
        self.assertEqual(market["mode"], "data_only")
        self.assertEqual(
            stock["target"],
            {"type": "jp_stock", "id": "7203"},
        )
        self.assertEqual(
            freshness["target"],
            {"type": "data_freshness", "market": "tw"},
        )
        self.assertEqual(
            source_health["market_data_params"],
            {
                "market": "tw",
                "provider": "twse",
                "problems_only": True,
                "health_limit": 25,
            },
        )
        self.assertEqual(
            capability["target"],
            {"type": "capability_status", "id": "quote.snapshot"},
        )
        self.assertTrue(capability["enabled_only"])
        self.assertFalse(capability["include_children"])

    def test_public_shortcuts_still_force_read_only_payload_flags(self) -> None:
        cases = [
            self.server._market_overview_arguments({}),
            self.server._stock_context_arguments({"symbol": "2330"}),
            self.server._data_freshness_arguments({}),
            self.server._source_health_arguments({}),
            self.server._capability_status_arguments({}),
        ]

        for arguments in cases:
            with self.subTest(target=arguments["target"]):
                payload = self.server._search_payload(arguments)
                self.assertEqual(payload["contract_version"], "omi.decision.v4")
                self.assertEqual(payload["mode"], "data_only")
                self.assertFalse(payload["allow_llm"])
                self.assertFalse(payload["allow_write"])

    def test_compact_response_exposes_debug_request_flags(self) -> None:
        arguments = {
            "query": "TSM intraday",
            "symbol": "TSM",
            "refresh_if_missing": True,
            "analysis_horizon": "intraday",
        }
        payload = self.server._search_payload(arguments)

        compact = self.server._compact_search_response(
            arguments=arguments,
            payload=payload,
            response={"result": {}, "source_refs": []},
        )

        flags = compact["debug_request_flags"]
        self.assertEqual(flags["adapter"], "OMI_search")
        self.assertEqual(flags["route"], "POST /api/ai/ask")
        self.assertEqual(flags["route_hint"], "omi_evidence_context")
        self.assertEqual(flags["live_surface"], "none")
        self.assertTrue(flags["allow_external_fetch"])
        self.assertTrue(flags["refresh_if_missing"])
        self.assertEqual(flags["symbol"], "TSM")
        self.assertEqual(flags["analysis_horizon"], "intraday")
        self.assertEqual(flags["market_data_params"], {})

    def test_v4_response_is_forwarded_without_adapter_semantic_projection(self) -> None:
        arguments = {"query": "2330 brief", "stock_id": "2330"}
        payload = self.server._search_payload(arguments)
        response = {
            "kind": "omi_decision",
            "contract_version": "omi.decision.v4",
            "ok": True,
            "request_status": "completed",
            "answer": {"headline": "等待回測確認"},
            "decision": {"intent": "entry_decision"},
            "evidence": {"slots": {"quote": {"status": "ready"}}},
            "limitations": {"missing": [], "warnings": []},
            "status": {"readiness": {"decision_ready": True}},
        }

        projected = self.server._compact_search_response(
            arguments=arguments,
            payload=payload,
            response=response,
        )

        self.assertIs(projected, response)
        self.assertNotIn("debug_request_flags", projected)

    def test_search_returns_only_v4_backend_envelope(self) -> None:
        v4_response = {
            "kind": "omi_decision",
            "contract_version": "omi.decision.v4",
            "ok": True,
            "answer": {},
            "decision": {},
            "evidence": {},
        }
        with patch.object(self.server, "_api_post", return_value=v4_response):
            response = self.server._search({"query": "2330"})

        self.assertIs(response, v4_response)

        with patch.object(
            self.server,
            "_api_post",
            return_value={
                "kind": "omi_decision",
                "contract_version": "omi.decision.v3",
                "ok": True,
            },
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "non-v4 public ask response",
            ):
                self.server._search({"query": "2330"})

    def test_compact_response_trims_intraday_points_by_default(self) -> None:
        points = [{"time": f"t{i}", "price": i} for i in range(12)]
        response = {
            "analysis": {
                "compact_evidence": {
                    "quote": {"price": 12, "quote_time": "t11", "is_realtime": True},
                    "intraday_bars": {"series": {"1m": {"points": points}}},
                }
            },
            "result": {
                "data": {
                    "compact": {
                        "quote": {"price": 12, "quote_time": "t11", "is_realtime": True},
                        "intraday_bars": {"series": {"1m": {"points": points}}},
                    },
                    "result_view": {"mode": "data_only", "detail": "compact_core"},
                }
            },
            "tool_runs": [
                {
                    "tool": "us.read_intraday_trend",
                    "status": "success",
                    "result_summary": {"points": points, "latest_point": points[-1]},
                }
            ],
            "source_refs": [{"kind": "us_daily_price"}, {"type": "table", "name": "us_company_profile"}],
        }
        payload = self.server._search_payload(
            {"query": "TSM intraday", "symbol": "TSM", "refresh_if_missing": True}
        )

        compact = self.server._compact_search_response(
            arguments={"query": "TSM intraday", "symbol": "TSM"},
            payload=payload,
            response=response,
        )

        series_points = compact["result"]["data"]["intraday_bars"]["series"]["1m"]["points"]
        tool_points = compact["tool_runs"][0]["result_summary"]["points"]
        self.assertEqual(compact["live_surface"], "quote_intraday")
        self.assertEqual(compact["route_hint"], "us_stock_compact_live")
        self.assertEqual(compact["live_summary"]["quote_price"], 12)
        self.assertEqual(compact["live_summary"]["quote_time"], "t11")
        self.assertTrue(compact["live_summary"]["quote_is_realtime"])
        self.assertTrue(compact["live_summary"]["intraday_enabled"])
        self.assertEqual(compact["live_summary"]["intraday_latest"], "t11")
        self.assertEqual(compact["debug_request_flags"]["route_hint"], "us_stock_compact_live")
        self.assertEqual(compact["debug_request_flags"]["live_surface"], "quote_intraday")
        self.assertEqual(compact["source_refs"][0]["kind"], "us_daily_price")
        self.assertIn("background_evidence", compact["source_refs_role"])
        self.assertEqual(len(series_points), self.server.DEFAULT_POINTS_TAIL_LIMIT)
        self.assertEqual(series_points[0]["time"], "t4")
        self.assertEqual(len(tool_points), self.server.DEFAULT_POINTS_TAIL_LIMIT)
        self.assertEqual(compact["result_view"]["detail"], "compact_core")
        self.assertNotIn("analysis", compact)
        self.assertEqual(compact["compact_evidence_ref"], "result.data")
        self.assertNotIn("human_answer", compact["result"])
        self.assertNotIn("raw_response", compact)

    def test_compact_response_uses_backend_live_summary_for_txf(self) -> None:
        response = {
            "result": {
                "live_summary": {
                    "version": "market_live_summary.v1",
                    "status": "ready",
                    "target_type": "tw_futures",
                    "symbol": "TXF",
                    "quote_price": 43_481,
                    "quote_time": "2026-07-18T04:59:58+08:00",
                    "is_live": False,
                    "is_realtime": False,
                    "is_latest_session_quote": True,
                    "market_status": "closed",
                    "intraday_available": True,
                    "intraday_latest": "2026-07-18T05:00:00+08:00",
                    "intraday_latest_price": 43_481,
                    "intraday_point_count": 390,
                },
                "data": {
                    "compact": {
                        "target": {"type": "tw_futures", "id": "TXF"},
                        "quote": {"last_price": 43_481},
                        "intraday_chart": {
                            "point_count": 390,
                            "to_date": "2026-07-18T05:00:00+08:00",
                            "points": [
                                {"time": "2026-07-18T04:59:00+08:00", "close": 43_481}
                            ],
                        },
                    }
                },
            },
            "source_refs": [],
        }
        payload = self.server._search_payload({"query": "TXF latest", "symbol": "TXF"})

        compact = self.server._compact_search_response(
            arguments={"query": "TXF latest", "symbol": "TXF"},
            payload=payload,
            response=response,
        )

        self.assertEqual(compact["live_surface"], "quote_intraday")
        self.assertEqual(compact["live_summary"]["quote_price"], 43_481)
        self.assertFalse(compact["live_summary"]["is_live"])
        self.assertTrue(compact["live_summary"]["intraday_available"])
        self.assertEqual(compact["intraday_ref"], "result.data.intraday_chart")

    def test_tool_result_exposes_structured_content(self) -> None:
        payload = {"kind": "omi_search", "result": {"data": {"status": "ready"}}}

        tool_result = self.server._tool_result(payload)

        self.assertEqual(tool_result["structuredContent"], payload)
        self.assertEqual(json.loads(tool_result["content"][0]["text"]), payload)
        self.assertFalse(tool_result["isError"])

    def test_backend_business_failure_is_not_projected_as_success(self) -> None:
        payload = self.server._search_payload({"query": "精確查詢台股 9999", "symbol": "9999"})
        response = {
            "kind": "ai_ask",
            "ok": False,
            "answer_ready": False,
            "facts_ready": False,
            "analysis_ready": False,
            "decision_ready": False,
            "error": {"code": "TARGET_NOT_FOUND", "message": "找不到台股 9999"},
            "result": {"kind": "target_error"},
        }

        compact = self.server._compact_search_response(
            arguments={"query": "精確查詢台股 9999", "symbol": "9999"},
            payload=payload,
            response=response,
        )

        self.assertFalse(compact["ok"])
        self.assertEqual(compact["error"]["code"], "TARGET_NOT_FOUND")

    def test_business_failure_and_empty_success_are_transport_successes(self) -> None:
        failed = {
            "kind": "omi_search",
            "ok": False,
            "error": {"code": "TARGET_NOT_FOUND"},
        }
        with patch.object(self.server, "_call_tool", return_value=failed):
            failed_response = self.server._handle_request(
                {
                    "jsonrpc": "2.0",
                    "id": 9,
                    "method": "tools/call",
                    "params": {"name": "omi.search", "arguments": {"query": "9999"}},
                }
            )
        self.assertFalse(failed_response["result"]["isError"])
        self.assertEqual(
            failed_response["result"]["structuredContent"]["error"]["code"],
            "TARGET_NOT_FOUND",
        )

        empty_success = {"kind": "omi_search", "ok": True, "results": []}
        with patch.object(self.server, "_call_tool", return_value=empty_success):
            success_response = self.server._handle_request(
                {
                    "jsonrpc": "2.0",
                    "id": 10,
                    "method": "tools/call",
                    "params": {"name": "omi.search", "arguments": {"query": "empty"}},
                }
            )
        self.assertFalse(success_response["result"]["isError"])

    def test_compact_response_keeps_human_answer_without_raw_response(self) -> None:
        arguments = {"query": "TXF brief", "target": {"type": "tw_futures", "id": "TXF"}}
        payload = self.server._search_payload(arguments)
        response = {
            "analysis": {
                "human_answer": {
                    "summary": "夜盤 43,481；日 K 收盤 42,725。",
                    "sections": [],
                }
            },
            "result": {
                "kind": "tw_futures_context",
                "as_of": "2026-07-18T04:59:58+08:00",
                "data": {
                    "compact": {
                        "kind": "tw_futures_compact_evidence",
                        "quote": {"last_price": 43481},
                    }
                },
            },
        }

        compact = self.server._compact_search_response(
            arguments=arguments,
            payload=payload,
            response=response,
        )

        self.assertEqual(compact["result"]["human_answer"]["summary"], "夜盤 43,481；日 K 收盤 42,725。")
        self.assertEqual(compact["result"]["kind"], "tw_futures_context")
        self.assertEqual(compact["result"]["data"]["quote"]["last_price"], 43481)
        self.assertNotIn("raw_response", compact)


if __name__ == "__main__":
    unittest.main()
