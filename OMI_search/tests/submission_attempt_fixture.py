"""Synthetic HTTP error -> real registered MCP tool. No sockets/Backend/SDK/DB."""
from io import BytesIO
import json
from pathlib import Path
import sys
from unittest.mock import patch
from urllib.error import HTTPError

import anyio
from mcp import Client
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


PIN = {"id": "fixture-stage-3711", "expected_revision": 1, "expected_digest": "b" * 64}


def receipt_body(middleware=True):
    detail = {"error_type": "ControlUnavailable", "retry_policy": "EXPLICIT_RETRY_SAME_STAGE",
              "submission_attempt": {"contract": "omi.execution.submission-attempt.v1", "outcome": "NOT_ATTEMPTED",
                                     "candidate_id": PIN["id"], "candidate_revision": PIN["expected_revision"],
                                     "candidate_digest": PIN["expected_digest"], "phase": "READINESS", "native_command_started": False}}
    if middleware:
        return {"error": {"code": "EXECUTOR_NOT_READY", "message": "Request failed.", "request_id": "synthetic-request",
                          "detail": detail}}
    return {"detail": {"code": "EXECUTOR_NOT_READY", **detail}}


async def mcp_receipt(body=None, status=503):
    body = receipt_body() if body is None else body
    error = HTTPError("http://fixture.invalid", status, "synthetic", {}, BytesIO(json.dumps(body).encode()))
    with patch.object(server, "_tools_for_client", return_value=server.PUBLIC_TOOLS):
        async with Client(server.build_mcp_server(), mode="auto") as client:
            with patch.object(server, "urlopen", side_effect=error) as http:
                result = await client.call_tool("omi_confirm_desk_staged", PIN)
                http.assert_called_once()
                request = http.call_args.args[0]
                assert request.method == "POST"
                assert request.full_url.endswith("/api/research/conditional-candidates/desk/staged/fixture-stage-3711/confirm")
                assert json.loads(request.data) == {key: value for key, value in PIN.items() if key != "id"}
                return result.model_dump(mode="json", by_alias=True, exclude_none=True)


if __name__ == "__main__":
    body = json.load(sys.stdin) if sys.argv[1:] == ["--stdin"] else None
    print(json.dumps(anyio.run(mcp_receipt, body), ensure_ascii=False))
