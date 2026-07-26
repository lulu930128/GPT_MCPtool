from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass

import httpx
from mcp.server.fastmcp import FastMCP
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route

from memory_core.mcp.client import MemoryCoreApiClient
from memory_core.mcp.settings import McpSettings
from memory_core.mcp.tools import register_tools

SERVER_INSTRUCTIONS = (
    "Use search before fetch when an item id is unknown. Read tools never change data. "
    "Call the matching memory_propose_* tool only after the user explicitly asks to save, "
    "update, or archive something in Memory Core; proposal tools create pending candidates "
    "and cannot approve them. Before approval, "
    "show the exact candidate and review digest, prepare a short-lived review challenge, "
    "then call memory_approve_candidate only after a separate explicit user instruction "
    "to apply that exact candidate. Viewing, editing, summarizing, or creating a candidate "
    "is not approval. Never place secrets in Memory Core."
)


@dataclass(slots=True)
class MemoryCoreMcpRuntime:
    server: FastMCP
    api_client: MemoryCoreApiClient
    review_api_client: MemoryCoreApiClient | None


def build_runtime(
    settings: McpSettings,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> MemoryCoreMcpRuntime:
    api_client = MemoryCoreApiClient(settings, transport=transport)
    review_api_client = (
        MemoryCoreApiClient(
            settings,
            client_token=settings.review_client_token,
            transport=transport,
        )
        if settings.review_client_token is not None
        else None
    )
    server = FastMCP(
        name="memory-core-mcp",
        instructions=SERVER_INSTRUCTIONS,
        host=settings.host,
        port=settings.port,
        streamable_http_path="/mcp",
        json_response=True,
        stateless_http=True,
        log_level=settings.log_level,
    )
    register_tools(
        server,
        api_client,
        review_client=review_api_client,
        max_content_chars=settings.max_content_chars,
        expose_legacy_candidate_tool=settings.expose_legacy_candidate_tool,
    )
    return MemoryCoreMcpRuntime(
        server=server,
        api_client=api_client,
        review_api_client=review_api_client,
    )


def create_http_app(runtime: MemoryCoreMcpRuntime) -> Starlette:
    @asynccontextmanager
    async def lifespan(_app: Starlette) -> AsyncIterator[None]:
        try:
            async with runtime.server.session_manager.run():
                yield
        finally:
            await runtime.api_client.close()
            if runtime.review_api_client is not None:
                await runtime.review_api_client.close()

    async def health(_request: Request) -> JSONResponse:
        backend_ok = await runtime.api_client.health()
        return JSONResponse(
            {
                "status": "ok" if backend_ok else "degraded",
                "service": "memory-core-mcp",
                "backend": "ok" if backend_ok else "unavailable",
                "mcp_endpoint": "/mcp",
                "review_tools": "enabled" if runtime.review_api_client is not None else "disabled",
            },
            status_code=200 if backend_ok else 503,
        )

    return Starlette(
        routes=[
            Route("/health", health, methods=["GET"]),
            Mount("/", app=runtime.server.streamable_http_app()),
        ],
        lifespan=lifespan,
    )
