from __future__ import annotations

from dataclasses import replace
from decimal import Decimal

import pytest

from kgi_broker_bridge.adapters.kgi_inventory import KGIInventoryAdapter
from kgi_broker_bridge.contracts import PositionType, SnapshotStatus
from kgi_broker_bridge.errors import AmbiguousEmptyInventoryError, SchemaParseError
from kgi_broker_bridge.identity import AccountIdentityProjector
from kgi_broker_bridge.ports import RawInventoryBatch
from tests.helpers import FakeGateway, synthetic_batch, synthetic_v2_batch


def adapter_for(batch: RawInventoryBatch) -> tuple[KGIInventoryAdapter, FakeGateway]:
    gateway = FakeGateway(batch)
    adapter = KGIInventoryAdapter(
        gateway=gateway,
        identity=AccountIdentityProjector("synthetic-hmac-key-for-tests-0001"),
    )
    return adapter, gateway


def test_normalizes_positions_and_keeps_valuation_once_per_symbol() -> None:
    batch = synthetic_batch()
    adapter, gateway = adapter_for(batch)
    snapshot = adapter.get_positions()

    assert gateway.requested_book_codes == ["B"]
    assert snapshot.status is SnapshotStatus.COMPLETE
    assert len(snapshot.positions) == 4
    assert len(snapshot.valuations) == 2
    assert {
        (item.symbol, item.position_type)
        for item in snapshot.positions
        if item.symbol == "3711"
    } == {
        ("3711", PositionType.CASH),
        ("3711", PositionType.MARGIN),
        ("3711", PositionType.ODD_LOT),
    }
    cash = next(
        item
        for item in snapshot.positions
        if item.symbol == "3711" and item.position_type is PositionType.CASH
    )
    margin = next(
        item
        for item in snapshot.positions
        if item.symbol == "3711" and item.position_type is PositionType.MARGIN
    )
    assert str(cash.average_cost) == "623.15"
    assert margin.average_cost is None
    assert sum(
        (
            item.quantity
            for item in snapshot.positions
            if item.symbol == "3711"
        ),
        start=Decimal(0),
    ) == Decimal("153")
    assert len(snapshot.payload_hash) == 64
    serialized = snapshot.model_dump_json()
    assert batch.account_ref not in serialized
    assert "synthetic_fixture_only" in snapshot.warnings


def test_removes_proven_odd_lot_overlap_from_cash_in_v1_and_v2() -> None:
    source = synthetic_batch()
    rows = [dict(row) for row in source.rows]
    rows[0].update(
        {
            "RLPRICE": "587",
            "ASSET": "58700",
            "NETQTY0": "100",
            "NETQTY3": "0",
            "NETQTY4": "0",
            "NETQTY9": "100",
        }
    )
    overlap_batch = replace(source, rows=tuple(rows))
    adapter, _ = adapter_for(overlap_batch)

    v1 = adapter.get_positions()
    v1_positions = [item for item in v1.positions if item.symbol == "3711"]
    assert [(item.position_type, item.quantity) for item in v1_positions] == [
        (PositionType.ODD_LOT, Decimal("100"))
    ]
    assert "odd_lot_overlap_removed_from_cash:3711" in v1.warnings

    v2_source = synthetic_v2_batch()
    v2 = adapter._normalize_v2(
        replace(
            v2_source,
            scopes=(
                replace(v2_source.scopes[0], rows=overlap_batch.rows),
                v2_source.scopes[1],
            ),
        )
    )
    tw = next(scope for scope in v2.scopes if scope.market == "TW")
    tw_positions = [item for item in tw.positions if item.symbol == "3711"]
    assert [(item.position_type, item.quantity) for item in tw_positions] == [
        (PositionType.ODD_LOT, Decimal("100"))
    ]
    assert "odd_lot_overlap_removed_from_cash:3711" in tw.warnings


def test_payload_hash_is_deterministic_for_same_normalized_snapshot() -> None:
    first, _ = adapter_for(synthetic_batch())
    second, _ = adapter_for(synthetic_batch())
    assert first.get_positions().payload_hash == second.get_positions().payload_hash


def test_explicit_empty_is_publishable_but_ambiguous_empty_is_not() -> None:
    source = synthetic_batch()
    explicit_adapter, _ = adapter_for(replace(source, rows=(), explicit_empty=True))
    snapshot = explicit_adapter.get_positions()
    assert snapshot.status is SnapshotStatus.EXPLICIT_EMPTY
    assert snapshot.positions == ()

    ambiguous_adapter, _ = adapter_for(replace(source, rows=(), explicit_empty=False))
    with pytest.raises(AmbiguousEmptyInventoryError):
        ambiguous_adapter.get_positions()


def test_invalid_field_or_contradictory_empty_does_not_publish_snapshot() -> None:
    source = synthetic_batch()
    invalid_rows = [dict(row) for row in source.rows]
    invalid_rows[0]["NETQTY0"] = "not-a-number"
    invalid_adapter, _ = adapter_for(replace(source, rows=tuple(invalid_rows)))
    with pytest.raises(SchemaParseError, match="NETQTY0"):
        invalid_adapter.get_positions()

    contradictory_adapter, _ = adapter_for(replace(source, explicit_empty=True))
    with pytest.raises(SchemaParseError, match="explicit_empty"):
        contradictory_adapter.get_positions()


def test_contract_validation_errors_are_sanitized_as_schema_errors() -> None:
    source = synthetic_batch()
    invalid_rows = [dict(row) for row in source.rows]
    invalid_rows[0]["Symbol"] = "X" * 40
    adapter, _ = adapter_for(replace(source, rows=tuple(invalid_rows)))

    with pytest.raises(SchemaParseError, match="schema validation failed"):
        adapter.get_positions()


def test_v2_normalizes_tw_and_us_with_native_us_valuation() -> None:
    adapter, _ = adapter_for(synthetic_batch())
    snapshot = adapter._normalize_v2(synthetic_v2_batch())

    assert snapshot.schema_version == "broker.position.v2"
    assert snapshot.status.value == "complete"
    us = next(scope for scope in snapshot.scopes if scope.market == "US")
    assert str(us.positions[0].quantity) == "2.5"
    assert str(us.valuations[0].last_price) == "200"
    assert str(us.valuations[0].native_market_value) == "500.0"
    assert us.valuations[0].price_quality.value == "broker_snapshot"
    assert us.valuations[0].price_as_of is not None
    assert "SYNTHETIC-SUB-0001" not in snapshot.model_dump_json()


def test_v2_keeps_successful_market_when_other_scope_is_unavailable() -> None:
    batch = synthetic_v2_batch()
    partial = replace(
        batch,
        scopes=(
            batch.scopes[0],
            replace(
                batch.scopes[1],
                account_ref=None,
                source_as_of=None,
                rows=(),
                error_code="inventory_fetch_failed",
            ),
        ),
    )
    adapter, _ = adapter_for(synthetic_batch())
    snapshot = adapter._normalize_v2(partial)

    assert snapshot.status.value == "partial"
    assert snapshot.scopes[0].status.value == "complete"
    assert snapshot.scopes[1].status.value == "unavailable"
