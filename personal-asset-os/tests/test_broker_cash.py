from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from personal_asset_os.domain.enums import AccountSubtype
from personal_asset_os.services import reporting
from personal_asset_os.services.broker_account_state import AccountState
from personal_asset_os.services.broker_cash import cash_projection
from personal_asset_os.services.broker_read import BrokerReadResult
from tests.test_broker_overlay import add_account

NOW = datetime(2026, 9, 10, 10, tzinfo=UTC)
FX = {"status": "complete", "base_currency": "USD", "quote_currency": "TWD",
      "rate": Decimal("32"), "provider": "taifex.daily_fx", "effective_at": NOW}


def state(**changes: object) -> AccountState:
    return AccountState.model_validate({
        "captured_at": NOW, "status": "partial", "cash_quality": "qualified",
        "settled_cash": "10", "buying_power": "10", "withdrawable_cash": "10",
        "liquidity_account": {"opaque_id": "kgi_" + "a" * 24, "masked_label": "****1234"},
        **changes,
    })


def test_usd_cash_converts_once_without_adding_liquidity(session: Session) -> None:
    view, delta, _ = cash_projection(session, state(), now=NOW, fx=FX,
                                    fx_provider=None, account_id=None, accounts=[])
    assert delta == 320
    assert view["settled_cash_twd"] == 320
    assert view["cash_valuation_included"] is True
    assert not session.new and not session.dirty


@pytest.mark.parametrize("fx", [None, {**FX, "status": "stale"}, {**FX, "rate": "NaN"},
                                {**FX, "rate": "0"}, {**FX, "base_currency": "TWD"}])
def test_missing_or_invalid_fx_keeps_native_cash(session: Session, fx: object) -> None:
    view, delta, _ = cash_projection(session, state(), now=NOW, fx=fx,
                                    fx_provider=None, account_id=None, accounts=[])
    assert delta == 0
    assert view["settled_cash"] == "10"
    assert view["settled_cash_twd"] is None
    assert not view["cash_valuation_included"]


def test_mapping_replaces_existing_balance_and_invalid_mapping_fails_closed(
    session: Session,
) -> None:
    from personal_asset_os.models import Account
    account_id = add_account(session, "Synthetic broker", AccountSubtype.BROKER_CASH,
                             opening=Decimal("300"))
    account = session.get(Account, account_id)
    view, delta, _ = cash_projection(session, state(), now=NOW, fx=FX,
                                    fx_provider=None, account_id=account_id, accounts=[account])
    assert delta == 20
    assert view["cash_difference"] == 20
    assert view["cash_reconciliation_status"] == "mismatch"
    for mapping in (None, "missing"):
        _, delta, _ = cash_projection(session, state(), now=NOW, fx=FX,
                                      fx_provider=None, account_id=mapping, accounts=[account])
        assert delta == 0


def test_stale_cash_not_included(session: Session) -> None:
    view, delta, _ = cash_projection(session, state(captured_at=NOW-timedelta(minutes=5)),
                                    now=NOW, fx=FX, fx_provider=None, account_id=None, accounts=[])
    assert delta == 0 and view["freshness"] == "stale"


def test_dashboard_and_review_include_same_cash_without_changing_known_value(
    session: Session,
) -> None:
    from personal_asset_os.services.fx_rates import FxRateFact, FxReadResult
    from tests.test_broker_overlay import FakeFxProvider
    provider = FakeFxProvider(FxReadResult(
        status="complete", read_mode="live", retrieved_at=NOW,
        fact=FxRateFact(base_currency="USD", quote_currency="TWD", rate=Decimal("32"),
                        effective_at=NOW, retrieved_at=NOW, provider="taifex.daily_fx",
                        quality="official_reference"),
    ))
    before = reporting.dashboard(session, as_of=NOW)
    read = BrokerReadResult(status="unavailable", read_mode="unavailable", retrieved_at=NOW,
                            account_state=state())
    after = reporting.dashboard(session, as_of=NOW, broker_read=read, fx_provider=provider)
    assert before["metrics"]["broker_cash_total"] is None
    assert after["metrics"]["broker_cash_total"] == 320
    expected = before["metrics"]["provisional_net_worth"] + 320
    assert after["metrics"]["provisional_net_worth"] == expected
    assert after["metrics"]["known_net_worth"] == before["metrics"]["known_net_worth"]
    assert after["review"]["summary"]["provisional_net_worth"] == expected
    assert not session.new and not session.dirty
