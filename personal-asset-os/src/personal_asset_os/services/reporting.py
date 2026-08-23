from __future__ import annotations

import json
from datetime import datetime
from decimal import Decimal
from typing import cast

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from personal_asset_os.build import source_build_id
from personal_asset_os.domain.enums import (
    AccountKind,
    AccountSubtype,
    AuditAction,
    FinancialEventStatus,
)
from personal_asset_os.errors import NotFoundError, ValidationError
from personal_asset_os.models import (
    Account,
    AppSetting,
    AuditLog,
    BalanceObservation,
    FinancialEvent,
    LedgerTransaction,
    Posting,
    Snapshot,
)
from personal_asset_os.services.broker_read import BrokerReadResult
from personal_asset_os.services.dashboard_review import (
    build_dashboard_review,
    calendar_month_start,
)
from personal_asset_os.services.fx_rates import FxRateProvider
from personal_asset_os.services.ledger import (
    MONEY_QUANT,
    ZERO,
    account_balance,
    money,
    require_account,
)
from personal_asset_os.services.portfolio import portfolio_read_model
from personal_asset_os.services.reporting_annotations import metadata_by_transaction
from personal_asset_os.temporal import ensure_utc, utc_now

CALCULATION_VERSION = "net-worth-v1"


def seed_settings(session: Session) -> None:
    if session.get(AppSetting, "reserved_cash") is None:
        session.add(AppSetting(key="reserved_cash", value="0"))
    if session.get(AppSetting, "base_currency") is None:
        session.add(AppSetting(key="base_currency", value="TWD"))
    session.flush()


def reserved_cash(session: Session) -> Decimal:
    setting = session.get(AppSetting, "reserved_cash")
    return money(setting.value if setting else "0")


def set_reserved_cash(session: Session, value: Decimal) -> Decimal:
    normalized = money(value)
    if normalized < ZERO:
        raise ValidationError("保留現金不可為負數")
    setting = session.get(AppSetting, "reserved_cash")
    if setting is None:
        setting = AppSetting(key="reserved_cash", value=str(normalized))
        session.add(setting)
    else:
        setting.value = str(normalized)
        setting.updated_at = utc_now()
    session.flush()
    return normalized


def record_balance_observation(
    session: Session,
    *,
    account_id: str,
    reported_balance: Decimal,
    observed_at: datetime,
    source: str,
    notes: str | None = None,
    reconciled: bool = False,
    actor: str = "local_user",
) -> BalanceObservation:
    account = require_account(session, account_id)
    value = money(reported_balance)
    if account.kind is AccountKind.LIABILITY and value > ZERO:
        value = -value
    if not source.strip():
        raise ValidationError("對帳來源不可為空")
    observation = BalanceObservation(
        account_id=account.id,
        balance=value,
        observed_at=ensure_utc(observed_at),
        source=source.strip(),
        notes=notes.strip() if notes else None,
        reconciled=reconciled,
    )
    session.add(observation)
    session.flush()
    session.add(
        AuditLog(
            entity_type="balance_observation",
            entity_id=observation.id,
            action=AuditAction.CREATE,
            actor=actor,
            after_json=None,
        )
    )
    return observation


def _monthly_flow(
    session: Session, *, kind: AccountKind, start: datetime, end: datetime
) -> Decimal:
    value = session.scalar(
        select(func.coalesce(func.sum(Posting.base_amount), 0))
        .join(Account, Account.id == Posting.account_id)
        .join(LedgerTransaction, LedgerTransaction.id == Posting.transaction_id)
        .where(
            Account.kind == kind,
            LedgerTransaction.occurred_at >= start,
            LedgerTransaction.occurred_at <= end,
        )
    )
    normalized = money(value or ZERO)
    return -normalized if kind is AccountKind.INCOME else normalized


