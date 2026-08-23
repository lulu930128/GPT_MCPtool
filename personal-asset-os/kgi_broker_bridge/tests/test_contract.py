from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from pydantic import ValidationError

from kgi_broker_bridge.contracts import (
    BrokerAccountRef,
    BrokerInstrumentValuation,
    BrokerPosition,
    BrokerPositionSnapshot,
    PositionType,
    SnapshotStatus,
)


def test_decimal_values_serialize_as_strings_and_datetimes_as_utc() -> None:
    position = BrokerPosition(
        symbol="3711",
        name="合成測試股票",
        position_type=PositionType.CASH,
        quantity=Decimal("100.25000000"),
        average_cost=Decimal("623.150000"),
    )
    valuation = BrokerInstrumentValuation(
        symbol="3711",
        name="合成測試股票",
        last_price=Decimal("588.0"),
        broker_market_value=Decimal("58947.0"),
        broker_unrealized_pnl=Decimal("-3842.0"),
    )
    snapshot = BrokerPositionSnapshot(
        account=BrokerAccountRef(
            opaque_id="kgi_0123456789abcdef01234567",
            masked_label="KGI •••0001",
        ),
        captured_at=datetime(2026, 8, 19, 15, tzinfo=UTC),
        source_as_of=datetime(2026, 8, 19, 23, tzinfo=UTC) + timedelta(hours=8),
        status=SnapshotStatus.COMPLETE,
        positions=(position,),
        valuations=(valuation,),
        payload_hash="0" * 64,
    )

    payload = snapshot.model_dump(mode="json")
    assert payload["positions"][0]["quantity"] == "100.25000000"  # type: ignore[index]
    assert payload["positions"][0]["average_cost"] == "623.150000"  # type: ignore[index]
    assert payload["valuations"][0]["last_price"] == "588.0"  # type: ignore[index]
    assert snapshot.source_as_of.tzinfo is UTC


def test_contract_models_are_frozen_and_reject_naive_datetimes() -> None:
    position = BrokerPosition(
        symbol="0050",
        name="合成測試 ETF",
        position_type=PositionType.CASH,
        quantity=Decimal("1"),
    )
    with pytest.raises(ValidationError):
        position.quantity = Decimal("2")  # type: ignore[misc]

    with pytest.raises(ValidationError, match="timezone"):
        BrokerPositionSnapshot(
            account=BrokerAccountRef(
                opaque_id="kgi_0123456789abcdef01234567",
                masked_label="KGI •••0001",
            ),
            captured_at=datetime(2026, 8, 19),
            source_as_of=datetime(2026, 8, 19, tzinfo=UTC),
            status=SnapshotStatus.COMPLETE,
            positions=(position,),
            valuations=(
                BrokerInstrumentValuation(symbol="0050", name="合成測試 ETF"),
            ),
            payload_hash="0" * 64,
        )

def test_explicit_empty_snapshot_cannot_contain_positions() -> None:
    with pytest.raises(ValidationError, match="explicit_empty"):
        BrokerPositionSnapshot(
            account=BrokerAccountRef(
                opaque_id="kgi_0123456789abcdef01234567",
                masked_label="KGI •••0001",
            ),
            captured_at=datetime(2026, 8, 19, tzinfo=UTC),
            source_as_of=datetime(2026, 8, 19, tzinfo=UTC),
            status=SnapshotStatus.EXPLICIT_EMPTY,
            positions=(
                BrokerPosition(
                    symbol="0050",
                    name="合成測試 ETF",
                    position_type=PositionType.CASH,
                    quantity=Decimal("1"),
                ),
            ),
            payload_hash="0" * 64,
        )
