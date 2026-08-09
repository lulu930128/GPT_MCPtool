from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from personal_asset_os.domain.enums import AccountKind, AccountSubtype, PriceQuality
from personal_asset_os.errors import ValidationError
from personal_asset_os.services import ledger, portfolio, reporting
from tests.helpers import NOW, add_account


def setup_investment(session: Session) -> tuple[str, str, str]:
    cash = add_account(
        session,
        "券商交割戶",
        AccountKind.ASSET,
        AccountSubtype.BROKER_CASH,
        liquid=True,
        opening=Decimal("100000"),
    )
    investment = add_account(session, "台股投資", AccountKind.ASSET, AccountSubtype.INVESTMENT)
    instrument = portfolio.create_instrument(session, symbol="2330", market="TWSE", name="台積電")
    return cash.id, investment.id, instrument.id


def test_buy_is_asset_conversion_and_fee_is_expense(session: Session) -> None:
    cash_id, investment_id, instrument_id = setup_investment(session)
    before = reporting.dashboard(session, as_of=NOW)
    portfolio.buy(
        session,
        instrument_id=instrument_id,
        investment_account_id=investment_id,
        cash_account_id=cash_id,
        quantity=Decimal("10"),
        execution_price=Decimal("9990"),
        fee=Decimal("100"),
        tax=Decimal("0"),
        occurred_at=NOW + timedelta(minutes=1),
        description="買進 2330",
        idempotency_key="buy-2330-0001",
    )
    after = reporting.dashboard(session, as_of=NOW + timedelta(minutes=2))
    positions = portfolio.portfolio(session, as_of=NOW + timedelta(minutes=2))

    assert ledger.account_balance(session, cash_id) == Decimal("0.000000")
    assert ledger.account_balance(session, investment_id) == Decimal("99900.000000")
    assert after["metrics"]["monthly_expense"] == Decimal("100.000000")  # type: ignore[index]
    assert after["metrics"]["provisional_net_worth"] == before["metrics"][
        "provisional_net_worth"
    ] - Decimal("100.000000")  # type: ignore[index]
    assert positions[0]["quantity"] == Decimal("10.000000")
    assert positions[0]["market_value"] == Decimal("99900.000000")
    assert positions[0]["valuation_status"] == "manual"


def test_price_change_updates_valuation_without_income(session: Session) -> None:
    cash_id, investment_id, instrument_id = setup_investment(session)
    portfolio.buy(
        session,
        instrument_id=instrument_id,
        investment_account_id=investment_id,
        cash_account_id=cash_id,
        quantity=Decimal("10"),
        execution_price=Decimal("9000"),
        fee=Decimal("0"),
        tax=Decimal("0"),
        occurred_at=NOW,
        description="買進",
    )
    before = reporting.dashboard(session, as_of=NOW + timedelta(minutes=1))
    portfolio.record_price(
        session,
        instrument_id=instrument_id,
        price=Decimal("9900"),
        price_at=NOW + timedelta(minutes=2),
        provider="manual",
        quality=PriceQuality.MANUAL,
    )
    after = reporting.dashboard(session, as_of=NOW + timedelta(minutes=3))
    assert after["metrics"]["provisional_net_worth"] == before["metrics"][
        "provisional_net_worth"
    ] + Decimal("9000.000000")  # type: ignore[index]
    assert after["metrics"]["monthly_income"] == before["metrics"]["monthly_income"]  # type: ignore[index]


def test_sell_uses_moving_average_and_reports_net_realized_pnl(session: Session) -> None:
    cash_id, investment_id, instrument_id = setup_investment(session)
    portfolio.buy(
        session,
        instrument_id=instrument_id,
        investment_account_id=investment_id,
        cash_account_id=cash_id,
        quantity=Decimal("4"),
        execution_price=Decimal("10000"),
        fee=Decimal("0"),
        tax=Decimal("0"),
        occurred_at=NOW,
        description="first buy",
    )
    portfolio.buy(
        session,
        instrument_id=instrument_id,
        investment_account_id=investment_id,
        cash_account_id=cash_id,
        quantity=Decimal("4"),
        execution_price=Decimal("12000"),
        fee=Decimal("0"),
        tax=Decimal("0"),
        occurred_at=NOW + timedelta(minutes=1),
        description="second buy",
    )
    portfolio.sell(
        session,
        instrument_id=instrument_id,
        investment_account_id=investment_id,
        cash_account_id=cash_id,
        quantity=Decimal("2"),
        execution_price=Decimal("13000"),
        fee=Decimal("100"),
        tax=Decimal("50"),
        occurred_at=NOW + timedelta(minutes=2),
        description="sell",
    )
    state = portfolio.position_state(
        session, instrument_id=instrument_id, investment_account_id=investment_id
    )
    assert state.quantity == Decimal("6.000000")
    assert state.average_cost == Decimal("11000.000000")
    assert state.realized_pnl == Decimal("3850.000000")


def test_sell_more_than_available_is_rejected(session: Session) -> None:
    cash_id, investment_id, instrument_id = setup_investment(session)
    with pytest.raises(ValidationError, match="大於可用持倉"):
        portfolio.sell(
            session,
            instrument_id=instrument_id,
            investment_account_id=investment_id,
            cash_account_id=cash_id,
            quantity=Decimal("1"),
            execution_price=Decimal("100"),
            fee=Decimal("0"),
            tax=Decimal("0"),
            occurred_at=NOW,
            description="invalid",
        )
