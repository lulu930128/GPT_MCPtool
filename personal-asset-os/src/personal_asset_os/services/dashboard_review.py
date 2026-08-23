from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from personal_asset_os.domain.enums import (
    AccountKind,
    AccountSubtype,
    TransactionStatus,
)
from personal_asset_os.models import (
    Account,
    LedgerTransaction,
    Posting,
)
from personal_asset_os.services import activity_fund, reporting_annotations
from personal_asset_os.services.ledger import ZERO, account_balance, money
from personal_asset_os.services.portfolio import PositionRow
from personal_asset_os.temporal import ensure_utc

SHARE_QUANT = Decimal("0.01")
HUNDRED = Decimal("100.00")
CHART_ITEM_LIMIT = 5
SPENDING_RANGE_MONTHS = {"1m": 1, "3m": 3, "1y": 12}


def calendar_month_start(cutoff: datetime, months: int, reporting_timezone: str) -> datetime:
    local_cutoff = cutoff.astimezone(ZoneInfo(reporting_timezone))
    month_index = local_cutoff.year * 12 + local_cutoff.month - months
    year, zero_based_month = divmod(month_index, 12)
    return local_cutoff.replace(
        year=year,
        month=zero_based_month + 1,
        day=1,
        hour=0,
        minute=0,
        second=0,
        microsecond=0,
    ).astimezone(cutoff.tzinfo)


def _with_shares(items: list[dict[str, object]]) -> list[dict[str, object]]:
    if not items:
        return []
    amounts = [amount for item in items if isinstance((amount := item["amount"]), Decimal)]
    total = sum(amounts, start=ZERO)
    if total <= ZERO:
        return []
    result: list[dict[str, object]] = []
    for item in items:
        amount = item["amount"]
        if not isinstance(amount, Decimal):
            continue
        result.append(
            {
                **item,
                "share_percent": ((amount / total) * HUNDRED).quantize(SHARE_QUANT),
            }
        )
    if result:
        shares = [
            share
            for item in result
            if isinstance((share := item["share_percent"]), Decimal)
        ]
        rounded_total = sum(
            shares,
            start=Decimal("0.00"),
        )
        first_share = result[0]["share_percent"]
        if isinstance(first_share, Decimal):
            result[0]["share_percent"] = first_share + (HUNDRED - rounded_total)
    return result


def _composition(
    items: list[dict[str, object]],
    *,
    status: str | None = None,
    excluded_count: int = 0,
    excluded_amount: Decimal = ZERO,
    policy: str,
) -> dict[str, object]:
    positive_items: list[dict[str, object]] = []
    for item in items:
        amount = item.get("amount")
        if isinstance(amount, Decimal) and amount > ZERO:
            positive_items.append({**item, "amount": money(amount)})
    positive_items.sort(key=lambda item: (-Decimal(str(item["amount"])), str(item["key"])))
    table_items = _with_shares(positive_items)
    chart_source = positive_items[:CHART_ITEM_LIMIT]
    if len(positive_items) > CHART_ITEM_LIMIT:
        other_amount = sum(
            (Decimal(str(item["amount"])) for item in positive_items[CHART_ITEM_LIMIT:]),
            start=ZERO,
        )
        chart_source.append(
            {
                "key": "__other__",
                "label": "其他",
                "amount": money(other_amount),
                "market": None,
                "symbol": None,
                "label_source": "aggregate",
            }
        )
    chart_items = _with_shares(chart_source)
    total = money(
        sum((Decimal(str(item["amount"])) for item in positive_items), start=ZERO)
    )
    resolved_status = status or (
        "partial" if excluded_count or excluded_amount > ZERO else "complete"
    )
    if not positive_items and resolved_status == "complete":
        resolved_status = "empty"
    return {
        "status": resolved_status,
        "currency": "TWD",
        "total": total,
        "item_count": len(table_items),
        "chart_items": chart_items,
        "table_items": table_items,
        "excluded_count": excluded_count,
        "excluded_amount": money(excluded_amount),
        "chart_policy": f"top_{CHART_ITEM_LIMIT}_plus_other",
        "policy": policy,
    }


