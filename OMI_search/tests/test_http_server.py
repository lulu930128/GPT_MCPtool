from __future__ import annotations

from contextlib import asynccontextmanager
import json
import unittest
from unittest.mock import patch

from mcp import Client
from mcp.client.streamable_http import streamable_http_client
import httpx2

from http_server import (
    MAX_BODY_BYTES,
    MCP_ARCHITECTURE,
    MCP_SDK_VERSION,
    SOURCE_BUILD_ID,
    build_app,
)


TEST_PORT = 18798
TEST_BASE_URL = f"http://127.0.0.1:{TEST_PORT}"
MCP_HEADERS = {
    "Accept": "application/json, text/event-stream",
    "Content-Type": "application/json",
}


@asynccontextmanager
async def app_client(*, token: str | None = None):
    app = build_app(
        host="127.0.0.1",
        port=TEST_PORT,
        bearer_token=token,
    )
    async with (
        app.router.lifespan_context(app),
        httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=app),
            base_url=TEST_BASE_URL,
        ) as client,
    ):
        yield client


async def legacy_initialize(
    client: httpx2.AsyncClient,
    *,
    token: str | None = None,
):
    headers = dict(MCP_HEADERS)
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return await client.post(
        "/mcp",
        headers=headers,
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "omi-search-test", "version": "1"},
            },
        },
    )


class OmiSearchHttpServerTests(unittest.IsolatedAsyncioTestCase):
    async def test_health_endpoint(self) -> None:
        async with app_client() as client:
            response = await client.get("/health")

        body = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["service"], "omi-search-http-mcp")
        self.assertEqual(body["version"], "1.2.0")
        self.assertEqual(body["buildId"], SOURCE_BUILD_ID)
        self.assertRegex(body["buildId"], r"^[0-9a-f]{16}$")
        self.assertEqual(body["mcpSdk"], MCP_SDK_VERSION)
        self.assertEqual(body["mcpArchitecture"], MCP_ARCHITECTURE)
        self.assertEqual(body["toolCount"], 11)
        self.assertIn("/mcp", body["mcp_url"])

    async def test_upstream_health_ready_contract(self) -> None:
        async with app_client() as client:
            with patch(
                "http_server.omi_search_stdio._api_request",
                return_value={
                    "status": "ok",
                    "app_name": "Open Market Intelligence",
                    "private": "must-not-be-forwarded",
                },
            ) as request:
                response = await client.get("/upstream-health")

        self.assertEqual(
            response.json(),
            {
                "service": "omi-search-upstream",
                "ok": True,
                "status": "ready",
                "errorCode": None,
            },
        )
        request.assert_called_once_with(
            "GET", "/api/system/health", timeout_seconds=2
        )

    async def test_upstream_health_redacts_failures(self) -> None:
        async with app_client() as client:
            with patch(
                "http_server.omi_search_stdio._api_request",
                side_effect=TimeoutError("private backend URL and credential"),
            ):
                response = await client.get("/upstream-health")

        body = response.json()
        self.assertFalse(body["ok"])
        self.assertEqual(body["errorCode"], "UPSTREAM_UNAVAILABLE")
        self.assertNotIn("private", json.dumps(body))

    async def test_exact_2025_06_18_legacy_session_and_resources(self) -> None:
        async with app_client() as client:
            initialized = await legacy_initialize(client)
            session_id = initialized.headers.get("Mcp-Session-Id")

            self.assertEqual(initialized.status_code, 200)
            self.assertEqual(
                initialized.json()["result"]["protocolVersion"],
                "2025-06-18",
            )
            self.assertTrue(session_id)

            legacy_headers = {
                **MCP_HEADERS,
                "MCP-Protocol-Version": "2025-06-18",
                "Mcp-Session-Id": session_id or "",
            }
            acknowledged = await client.post(
                "/mcp",
                headers=legacy_headers,
                json={
                    "jsonrpc": "2.0",
                    "method": "notifications/initialized",
                },
            )
            tools = await client.post(
                "/mcp",
                headers=legacy_headers,
                json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            )
            resources = await client.post(
                "/mcp",
                headers=legacy_headers,
                json={"jsonrpc": "2.0", "id": 3, "method": "resources/list"},
            )
            resource_uri = resources.json()["result"]["resources"][0]["uri"]
            read = await client.post(
                "/mcp",
                headers=legacy_headers,
                json={
                    "jsonrpc": "2.0",
                    "id": 4,
                    "method": "resources/read",
                    "params": {"uri": resource_uri},
                },
            )

        self.assertIn(acknowledged.status_code, {200, 202})
        self.assertEqual(tools.status_code, 200)
        names = [tool["name"] for tool in tools.json()["result"]["tools"]]
        self.assertEqual(len(names), 11)
        self.assertNotIn("omi.search", names)
        self.assertEqual(read.status_code, 200)
        self.assertEqual(
            read.json()["result"]["contents"][0]["mimeType"],
            "text/html;profile=mcp-app",
        )

    async def test_modern_2026_07_28_sdk_client_is_sessionless(self) -> None:
        async with app_client() as http_client:
            transport = streamable_http_client(
                f"{TEST_BASE_URL}/mcp", http_client=http_client
            )
            async with Client(transport, mode="2026-07-28") as client:
                tools = await client.list_tools()
                resources = await client.list_resources()
                protocol_version = client.protocol_version

        self.assertEqual(protocol_version, "2026-07-28")
        self.assertEqual(len(tools.tools), 11)
        self.assertEqual(len(resources.resources), 1)

    async def test_refresh_status_result_semantics(self) -> None:
        backend_response = {
            "job_id": 52,
            "operation": {"status": "completed"},
            "evidence": {"status": "rebuild_required"},
        }
        async with app_client() as http_client:
            transport = streamable_http_client(
                f"{TEST_BASE_URL}/mcp", http_client=http_client
            )
            with patch(
                "http_server.omi_search_stdio._api_request",
                return_value=backend_response,
            ) as upstream:
                async with Client(transport, mode="2026-07-28") as client:
                    result = await client.call_tool(
                        "omi_read_refresh_status", {"job_id": 52}
                    )

        self.assertFalse(result.is_error)
        self.assertEqual(result.structured_content, backend_response)
        upstream.assert_any_call("GET", "/api/ai/refresh-status/52")
        self.assertEqual(
            sum(
                call.args == ("GET", "/api/ai/refresh-status/52")
                for call in upstream.call_args_list
            ),
            1,
        )

    async def test_optional_bearer_token(self) -> None:
        async with app_client(token="secret-token") as client:
            unauthorized = await legacy_initialize(client)
            authorized = await legacy_initialize(client, token="secret-token")

        self.assertEqual(unauthorized.status_code, 401)
        self.assertEqual(authorized.status_code, 200)
        self.assertEqual(
            authorized.json()["result"]["serverInfo"]["name"],
            "omi-search-mcp",
        )

    async def test_request_body_limit_is_enforced_by_sdk_transport(self) -> None:
        async with app_client() as client:
            response = await client.post(
                "/mcp",
                headers=MCP_HEADERS,
                content=b"x" * (MAX_BODY_BYTES + 1),
            )

        self.assertIn(response.status_code, {400, 413})


if __name__ == "__main__":
    unittest.main()
