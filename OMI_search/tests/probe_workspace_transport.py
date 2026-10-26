"""Opt-in loopback cache-only research probe. Prints metrics, never payloads.

Default: health, negotiated MCP catalog and resource parity only.
--research: exactly one direct GET, source helper GET and local tools/call.
No host gateway, credentials, provider, retries, persistence or lifecycle calls.
Uses stdlib JSON-RPC against the running SDK; it is not an SDK client test.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from time import perf_counter
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, Request, build_opener

from workspace_transport_fixture import ROOT, SNAPSHOT, load_core

BASE = "http://127.0.0.1:18797"
OPENER = build_opener(ProxyHandler({}))


def emit(**values):
    print(json.dumps(values, ensure_ascii=True), flush=True)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def get(url):
    started = perf_counter()
    with OPENER.open(url, timeout=45) as response:
        raw = response.read()
        metrics = {"http_status": response.status, "wire_bytes": len(raw), "elapsed_ms": round((perf_counter() - started) * 1000, 2)}
    return json.loads(raw), metrics


class Session:
    def __init__(self):
        self.headers = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
        self.counter = 0

    def call(self, method, params=None, notification=False):
        self.counter += 1
        params = dict(params or {})
        headers = dict(self.headers)
        if headers.get("MCP-Protocol-Version") == "2026-07-28":
            # Mirrors installed SDK client/session.py::_make_modern_stamp.
            params["_meta"] = {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": {"name": "omi-bounded-transport-probe", "version": "1"},
                "io.modelcontextprotocol/clientCapabilities": {},
            }
            headers["Mcp-Method"] = method
            if method in {"tools/call", "resources/read"}:
                headers["Mcp-Name"] = params["name" if method == "tools/call" else "uri"]
        body = {"jsonrpc": "2.0", "method": method, "params": params}
        if not notification:
            body["id"] = self.counter
        started = perf_counter()
        with OPENER.open(Request(BASE + "/mcp", data=encoded(body), headers=headers), timeout=45) as response:
            raw = response.read()
            if response.headers.get("Mcp-Session-Id"):
                self.headers["Mcp-Session-Id"] = response.headers["Mcp-Session-Id"]
            metrics = {"method": method, "http_status": response.status, "wire_bytes": len(raw), "elapsed_ms": round((perf_counter() - started) * 1000, 2)}
            content_type = response.headers.get("Content-Type", "")
        if "text/event-stream" in content_type and raw:
            messages = [json.loads(line[5:].strip()) for line in raw.decode().splitlines() if line.startswith("data:")]
            payload = next(item for item in messages if item.get("id") == self.counter)
        else:
            payload = json.loads(raw) if raw else {}
        if "error" in payload:
            emit(**metrics, success=False, error_code=payload["error"].get("code"))
            raise RuntimeError("MCP JSON-RPC failure; payload withheld")
        result = payload.get("result", {})
        emit(**metrics, success=not result.get("isError", False))
        return result

    def initialize(self, requested):
        initialized = self.call("initialize", {"protocolVersion": requested, "capabilities": {}, "clientInfo": {"name": "omi-bounded-transport-probe", "version": "1"}})
        self.headers["MCP-Protocol-Version"] = initialized["protocolVersion"]
        emit(requested_protocol=requested, negotiated_protocol=initialized["protocolVersion"], session_present="Mcp-Session-Id" in self.headers)
        self.call("notifications/initialized", notification=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--research", action="store_true")
    options = parser.parse_args()
    emit(observed_at=datetime.now(timezone.utc).isoformat())
    health, metrics = get(BASE + "/health")
    assert health["ok"] and health["service"] == "omi-search-http-mcp"
    backend = health["omi_api_base_url"]
    parsed = urlsplit(backend)
    assert parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost"} and not parsed.username and not parsed.password
    emit(layer="adapter_health", **metrics, **{key: health.get(key) for key in ("version", "buildId", "mcpSdk", "mcpArchitecture", "toolCount")})
    backend_health, metrics = get(backend + "/api/system/health")
    assert backend_health.get("status") == "ok" and backend_health.get("app_name") == "Open Market Intelligence"
    runtime = backend_health.get("runtime", {})
    emit(layer="backend_identity", **metrics, **{key: runtime.get(key) for key in ("project_root", "python_executable", "python_version")})
    files = ["http_server.py", "server.py", "pyproject.toml", "uv.lock", "public_contract_snapshot.json", "tw_market_dashboard_contract_snapshot.json", "ui/tw-market-dashboard/dist/index.html"]
    digest = hashlib.sha256("".join(hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in files).encode()).hexdigest()[:16]
    emit(source_build_id=digest, runtime_build_id=health["buildId"], source_runtime_build_equal=digest == health["buildId"], snapshot_digest=SNAPSHOT["digest"])
    # SDK 2.1.1's current protocol is sessionless; the two legacy modes initialize.
    current = Session()
    current.headers["MCP-Protocol-Version"] = "2026-07-28"
    emit(requested_protocol="2026-07-28", mode="sessionless", sdk_client=False)
    current.call("server/discover")
    for requested, session in (("2026-07-28", current), ("2025-11-25", Session()), ("2025-06-18", Session())):
        if session is not current:
            session.initialize(requested)
        resources = session.call("resources/list")["resources"]
        assert len(resources) == 2
        dist = (ROOT / "ui/tw-market-dashboard/dist/index.html").read_text(encoding="utf-8")
        for resource in resources:
            actual = session.call("resources/read", {"uri": resource["uri"]})["contents"][0]
            workspace = resource["uri"] == "ui://omi/tw-workspace/v1.html"
            expected = dist.replace('<html ', '<html data-omi-workspace="true" ', 1) if workspace else dist
            assert actual["text"] == expected
            assert actual["mimeType"] == "text/html;profile=mcp-app"
            assert actual["_meta"]["ui"]["csp"]["connectDomains"] == []
        tools = session.call("tools/list")["tools"]
        assert len(tools) == 20
        for source in SNAPSHOT["workspace_tools"]:
            actual = next(t for t in tools if t["name"] == source["name"].replace(".", "_"))
            for key in ("inputSchema", "outputSchema", "annotations"):
                assert actual[key] == source[key]
        opened = session.call("tools/call", {"name": "omi_open_tw_workspace", "arguments": {}})
        assert not opened.get("isError")
        emit(catalog_parity=True, resource_parity=True, tools=20, resources=2)
    if not options.research:
        return
    path = "/api/market/tw-dashboard/stocks/2330/research?timeframe=monthly"
    direct, metrics = get(backend + path)
    assert direct.get("cache_only") is True
    emit(layer="backend_monthly", **metrics, structured_json_bytes=len(encoded(direct)))
    del direct
    core = load_core()
    namespace = core._api_request.__globals__
    namespace.update(API_BASE_URL=backend)
    # Preserve the helper's normal urlopen/proxy behavior; only impose this probe's deadline.
    started = perf_counter()
    helper = core._api_request("GET", path, timeout_seconds=45)
    helper_ms = (perf_counter() - started) * 1000
    started = perf_counter()
    result = core._tool_result(helper)
    envelope = encoded({"jsonrpc": "2.0", "id": 1, "result": result})
    serialize_ms = (perf_counter() - started) * 1000
    assert result["structuredContent"] == helper == json.loads(result["content"][0]["text"])
    emit(layer="source_helper_monthly", elapsed_ms=round(helper_ms, 2), serialization_ms=round(serialize_ms, 2), structured_json_bytes=len(encoded(helper)), mcp_json_bytes=len(envelope), complete_dual_representation=True, actual_sdk_serialization=False)
    del helper, result, envelope
    live = current.call("tools/call", {"name": "omi_read_tw_stock_research", "arguments": {"stock_id": "2330", "timeframe": "monthly"}})
    assert live.get("isError") is False
    assert live["structuredContent"]["cache_only"] is True
    assert json.loads(live["content"][0]["text"]) == live["structuredContent"]
    emit(layer="local_mcp_monthly", structured_json_bytes=len(encoded(live["structuredContent"])), text_utf8_bytes=len(live["content"][0]["text"].encode()), complete_dual_representation=True, host_acceptance="UNVERIFIED")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Backend HTTP errors can contain market data: only report exception type.
        emit(success=False, error_type=type(error).__name__, http_status=error.code if isinstance(error, HTTPError) else None, detail="Probe stopped without retry; payload withheld")
        raise SystemExit(1)