def dashboard(
    session: Session,
    *,
    as_of: datetime | None = None,
    broker_read: BrokerReadResult | None = None,
    broker_investment_account_id: str | None = None,
    broker_us_investment_account_id: str | None = None,
    fx_provider: FxRateProvider | None = None,
    reporting_timezone: str = "Asia/Taipei",
) -> dict[str, object]:
    cutoff = ensure_utc(as_of or utc_now())
    accounts = list(session.scalars(select(Account).order_by(Account.is_system, Account.name)))
    account_rows: list[dict[str, object]] = []
    non_investment_assets = ZERO
    investment_book_value = ZERO
    debt = ZERO
    liquid_cash = ZERO
    for account in accounts:
        balance = account_balance(session, account.id, as_of=cutoff)
        if account.kind is AccountKind.ASSET:
            if account.subtype is AccountSubtype.INVESTMENT:
                investment_book_value += balance
            else:
                non_investment_assets += balance
            if account.is_liquid:
                liquid_cash += balance
        elif account.kind is AccountKind.LIABILITY:
            debt += max(-balance, ZERO)
        account_rows.append(
            {
                "id": account.id,
                "name": account.name,
                "kind": account.kind.value,
                "subtype": account.subtype.value,
                "currency": account.currency,
                "is_liquid": account.is_liquid,
                "is_system": account.is_system,
                "balance": balance,
                "display_balance": -balance if account.kind is AccountKind.LIABILITY else balance,
            }
        )

    portfolio_view = portfolio_read_model(
        session,
        broker_read=broker_read,
        broker_investment_account_id=broker_investment_account_id,
        broker_us_investment_account_id=broker_us_investment_account_id,
        fx_provider=fx_provider,
        as_of=cutoff,
    )
    positions = portfolio_view.positions
    valued_market = sum(
        (
            value
            for item in positions
            if item["valuation_included"] and (value := item["market_value"]) is not None
        ),
        start=ZERO,
    )
    unpriced_cost = sum(
        (
            cost
            for item in positions
            if item["valuation_included"]
            and item["market_value"] is None
            and (cost := item["cost_basis"]) is not None
        ),
        start=ZERO,
    )
    missing_count = sum(
        1
        for item in positions
        if item["valuation_status"] == "missing"
        and (item["valuation_included"] or item["position_source"] == "kgi_broker")
    )
    stale_count = sum(
        1
        for item in positions
        if item["valuation_included"]
        and item["valuation_status"] in {"stale", "broker_stale"}
    )
    price_times = [
        price_at
        for item in positions
        if item["valuation_included"] and (price_at := item["price_at"]) is not None
    ]
    provisional_net_worth = non_investment_assets + valued_market + unpriced_cost - debt
    known_net_worth = non_investment_assets + valued_market - debt
    reserve = reserved_cash(session)
    available_cash = liquid_cash - debt - reserve

    latest_observations: dict[str, BalanceObservation] = {}
    for observation in session.scalars(
        select(BalanceObservation).order_by(
            BalanceObservation.account_id,
            BalanceObservation.observed_at.desc(),
            BalanceObservation.created_at.desc(),
        )
    ):
        latest_observations.setdefault(observation.account_id, observation)
    reconciliation_rows: list[dict[str, object]] = []
    unresolved_count = 0
    unresolved_total = ZERO
    for account_id, observation in latest_observations.items():
        account = require_account(session, account_id)
        ledger_value = account_balance(session, account_id, as_of=observation.observed_at)
        difference = (observation.balance - ledger_value).quantize(MONEY_QUANT)
        unresolved = difference != ZERO and not observation.reconciled
        if unresolved:
            unresolved_count += 1
            unresolved_total += abs(difference)
        reconciliation_rows.append(
            {
                "id": observation.id,
                "account_id": account.id,
                "account_name": account.name,
                "observed_at": observation.observed_at,
                "source": observation.source,
                "reported_balance": (
                    -observation.balance
                    if account.kind is AccountKind.LIABILITY
                    else observation.balance
                ),
                "ledger_balance": -ledger_value
                if account.kind is AccountKind.LIABILITY
                else ledger_value,
                "difference": difference,
                "reconciled": observation.reconciled,
                "unresolved": unresolved,
            }
        )

    start = calendar_month_start(cutoff, 1, reporting_timezone)
    pending_count = int(
        session.scalar(
            select(func.count())
            .select_from(FinancialEvent)
            .where(FinancialEvent.status == FinancialEventStatus.PENDING_MATCH)
        )
        or 0
    )
    needs_review_count = int(
        session.scalar(
            select(func.count())
            .select_from(FinancialEvent)
            .where(FinancialEvent.status == FinancialEventStatus.NEEDS_REVIEW)
        )
        or 0
    )
    pending_amount = money(
        session.scalar(
            select(func.coalesce(func.sum(FinancialEvent.amount), 0)).where(
                FinancialEvent.status.in_(
                    [FinancialEventStatus.PENDING_MATCH, FinancialEventStatus.NEEDS_REVIEW]
                )
            )
        )
        or ZERO
    )
    warnings = list(portfolio_view.warnings)
    if missing_count:
        warnings.append(f"{missing_count} 個投資部位缺少價格，淨資產包含成本替代值")
    if stale_count:
        warnings.append(f"{stale_count} 個投資部位使用超過 7 日的手動價格")
    if unresolved_count:
        warnings.append(f"{unresolved_count} 個帳戶仍有未解決對帳差額")
    if pending_count or needs_review_count:
        warnings.append(f"{pending_count + needs_review_count} 筆日常記錄尚未進入正式帳本")
    if not accounts or all(account.is_system for account in accounts):
        warnings.append("尚未建立個人帳戶，請先新增帳戶與期初餘額")

    review, review_warnings = build_dashboard_review(
        session,
        as_of=cutoff,
        non_investment_assets=non_investment_assets,
        investment_market_value=valued_market,
        unpriced_investment_cost=unpriced_cost,
        debt=debt,
        positions=positions,
        reporting_timezone=reporting_timezone,
    )
    warnings.extend(review_warnings)

    recent_transaction_rows = list(
        session.scalars(
        select(LedgerTransaction)
        .order_by(LedgerTransaction.occurred_at.desc(), LedgerTransaction.recorded_at.desc())
        .limit(12)
        )
    )
    recent_metadata = metadata_by_transaction(
        session, {transaction.id for transaction in recent_transaction_rows}
    )
    recent_transactions = []
    for transaction in recent_transaction_rows:
        metadata = recent_metadata.get(transaction.id)
        recent_transactions.append(
            {
                "id": transaction.id,
                "occurred_at": transaction.occurred_at,
                "description": transaction.description,
                "category": metadata.category if metadata else None,
                "note": metadata.note if metadata else None,
                "category_source": metadata.category_source if metadata else None,
                "source": transaction.source,
                "status": transaction.status.value,
                "reversal_of_id": transaction.reversal_of_id,
            }
        )

    not_initialized = not accounts or all(account.is_system for account in accounts)
    broker = portfolio_view.broker
    broker_reconciliation_count = sum(
        int(cast(int, broker[key]))
        for key in (
            "quantity_mismatch_count",
            "broker_only_count",
            "unmapped_count",
            "ledger_only_count",
        )
    )
    broker_degraded = broker["status"] in {"unavailable", "stale", "partial"}
    quality_flags = sum(
        [
            bool(missing_count or pending_count or needs_review_count),
            bool(stale_count or broker_degraded),
            bool(unresolved_count or broker_reconciliation_count),
        ]
    )
    if not_initialized:
        quality = "not_initialized"
    elif quality_flags > 1:
        quality = "mixed"
    elif unresolved_count or broker_reconciliation_count:
        quality = "unreconciled"
    elif stale_count or broker_degraded:
        quality = "stale"
    elif missing_count or pending_count or needs_review_count:
        quality = "partial"
    else:
        quality = "complete"
    return {
        "as_of": cutoff,
        "base_currency": "TWD",
        "quality": quality,
        "capture": {
            "pending_count": pending_count,
            "needs_review_count": needs_review_count,
            "pending_amount": pending_amount,
        },
        "metrics": {
            "provisional_net_worth": provisional_net_worth,
            "known_net_worth": known_net_worth,
            "non_investment_assets": non_investment_assets,
            "liquid_cash": liquid_cash,
            "debt": debt,
            "reserved_cash": reserve,
            "available_cash": available_cash,
            "investment_book_value": investment_book_value,
            "investment_market_value": valued_market,
            "broker_market_value": broker["market_value"],
            "broker_position_count": broker["position_count"],
            "broker_unreconciled_count": broker_reconciliation_count,
            "unpriced_investment_cost": unpriced_cost,
            "monthly_income": _monthly_flow(
                session, kind=AccountKind.INCOME, start=start, end=cutoff
            ),
            "monthly_expense": _monthly_flow(
                session, kind=AccountKind.EXPENSE, start=start, end=cutoff
            ),
            "unresolved_count": unresolved_count,
            "unresolved_total": unresolved_total,
        },
        "valuation": {
            "price_as_of_min": min(price_times) if price_times else None,
            "price_as_of_max": max(price_times) if price_times else None,
            "missing_count": missing_count,
            "stale_count": stale_count,
            "policy": "manual prices older than 7 calendar days are marked stale",
        },
        "warnings": warnings,
        "review": review,
        "broker": broker,
        "accounts": account_rows,
        "positions": positions,
        "reconciliations": reconciliation_rows,
        "recent_transactions": recent_transactions,
    }


