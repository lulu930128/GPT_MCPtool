from datetime import UTC, datetime
from decimal import Decimal

import pytest

from kgi_broker_bridge.account_state import normalize_account_state
from kgi_broker_bridge.identity import AccountIdentityProjector

NOW = datetime(2026, 9, 10, tzinfo=UTC)
IDENTITY = AccountIdentityProjector("synthetic-account-state-key-00000000")


def evidence() -> dict:
    row = {"CURRENCY": "TWD", "customer_name": "SECRET-NAME"}
    for slot, trade, settle, amount in (
        (1, "20260908", "20260910", "-100"),
        (2, "20260909", "20260911", "0"),
        (3, "20260910", "20260914", "250"),
    ):
        row.update({f"DealDate{slot}": trade, f"CDate{slot}": settle,
                    f"CSRPAMT{slot}": amount, f"SettleMark{slot}": "Y"})
    return {"account_ref": "SYNTHETIC-ACCOUNT-1234", "rows": [row], "liquidity": {
        "account_ref": "SYNTHETIC-SUB-5678",
        "rows": [{"currency": "USD", "pp3": "12.34", "pp5": "10", "balance_twd": "1.25"}],
    }}


def test_preserves_dates_signs_and_never_promotes_unqualified_cash() -> None:
    state = normalize_account_state(evidence(), NOW, IDENTITY)
    assert str(state.settlements[2].settlement_date) == "2026-09-14"
    assert state.settlements[0].amount == Decimal("-100")
    assert state.settlements[1].amount == 0
    assert state.buying_power == Decimal("12.34")
    assert state.withdrawable_cash == 10
    assert state.cash_candidate == Decimal("1.25")
    assert state.settled_cash == Decimal("1.25")
    assert state.settled_cash_currency == "USD"
    assert state.cash_quality == "qualified"
    assert state.settlement_net is state.pending_receivable is None
    assert state.valuation_included is False
    assert "SECRET" not in state.model_dump_json()
    assert "SYNTHETIC-ACCOUNT" not in state.model_dump_json()


@pytest.mark.parametrize("field,value", [
    ("CDate3", "20260931"), ("CSRPAMT2", "NaN"), ("CSRPAMT1", None),
    ("CURRENCY", "USD"), ("SettleMark1", "unknown"),
])
def test_bad_settlement_keeps_liquidity(field: str, value: object) -> None:
    raw = evidence()
    raw["rows"][0][field] = value
    state = normalize_account_state(raw, NOW, IDENTITY)
    assert state.settlements == ()
    assert state.settlement_status == "unavailable"
    assert state.buying_power == Decimal("12.34")


def test_bad_liquidity_keeps_settlement_and_does_not_leak_raw_error() -> None:
    raw = evidence()
    raw["liquidity"] = {"error": "SECRET"}
    state = normalize_account_state(raw, NOW, IDENTITY)
    assert len(state.settlements) == 3
    assert state.buying_power is None
    assert "SECRET" not in state.model_dump_json()


def test_empty_response_is_unavailable_not_zero() -> None:
    state = normalize_account_state({}, NOW, IDENTITY)
    assert state.status == "unavailable"
    assert state.settlement_net is state.settled_cash is None


def test_missing_liquidity_does_not_erase_qualified_cash() -> None:
    raw = evidence()
    raw["liquidity"]["rows"][0]["pp3"] = "bad"
    state = normalize_account_state(raw, NOW, IDENTITY)
    assert state.buying_power is None
    assert state.settled_cash == Decimal("1.25")
    assert state.cash_quality == "qualified"


def test_true_zero_cash_is_qualified_and_missing_is_not_zero() -> None:
    raw = evidence()
    raw["liquidity"]["rows"][0]["balance_twd"] = "0"
    assert normalize_account_state(raw, NOW, IDENTITY).settled_cash == 0
    raw["liquidity"]["rows"][0]["balance_twd"] = None
    state = normalize_account_state(raw, NOW, IDENTITY)
    assert state.settled_cash is None
    assert state.cash_quality == "unavailable"