def _asset_allocation(
    session: Session,
    *,
    cutoff: datetime,
    non_investment_assets: Decimal,
    investment_market_value: Decimal,
    unpriced_investment_cost: Decimal,
    missing_investment_count: int,
) -> tuple[dict[str, object], list[str]]:
    candidates = activity_fund.candidates(session)
    warnings: list[str] = []
    items: list[dict[str, object]] = []
    other_assets = non_investment_assets
    status: str | None = None
    if len(candidates) == 1:
        activity_balance = account_balance(session, candidates[0].id, as_of=cutoff)
        if activity_balance > ZERO:
            items.append(
                {
                    "key": "activity_fund",
                    "label": "活動資金",
                    "amount": activity_balance,
                    "market": None,
                    "symbol": None,
                    "label_source": "activity_fund",
                }
            )
            other_assets -= activity_balance
        elif activity_balance < ZERO:
            warnings.append("活動資金為負值，資產配置圖不將負值畫成圓餅切片")
            status = "partial"
    else:
        warnings.append(
            f"資產配置無法辨識唯一活動資金帳戶（候選 {len(candidates)} 個），已歸入其他資產"
        )
        status = "partial"

    if investment_market_value > ZERO:
        items.append(
            {
                "key": "stocks",
                "label": "股票市值",
                "amount": investment_market_value,
                "market": "TW+US",
                "symbol": None,
                "label_source": "portfolio_valuation",
            }
        )
    if other_assets > ZERO:
        items.append(
            {
                "key": "other_assets",
                "label": "其他資產",
                "amount": other_assets,
                "market": None,
                "symbol": None,
                "label_source": "ledger",
            }
        )
    elif other_assets < ZERO:
        warnings.append("其他資產合計為負值，資產配置圖不將負值畫成圓餅切片")
        status = "partial"

    if missing_investment_count:
        warnings.append(
            f"資產配置排除 {missing_investment_count} 檔缺少 TWD 市值的股票部位；缺值不是零"
        )
    return (
        _composition(
            items,
            status=status,
            excluded_count=missing_investment_count,
            excluded_amount=unpriced_investment_cost,
            policy="正值活動資金、其他非投資資產與可用 TWD 股票市值；負債另列",
        ),
        warnings,
    )


def _stock_allocation(
    positions: list[PositionRow],
) -> tuple[dict[str, object], list[str]]:
    grouped: dict[str, dict[str, object]] = {}
    excluded_count = 0
    for position in positions:
        market_value = position["market_value"]
        if not position["valuation_included"] or market_value is None:
            if position["position_source"] == "kgi_broker" and market_value is None:
                excluded_count += 1
            elif position["valuation_included"] and market_value is None:
                excluded_count += 1
            continue
        if market_value <= ZERO:
            continue
        key = f"{position['market']}:{position['symbol']}"
        existing = grouped.get(key)
        if existing is None:
            grouped[key] = {
                "key": key,
                "label": position["name"] or position["symbol"],
                "amount": market_value,
                "market": position["market"],
                "symbol": position["symbol"],
                "label_source": "position",
                "valuation_status": position["valuation_status"],
                "position_source": position["position_source"],
            }
        else:
            existing_amount = existing["amount"]
            if isinstance(existing_amount, Decimal):
                existing["amount"] = money(existing_amount + market_value)
            if existing["valuation_status"] != position["valuation_status"]:
                existing["valuation_status"] = "mixed"

    warnings = (
        [f"股票占比排除 {excluded_count} 檔缺少 TWD 市值的部位；美股缺 FX 時不會補零"]
        if excluded_count
        else []
    )
    return (
        _composition(
            list(grouped.values()),
            excluded_count=excluded_count,
            policy="合併 TW/US 後按 TWD 市值排序；缺價或缺 FX 的部位排除於分母",
        ),
        warnings,
    )


