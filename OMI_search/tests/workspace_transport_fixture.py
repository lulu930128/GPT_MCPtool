"""Synthetic transport fixtures and isolated source loading; no runtime imports.

The stdlib harness executes selected *actual* server function ASTs. It does not
stand in for importing the application or for the MCP SDK protocol suite.
"""
import ast
from copy import deepcopy
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT = json.loads((ROOT / "tw_market_dashboard_contract_snapshot.json").read_bytes())


def load_core():
    names = {
        "_read_tw_workspace", "_api_request", "_tool_result", "_json_default",
        "_replace_surrogates", "_sanitize_json_value", "_build_tw_workspace_tools",
        "_read_only_annotations",
        "_workspace_response_constants",
    }
    source = ast.parse((ROOT / "server.py").read_text(encoding="utf-8"))
    functions = [node for node in source.body if isinstance(node, ast.FunctionDef) and node.name in names]
    assert {node.name for node in functions} == names
    namespace = dict(globals())
    # Constants are evaluated from source, never copied into a replacement adapter.
    wanted = {"SERVER_NAME", "SERVER_VERSION", "TW_WORKSPACE_RESOURCE_URI"}
    for node in source.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in wanted for t in node.targets):
            for target in node.targets:
                namespace[target.id] = ast.literal_eval(node.value)
    namespace.update(
        API_BASE_URL="http://127.0.0.1:8400", AI_TRUST_TOKEN="",
        AI_TRUST_TOKEN_HEADER="X-OMI-AI-Trust-Token", API_TIMEOUT_SECONDS=90,
        TW_WORKSPACE_ROUTES={t["name"].replace(".", "_"): deepcopy(t) for t in SNAPSHOT["workspace_tools"]},
        TW_WORKSPACE_SELECTION_SCHEMA={},
    )
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(ROOT / "server.py"), "exec"), namespace)
    return SimpleNamespace(**namespace)


def sample(schema):
    """Reuse the existing schema-driven fixture without importing its SDK tests."""
    tree = ast.parse((ROOT / "tests/test_workspace.py").read_text(encoding="utf-8"))
    function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "sample")
    namespace = {"deepcopy": deepcopy}
    exec(compile(ast.Module(body=[function], type_ignores=[]), "test_workspace.py", "exec"), namespace)
    return namespace["sample"](schema)


def research_fixture(timeframe, *, large=False):
    route = next(t for t in SNAPSHOT["workspace_tools"] if t["name"] == "omi.read_tw_stock_research")
    value = sample(route["outputSchema"])
    value.update(stock_id="2330", timeframe=timeframe)
    # Use a schema-owned string field, not a made-up projection or market truth.
    value["warnings"] = ["SYNTHETIC / no provider / 非市場資料", "BEGIN:" + ("界\\\"\n" * 1_200_000 if large else "small") + ":END"]
    value["technical"].update(
        stock_id="2330", timeframe=timeframe, status="partial", decision_usable=False,
        warnings=["SYNTHETIC nested warning"], missing=["SYNTHETIC missing evidence"],
        source_refs=[{"source": "synthetic-cache", "as_of": "2026-10-07T00:00:00Z"}],
        data={
            "freshness": {"status": "stale", "basis": "completed_session"},
            "quality": {"status": "partial", "coverage": 0, "usable": False},
            "source": {"name": "synthetic-cache", "fetched_at": "2026-10-07T00:00:00Z"},
            "limitations": ["SYNTHETIC unchanged limitation"],
            "unknown_future_field": {"preserve": [None, False, 0, "繁體中文"]},
        },
    )
    return value
