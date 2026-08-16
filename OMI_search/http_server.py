from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from uuid import uuid4

import server as omi_search_stdio


SERVER_NAME = "omi-search-http-mcp"
SERVER_VERSION = "1.1.0"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 18797
MAX_BODY_BYTES = 1_048_576
UPSTREAM_HEALTH_TIMEOUT_SECONDS = 2
SOURCE_BUILD_FILES = (
    Path(__file__).resolve(),
    Path(omi_search_stdio.__file__).resolve(),
    Path(__file__).resolve().with_name("public_contract_snapshot.json"),
    Path(__file__).resolve().with_name(
        "tw_market_dashboard_contract_snapshot.json"
    ),
    (
        Path(__file__).resolve().parent
        / "ui"
        / "tw-market-dashboard"
        / "dist"
        / "index.html"
    ),
)


def _source_build_id() -> str:
    artifact_hashes: list[str] = []
    for path in SOURCE_BUILD_FILES:
        if not path.is_file():
            return ""
        artifact_hashes.append(hashlib.sha256(path.read_bytes()).hexdigest())
    combined = "".join(artifact_hashes).encode("utf-8")
    return hashlib.sha256(combined).hexdigest()[:16]


SOURCE_BUILD_ID = _source_build_id()


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, default=str).encode("utf-8")


def _single_header(headers: Any, name: str) -> str | None:
    value = headers.get(name)
    if value is None:
        return None
    return str(value)


def _authorized(headers: Any, bearer_token: str | None) -> bool:
    if not bearer_token:
        return True
    authorization = _single_header(headers, "Authorization") or ""
    prefix = "Bearer "
    if not authorization.startswith(prefix):
        return False
    candidate = authorization[len(prefix) :].strip()
    return hmac.compare_digest(candidate, bearer_token)


def _upstream_health_document() -> dict[str, Any]:
    base = {
        "service": "omi-search-upstream",
    }
    try:
        payload = omi_search_stdio._api_request(
            "GET",
            "/api/system/health",
            timeout_seconds=UPSTREAM_HEALTH_TIMEOUT_SECONDS,
        )
    except Exception:
        return {
            **base,
            "ok": False,
            "status": "unavailable",
            "errorCode": "UPSTREAM_UNAVAILABLE",
        }

    if (
        not isinstance(payload, dict)
        or payload.get("status") != "ok"
        or payload.get("app_name") != "Open Market Intelligence"
    ):
        return {
            **base,
            "ok": False,
            "status": "unavailable",
            "errorCode": "UPSTREAM_CONTRACT_MISMATCH",
        }

    return {
        **base,
        "ok": True,
        "status": "ready",
        "errorCode": None,
    }


class OmiSearchHttpServer(ThreadingHTTPServer):
    allow_reuse_address = True

    def __init__(
        self,
        server_address: tuple[str, int],
        RequestHandlerClass: type[BaseHTTPRequestHandler],
        *,
        bearer_token: str | None = None,
    ) -> None:
        super().__init__(server_address, RequestHandlerClass)
        self.bearer_token = bearer_token
        self.sessions: set[str] = set()