def _json_default(value: object) -> str:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        return ensure_utc(value).isoformat()
    raise TypeError(f"Unsupported JSON value: {type(value)!r}")


def close_month(
    session: Session,
    *,
    period_key: str,
    as_of: datetime,
    actor: str = "local_user",
) -> tuple[Snapshot, bool]:
    if len(period_key) != 7 or period_key[4] != "-":
        raise ValidationError("period_key 必須是 YYYY-MM")
    try:
        year = int(period_key[:4])
        month = int(period_key[5:])
    except ValueError as exc:
        raise ValidationError("period_key 必須是 YYYY-MM") from exc
    if month < 1 or month > 12:
        raise ValidationError("月份必須介於 01 到 12")
    cutoff = ensure_utc(as_of)
    if cutoff.year != year or cutoff.month != month:
        raise ValidationError("as_of 必須位於指定月份")
    existing = session.scalar(select(Snapshot).where(Snapshot.period_key == period_key))
    if existing is not None:
        return existing, False
    metrics = dashboard(session, as_of=cutoff)
    price_as_of = metrics["valuation"]["price_as_of_max"]  # type: ignore[index]
    snapshot = Snapshot(
        period_key=period_key,
        as_of=cutoff,
        metrics_json=json.dumps(metrics, ensure_ascii=False, sort_keys=True, default=_json_default),
        price_as_of=price_as_of if isinstance(price_as_of, datetime) else None,
        calculation_version=f"{CALCULATION_VERSION}:{source_build_id()}",
        created_by=actor,
    )
    session.add(snapshot)
    session.flush()
    session.add(
        AuditLog(
            entity_type="snapshot",
            entity_id=snapshot.id,
            action=AuditAction.SNAPSHOT,
            actor=actor,
            after_json=None,
        )
    )
    return snapshot, True


def read_snapshot(session: Session, snapshot_id: str) -> dict[str, object]:
    snapshot = session.get(Snapshot, snapshot_id)
    if snapshot is None:
        raise NotFoundError("找不到月結快照")
    return cast(dict[str, object], json.loads(snapshot.metrics_json))
