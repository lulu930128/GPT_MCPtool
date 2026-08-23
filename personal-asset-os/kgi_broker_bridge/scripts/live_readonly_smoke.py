from __future__ import annotations

import argparse
import asyncio
import json
import re
from typing import Any

from httpx import ASGITransport, AsyncClient

from kgi_broker_bridge.runtime import create_runtime_app
from kgi_broker_bridge.settings import Settings

OPAQUE_ACCOUNT_PATTERN = re.compile(r"^kgi_[0-9a-f]{24}$")


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run one redacted, read-only KGI positions qualification."
    )
    parser.add_argument(
        "--confirm-read-only",
        action="store_true",
        help="Confirm that one live KGI InventorySum(B) request is authorized.",
    )
    return parser.parse_args()


async def _run() -> dict[str, object]:
    settings = Settings()
    app = create_runtime_app(settings)
    transport = ASGITransport(app=app)
    headers = {
        "Authorization": f"Bearer {settings.api_token.get_secret_value()}",
    }

    async with AsyncClient(transport=transport, base_url="http://bridge.local") as client:
        health_before = await client.get("/api/health")
        positions = await client.get("/api/v1/positions", headers=headers)
        health_after = await client.get("/api/health")
        openapi = await client.get("/openapi.json")

    before_payload = health_before.json()
    after_payload = health_after.json()
    paths = set(openapi.json().get("paths", {}))

    if positions.status_code != 200:
        error_payload = positions.json()
        error = error_payload.get("error", {}) if isinstance(error_payload, dict) else {}
        error_code = error.get("code") if isinstance(error, dict) else None
        return {
            "ok": False,
            "http_status": positions.status_code,
            "error_code": error_code or "invalid_error_envelope",
            "health_before": before_payload.get("status"),
            "health_after": after_payload.get("status"),
            "read_only_routes_only": paths == {"/api/health", "/api/v1/positions"},
        }

    payload: dict[str, Any] = positions.json()
    account = payload.get("account", {})
    account = account if isinstance(account, dict) else {}
    opaque_id = str(account.get("opaque_id", ""))
    masked_label = str(account.get("masked_label", ""))
    position_rows = payload.get("positions", [])
    valuation_rows = payload.get("valuations", [])
    warnings = payload.get("warnings", [])

    return {
        "ok": True,
        "http_status": positions.status_code,
        "schema_version": payload.get("schema_version"),
        "snapshot_status": payload.get("status"),
        "position_count": len(position_rows) if isinstance(position_rows, list) else None,
        "valuation_count": len(valuation_rows) if isinstance(valuation_rows, list) else None,
        "captured_at": payload.get("captured_at"),
        "source_as_of": payload.get("source_as_of"),
        "warning_count": len(warnings) if isinstance(warnings, list) else None,
        "payload_hash_present": bool(payload.get("payload_hash")),
        "account_is_opaque": bool(OPAQUE_ACCOUNT_PATTERN.fullmatch(opaque_id)),
        "account_label_is_masked": masked_label.startswith("KGI ") and "•••" in masked_label,
        "health_before": before_payload.get("status"),
        "health_after": after_payload.get("status"),
        "health_login": after_payload.get("login"),
        "health_ca": after_payload.get("ca"),
        "health_account": after_payload.get("account"),
        "health_positions": after_payload.get("positions"),
        "package_version": after_payload.get("package_version"),
        "read_only_routes_only": paths == {"/api/health", "/api/v1/positions"},
    }


def main() -> int:
    arguments = _arguments()
    if not arguments.confirm_read_only:
        print(json.dumps({"ok": False, "error_code": "confirmation_required"}))
        return 2
    try:
        result = asyncio.run(_run())
    except BaseException as exc:
        result = {
            "ok": False,
            "error_code": "smoke_exception",
            "error_type": type(exc).__name__,
        }
    print(json.dumps(result, ensure_ascii=True, sort_keys=True))
    return 0 if result.get("ok") is True else 1


if __name__ == "__main__":
    raise SystemExit(main())
