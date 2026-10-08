from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from decimal import Decimal
from pathlib import Path
from typing import Any, cast

import httpx

from personal_asset_os.settings import Settings


def database_counts(path: Path) -> dict[str, int]:
    connection = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    try:
        tables = [
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            )
        ]
        return {
            table: int(connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
            for table in tables
        }
    finally:
        connection.close()


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def database_content_hash(path: Path) -> str:
    """Include committed WAL contents; never print financial rows or SQL."""
    connection = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    try:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        digest = hashlib.sha256()
        for statement in connection.iterdump():
            digest.update(statement.encode("utf-8"))
            digest.update(b"\n")
        return digest.hexdigest()
    finally:
        connection.close()


def require_mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RuntimeError(f"{label} is not an object")
    return cast(dict[str, Any], value)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database-fingerprint", action="store_true")
    parser.add_argument("--base-url", default="http://127.0.0.1:18876")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    settings = Settings()
    if not settings.database_path.is_file():
        raise SystemExit("PAOS database is missing")
    before_counts = database_counts(settings.database_path)
    before_hash = file_hash(settings.database_path)
    before_content_hash = database_content_hash(settings.database_path)
    if args.database_fingerprint:
        count_bytes = json.dumps(before_counts, sort_keys=True).encode("utf-8")
        print(
            json.dumps(
                {
                    "table_counts_hash": hashlib.sha256(count_bytes).hexdigest(),
                    "database_file_hash": before_hash,
                    "database_content_hash": before_content_hash,
                }
            )
        )
        return 0
    timeout = settings.broker_bridge_timeout_seconds + 10
    with httpx.Client(
        base_url=args.base_url,
        timeout=timeout,
        trust_env=False,
    ) as client:
        dashboard_response = client.get("/api/dashboard")
        dashboard_response.raise_for_status()
        portfolio_response = client.get("/api/portfolio")
        portfolio_response.raise_for_status()
    dashboard = require_mapping(dashboard_response.json(), "dashboard")
    broker = require_mapping(dashboard.get("broker"), "dashboard.broker")
    metrics = require_mapping(dashboard.get("metrics"), "dashboard.metrics")
    positions = portfolio_response.json()
    if not isinstance(positions, list):
        raise RuntimeError("portfolio is not a list")
    broker_positions = [
        require_mapping(item, "portfolio row")
        for item in positions
        if require_mapping(item, "portfolio row").get("position_source") == "kgi_broker"
    ]
    broker_total = Decimal(str(metrics["broker_market_value"]))
    investment_total = Decimal(str(metrics["investment_market_value"]))
    projected_total = sum(
        (
            Decimal(str(item["market_value"]))
            for item in broker_positions
            if item.get("valuation_included") and item.get("market_value") is not None
        ),
        start=Decimal("0"),
    )
    after_counts = database_counts(settings.database_path)
    after_hash = file_hash(settings.database_path)
    after_content_hash = database_content_hash(settings.database_path)
    markets = broker.get("markets", [])
    fallback_markets = [
        item["market"] for item in markets if item.get("read_mode") == "persistent_fallback"
    ]

    checks = {
        "broker_read_usable": broker.get("status") in {"complete", "partial", "stale"},
        "broker_schema_v2": broker.get("schema_version") == "paos.broker_valuation.v2",
        "market_statuses_present": bool(broker.get("markets")),
        "source_time_present": bool(broker.get("source_as_of")),
        "broker_positions_applied": len(broker_positions) == int(broker["position_count"]),
        "broker_total_matches_rows": broker_total == projected_total,
        "investment_total_includes_broker": investment_total >= broker_total,
        "all_broker_rows_included": bool(broker_positions)
        and all(item.get("valuation_included") is True for item in broker_positions),
        "all_accounts_opaque": all(
            str(item.get("investment_account_id", "")).startswith("kgi_")
            for item in broker_positions
        ),
        "database_table_counts_unchanged": before_counts == after_counts,
        "database_file_unchanged": before_hash == after_hash,
        "database_content_including_wal_unchanged": before_content_hash == after_content_hash,
        "market_guard_contract_adopted": all(
            item.get("read_mode") in {"live", "memory_cache", "persistent_fallback", "unavailable"}
            and isinstance(item.get("stale"), bool) for item in markets
        ),
        "fallback_is_non_live": not fallback_markets or (
            broker.get("read_mode") == "persistent_fallback"
            and broker.get("status") == "stale"
            and all(item["stale"] for item in markets if item["market"] in fallback_markets)
            and bool(dashboard.get("warnings"))
        ),
    }
    result = {
        "ok": all(checks.values()),
        "broker_status": broker.get("status"),
        "dashboard_read_mode": broker.get("read_mode"),
        "position_count": len(broker_positions),
        "markets": [
            {key: item.get(key) for key in ("market", "status", "read_mode", "stale")}
            for item in markets
        ],
        "fallback_markets": fallback_markets,
        "warnings_present": bool(dashboard.get("warnings")),
        "checks": checks,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())