def _spending_records(
    session: Session,
    *,
    start: datetime,
    cutoff: datetime,
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    rows = session.execute(
        select(
            LedgerTransaction.id,
            LedgerTransaction.occurred_at,
            LedgerTransaction.description,
            Account.subtype,
            func.sum(Posting.base_amount),
        )
        .join(Posting, Posting.transaction_id == LedgerTransaction.id)
        .join(Account, Account.id == Posting.account_id)
        .where(
            Account.kind == AccountKind.EXPENSE,
            LedgerTransaction.status == TransactionStatus.POSTED,
            LedgerTransaction.occurred_at >= start,
            LedgerTransaction.occurred_at <= cutoff,
        )
        .group_by(
            LedgerTransaction.id,
            LedgerTransaction.occurred_at,
            LedgerTransaction.description,
            Account.subtype,
        )
    ).all()
    transaction_ids = {str(row[0]) for row in rows}
    metadata = reporting_annotations.metadata_by_transaction(session, transaction_ids)

    spending: list[dict[str, object]] = []
    fees: list[dict[str, object]] = []
    for transaction_id, occurred_at, description, subtype, raw_amount in rows:
        amount = money(raw_amount or ZERO)
        if amount <= ZERO:
            continue
        record = {
            "transaction_id": str(transaction_id),
            "occurred_at": ensure_utc(occurred_at),
            "description": str(description),
            "amount": amount,
        }
        if subtype == AccountSubtype.INVESTMENT_FEE:
            fees.append(record)
            continue
        reporting_metadata = metadata.get(str(transaction_id))
        if reporting_metadata and reporting_metadata.category:
            record["label"] = reporting_metadata.category
            record["label_source"] = reporting_metadata.category_source or "category_hint"
        elif reporting_metadata and reporting_metadata.merchant:
            record["label"] = reporting_metadata.merchant
            record["label_source"] = "merchant"
        else:
            clean_description = str(description).strip()
            record["label"] = clean_description or "未分類"
            record["label_source"] = "transaction_description"
        spending.append(record)
    return spending, fees


def _spending_composition(
    records: list[dict[str, object]],
    fees: list[dict[str, object]],
    *,
    start: datetime,
    cutoff: datetime,
) -> dict[str, object]:
    grouped_amounts: defaultdict[str, Decimal] = defaultdict(lambda: ZERO)
    display_labels: dict[str, str] = {}
    label_sources: dict[str, str] = {}
    source_priority = {
        "transaction_description": 0,
        "merchant": 1,
        "category_hint": 2,
        "reporting_annotation": 3,
    }
    included_count = 0
    for record in records:
        occurred_at = record["occurred_at"]
        if not isinstance(occurred_at, datetime) or occurred_at < start:
            continue
        label = str(record["label"])
        normalized = " ".join(label.split()).casefold()
        amount = record["amount"]
        if not isinstance(amount, Decimal):
            continue
        grouped_amounts[normalized] += amount
        display_labels.setdefault(normalized, label)
        source = str(record["label_source"])
        previous = label_sources.get(normalized)
        if previous is None or source_priority[source] > source_priority[previous]:
            label_sources[normalized] = source
        included_count += 1

    excluded_fees = [
        record
        for record in fees
        if isinstance(record["occurred_at"], datetime) and record["occurred_at"] >= start
    ]
    excluded_fee_amount = sum(
        (
            record["amount"]
            for record in excluded_fees
            if isinstance(record["amount"], Decimal)
        ),
        start=ZERO,
    )
    composition = _composition(
        [
            {
                "key": f"spending:{key}",
                "label": display_labels[key],
                "amount": money(amount),
                "market": None,
                "symbol": None,
                "label_source": label_sources[key],
            }
            for key, amount in grouped_amounts.items()
        ],
        excluded_count=len(excluded_fees),
        excluded_amount=excluded_fee_amount,
        policy=(
            "金額取自 posted 一般費用 postings；依報表註記、分類提示、店家、交易描述依序分組；"
            "排除已沖銷交易與投資手續費"
        ),
    )
    composition.update(
        {
            "start_at": start,
            "end_at": cutoff,
            "transaction_count": included_count,
        }
    )
    return composition


def build_dashboard_review(
    session: Session,
    *,
    as_of: datetime,
    non_investment_assets: Decimal,
    investment_market_value: Decimal,
    unpriced_investment_cost: Decimal,
    debt: Decimal,
    positions: list[PositionRow],
    reporting_timezone: str = "Asia/Taipei",
) -> tuple[dict[str, object], list[str]]:
    cutoff = ensure_utc(as_of)
    missing_investment_count = sum(
        1
        for position in positions
        if position["market_value"] is None
        and (
            position["valuation_included"]
            or position["position_source"] == "kgi_broker"
        )
    )
    asset_allocation, asset_warnings = _asset_allocation(
        session,
        cutoff=cutoff,
        non_investment_assets=non_investment_assets,
        investment_market_value=investment_market_value,
        unpriced_investment_cost=unpriced_investment_cost,
        missing_investment_count=missing_investment_count,
    )
    stock_allocation, stock_warnings = _stock_allocation(positions)
    starts = {
        range_code: calendar_month_start(cutoff, months, reporting_timezone)
        for range_code, months in SPENDING_RANGE_MONTHS.items()
    }
    records, fees = _spending_records(
        session,
        start=min(starts.values()),
        cutoff=cutoff,
    )
    spending_ranges = {
        range_code: _spending_composition(
            records,
            fees,
            start=start,
            cutoff=cutoff,
        )
        for range_code, start in starts.items()
    }
    return (
        {
            "schema_version": "paos.dashboard_review.v1",
            "as_of": cutoff,
            "base_currency": "TWD",
            "reporting_timezone": reporting_timezone,
            "summary": {
                "gross_assets": money(
                    non_investment_assets
                    + investment_market_value
                    + unpriced_investment_cost
                ),
                "debt": money(debt),
                "provisional_net_worth": money(
                    non_investment_assets
                    + investment_market_value
                    + unpriced_investment_cost
                    - debt
                ),
                "unpriced_investment_cost": money(unpriced_investment_cost),
            },
            "asset_allocation": asset_allocation,
            "stock_allocation": stock_allocation,
            "spending": {
                "default_range": "1m",
                "ranges": spending_ranges,
                "range_semantics": {
                    "1m": "本曆月",
                    "3m": "本月與前 2 個曆月",
                    "1y": "本月與前 11 個曆月",
                },
            },
        },
        [*asset_warnings, *stock_warnings],
    )
