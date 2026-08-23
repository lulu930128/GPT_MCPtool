from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from personal_asset_os.domain.enums import AccountKind, AccountSubtype
from personal_asset_os.models import AuditLog, LedgerTransaction, Posting, PriceFact, Trade
from personal_asset_os.services import ledger, portfolio, reporting
from personal_asset_os.services.broker_read import (
    BrokerMarketScopeV2,
    BrokerPositionV2,
    BrokerReadResult,
    BrokerSnapshotV2,
    BrokerValuationV2,
)
from personal_asset_os.services.fx_rates import FxRateFact, FxReadResult
from tests.broker_helpers import broker_result

NOW = datetime(2026, 8, 20, 2, 0, tzinfo=UTC)


class FakeFxProvider:
    def __init__(self, result: FxReadResult) -> None:
        self.result = result

    def read(self, *, now: datetime | None = None) -> FxReadResult:
        del now
        return self.result


def us_broker_result() -> BrokerReadResult:
    tw = BrokerMarketScopeV2(
        market="TW",
        account={"opaque_id": "kgi_0123456789abcdef01234567", "masked_label": "****1234"},
        status="explicit_empty",
        source="kgi.inventory_sum",
        source_as_of=NOW,
        positions=(),
        valuations=(),
        warnings=(),
    )
    us = BrokerMarketScopeV2(
        market="US",
        account={"opaque_id": "kgi_abcdef0123456789abcdef01", "masked_label": "****5678"},
        status="complete",
        source="kgi.stock_position_report",
        source_as_of=NOW,
        positions=(
            BrokerPositionV2(
                market="US",
                symbol="AAPL",
                name="Apple Inc.",
                currency="USD",
                settlement_currency="USD",
                position_type="cash",
                quantity=Decimal("2.5"),
            ),
        ),
        valuations=(
            BrokerValuationV2(
                market="US",
                symbol="AAPL",
                name="Apple Inc.",
                currency="USD",
                last_price=Decimal("200"),
                native_market_value=Decimal("500"),
                price_as_of=NOW,
                price_quality="broker_snapshot",
            ),
        ),
        warnings=(),
    )
    return BrokerReadResult(
        status="complete",
        read_mode="live",
        retrieved_at=NOW,
        snapshot=BrokerSnapshotV2(
            schema_version="broker.position.v2",
            broker="KGI",
            captured_at=NOW,
            status="complete",
            scopes=(tw, us),
            warnings=(),
            payload_hash="b" * 64,
        ),
    )


def add_account(
    session: Session,
    name: str,
    subtype: AccountSubtype,
    *,
    opening: Decimal | None = None,
) -> str:
    account = ledger.create_account(
        session,
        name=name,
        kind=AccountKind.ASSET,
        subtype=subtype,
        currency="TWD",
        institution="KGI" if subtype is AccountSubtype.INVESTMENT else None,
        is_liquid=subtype is not AccountSubtype.INVESTMENT,
    )
    if opening is not None:
        ledger.opening_balance(
            session,
            account_id=account.id,
            amount=opening,
            occurred_at=NOW - timedelta(hours=1),
            description=f"{name}期初",
        )
    return account.id


def add_ledger_position(session: Session) -> tuple[str, str]:
    cash_id = add_account(session, "銀行", AccountSubtype.BANK, opening=Decimal("100000"))
    investment_id = add_account(session, "KGI 台股", AccountSubtype.INVESTMENT)
    instrument = portfolio.create_instrument(session, symbol="2330", market="TWSE", name="台積電")
    portfolio.buy(
        session,
        instrument_id=instrument.id,
        investment_account_id=investment_id,
        cash_account_id=cash_id,
        quantity=Decimal("10"),
        execution_price=Decimal("1000"),
        fee=Decimal("0"),
        tax=Decimal("0"),
        occurred_at=NOW - timedelta(minutes=30),
        description="買進 2330",
    )
    return investment_id, instrument.id


def persisted_counts(session: Session) -> tuple[int, ...]:
    return tuple(
        int(session.scalar(select(func.count()).select_from(model)) or 0)
        for model in (LedgerTransaction, Posting, Trade, PriceFact, AuditLog)
    )


def test_broker_only_position_is_applied_without_ledger_write(session: Session) -> None:
    before = persisted_counts(session)
    view = reporting.dashboard(session, as_of=NOW, broker_read=broker_result(as_of=NOW))
    after = persisted_counts(session)

    assert view["metrics"]["investment_market_value"] == Decimal("12000.000000")  # type: ignore[index]
    assert view["metrics"]["broker_market_value"] == Decimal("12000.000000")  # type: ignore[index]
    assert view["positions"][0]["position_source"] == "kgi_broker"  # type: ignore[index]
    assert view["positions"][0]["reconciliation_status"] == "unmapped"  # type: ignore[index]
    assert before == after


