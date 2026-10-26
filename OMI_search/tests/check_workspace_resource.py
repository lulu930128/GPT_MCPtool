"""Bounded read-only local MCP check; no tools/call, restart or credentials."""
import hashlib
import json
from pathlib import Path
from time import perf_counter
from urllib.request import ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
BASE = "http://127.0.0.1:18797"
URI = "ui://omi/tw-workspace/v1.html"
opener = build_opener(ProxyHandler({}))
headers = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
request_id = 0


def request(method, params=None, *, notification=False):
    global request_id
    request_id += 1
    body = {"jsonrpc": "2.0", "method": method, "params": params or {}}
    if not notification:
        body["id"] = request_id
    started = perf_counter()
    with opener.open(Request(BASE + "/mcp", data=json.dumps(body).encode(), headers=headers), timeout=15) as response:
        raw = response.read()
        session = response.headers.get("Mcp-Session-Id")
        if session:
            headers["Mcp-Session-Id"] = session
        payload = json.loads(raw) if raw else {}
    assert "error" not in payload, f"{method}: MCP error"
    print(json.dumps({"method": method, "success": True, "elapsed_ms": round((perf_counter() - started) * 1000, 2)}))
    return payload.get("result", {})


def main():
    with opener.open(BASE + "/health", timeout=10) as response:
        health = json.load(response)
    print(json.dumps({"health": {key: health.get(key) for key in ("ok", "server", "version", "buildId", "mcpSdk")}}))
    initialized = request("initialize", {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "workspace-resource-read-check", "version": "1.0"}})
    headers["MCP-Protocol-Version"] = initialized["protocolVersion"]
    print(json.dumps({"protocolVersion": initialized["protocolVersion"]}))
    request("notifications/initialized", notification=True)
    resources = request("resources/list")["resources"]
    assert len(resources) == 2
    assert {item["uri"] for item in resources} == {URI, "ui://omi/tw-market-dashboard/v2.html"}
    tools = request("tools/list")["tools"]
    assert len(tools) == 20
    expected = {"omi_ask", "omi_read_refresh_status", "omi_read_market_overview", "omi_read_stock_context",
                "omi_read_data_freshness", "omi_read_source_health", "omi_read_capability_status",
                "omi_read_tw_market_dashboard", "omi_open_tw_market_dashboard", "omi_search_tw_symbols",
                "omi_read_tw_stock_dashboard_detail", "omi_read_tw_workspace_header", "omi_read_tw_workspace_watchlist",
                "omi_read_tw_workspace_hot_groups", "omi_read_tw_stock_chart", "omi_read_tw_stock_research", "omi_open_tw_workspace"}
    assert {item["name"] for item in tools} == expected
    snapshot = json.loads((ROOT / "tw_market_dashboard_contract_snapshot.json").read_text(encoding="utf-8"))
    for spec in snapshot["workspace_tools"]:
        tool = next(item for item in tools if item["name"] == spec["name"].replace(".", "_"))
        assert tool["annotations"]["readOnlyHint"] is True
        assert tool["inputSchema"] == spec["inputSchema"] and tool["outputSchema"] == spec["outputSchema"]
    contents = request("resources/read", {"uri": URI})["contents"]
    assert len(contents) == 1
    resource = contents[0]
    assert resource["uri"] == URI
    assert resource["mimeType"] == "text/html;profile=mcp-app"
    html = resource["text"]
    dist = (ROOT / "ui/tw-market-dashboard/dist/index.html").read_text(encoding="utf-8")
    expected = dist.replace('<html ', '<html data-omi-workspace="true" ', 1)
    assert html == expected, "Live resource differs from latest transformed dist"
    csp = resource["_meta"]["ui"]["csp"]
    assert csp["connectDomains"] == [] and csp["resourceDomains"] == []
    assert "workspace-market-cards" in html and "sidebar market market" in html
    assert "workspace-status-panel" in html and "workspace-technical-summary" in html
    dashboard = request("resources/read", {"uri": "ui://omi/tw-market-dashboard/v2.html"})["contents"][0]
    assert dashboard["text"] == dist, "Legacy dashboard differs from shared dist"
    assert dashboard["mimeType"] == "text/html;profile=mcp-app"
    assert dashboard["_meta"]["ui"]["csp"] == csp
    print(json.dumps({"tools": len(tools), "resources": len(resources), "transformed_dist_equal": True,
                      "resource_bytes": len(html.encode()), "resource_sha256": hashlib.sha256(html.encode()).hexdigest(),
                      "empty_csp_allowlists": True, "legacy_dist_equal": True}))


if __name__ == "__main__":
    main()
