"""Read actual Backend handler/context source into an isolated ASGI fixture.

Run explicitly with Backend's existing Python and --backend-root. No app.main
import, lifespan, real router, DB, SDK, environment file or network listener.
"""
import argparse
import ast
import asyncio
import hashlib
import json
import logging
from pathlib import Path
import runpy
import time
import uuid

from fastapi import FastAPI, HTTPException, Request, Response
from starlette.exceptions import HTTPException as StarletteHTTPException


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend-root", type=Path, required=True)
    args = parser.parse_args()
    backend = args.backend_root.resolve() / "backend/app"
    errors_path, main_path = backend / "errors.py", backend / "main.py"
    handler = runpy.run_path(str(errors_path))["http_exception_handler"]
    app = FastAPI()
    app.add_exception_handler(StarletteHTTPException, handler)
    # Compile only the real middleware function, including its decorator. Never
    # execute main's imports, admission, lifespan or production route wiring.
    source = main_path.read_text(encoding="utf-8-sig")
    context = next(node for node in ast.parse(source).body if isinstance(node, ast.AsyncFunctionDef) and node.name == "add_request_context")
    namespace = {"app": app, "Request": Request, "Response": Response, "uuid": uuid, "time": time,
                 "request_logger": logging.getLogger("synthetic-asgi")}
    exec(compile(ast.Module(body=[context], type_ignores=[]), str(main_path), "exec"), namespace)

    @app.post("/api/research/conditional-candidates/desk/staged/fixture-stage-3711/confirm")
    def synthetic_readiness_failure():
        raise HTTPException(503, detail={"code": "EXECUTOR_NOT_READY", "error_type": "ControlUnavailable",
            "retry_policy": "EXPLICIT_RETRY_SAME_STAGE", "submission_attempt": {
                "contract": "omi.execution.submission-attempt.v1", "outcome": "NOT_ATTEMPTED",
                "candidate_id": "fixture-stage-3711", "candidate_revision": 1, "candidate_digest": "b" * 64,
                "phase": "READINESS", "native_command_started": False}})

    async def invoke():
        messages, delivered, complete = [], False, asyncio.Event()

        async def receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": json.dumps({"expected_revision": 1, "expected_digest": "b" * 64}).encode(), "more_body": False}
            await complete.wait()
            return {"type": "http.disconnect"}

        async def send(message):
            messages.append(message)
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                complete.set()

        path = "/api/research/conditional-candidates/desk/staged/fixture-stage-3711/confirm"
        await app({"type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"}, "http_version": "1.1", "method": "POST",
                   "scheme": "http", "path": path, "raw_path": path.encode(), "root_path": "", "query_string": b"",
                   "headers": [(b"content-type", b"application/json"), (b"x-request-id", b"synthetic-asgi-request")],
                   "client": ("fixture", 1), "server": ("fixture", 80)}, receive, send)
        start = next(message for message in messages if message["type"] == "http.response.start")
        body = json.loads(b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body"))
        return start["status"], dict(start["headers"])[b"x-request-id"].decode(), body

    status, request_id, body = asyncio.run(invoke())
    assert status == 503
    assert body["error"]["request_id"] == request_id == "synthetic-asgi-request"
    print(json.dumps({"status": status, "body": body, "request_id": request_id,
                      "source_sha256": {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in (errors_path, main_path)}}, ensure_ascii=False))


if __name__ == "__main__":
    main()
