"""Offline standard-library checks. Does not import MCP, backend, or providers."""
import ast
import hashlib
import json
from pathlib import Path
from workspace_transport_fixture import load_core
from runtime_control_fixture import load_source

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(r"C:\project\Open Market Intelligence\agents\omi_mcp_server\tw_market_dashboard_contract_snapshot.json")

for path in [ROOT / "server.py", ROOT / "http_server.py", *sorted((ROOT / "tests").glob("*.py"))]:
    ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
snapshot_bytes = (ROOT / "tw_market_dashboard_contract_snapshot.json").read_bytes()
assert snapshot_bytes == SOURCE.read_bytes(), "Generated snapshot differs from main OMI"
snapshot = json.loads(snapshot_bytes)
unsigned = {key: value for key, value in snapshot.items() if key != "digest"}
digest = hashlib.sha256(json.dumps(unsigned, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
assert digest == snapshot["digest"], "Snapshot digest invalid"
expected = {
    "omi.read_tw_workspace_header", "omi.read_tw_workspace_watchlist",
    "omi.read_tw_workspace_hot_groups", "omi.read_tw_stock_chart", "omi.read_tw_stock_research",
}
assert {tool["name"] for tool in snapshot["workspace_tools"]} == expected
for tool in snapshot["workspace_tools"]:
    assert tool["method"] == "GET"
    assert tool["path"].startswith("/api/market/tw-dashboard/")
    assert all("{" + key + "}" in tool["path"] for key in tool["path_parameters"])
    assert tool["inputSchema"]["additionalProperties"] is False
    for constants in load_core()._workspace_response_constants(tool["outputSchema"]):
        assert constants["cache_only"] is True
    assert tool["annotations"]["readOnlyHint"] is True
    assert tool["annotations"]["openWorldHint"] is False
research = next(tool for tool in snapshot["workspace_tools"] if tool["name"] == "omi.read_tw_stock_research")
assert research["inputSchema"]["properties"]["projection"]["default"] == "full"
assert research["inputSchema"]["properties"]["projection"]["pattern"] == "^(full|workspace)$"
assert len(research["outputSchema"]["anyOf"]) == 2
variants = load_core()._workspace_response_constants(research["outputSchema"])
assert {item["version"] for item in variants} == {"omi.tw_stock_research.v1", "omi.tw_stock_research.workspace.v1"}
assert next(item for item in variants if item["version"].endswith("workspace.v1"))["max_bytes"] == 131072
server_ast = ast.parse((ROOT / "server.py").read_text(encoding="utf-8"))
functions = {node.name: node for node in server_ast.body if isinstance(node, ast.FunctionDef)}
resources = next(node.value for node in ast.walk(functions["_tw_dashboard_resources_for_client"]) if isinstance(node, ast.Return))
assert isinstance(resources, ast.List) and len(resources.elts) == 2
legacy = next(node.value for node in ast.walk(functions["_build_tw_dashboard_tools"]) if isinstance(node, ast.Return) and isinstance(node.value, ast.List) and node.value.elts)
assert len(legacy.elts) == 4
public = next(node.value for node in ast.walk(functions["_build_public_tools"]) if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "tools" for target in node.targets))
assert len(public.elts) + len(legacy.elts) + len(expected) + 1 == 17
assert len(load_source().PUBLIC_TOOLS) == 20
print(f"AST OK; generated workspace contracts OK; static tool/resource counts 20/2 (17 original + 3 runtime); digest {digest}; byte parity OK")
