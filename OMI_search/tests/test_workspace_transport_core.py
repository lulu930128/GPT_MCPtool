"""Offline stdlib source-function regression; not SDK/host acceptance."""
from copy import deepcopy
import io
import json
from time import perf_counter
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError

from workspace_transport_fixture import SNAPSHOT, load_core, research_fixture, sample


class WorkspaceTransportCoreTests(unittest.TestCase):
    def setUp(self):
        self.core = load_core()
        self.namespace = self.core._api_request.__globals__

    def test_generated_progressive_catalog_and_read_only_annotations(self):
        catalog = {t["name"]: t for t in self.core._build_tw_workspace_tools()}
        self.assertEqual(len(catalog), 6)
        for route in SNAPSHOT["workspace_tools"]:
            tool = catalog[route["name"].replace(".", "_")]
            for key in ("inputSchema", "outputSchema", "annotations", "description"):
                self.assertEqual(tool[key], route[key])
            self.assertEqual(route["method"], "GET")
            for constants in self.core._workspace_response_constants(route["outputSchema"]):
                self.assertIs(constants["cache_only"], True)
            self.assertEqual(tool["annotations"], {
                "readOnlyHint": True, "destructiveHint": False,
                "idempotentHint": True, "openWorldHint": False,
            })
            self.assertNotIn("_meta", tool)

    def test_four_timeframes_complete_relay_and_large_serialization(self):
        for timeframe in ("today", "daily", "weekly", "monthly"):
            with self.subTest(timeframe=timeframe):
                expected = research_fixture(timeframe, large=timeframe == "monthly")
                before = deepcopy(expected)
                raw = json.dumps(expected, ensure_ascii=False, separators=(",", ":")).encode()
                if timeframe == "monthly":
                    self.assertGreaterEqual(len(raw), 10 * 1024 * 1024)
                response = io.BytesIO(raw)
                opened = Mock(return_value=response)
                started = perf_counter()
                with patch.dict(self.namespace, urlopen=opened):
                    actual = self.core._read_tw_workspace("omi_read_tw_stock_research", {"stock_id": "2330", "timeframe": timeframe})
                helper_ms = (perf_counter() - started) * 1000
                opened.assert_called_once()
                request = opened.call_args.args[0]
                self.assertEqual(request.full_url, f"http://127.0.0.1:8400/api/market/tw-dashboard/stocks/2330/research?timeframe={timeframe}")
                self.assertEqual(request.method, "GET")
                self.assertIsNone(request.data)
                self.assertEqual(opened.call_args.kwargs, {"timeout": 90})
                started = perf_counter()
                result = self.core._tool_result(actual)
                wire = json.dumps({"jsonrpc": "2.0", "id": 1, "result": result}, ensure_ascii=False, separators=(",", ":")).encode()
                serialize_ms = (perf_counter() - started) * 1000
                decoded = json.loads(wire)["result"]
                self.assertFalse(decoded["isError"])
                self.assertEqual(decoded["structuredContent"], before)
                self.assertEqual(json.loads(decoded["content"][0]["text"]), before)
                self.assertEqual(actual, before)
                self.assertEqual(expected, before)
                if timeframe == "monthly":
                    # Size regression: both complete representations must survive.
                    self.assertGreater(len(wire), 2 * len(raw))
                    print(json.dumps({"fixture_backend_bytes": len(raw), "fixture_mcp_json_bytes": len(wire), "helper_ms": round(helper_ms, 2), "serialize_ms": round(serialize_ms, 2), "sdk_or_host_acceptance": False}))

    def test_all_progressive_gets_preserve_every_backend_field(self):
        for route in SNAPSHOT["workspace_tools"]:
            expected = sample(route["outputSchema"])
            args = {"stock_id": "23/30 ?"} if route["path_parameters"] else {}
            read = Mock(return_value=expected)
            with patch.dict(self.namespace, _api_request=read):
                actual = self.core._read_tw_workspace(route["name"].replace(".", "_"), args)
            self.assertIs(actual, expected)
            read.assert_called_once_with("GET", route["path"].replace("{stock_id}", "23%2F30%20%3F"))
            self.assertEqual(json.loads(self.core._tool_result(actual)["content"][0]["text"]), expected)

    def test_failures_never_retry_or_invent_fallback(self):
        failures = [TimeoutError("synthetic timeout"), URLError("synthetic network"),
                    HTTPError("http://fixture", 503, "synthetic", {}, io.BytesIO(b"synthetic"))]
        for error in failures:
            with self.subTest(error=type(error).__name__):
                opened = Mock(side_effect=error)
                with patch.dict(self.namespace, urlopen=opened), self.assertRaises((RuntimeError, TimeoutError)):
                    self.core._read_tw_workspace("omi_read_tw_stock_research", {"stock_id": "2330", "timeframe": "monthly"})
                opened.assert_called_once()
        for raw in (b"not JSON", b'{"kind":"wrong"}'):
            opened = Mock(return_value=io.BytesIO(raw))
            with patch.dict(self.namespace, urlopen=opened), self.assertRaises(RuntimeError):
                self.core._read_tw_workspace("omi_read_tw_stock_research", {"stock_id": "2330"})
            opened.assert_called_once()
        opened = Mock()
        with patch.dict(self.namespace, urlopen=opened), self.assertRaises(ValueError):
            self.core._read_tw_workspace("omi_read_tw_stock_research", {"stock_id": "2330", "refresh": True})
        opened.assert_not_called()
        route = self.namespace["TW_WORKSPACE_ROUTES"]["omi_read_tw_stock_research"]
        with patch.dict(route, method="POST"), patch.dict(self.namespace, urlopen=opened), self.assertRaises(RuntimeError):
            self.core._read_tw_workspace("omi_read_tw_stock_research", {"stock_id": "2330"})
        opened.assert_not_called()


if __name__ == "__main__":
    unittest.main()
