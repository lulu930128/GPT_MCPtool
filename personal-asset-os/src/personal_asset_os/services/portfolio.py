from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Literal, TypedDict

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from personal_asset_os.domain.enums import (
    AccountKind,
    AccountSubtype,
    AuditAction,
    PriceQuality,
    TradeSide,
)
from personal_asset_os.errors import ConflictError, NotFoundError, ValidationError
from personal_asset_os.models import (
    Account,
    AuditLog,
    Instrument,
    LedgerTransaction,
    PriceFact,
    Trade,
)
from personal_asset_os.services.ledger import (
    MONEY_QUANT,
    ZERO,
    PostingDraft,
    account_balance,
    create_transaction,
    money,
    positive_money,
    require_account,
    system_account,
)
from personal_asset_os.temporal import ensure_utc, utc_now


@dataclass(slots=True)
class PositionState:
    instrument_id: str
    investment_account_id: str
    quantity: Decimal = ZERO
    cost_basis: Decimal = ZERO
    realized_pnl: Decimal = ZERO

    @property
    def average_cost(self) -> Decimal:
        if self.quantity == ZERO:
            return ZERO
        return (self.cost_basis / self.quantity).quantize(MONEY_QUANT)


class PositionRow(TypedDict):
    instrument_id: str
    symbol: str
    market: str
    name: str
    investment_account_id: str
    investment_account_name: str
    quantity: Decimal
    average_cost: Decimal
    cost_basis: Decimal
    realized_pnl: Decimal
    price: Decimal | None
    price_at: datetime | None
    price_provider: str | None
    price_quality: str | None
    price_age_days: int | None
    market_value: Decimal | None
    unrealized_pnl: Decimal | None
    valuation_status: Literal["missing", "stale", "manual"]


def _existing_trade_for_retry(
    session: Session,
    *,
    idempotency_key: str | None,
    side: TradeSide,
    instrument_id: str,
    investment_account_id: str,
    cash_account_id: str,
    quantity: Decimal,
    execution_price: Decimal,
    fee: Decimal,
    tax: Decimal,
    occurred_at: datetime,
    description: str,
) -> LedgerTransaction | None:
    if not idempotency_key:
        return None
    transaction = session.scalar(
        select(LedgerTransaction)
        .options(
            selectinload(LedgerTransaction.trade),
            selectinload(LedgerTransaction.postings),
        )
        .where(LedgerTransaction.idempotency_key == idempotency_key)
    )
    if transaction is None:
        return None
    trade = transaction.trade
    matches = (
        trade is not None
        and trade.side is side
        and trade.instrument_id == instrument_id
        and trade.investment_account_id == investment_account_id
        and trade.cash_account_id == cash_account_id
        and trade.quantity == quantity
        and trade.execution_price == execution_price
        and trade.fee == fee
        and trade.tax == tax
        and transaction.occurred_at == ensure_utc(occurred_at)
        and transaction.description == description.strip()
    )
    if not matches:
        raise ConflictError("相同 idempotency key 對應不同投資交易內容")
    return transaction


def create_instrument(
    session: Session,
    *,
    symbol: str,
    market: str,
    name: str,
    asset_class: str = "equity",
    currency: str = "TWD",
    actor: str = "local_user",
) -> Instrument:
    clean_symbol = symbol.strip().upper()
    clean_market = market.strip().upper()
    if not clean_symbol or not clean_market or not name.strip():
        raise ValidationError("商品代號、市場與名稱不可為空")
    if currency.upper() != "TWD":
        raise ValidationError("第一版只支援 TWD 投資商品")
    existing = session.scalar(
        select(Instrument).where(
            Instrument.symbol == clean_symbol,
            Instrument.market == clean_market,
        )
    )
    if existing is not None:
        raise ConflictError("相同市場與商品代號已存在")
    instrument = Instrument(
        symbol=clean_symbol,
        market=clean_market,
        name=name.strip(),
        asset_class=asset_class.strip().lower() or "equity",
        currency="TWD",
    )
    session.add(instrument)
    session.flush()
    session.add(
        AuditLog(
            entity_type="instrument",
            entity_id=instrument.id,
            action=AuditAction.CREATE,
            actor=actor,
            after_json=None,
        )
    )
    return instrument


