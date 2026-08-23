from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy.orm import Session

from personal_asset_os.domain.enums import (
    AccountKind,
    AccountSubtype,
    FinancialEventKind,
)
from personal_asset_os.services import (
    dashboard_review,
    financial_events,
    ledger,
    reporting,
    reporting_annotations,
)
from personal_asset_os.services.ledger import PostingDraft
from personal_asset_os.services.portfolio import PositionRow
from tests.helpers import NOW, add_account


def _position(
    *,
    market: str,
    symbol: str,
    name: str,
    market_value: Decimal | None,
    source: str = "kgi_broker",
) -> PositionRow:
    return {
        "instrument_id": f"test:{market}:{symbol}",
        "symbol": symbol,
        "market": market,
        "name": name,
        "investment_account_id": "test-investment",
        "investment_account_name": "測試投資",
        "quantity": Decimal("1"),
        "average_cost": None,
        "cost_basis": None,
        "realized_pnl": None,
        "price": market_value,
        "price_at": NOW if market_value is not None else None,
        "price_provider": "test" if market_value is not None else None,
        "price_quality": "broker_live" if market_value is not None else None,
        "price_age_days": 0 if market_value is not None else None,
        "market_value": market_value,
        "unrealized_pnl": None,
        "valuation_status": "broker_live" if market_value is not None else "missing",
        "position_source": source,  # type: ignore[typeddict-item]
        "valuation_included": market_value is not None,
        "reconciliation_status": "broker_only",
        "ledger_quantity": None,
        "broker_unrealized_pnl": None,
        "native_currency": "TWD" if market == "TW" else "USD",
        "native_price": market_value,
        "native_market_value": market_value,
        "settlement_currency": "TWD" if market == "TW" else "USD",
        "fx_rate": Decimal("1") if market_value is not None else None,
        "fx_at": NOW if market_value is not None else None,
        "fx_provider": "test" if market_value is not None else None,
        "fx_quality": "test" if market_value is not None else None,
    }


def test_asset_and_tw_us_stock_allocations_reconcile_to_twd_values(session: Session) -> None:
    add_account(
        session,
        "活動資金",
        AccountKind.ASSET,
        AccountSubtype.BANK,
        liquid=True,
        opening=Decimal("40000"),
    )
    positions = [
        _position(market="TW", symbol="3711", name="日月光投控", market_value=Decimal("60000")),
        _position(
            market="US",
            symbol="VOO",
            name="Vanguard S&P 500 ETF",
            market_value=Decimal("32000"),
        ),
    ]

    review, warnings = dashboard_review.build_dashboard_review(
        session,
        as_of=NOW,
        non_investment_assets=Decimal("40000"),
        investment_market_value=Decimal("92000"),
        unpriced_investment_cost=Decimal("0"),
        debt=Decimal("5000"),
        positions=positions,
    )

    assets = review["asset_allocation"]
    stocks = review["stock_allocation"]
    assert assets["total"] == Decimal("132000.000000")  # type: ignore[index]
    assert [item["key"] for item in assets["table_items"]] == [  # type: ignore[index]
        "stocks",
        "activity_fund",
    ]
    assert stocks["total"] == Decimal("92000.000000")  # type: ignore[index]
    assert {item["market"] for item in stocks["table_items"]} == {"TW", "US"}  # type: ignore[index]
    assert sum(item["share_percent"] for item in stocks["table_items"]) == Decimal(  # type: ignore[index]
        "100.00"
    )
    assert review["summary"]["provisional_net_worth"] == Decimal("127000.000000")  # type: ignore[index]
    assert warnings == []


