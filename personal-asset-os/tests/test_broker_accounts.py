from decimal import Decimal

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from personal_asset_os.domain.enums import AccountKind, AccountSubtype
from personal_asset_os.errors import ValidationError
from personal_asset_os.models import LedgerTransaction
from personal_asset_os.services import broker_accounts, ledger, reporting
from personal_asset_os.services.broker_cash import cash_projection
from tests.helpers import NOW, add_account
from tests.test_broker_cash import FX, state


def test_setup_and_transfer_preserve_net_worth(session: Session) -> None:
    bank = add_account(session, "銀行", AccountKind.ASSET, AccountSubtype.BANK,
                       liquid=True, opening=Decimal("1000"))
    result = broker_accounts.setup(session)
    assert result == broker_accounts.setup(session)
    assert session.scalar(select(func.count()).select_from(LedgerTransaction)) == 1
    before = reporting.dashboard(session, as_of=NOW)
    ledger.record_transfer(session, from_account_id=bank.id,
                           to_account_id=result["broker_cash"], amount=Decimal("200"),
                           occurred_at=NOW, description="轉入券商")
    after = reporting.dashboard(session, as_of=NOW)
    assert before["metrics"]["known_net_worth"] == after["metrics"]["known_net_worth"]
    assert after["metrics"]["liquid_cash"] == Decimal("800")
    assert after["metrics"]["monthly_expense"] == 0
    with pytest.raises(ValidationError):
        ledger.record_transfer(session, from_account_id=bank.id,
                               to_account_id=result["investment"], amount=Decimal("10"),
                               occurred_at=NOW, description="不能直接轉入股票")


def test_settlement_schedule_never_changes_cash_or_claims_posted(session: Session) -> None:
    from tests.test_broker_cash import NOW as captured
    evidence = state(settlement_status="reported", settlements=[
        {"slot": 1, "trade_date": "2026-09-08", "settlement_date": "2026-09-10",
         "currency": "TWD", "amount": "100", "settle_mark": "Y"},
        {"slot": 2, "trade_date": "2026-09-09", "settlement_date": "2026-09-11",
         "currency": "TWD", "amount": "-40", "settle_mark": "N"},
    ])
    view, delta, _ = cash_projection(session, evidence, now=captured, fx=FX,
                                     fx_provider=None, account_id=None, accounts=[])
    assert delta == Decimal("320")
    assert view["settlement_schedule"]["reported_net"] == Decimal("60")
    assert view["settlement_schedule"]["posting_status"] == "unknown"
    assert view["settlement_schedule"]["valuation_included"] is False
    assert not session.new and not session.dirty