def test_mapped_broker_value_replaces_ledger_price_without_double_count(session: Session) -> None:
    investment_id, _instrument_id = add_ledger_position(session)
    before = persisted_counts(session)
    view = reporting.dashboard(
        session,
        as_of=NOW,
        broker_read=broker_result(as_of=NOW),
        broker_investment_account_id=investment_id,
    )
    after = persisted_counts(session)
    positions = view["positions"]  # type: ignore[assignment]

    assert view["metrics"]["investment_market_value"] == Decimal("12000.000000")  # type: ignore[index]
    assert view["metrics"]["provisional_net_worth"] == Decimal("102000.000000")  # type: ignore[index]
    assert len(positions) == 1
    assert positions[0]["position_source"] == "kgi_broker"
    assert positions[0]["reconciliation_status"] == "matched"
    assert positions[0]["cost_basis"] == Decimal("10000.000000")
    assert positions[0]["unrealized_pnl"] == Decimal("2000.000000")
    assert before == after


def test_quantity_mismatch_uses_broker_market_value_but_not_book_pnl(session: Session) -> None:
    investment_id, _instrument_id = add_ledger_position(session)
    view = reporting.dashboard(
        session,
        as_of=NOW,
        broker_read=broker_result(
            as_of=NOW,
            quantity=Decimal("12"),
            market_value=Decimal("14400"),
        ),
        broker_investment_account_id=investment_id,
    )
    position = view["positions"][0]  # type: ignore[index]

    assert view["metrics"]["investment_market_value"] == Decimal("14400.000000")  # type: ignore[index]
    assert position["reconciliation_status"] == "quantity_mismatch"
    assert position["ledger_quantity"] == Decimal("10.000000")
    assert position["cost_basis"] is None
    assert position["unrealized_pnl"] is None


def test_unavailable_broker_retains_paos_valuation(session: Session) -> None:
    investment_id, _instrument_id = add_ledger_position(session)
    unavailable = BrokerReadResult(
        status="unavailable",
        read_mode="unavailable",
        retrieved_at=NOW,
        warnings=("KGI Bridge 無法連線，已保留 PAOS 原估值",),
    )
    view = reporting.dashboard(
        session,
        as_of=NOW,
        broker_read=unavailable,
        broker_investment_account_id=investment_id,
    )

    assert view["metrics"]["investment_market_value"] == Decimal("10000.000000")  # type: ignore[index]
    assert view["positions"][0]["position_source"] == "ledger"  # type: ignore[index]
    assert any("保留 PAOS 原估值" in warning for warning in view["warnings"])  # type: ignore[union-attr]


def test_explicit_empty_excludes_linked_ledger_positions(session: Session) -> None:
    investment_id, _instrument_id = add_ledger_position(session)
    view = reporting.dashboard(
        session,
        as_of=NOW,
        broker_read=broker_result(as_of=NOW, status="explicit_empty"),
        broker_investment_account_id=investment_id,
    )

    assert view["metrics"]["investment_market_value"] == Decimal("0.000000")  # type: ignore[index]
    assert view["positions"][0]["valuation_included"] is False  # type: ignore[index]
    assert view["positions"][0]["reconciliation_status"] == "ledger_only"  # type: ignore[index]


def test_us_position_keeps_native_usd_and_enters_twd_total_with_fx(
    session: Session,
) -> None:
    before = persisted_counts(session)
    fx = FxReadResult(
        status="complete",
        read_mode="live",
        retrieved_at=NOW,
        fact=FxRateFact(
            base_currency="USD",
            quote_currency="TWD",
            rate=Decimal("32"),
            effective_at=NOW,
            retrieved_at=NOW,
            provider="cbc.bp01d01",
            quality="official_close",
        ),
    )
    view = reporting.dashboard(
        session,
        as_of=NOW,
        broker_read=us_broker_result(),
        fx_provider=FakeFxProvider(fx),
    )
    after = persisted_counts(session)
    position = view["positions"][0]  # type: ignore[index]

    assert position["native_currency"] == "USD"
    assert position["native_market_value"] == Decimal("500.000000")
    assert position["market_value"] == Decimal("16000.000000")
    assert position["fx_rate"] == Decimal("32")
    assert view["metrics"]["investment_market_value"] == Decimal("16000.000000")  # type: ignore[index]
    assert [item["market"] for item in view["broker"]["markets"]] == ["TW", "US"]  # type: ignore[index]
    assert [item["status"] for item in view["broker"]["markets"]] == [  # type: ignore[index]
        "explicit_empty",
        "complete",
    ]
    assert before == after


def test_us_position_without_fx_is_visible_but_excluded_from_twd_total(
    session: Session,
) -> None:
    unavailable_fx = FxReadResult.unavailable(
        now=NOW, warnings=("USD/TWD 目前不可用",)
    )
    view = reporting.dashboard(
        session,
        as_of=NOW,
        broker_read=us_broker_result(),
        fx_provider=FakeFxProvider(unavailable_fx),
    )
    position = view["positions"][0]  # type: ignore[index]

    assert position["native_market_value"] == Decimal("500.000000")
    assert position["market_value"] is None
    assert position["valuation_included"] is False
    assert view["metrics"]["investment_market_value"] == Decimal("0")  # type: ignore[index]
    assert view["broker"]["status"] == "partial"  # type: ignore[index]
