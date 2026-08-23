from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

from kgi_broker_bridge.contracts import BrokerHealth, HealthStatus
from kgi_broker_bridge.ports import (
    RawBrokerSnapshotBatch,
    RawInventoryBatch,
    RawMarketInventoryScope,
)

FIXED_NOW = datetime(2026, 8, 19, 7, 0, 1, tzinfo=UTC)
FIXTURE_PATH = Path(__file__).parent / "fixtures" / "inventory_sum_synthetic.json"


def healthy() -> BrokerHealth:
    return BrokerHealth(
        status=HealthStatus.HEALTHY,
        package_version="2.1.0",
        login=True,
        ca=True,
        account=True,
        quote=True,
        positions=True,
        checked_at=FIXED_NOW,
        last_success_at=FIXED_NOW,
    )


def synthetic_batch() -> RawInventoryBatch:
    payload = cast(dict[str, object], json.loads(FIXTURE_PATH.read_text(encoding="utf-8")))
    rows = cast(list[dict[str, object]], payload["rows"])
    return RawInventoryBatch(
        account_ref=str(payload["account_ref"]),
        captured_at=datetime.fromisoformat(str(payload["captured_at"])),
        source_as_of=datetime.fromisoformat(str(payload["source_as_of"])),
        rows=tuple(rows),
        explicit_empty=bool(payload["explicit_empty"]),
        warnings=tuple(cast(list[str], payload["warnings"])),
    )


def synthetic_v2_batch() -> RawBrokerSnapshotBatch:
    tw = synthetic_batch()
    return RawBrokerSnapshotBatch(
        captured_at=tw.captured_at,
        scopes=(
            RawMarketInventoryScope(
                market="TW",
                account_ref=tw.account_ref,
                source_as_of=tw.source_as_of,
                rows=tw.rows,
                explicit_empty=tw.explicit_empty,
                warnings=tw.warnings,
            ),
            RawMarketInventoryScope(
                market="US",
                account_ref="SYNTHETIC-SUB-0001",
                source_as_of=tw.source_as_of,
                rows=(
                    {
                        "symbol": "AAPL",
                        "symbol_name": "Apple Inc.",
                        "market": "US",
                        "currency": "USD",
                        "settle_currency": "USD",
                        "Qty": "2.5",
                        "market_price": "199",
                        "close_date": "20260818",
                        "_snapshot_close": "200",
                        "_snapshot_timestamp": "20260819160000000",
                    },
                ),
                warnings=("synthetic_us_fixture_only",),
            ),
        ),
        warnings=("synthetic_v2_fixture_only",),
    )


class FakeGateway:
    def __init__(self, batch: RawInventoryBatch) -> None:
        self.batch = batch
        self.requested_book_codes: list[str] = []

    def get_health(self) -> BrokerHealth:
        return healthy()

    def read_inventory(self, book_code: str) -> RawInventoryBatch:
        self.requested_book_codes.append(book_code)
        return self.batch

    def read_positions_v2(self) -> RawBrokerSnapshotBatch:
        return synthetic_v2_batch()