def require_instrument(session: Session, instrument_id: str) -> Instrument:
    instrument = session.get(Instrument, instrument_id)
    if instrument is None or not instrument.is_active:
        raise NotFoundError("找不到投資商品", details={"instrument_id": instrument_id})
    return instrument


def _require_investment_account(session: Session, account_id: str) -> Account:
    account = require_account(session, account_id)
    if account.kind is not AccountKind.ASSET or account.subtype is not AccountSubtype.INVESTMENT:
        raise ValidationError("投資帳戶類型不正確")
    return account


def position_state(
    session: Session,
    *,
    instrument_id: str,
    investment_account_id: str,
    as_of: datetime | None = None,
) -> PositionState:
    query = (
        select(Trade, LedgerTransaction)
        .join(LedgerTransaction, LedgerTransaction.id == Trade.transaction_id)
        .where(
            Trade.instrument_id == instrument_id,
            Trade.investment_account_id == investment_account_id,
        )
        .order_by(LedgerTransaction.occurred_at, LedgerTransaction.recorded_at, Trade.id)
    )
    if as_of is not None:
        query = query.where(LedgerTransaction.occurred_at <= ensure_utc(as_of))
    state = PositionState(instrument_id=instrument_id, investment_account_id=investment_account_id)
    for trade, _transaction in session.execute(query):
        if trade.side is TradeSide.BUY:
            state.quantity = (state.quantity + trade.quantity).quantize(MONEY_QUANT)
            gross_cost = (trade.quantity * trade.execution_price).quantize(MONEY_QUANT)
            state.cost_basis = (state.cost_basis + gross_cost).quantize(MONEY_QUANT)
        else:
            state.quantity = (state.quantity - trade.quantity).quantize(MONEY_QUANT)
            state.cost_basis = (state.cost_basis - trade.cost_basis_released).quantize(MONEY_QUANT)
            state.realized_pnl = (state.realized_pnl + trade.realized_pnl).quantize(MONEY_QUANT)
        if state.quantity < ZERO or state.cost_basis < -MONEY_QUANT:
            raise ValidationError("投資交易歷史產生負持倉，請先修正交易順序")
        if state.quantity == ZERO:
            state.cost_basis = ZERO
    return state


def record_price(
    session: Session,
    *,
    instrument_id: str,
    price: Decimal,
    price_at: datetime,
    provider: str = "manual",
    quality: PriceQuality = PriceQuality.MANUAL,
    actor: str = "local_user",
) -> PriceFact:
    instrument = require_instrument(session, instrument_id)
    value = positive_money(price, "價格")
    if not provider.strip():
        raise ValidationError("價格來源不可為空")
    fact = PriceFact(
        instrument_id=instrument.id,
        price=value,
        currency=instrument.currency,
        price_at=ensure_utc(price_at),
        provider=provider.strip(),
        quality=quality,
    )
    session.add(fact)
    session.flush()
    session.add(
        AuditLog(
            entity_type="price",
            entity_id=fact.id,
            action=AuditAction.CREATE,
            actor=actor,
            after_json=None,
        )
    )
    return fact


