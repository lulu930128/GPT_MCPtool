from __future__ import annotations

import json
from threading import Thread
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from http_server import OmiSearchHttpHandler, OmiSearchHttpServer


def request_json(
    url: str,
    payload: dict | None = None,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
) -> tuple[int, dict, dict[str, str]]:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request_headers = {"Content-Type": "application/json", **(headers or {})}
    request = Request(url, data=data, headers=request_headers, method=method)
    try:
        with urlopen(request, timeout=5) as response:
            body = response.read().decode("utf-8")
            parsed = json.loads(body) if body else {}
            return response.status, parsed, dict(response.headers.items())
    except HTTPError as exc:
        body = exc.read().decode("utf-8")
        parsed = json.loads(body) if body else {}
        return exc.code, parsed, dict(exc.headers.items())


class HttpServerHandle:
    def __init__(self, token: str | None = None) -> None:
        self.server = OmiSearchHttpServer(
            ("127.0.0.1", 0),
            OmiSearchHttpHandler,
            bearer_token=token,
        )
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class OmiSearchHttpServerTests(unittest.TestCase):
    def test_health_endpoint(self) -> None:
        handle = HttpServerHandle()
        try:
            status, body, _headers = request_json(f"{handle.base_url}/health")

            self.assertEqual(status, 200)
            self.assertTrue(body["ok"])
            self.assertEqual(body["service"], "omi-search-http-mcp")
            self.assertIn("/mcp", body["mcp_url"])
        finally:
            handle.close()

    def test_initialize_and_tools_list_with_session(self) -> None:
        handle = HttpServerHandle()
        try:
            init_status, init_body, init_headers = request_json(
                f"{handle.base_url}/mcp",
                {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
                method="POST",
            )
            session_id = init_headers.get("Mcp-Session-Id")

            self.assertEqual(init_status, 200)
            self.assertEqual(init_body["result"]["serverInfo"]["name"], "omi-search-mcp")
            self.assertTrue(session_id)

            tools_status, tools_body, _tools_headers = request_json(
                f"{handle.base_url}/mcp",
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                method="POST",
                headers={"Mcp-Session-Id": session_id or ""},
            )

            self.assertEqual(tools_status, 200)
            self.assertEqual(
                [tool["name"] for tool in tools_body["result"]["tools"]],
                [
                    "omi.ask",
                    "omi.read_market_overview",
                    "omi.read_stock_context",
                    "omi.read_data_freshness",
                    "omi.read_source_health",
                    "omi.read_capability_status",
                ],
            )
        finally:
            handle.close()

    def test_rejects_non_initialize_without_session(self) -> None:
        handle = HttpServerHandle()
        try:
            status, body, _headers = request_json(
                f"{handle.base_url}/mcp",
                {"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                method="POST",
            )

            self.assertEqual(status, 400)
            self.assertEqual(body["error"]["code"], -32000)
        finally:
            handle.close()

    def test_optional_bearer_token(self) -> None:
        handle = HttpServerHandle(token="secret-token")
        try:
            unauthorized_status, _body, _headers = request_json(
                f"{handle.base_url}/mcp",
                {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
                method="POST",
            )
            self.assertEqual(unauthorized_status, 401)

            authorized_status, authorized_body, _authorized_headers = request_json(
                f"{handle.base_url}/mcp",
                {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
                method="POST",
                headers={"Authorization": "Bearer secret-token"},
            )
            self.assertEqual(authorized_status, 200)
            self.assertEqual(authorized_body["result"]["serverInfo"]["name"], "omi-search-mcp")
        finally:
            handle.close()


if __name__ == "__main__":
    unittest.main()