def test_stock_chart_is_top_five_plus_other_and_missing_fx_is_not_zero(
    session: Session,
) -> None:
    add_account(
        session,
        "活動資金",
        AccountKind.ASSET,
        AccountSubtype.BANK,
        liquid=True,
        opening=Decimal("1000"),
    )
    positions = [
        _position(
            market="TW",
            symbol=str(index),
            name=f"股票 {index}",
            market_value=Decimal(index * 100),
        )
        for index in range(1, 8)
    ]
    positions.append(
        _position(market="US", symbol="QQQ", name="Invesco QQQ", market_value=None)
    )

    review, warnings = dashboard_review.build_dashboard_review(
        session,
        as_of=NOW,
        non_investment_assets=Decimal("1000"),
        investment_market_value=Decimal("2800"),
        unpriced_investment_cost=Decimal("0"),
        debt=Decimal("0"),
        positions=positions,
    )

    stocks = review["stock_allocation"]
    assert len(stocks["chart_items"]) == 6  # type: ignore[arg-type,index]
    assert stocks["chart_items"][-1]["key"] == "__other__"  # type: ignore[index]
    assert stocks["chart_items"][-1]["amount"] == Decimal("300.000000")  # type: ignore[index]
    assert stocks["excluded_count"] == 1  # type: ignore[index]
    assert any("缺 FX" in warning for warning in warnings)


def _capture_and_finalize(
    session: Session,
    *,
    account_id: str,
    amount: str,
    description: str,
    key: str,
    merchant: str | None = None,
    category_hint: str | None = None,
    occurred_at=NOW,
) -> None:
    event, _ = financial_events.capture_event(
        session,
        event_kind=FinancialEventKind.EXPENSE,
        occurred_at=occurred_at,
        amount=Decimal(amount),
        description=description,
        merchant=merchant,
        category_hint=category_hint,
        idempotency_key=key,
    )
    financial_events.finalize_event(
        session,
        event_id=event.id,
        expected_version=1,
        payment_account_id=account_id,
    )


def test_spending_uses_postings_with_lineage_labels_and_excludes_reversals_and_fees(
    session: Session,
) -> None:
    bank = add_account(
        session,
        "活動資金",
        AccountKind.ASSET,
        AccountSubtype.BANK,
        liquid=True,
        opening=Decimal("20000"),
    )
    _capture_and_finalize(
        session,
        account_id=bank.id,
        amount="100",
        description="午餐 A",
        merchant="甲餐廳",
        category_hint="餐飲",
        key="review-food-001",
    )
    _capture_and_finalize(
        session,
        account_id=bank.id,
        amount="200",
        description="午餐 B",
        merchant="乙餐廳",
        category_hint="餐飲",
        key="review-food-002",
    )
    _capture_and_finalize(
        session,
        account_id=bank.id,
        amount="300",
        description="捷運加值",
        merchant="捷運",
        key="review-transit-001",
    )
    ledger.record_expense(
        session,
        payment_account_id=bank.id,
        amount=Decimal("50"),
        occurred_at=NOW,
        description="臨時用品",
        idempotency_key="review-misc-001",
    )
    reversed_transaction, _ = ledger.record_expense(
        session,
        payment_account_id=bank.id,
        amount=Decimal("80"),
        occurred_at=NOW,
        description="錯誤消費",
        idempotency_key="review-reversed-001",
    )
    ledger.reverse_transaction(
        session,
        transaction_id=reversed_transaction.id,
        reason="輸入錯誤",
        occurred_at=NOW + timedelta(minutes=1),
        idempotency_key="review-reversal-001",
    )
    investment_fee = ledger.system_account(session, AccountSubtype.INVESTMENT_FEE)
    ledger.create_transaction(
        session,
        occurred_at=NOW,
        description="投資手續費",
        postings=[
            PostingDraft(investment_fee.id, Decimal("25"), Decimal("25")),
            PostingDraft(bank.id, Decimal("-25"), Decimal("-25")),
        ],
        idempotency_key="review-fee-001",
    )

    view = reporting.dashboard(session, as_of=NOW + timedelta(minutes=2))
    spending = view["review"]["spending"]["ranges"]["1m"]  # type: ignore[index]

    assert spending["total"] == Decimal("650.000000")
    assert spending["transaction_count"] == 4
    assert spending["excluded_amount"] == Decimal("25.000000")
    assert {item["label"]: item["amount"] for item in spending["table_items"]} == {
        "餐飲": Decimal("300.000000"),
        "捷運": Decimal("300.000000"),
        "臨時用品": Decimal("50.000000"),
    }