def buy(
    session: Session,
    *,
    instrument_id: str,
    investment_account_id: str,
    cash_account_id: str,
    quantity: Decimal,
    execution_price: Decimal,
    fee: Decimal,
    tax: Decimal,
    occurred_at: datetime,
    description: str,
    idempotency_key: str | None = None,
    actor: str = "local_user",
) -> tuple[LedgerTransaction, bool]:
    instrument = require_instrument(session, instrument_id)
    investment = _require_investment_account(session, investment_account_id)
    cash = require_account(session, cash_account_id)
    if cash.kind is not AccountKind.ASSET or cash.subtype is AccountSubtype.INVESTMENT:
        raise ValidationError("扣款帳戶必須是非投資資產帳戶")
    qty = positive_money(quantity, "數量")
    price = positive_money(execution_price, "成交價")
    fee_value = money(fee)
    tax_value = money(tax)
    if fee_value < ZERO or tax_value < ZERO:
        raise ValidationError("手續費與稅不可為負數")
    gross = (qty * price).quantize(MONEY_QUANT)
    charges = (fee_value + tax_value).quantize(MONEY_QUANT)
    total = gross + charges

    existing = _existing_trade_for_retry(
        session,
        idempotency_key=idempotency_key,
        side=TradeSide.BUY,
        instrument_id=instrument.id,
        investment_account_id=investment.id,
        cash_account_id=cash.id,
        quantity=qty,
        execution_price=price,
        fee=fee_value,
        tax=tax_value,
        occurred_at=occurred_at,
        description=description,
    )
    if existing is not None:
        return existing, False

    if account_balance(session, cash.id) < total:
        raise ValidationError("投資扣款帳戶餘額不足")
    fee_account = system_account(session, AccountSubtype.INVESTMENT_FEE)
    postings = [
        PostingDraft(cash.id, -total, -total),
        PostingDraft(investment.id, gross, gross),
    ]
    if charges > ZERO:
        postings.append(PostingDraft(fee_account.id, charges, charges))
    transaction, created = create_transaction(
        session,
        occurred_at=occurred_at,
        description=description,
        postings=postings,
        idempotency_key=idempotency_key,
        actor=actor,
    )
    if created:
        session.add(
            Trade(
                transaction_id=transaction.id,
                instrument_id=instrument.id,
                investment_account_id=investment.id,
                cash_account_id=cash.id,
                side=TradeSide.BUY,
                quantity=qty,
                execution_price=price,
                fee=fee_value,
                tax=tax_value,
                cost_basis_released=ZERO,
                realized_pnl=ZERO,
            )
        )
        record_price(
            session,
            instrument_id=instrument.id,
            price=price,
            price_at=occurred_at,
            provider="trade_execution",
            quality=PriceQuality.TRADE_EXECUTION,
            actor=actor,
        )
        session.flush()
    return transaction, created


def sell(
    session: Session,
    *,
    instrument_id: str,
    investment_account_id: str,
    cash_account_id: str,
    quantity: Decimal,
    execution_price: Decimal,
    fee: Decimal,
    tax: Decimal,
    occurred_at: datetime,
    description: str,
    idempotency_key: str | None = None,
    actor: str = "local_user",
) -> tuple[LedgerTransaction, bool]:
    instrument = require_instrument(session, instrument_id)
    investment = _require_investment_account(session, investment_account_id)
    cash = require_account(session, cash_account_id)
    if cash.kind is not AccountKind.ASSET or cash.subtype is AccountSubtype.INVESTMENT:
        raise ValidationError("入款帳戶必須是非投資資產帳戶")
    qty = positive_money(quantity, "數量")
    price = positive_money(execution_price, "成交價")
    fee_value = money(fee)
    tax_value = money(tax)
    if fee_value < ZERO or tax_value < ZERO:
        raise ValidationError("手續費與稅不可為負數")
    existing = _existing_trade_for_retry(
        session,
        idempotency_key=idempotency_key,
        side=TradeSide.SELL,
        instrument_id=instrument.id,
        investment_account_id=investment.id,
        cash_account_id=cash.id,
        quantity=qty,
        execution_price=price,
        fee=fee_value,
        tax=tax_value,
        occurred_at=occurred_at,
        description=description,
    )
    if existing is not None:
        return existing, False
    current = position_state(
        session,
        instrument_id=instrument.id,
        investment_account_id=investment.id,
        as_of=occurred_at,
    )
    if current.quantity < qty:
        raise ValidationError("賣出數量大於可用持倉", details={"available": str(current.quantity)})
    gross = (qty * price).quantize(MONEY_QUANT)
    charges = (fee_value + tax_value).quantize(MONEY_QUANT)
    net_cash = gross - charges
    if net_cash <= ZERO:
        raise ValidationError("交易費用不可大於或等於賣出金額")
    cost_released = (current.average_cost * qty).quantize(MONEY_QUANT)
    gross_gain = (gross - cost_released).quantize(MONEY_QUANT)
    realized_pnl = (gross_gain - charges).quantize(MONEY_QUANT)
    fee_account = system_account(session, AccountSubtype.INVESTMENT_FEE)
    pnl_account = system_account(session, AccountSubtype.REALIZED_PNL)
    postings: list[PostingDraft] = [
        PostingDraft(cash.id, net_cash, net_cash),
        PostingDraft(investment.id, -cost_released, -cost_released),
    ]
    if gross_gain != ZERO:
        postings.append(PostingDraft(pnl_account.id, -gross_gain, -gross_gain))
    if charges > ZERO:
        postings.append(PostingDraft(fee_account.id, charges, charges))
    transaction, created = create_transaction(
        session,
        occurred_at=occurred_at,
        description=description,
        postings=postings,
        idempotency_key=idempotency_key,
        actor=actor,
    )
    if created:
        session.add(
            Trade(
                transaction_id=transaction.id,
                instrument_id=instrument.id,
                investment_account_id=investment.id,
                cash_account_id=cash.id,
                side=TradeSide.SELL,
                quantity=qty,
                execution_price=price,
                fee=fee_value,
                tax=tax_value,
                cost_basis_released=cost_released,
                realized_pnl=realized_pnl,
            )
        )
        record_price(
            session,
            instrument_id=instrument.id,
            price=price,
            price_at=occurred_at,
            provider="trade_execution",
            quality=PriceQuality.TRADE_EXECUTION,
            actor=actor,
        )
        session.flush()
    return transaction, created