class OmiSearchHttpHandler(BaseHTTPRequestHandler):
    server: OmiSearchHttpServer
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        if self.path_without_query == "/health":
            self.send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "service": SERVER_NAME,
                    "version": SERVER_VERSION,
                    "buildId": SOURCE_BUILD_ID,
                    "mcp_url": f"http://{self.server.server_address[0]}:{self.server.server_address[1]}/mcp",
                    "omi_api_base_url": omi_search_stdio.API_BASE_URL,
                },
            )
            return

        if self.path_without_query == "/upstream-health":
            self.send_json(HTTPStatus.OK, _upstream_health_document())
            return

        if self.path_without_query == "/mcp":
            self.send_json_rpc_error(
                HTTPStatus.METHOD_NOT_ALLOWED,
                -32000,
                "GET event streams are not used by this adapter. Send JSON-RPC requests with POST.",
            )
            return

        self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Not found."})

    def do_DELETE(self) -> None:
        if self.path_without_query != "/mcp":
            self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Not found."})
            return
        if not self.is_authorized():
            return
        session_id = self.header("Mcp-Session-Id")
        if session_id:
            self.server.sessions.discard(session_id)
        self.send_json(HTTPStatus.ACCEPTED, {"ok": True})

    def do_POST(self) -> None:
        if self.path_without_query != "/mcp":
            self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Not found."})
            return
        if not self.is_authorized():
            return

        try:
            message = self.read_json_body()
        except ValueError as exc:
            self.send_json_rpc_error(HTTPStatus.BAD_REQUEST, -32700, str(exc))
            return

        if not isinstance(message, dict):
            self.send_json_rpc_error(HTTPStatus.BAD_REQUEST, -32600, "JSON-RPC request must be an object.")
            return

        method = str(message.get("method") or "")
        request_id = message.get("id")
        incoming_session_id = self.header("Mcp-Session-Id")
        response_session_id: str | None = None

        if method == "initialize":
            response_session_id = incoming_session_id or uuid4().hex
            self.server.sessions.add(response_session_id)
        elif incoming_session_id and incoming_session_id in self.server.sessions:
            response_session_id = incoming_session_id
        elif incoming_session_id and method == "notifications/initialized":
            self.server.sessions.add(incoming_session_id)
            response_session_id = incoming_session_id
        elif not incoming_session_id and method != "initialize":
            self.send_json_rpc_error(
                HTTPStatus.BAD_REQUEST,
                -32000,
                "Bad Request: no valid MCP session ID provided.",
                request_id=request_id,
            )
            return

        response = omi_search_stdio._handle_request(message)
        if response is None:
            self.send_empty(HTTPStatus.ACCEPTED, session_id=response_session_id)
            return

        self.send_json(HTTPStatus.OK, response, session_id=response_session_id)

    @property
    def path_without_query(self) -> str:
        return self.path.split("?", 1)[0]

    def header(self, name: str) -> str | None:
        return _single_header(self.headers, name)

    def is_authorized(self) -> bool:
        if _authorized(self.headers, self.server.bearer_token):
            return True
        self.send_response(HTTPStatus.UNAUTHORIZED)
        self.send_header("WWW-Authenticate", "Bearer")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers_with_body(_json_bytes({"ok": False, "error": "Unauthorized."}))
        return False

    def read_json_body(self) -> Any:
        raw_length = self.header("Content-Length")
        if raw_length is None:
            raise ValueError("Missing Content-Length.")
        try:
            length = int(raw_length)
        except ValueError as exc:
            raise ValueError("Invalid Content-Length.") from exc
        if length < 0 or length > MAX_BODY_BYTES:
            raise ValueError("Request body is too large.")
        body = self.rfile.read(length)
        if not body:
            return None
        try:
            return json.loads(body.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError(f"Parse error: {exc}") from exc

    def send_json(
        self,
        status: int,
        body: Any,
        *,
        session_id: str | None = None,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        if session_id:
            self.send_header("Mcp-Session-Id", session_id)
        self.end_headers_with_body(_json_bytes(body))

    def send_json_rpc_error(
        self,
        status: int,
        code: int,
        message: str,
        *,
        request_id: Any | None = None,
    ) -> None:
        self.send_json(
            status,
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": code, "message": message},
            },
        )

    def send_empty(self, status: int, *, session_id: str | None = None) -> None:
        self.send_response(status)
        if session_id:
            self.send_header("Mcp-Session-Id", session_id)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def end_headers_with_body(self, body: bytes) -> None:
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write(f"{self.address_string()} - {format % args}\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run OMI Search MCP over Streamable HTTP-compatible POST endpoint.")
    parser.add_argument(
        "--host",
        default=os.environ.get("OMI_SEARCH_MCP_HTTP_HOST", DEFAULT_HOST),
    )
    parser.add_argument(
        "--port",
        type=int,
        default=_env_int("OMI_SEARCH_MCP_HTTP_PORT", DEFAULT_PORT),
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("OMI_SEARCH_MCP_HTTP_TOKEN", "").strip(),
        help="Optional Bearer token for /mcp. Leave empty only behind Secure MCP Tunnel or trusted localhost.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    httpd = OmiSearchHttpServer(
        (args.host, args.port),
        OmiSearchHttpHandler,
        bearer_token=args.token or None,
    )
    host, port = httpd.server_address
    print(f"OMI Search MCP HTTP listening at http://{host}:{port}/mcp", file=sys.stderr)
    if not args.token:
        print(
            "WARNING: OMI_SEARCH_MCP_HTTP_TOKEN is not set. Use only behind Secure MCP Tunnel or trusted localhost.",
            file=sys.stderr,
        )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
