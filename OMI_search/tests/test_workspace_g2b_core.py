"""Offline actual-source checks; synthetic payloads, no SDK/backend/provider IO."""
from copy import deepcopy
import io
import json
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError

from workspace_transport_fixture import SNAPSHOT, load_core, sample


def research_variant(projection, timeframe="daily"):
    schema = next(t for t in SNAPSHOT["workspace_tools"] if t["name"] == "omi.read_tw_stock_research")["outputSchema"]
    branch = next(branch for branch in schema["anyOf"]
                  if schema["$defs"][branch["$ref"].split("/")[-1]]["properties"]["version"]["const"]
                  == ("omi.tw_stock_research.workspace.v1" if projection == "workspace" else "omi.tw_stock_research.v1"))
    value = sample({**schema, "anyOf": [branch]})
    value.update(stock_id="2330", timeframe=timeframe,
                 warnings=["SYNTHETIC warning: \"完整\"\n" * 300, "END-warning"])
    value["technical"].update(
        stock_id="2330", timeframe=timeframe, status="partial", decision_usable=False,
        warnings=["nested warning"], missing=["missing evidence"],
        source_refs=[{"source": "SYNTHETIC-cache", "as_of": "2026-10-07T00:00:00Z"}],
        data={"quality": {"status": "partial", "usable": False},
              "freshness": {"status": "stale"}, "limitations": ["KEEP-limit"],
              "future_field": [None, False, 0, "繁體中文"]})
    if projection == "workspace":
        value["limitations"] = ["KEEP workspace limitation", "END-limit"]
        value["technical_summary"] = {
            "basis": "daily_background" if timeframe == "today" else "daily_indicator" if timeframe == "daily" else "indicator",
            "time": "2026-10-07", "close": 123.5, "change_pct": 0,
            "rsi": {"rsi14": 0}, "macd": {"macd": 0, "signal": 0, "histogram": 0},
            "kd": {"k9": 0, "d9": 0},
        }
    return value


class WorkspaceG2bCoreTests(unittest.TestCase):
    def setUp(self):
        self.core = load_core()
        self.namespace = self.core._read_tw_workspace.__globals__

    def test_union_variants_and_projection_queries_preserve_complete_results(self):
        for projection in (None, "full", "workspace"):
            for frame in ("today", "daily", "weekly", "monthly"):
                with self.subTest(projection=projection, frame=frame):
                    value = research_variant(projection, frame)
                    before = deepcopy(value)
                    args = {"stock_id": "2330", "timeframe": frame}
                    if projection is not None:
                        args["projection"] = projection
                    request = Mock(return_value=value)
                    with patch.dict(self.namespace, _api_request=request):
                        actual = self.core._read_tw_workspace("omi_read_tw_stock_research", args)
                    request.assert_called_once_with("GET", f"/api/market/tw-dashboard/stocks/2330/research?timeframe={frame}"
                                                    + (f"&projection={projection}" if projection else ""))
                    self.assertIs(actual, value)
                    result = self.core._tool_result(actual)
                    self.assertEqual(result["structuredContent"], before)
                    self.assertEqual(json.loads(result["content"][0]["text"]), before)
                    self.assertFalse(result["isError"])
                    self.assertEqual(value, before)

    def test_unknown_mixed_and_missing_envelope_constants_are_rejected(self):
        for projection in ("full", "workspace"):
            value = research_variant(projection)
            variants = self.core._workspace_response_constants(self.namespace["TW_WORKSPACE_ROUTES"]["omi_read_tw_stock_research"]["outputSchema"])
            constants = next(v for v in variants if v["version"] == value["version"])
            for key in constants:
                for bad in (None, "unknown", False, 1):
                    if type(bad) is type(constants[key]) and bad == constants[key]:
                        continue
                    changed = {**value, key: bad}
                    with self.subTest(projection=projection, key=key, bad=bad), patch.dict(self.namespace, _api_request=Mock(return_value=changed)):
                        with self.assertRaisesRegex(RuntimeError, "malformed"):
                            self.core._read_tw_workspace("omi_read_tw_stock_research", {"stock_id": "2330"})
                changed = {k: v for k, v in value.items() if k != key}
                with patch.dict(self.namespace, _api_request=Mock(return_value=changed)), self.assertRaises(RuntimeError):
                    self.core._read_tw_workspace("omi_read_tw_stock_research", {"stock_id": "2330"})

    def test_http_errors_preserve_complete_body_once_without_full_fallback(self):
        for status in (413, 422, 503):
            body = json.dumps({"detail": "SYNTHETIC: " + "限制" * 600, "warnings": ["END"], "limitations": ["KEEP"]}, ensure_ascii=False)
            error = HTTPError("http://fixture", status, "synthetic", {}, io.BytesIO(body.encode()))
            opened = Mock(side_effect=error)
            with patch.dict(self.namespace, urlopen=opened), self.assertRaises(RuntimeError) as raised:
                self.core._read_tw_workspace("omi_read_tw_stock_research", {"stock_id": "2330", "projection": "workspace"})
            self.assertEqual(str(raised.exception), f"OMI API HTTP {status}: {body}")
            opened.assert_called_once()
            self.assertTrue(opened.call_args.args[0].full_url.endswith("?projection=workspace"))

    def test_schema_identity_guard_fails_closed_without_fetching_refs(self):
        for schema in ({}, {"properties": {}}, {"$ref": "https://invalid/schema"},
                       {"$ref": "#/$defs/missing"}, {"$ref": "#/$defs/loop", "$defs": {"loop": {"$ref": "#/$defs/loop"}}}):
            with self.subTest(schema=schema), self.assertRaises(RuntimeError):
                self.core._workspace_response_constants(schema)


if __name__ == "__main__":
    unittest.main()