def portfolio(session: Session, *, as_of: datetime | None = None) -> list[PositionRow]:
    cutoff = ensure_utc(as_of or utc_now())
    pairs = session.execute(
        select(Trade.instrument_id, Trade.investment_account_id).distinct()
    ).all()
    result: list[PositionRow] = []
    for instrument_id, investment_account_id in pairs:
        state = position_state(
            session,
            instrument_id=instrument_id,
            investment_account_id=investment_account_id,
            as_of=cutoff,
        )
        if state.quantity == ZERO:
            continue
        instrument = require_instrument(session, instrument_id)
        account = require_account(session, investment_account_id)
        latest_price = session.scalar(
            select(PriceFact)
            .where(PriceFact.instrument_id == instrument_id, PriceFact.price_at <= cutoff)
            .order_by(PriceFact.price_at.desc(), PriceFact.created_at.desc())
            .limit(1)
        )
        if latest_price is None:
            market_value: Decimal | None = None
            unrealized_pnl: Decimal | None = None
            valuation_status: Literal["missing", "stale", "manual"] = "missing"
            age_days: int | None = None
            price_value: Decimal | None = None
            price_at: datetime | None = None
            provider: str | None = None
            quality: str | None = None
        else:
            market_value = (state.quantity * latest_price.price).quantize(MONEY_QUANT)
            unrealized_pnl = (market_value - state.cost_basis).quantize(MONEY_QUANT)
            age_days = max((cutoff.date() - latest_price.price_at.date()).days, 0)
            valuation_status = "stale" if age_days > 7 else "manual"
            price_value = latest_price.price
            price_at = latest_price.price_at
            provider = latest_price.provider
            quality = latest_price.quality.value
        result.append(
            {
                "instrument_id": instrument.id,
                "symbol": instrument.symbol,
                "market": instrument.market,
                "name": instrument.name,
                "investment_account_id": account.id,
                "investment_account_name": account.name,
                "quantity": state.quantity,
                "average_cost": state.average_cost,
                "cost_basis": state.cost_basis,
                "realized_pnl": state.realized_pnl,
                "price": price_value,
                "price_at": price_at,
                "price_provider": provider,
                "price_quality": quality,
                "price_age_days": age_days,
                "market_value": market_value,
                "unrealized_pnl": unrealized_pnl,
                "valuation_status": valuation_status,
            }
        )
    return result
