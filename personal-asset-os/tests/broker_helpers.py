from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal

from personal_asset_os.services.broker_read import (
    BrokerPosition,
    BrokerReadResult,
    BrokerSnapshot,
    BrokerValuation,
)


def broker_result(
    *,
    as_of: datetime,
    symbol: str = "2330",
    name: str = "台積電",
    quantity: Decimal = Decimal("10"),
    last_price: Decimal | None = Decimal("1200"),
    market_value: Decimal | None = Decimal("12000"),
    broker_pnl: Decimal | None = Decimal("2000"),
    status: Literal["complete", "explicit_empty"] = "complete",
) -> BrokerReadResult:
    positions: tuple[BrokerPosition, ...]
    valuations: tuple[BrokerValuation, ...]
    if status == "explicit_empty":
        positions = ()
        valuations = ()
    else:
        positions = (
            BrokerPosition(
                market="TW",
                symbol=symbol,
                name=name,
                currency="TWD",
                position_type="cash",
                quantity=quantity,
                average_cost=Decimal("1000"),
            ),
        )
        valuations = (
            BrokerValuation(
                market="TW",
                symbol=symbol,
                name=name,
                currency="TWD",
                last_price=last_price,
                broker_market_value=market_value,
                broker_unrealized_pnl=broker_pnl,
                broker_unrealized_pnl_twd=broker_pnl,
            ),
        )
    snapshot = BrokerSnapshot(
        schema_version="broker.position.v1",
        broker="KGI",
        account={"opaque_id": "kgi_0123456789abcdef01234567", "masked_label": "****1234"},
        captured_at=as_of,
        source_as_of=as_of,
        status=status,
        source="kgi.inventory_sum",
        positions=positions,
        valuations=valuations,
        warnings=(),
        payload_hash="a" * 64,
    )
    return BrokerReadResult(
        status=status,
        read_mode="live",
        retrieved_at=as_of,
        snapshot=snapshot,
    )


class FakeBrokerReader:
    def __init__(self, result: BrokerReadResult) -> None:
        self.result = result
        self.calls = 0

    def read(self, *, now: datetime | None = None) -> BrokerReadResult:
        del now
        self.calls += 1
        return self.result