def test_reporting_annotation_overrides_spending_label_and_preserves_original_description(
    session: Session,
) -> None:
    bank = add_account(
        session,
        "活動資金",
        AccountKind.ASSET,
        AccountSubtype.BANK,
        liquid=True,
        opening=Decimal("1000"),
    )
    _capture_and_finalize(
        session,
        account_id=bank.id,
        amount="70",
        description="肉燥飯",
        category_hint="吃飯",
        key="review-annotation-mobile-001",
    )
    transaction, _ = ledger.record_expense(
        session,
        payment_account_id=bank.id,
        amount=Decimal("100"),
        occurred_at=NOW,
        description="便當",
        idempotency_key="review-annotation-001",
    )
    payload_hash = transaction.payload_hash

    annotation, changed = reporting_annotations.set_annotation(
        session,
        transaction_id=transaction.id,
        category="吃飯",
        note="便當",
        expected_version=0,
        reason="舊資料分類修正",
    )
    repeated, repeated_changed = reporting_annotations.set_annotation(
        session,
        transaction_id=transaction.id,
        category="吃飯",
        note="便當",
        expected_version=1,
        reason="冪等重送",
    )
    view = reporting.dashboard(session, as_of=NOW + timedelta(minutes=1))
    spending = view["review"]["spending"]["ranges"]["1m"]  # type: ignore[index]
    recent = next(
        item for item in view["recent_transactions"] if item["id"] == transaction.id  # type: ignore[union-attr]
    )

    assert changed is True
    assert repeated_changed is False
    assert repeated.id == annotation.id
    assert transaction.description == "便當"
    assert transaction.payload_hash == payload_hash
    assert spending["total"] == Decimal("170.000000")
    assert spending["transaction_count"] == 2
    assert spending["table_items"][0]["label"] == "吃飯"
    assert spending["table_items"][0]["label_source"] == "reporting_annotation"
    assert recent["category"] == "吃飯"
    assert recent["note"] == "便當"


def test_spending_ranges_use_calendar_month_boundaries(session: Session) -> None:
    bank = add_account(
        session,
        "活動資金",
        AccountKind.ASSET,
        AccountSubtype.BANK,
        liquid=True,
        opening=Decimal("5000"),
    )
    ledger.record_expense(
        session,
        payment_account_id=bank.id,
        amount=Decimal("100"),
        occurred_at=NOW,
        description="八月消費",
        idempotency_key="review-august-001",
    )
    ledger.record_expense(
        session,
        payment_account_id=bank.id,
        amount=Decimal("200"),
        occurred_at=NOW.replace(month=6, day=30),
        description="六月消費",
        idempotency_key="review-june-001",
    )

    view = reporting.dashboard(session, as_of=NOW)
    ranges = view["review"]["spending"]["ranges"]  # type: ignore[index]

    assert ranges["1m"]["total"] == Decimal("100.000000")
    assert ranges["3m"]["total"] == Decimal("300.000000")
    assert ranges["1y"]["total"] == Decimal("300.000000")


def test_monthly_review_uses_reporting_timezone_boundary(session: Session) -> None:
    bank = add_account(
        session,
        "活動資金",
        AccountKind.ASSET,
        AccountSubtype.BANK,
        liquid=True,
    )
    cutoff = datetime(2026, 7, 31, 16, 30, tzinfo=UTC)
    ledger.record_expense(
        session,
        payment_account_id=bank.id,
        amount=Decimal("200"),
        occurred_at=datetime(2026, 7, 31, 15, 59, tzinfo=UTC),
        description="台北七月消費",
        idempotency_key="review-taipei-july-001",
    )
    ledger.record_expense(
        session,
        payment_account_id=bank.id,
        amount=Decimal("100"),
        occurred_at=datetime(2026, 7, 31, 16, 0, tzinfo=UTC),
        description="台北八月消費",
        idempotency_key="review-taipei-august-001",
    )

    view = reporting.dashboard(session, as_of=cutoff, reporting_timezone="Asia/Taipei")

    assert view["metrics"]["monthly_expense"] == Decimal("100.000000")  # type: ignore[index]
    assert view["review"]["spending"]["ranges"]["1m"]["total"] == Decimal(  # type: ignore[index]
        "100.000000"
    )
