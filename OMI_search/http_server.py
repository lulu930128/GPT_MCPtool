from __future__ import annotations

import argparse
import hashlib
import hmac
from importlib.metadata import version as package_version
import os
from pathlib import Path
import sys
from typing import Any

import anyio
from mcp.server.auth.provider import AccessToken, TokenVerifier
from mcp.server.auth.settings import AuthSettings
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
import uvicorn

import server as omi_search_stdio


SERVER_NAME = "omi-search-http-mcp"
SERVER_VERSION = omi_search_stdio.SERVER_VERSION
MCP_ARCHITECTURE = "official-python-sdk-v2"
MCP_SDK_VERSION = package_version("mcp")
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 18797
MAX_BODY_BYTES = 1_048_576
UPSTREAM_HEALTH_TIMEOUT_SECONDS = 2
SOURCE_BUILD_FILES = (
    Path(__file__).resolve(),
    Path(omi_search_stdio.__file__).resolve(),
    Path(__file__).resolve().with_name("pyproject.toml"),
    Path(__file__).resolve().with_name("uv.lock"),
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


def _loopback_host(host: str) -> bool:
    return host in {"127.0.0.1", "localhost", "::1", "[::1]"}


def _display_host(host: str) -> str:
    return f"[{host}]" if ":" in host and not host.startswith("[") else host


def _upstream_health_document() -> dict[str, Any]:
    base = {"service": "omi-search-upstream"}
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


class StaticBearerTokenVerifier(TokenVerifier):
    """Preserve the optional local shared bearer boundary without logging it."""

    def __init__(self, expected_token: str) -> None:
        self._expected_token = expected_token

    async def verify_token(self, token: str) -> AccessToken | None:
        if not hmac.compare_digest(token, self._expected_token):
            return None
        return AccessToken(
            token=token,
            client_id="omi-search-static-token",
            scopes=[],
        )


def _health_document(*, host: str, port: int) -> dict[str, Any]:
    return {
        "ok": True,
        "service": SERVER_NAME,
        "version": SERVER_VERSION,
        "buildId": SOURCE_BUILD_ID,
        "mcpSdk": MCP_SDK_VERSION,
        "mcpArchitecture": MCP_ARCHITECTURE,
        "toolCount": len(omi_search_stdio.PUBLIC_TOOLS),
        "mcp_url": f"http://{_display_host(host)}:{port}/mcp",
        # Retained for the existing Control Center summary contract. The value
        # is launcher-selected loopback state, never a credential or public URL.
        "omi_api_base_url": omi_search_stdio.API_BASE_URL,
    }


def build_app(
    *,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    bearer_token: str | None = None,
):
    if not _loopback_host(host):
        raise ValueError("OMI Search MCP HTTP host must be loopback.")

    async def health(_request: Request) -> JSONResponse:
        return JSONResponse(_health_document(host=host, port=port))

    async def upstream_health(_request: Request) -> JSONResponse:
        return JSONResponse(
            await anyio.to_thread.run_sync(_upstream_health_document)
        )

    mcp_server = omi_search_stdio.build_mcp_server()
    verifier = StaticBearerTokenVerifier(bearer_token) if bearer_token else None
    auth = (
        AuthSettings(
            issuer_url=f"http://{_display_host(host)}:{port}",
            resource_server_url=f"http://{_display_host(host)}:{port}/mcp",
            required_scopes=[],
        )
        if verifier
        else None
    )
    return mcp_server.streamable_http_app(
        streamable_http_path="/mcp",
        json_response=True,
        stateless_http=False,
        max_request_body_size=MAX_BODY_BYTES,
        host=host,
        auth=auth,
        token_verifier=verifier,
        custom_starlette_routes=[
            Route("/health", health, methods=["GET"]),
            Route("/upstream-health", upstream_health, methods=["GET"]),
        ],
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run OMI Search with the official MCP Streamable HTTP transport."
    )
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
        help=(
            "Optional Bearer token for /mcp. Leave empty only behind "
            "Secure MCP Tunnel or trusted localhost."
        ),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not _loopback_host(args.host):
        print("OMI Search MCP HTTP host must be loopback.", file=sys.stderr)
        return 2
    app = build_app(
        host=args.host,
        port=args.port,
        bearer_token=args.token or None,
    )
    print(
        f"OMI Search MCP HTTP listening at "
        f"http://{_display_host(args.host)}:{args.port}/mcp",
        file=sys.stderr,
    )
    if not args.token:
        print(
            "WARNING: OMI_SEARCH_MCP_HTTP_TOKEN is not set. Use only behind "
            "Secure MCP Tunnel or trusted localhost.",
            file=sys.stderr,
        )
    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        log_level="warning",
        access_log=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
