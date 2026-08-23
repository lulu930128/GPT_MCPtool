from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Literal, TypedDict, cast

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
from personal_asset_os.services.broker_read import (
    BrokerMarketScopeV2,
    BrokerPositionV2,
    BrokerReadResult,
    BrokerSnapshot,
    BrokerSnapshotV2,
    BrokerValuationV2,
)
from personal_asset_os.services.fx_rates import FxRateProvider, FxReadResult
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
    average_cost: Decimal | None
    cost_basis: Decimal | None
    realized_pnl: Decimal | None
    price: Decimal | None
    price_at: datetime | None
    price_provider: str | None
    price_quality: str | None
    price_age_days: int | None
    market_value: Decimal | None
    unrealized_pnl: Decimal | None
    valuation_status: Literal[
        "missing",
        "stale",
        "manual",
        "broker_live",
        "broker_stale",
        "broker_derived",
        "ledger_only",
    ]
    position_source: Literal["ledger", "kgi_broker"]
    valuation_included: bool
    reconciliation_status: Literal[
        "not_applicable",
        "matched",
        "quantity_mismatch",
        "broker_only",
        "unmapped",
        "ledger_only",
    ]
    ledger_quantity: Decimal | None
    broker_unrealized_pnl: Decimal | None
    native_currency: str
    native_price: Decimal | None
    native_market_value: Decimal | None
    settlement_currency: str | None
    fx_rate: Decimal | None
    fx_at: datetime | None
    fx_provider: str | None
    fx_quality: str | None


@dataclass(frozen=True, slots=True)
class PortfolioReadModel:
    positions: list[PositionRow]
    broker: dict[str, object]
    warnings: tuple[str, ...]


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
                "position_source": "ledger",
                "valuation_included": True,
                "reconciliation_status": "not_applicable",
                "ledger_quantity": state.quantity,
                "broker_unrealized_pnl": None,
                "native_currency": instrument.currency,
                "native_price": price_value,
                "native_market_value": market_value,
                "settlement_currency": instrument.currency,
                "fx_rate": Decimal(1),
                "fx_at": price_at,
                "fx_provider": "identity.TWD",
                "fx_quality": "identity",
            }
        )
    return result


def portfolio_read_model(
    session: Session,
    *,
    broker_read: BrokerReadResult | None = None,
    broker_investment_account_id: str | None = None,
    broker_us_investment_account_id: str | None = None,
    fx_provider: FxRateProvider | None = None,
    as_of: datetime | None = None,
) -> PortfolioReadModel:
    cutoff = ensure_utc(as_of or utc_now())
    ledger_rows = portfolio(session, as_of=cutoff)
    read = broker_read or BrokerReadResult.disabled(now=cutoff)
    snapshot = read.snapshot
    if snapshot is None:
        return PortfolioReadModel(
            positions=ledger_rows,
            broker={
                "schema_version": "paos.broker_valuation.v2",
                "enabled": read.status != "disabled",
                "status": read.status,
                "read_mode": read.read_mode,
                "broker": "KGI",
                "account": None,
                "accounts": [],
                "markets": [],
                "captured_at": None,
                "source_as_of": None,
                "market_value": ZERO,
                "native_market_values": {},
                "fx": None,
                "position_count": 0,
                "matched_count": 0,
                "quantity_mismatch_count": 0,
                "broker_only_count": 0,
                "unmapped_count": 0,
                "ledger_only_count": 0,
                "policy": "read-time overlay; no broker data is written to the PAOS database",
            },
            warnings=read.warnings,
        )

    scopes = _broker_scopes(snapshot)
    mappings = {
        "TW": broker_investment_account_id,
        "US": broker_us_investment_account_id,
    }
    needs_fx = any(
        scope.market == "US" and scope.status == "complete" and scope.positions
        for scope in scopes
    )
    fx_read = (
        fx_provider.read(now=cutoff)
        if needs_fx and fx_provider is not None
        else FxReadResult.unavailable(
            now=cutoff,
            warnings=("USD/TWD 匯率 provider 未設定；USD 部位未換算為 TWD",),
        )
        if needs_fx
        else None
    )
    fx_fact = fx_read.fact if fx_read and fx_read.fact is not None else None

    broker_rows: list[PositionRow] = []
    usable_broker_keys: set[tuple[str, str]] = set()
    broker_keys: set[tuple[str, str]] = set()
    matched_count = 0
    mismatch_count = 0
    broker_only_count = 0
    unmapped_count = 0
    derived_count = 0
    missing_market_count = 0

    scope_quantities: dict[str, set[str]] = {"TW": set(), "US": set()}
    for scope in scopes:
        if scope.status != "complete" or scope.account is None:
            continue
        quantities: dict[str, Decimal] = {}
        position_names: dict[str, str] = {}
        settlements: dict[str, str | None] = {}
        for item in scope.positions:
            symbol = _normalized_symbol(item.symbol)
            quantities[symbol] = quantities.get(symbol, ZERO) + item.quantity
            position_names.setdefault(symbol, item.name)
            settlements.setdefault(symbol, item.settlement_currency)
        valuations = {
            _normalized_symbol(item.symbol): item for item in scope.valuations
        }
        mapping = mappings[scope.market]
        scoped_rows = [
            row for row in ledger_rows if mapping and row["investment_account_id"] == mapping
        ]
        scoped_by_symbol: dict[str, list[PositionRow]] = {}
        for row in scoped_rows:
            scoped_by_symbol.setdefault(_normalized_symbol(row["symbol"]), []).append(row)

        for symbol in sorted(quantities):
            scope_quantities[scope.market].add(symbol)
            key = (scope.market, symbol)
            broker_keys.add(key)
            quantity = quantities[symbol]
            valuation = valuations[symbol]
            native_market_value = valuation.native_market_value
            derived = False
            if (
                native_market_value is None
                and valuation.last_price is not None
                and quantity > ZERO
            ):
                native_market_value = quantity * valuation.last_price
                derived = True
                derived_count += 1
            native_market_value = (
                native_market_value.quantize(MONEY_QUANT)
                if native_market_value is not None
                else None
            )
            fx_rate = Decimal(1) if scope.market == "TW" else fx_fact.rate if fx_fact else None
            market_value = (
                (native_market_value * fx_rate).quantize(MONEY_QUANT)
                if native_market_value is not None and fx_rate is not None
                else None
            )
            if market_value is None:
                missing_market_count += 1
            else:
                usable_broker_keys.add(key)

            matching_rows = scoped_by_symbol.get(symbol, [])
            ledger_quantity = sum((row["quantity"] for row in matching_rows), start=ZERO)
            quantities_match = bool(matching_rows) and ledger_quantity == quantity
            reconciliation_status: Literal[
                "matched", "quantity_mismatch", "broker_only", "unmapped"
            ]
            if not mapping:
                reconciliation_status = "unmapped"
                unmapped_count += 1
            elif not matching_rows:
                reconciliation_status = "broker_only"
                broker_only_count += 1
            elif quantities_match:
                reconciliation_status = "matched"
                matched_count += 1
            else:
                reconciliation_status = "quantity_mismatch"
                mismatch_count += 1

            ledger_cost = sum(
                (row["cost_basis"] for row in matching_rows if row["cost_basis"] is not None),
                start=ZERO,
            )
            ledger_realized = sum(
                (
                    row["realized_pnl"]
                    for row in matching_rows
                    if row["realized_pnl"] is not None
                ),
                start=ZERO,
            )
            comparable_cost = ledger_cost if quantities_match else None
            average_cost = (
                (ledger_cost / ledger_quantity).quantize(MONEY_QUANT)
                if quantities_match and ledger_quantity != ZERO
                else None
            )
            unrealized = (
                (market_value - ledger_cost).quantize(MONEY_QUANT)
                if market_value is not None and comparable_cost is not None
                else None
            )
            age_days = (
                max((cutoff.date() - valuation.price_as_of.date()).days, 0)
                if valuation.price_as_of
                else None
            )
            valuation_status: Literal[
                "missing", "broker_live", "broker_stale", "broker_derived"
            ]
            if native_market_value is None or market_value is None:
                valuation_status = "missing"
            elif read.status == "stale" or (fx_read and fx_read.status == "stale"):
                valuation_status = "broker_stale"
            elif derived:
                valuation_status = "broker_derived"
            else:
                valuation_status = "broker_live"
            broker_pnl = valuation.broker_unrealized_pnl_twd
            if broker_pnl is None and valuation.broker_unrealized_pnl_native is not None:
                broker_pnl = (
                    valuation.broker_unrealized_pnl_native * fx_rate
                    if fx_rate is not None
                    else None
                )
            broker_rows.append(
                {
                    "instrument_id": f"broker:kgi:{scope.market}:{symbol}",
                    "symbol": symbol,
                    "market": scope.market,
                    "name": valuation.name or position_names[symbol],
                    "investment_account_id": scope.account.opaque_id,
                    "investment_account_name": f"KGI {scope.account.masked_label}",
                    "quantity": quantity,
                    "average_cost": average_cost,
                    "cost_basis": comparable_cost,
                    "realized_pnl": ledger_realized if quantities_match else None,
                    "price": valuation.last_price,
                    "price_at": valuation.price_as_of,
                    "price_provider": scope.source,
                    "price_quality": "broker_derived" if derived else valuation.price_quality,
                    "price_age_days": age_days,
                    "market_value": market_value,
                    "unrealized_pnl": unrealized,
                    "valuation_status": valuation_status,
                    "position_source": "kgi_broker",
                    "valuation_included": market_value is not None,
                    "reconciliation_status": reconciliation_status,
                    "ledger_quantity": ledger_quantity if matching_rows else None,
                    "broker_unrealized_pnl": broker_pnl,
                    "native_currency": valuation.currency,
                    "native_price": valuation.last_price,
                    "native_market_value": native_market_value,
                    "settlement_currency": settlements[symbol],
                    "fx_rate": fx_rate,
                    "fx_at": (
                        valuation.price_as_of
                        if scope.market == "TW"
                        else fx_fact.effective_at if fx_fact else None
                    ),
                    "fx_provider": (
                        "identity.TWD"
                        if scope.market == "TW"
                        else fx_fact.provider if fx_fact else None
                    ),
                    "fx_quality": (
                        "identity"
                        if scope.market == "TW"
                        else fx_fact.quality if fx_fact else None
                    ),
                }
            )

    projected_ledger_rows: list[PositionRow] = []
    ledger_only_count = 0
    for row in ledger_rows:
        mapped_markets = [
            market
            for market, account_id in mappings.items()
            if account_id == row["investment_account_id"]
        ]
        is_scoped = bool(mapped_markets)
        symbol = _normalized_symbol(row["symbol"])
        if not is_scoped:
            projected_ledger_rows.append(row)
            continue
        if any((market, symbol) in usable_broker_keys for market in mapped_markets):
            continue
        relevant_scopes = [scope for scope in scopes if scope.market in mapped_markets]
        if any(scope.status == "unavailable" for scope in relevant_scopes) and not any(
            (market, symbol) in broker_keys for market in mapped_markets
        ):
            projected_ledger_rows.append(row)
            continue
        if not any(symbol in scope_quantities[market] for market in mapped_markets):
            ledger_only_count += 1
            projected_ledger_rows.append(
                cast(
                    PositionRow,
                    {
                        **row,
                        "valuation_included": False,
                        "valuation_status": "ledger_only",
                        "reconciliation_status": "ledger_only",
                    },
                )
            )
            continue
        projected_ledger_rows.append(row)

    warnings = list(read.warnings)
    if any(scope.status == "explicit_empty" and mappings[scope.market] for scope in scopes):
        warnings.append("KGI 明確回報空持倉；已連結帳戶的 Ledger 投資列不納入即時估值")
    for scope in scopes:
        warnings.extend(scope.warnings)
        if scope.status == "unavailable":
            warnings.append(f"KGI {scope.market} 持倉目前不可用；該市場未被解讀為零持倉")
    if fx_read:
        warnings.extend(fx_read.warnings)
    if unmapped_count:
        warnings.append("KGI 券商帳戶尚未連結對應市場的 PAOS 投資帳戶；券商持倉以外部唯讀資產納入")
    if mismatch_count:
        warnings.append(f"{mismatch_count} 個 KGI 部位與 PAOS Ledger 數量不同，成本損益暫不比較")
    if broker_only_count:
        warnings.append(f"{broker_only_count} 個 KGI 部位尚未存在於已連結的 PAOS Ledger 帳戶")
    if ledger_only_count:
        warnings.append(f"{ledger_only_count} 個 Ledger 部位未出現在 KGI 快照，已排除券商即時估值")
    if derived_count:
        warnings.append(f"{derived_count} 個 KGI 部位缺少券商市值，改以數量乘即時價暫估")
    if missing_market_count:
        warnings.append(f"{missing_market_count} 個 KGI 部位缺少可用市值，未納入投資市值")

    broker_market_value = sum(
        (
            row["market_value"]
            for row in broker_rows
            if row["valuation_included"] and row["market_value"] is not None
        ),
        start=ZERO,
    )
    native_market_values: dict[str, Decimal] = {}
    for row in broker_rows:
        native_value = row["native_market_value"]
        if native_value is not None:
            currency = row["native_currency"]
            native_market_values[currency] = native_market_values.get(currency, ZERO) + native_value
    accounts = [
        {
            "market": scope.market,
            "opaque_id": scope.account.opaque_id,
            "masked_label": scope.account.masked_label,
            "ledger_account_id": mappings[scope.market],
            "status": scope.status,
        }
        for scope in scopes
        if scope.account is not None
    ]
    markets = [
        {
            "market": scope.market,
            "status": scope.status,
            "source": scope.source,
            "source_as_of": scope.source_as_of,
            "position_count": len(scope.positions),
            "valuation_count": len(scope.valuations),
            "error_code": scope.error_code,
        }
        for scope in scopes
    ]
    source_times = [scope.source_as_of for scope in scopes if scope.source_as_of is not None]
    summary_status = read.status
    if summary_status not in {"disabled", "unavailable", "stale"} and (
        any(scope.status == "unavailable" for scope in scopes)
        or (needs_fx and fx_fact is None)
    ):
        summary_status = "partial"
    return PortfolioReadModel(
        positions=projected_ledger_rows + broker_rows,
        broker={
            "schema_version": "paos.broker_valuation.v2",
            "enabled": True,
            "status": summary_status,
            "read_mode": read.read_mode,
            "broker": snapshot.broker,
            "account": next((item for item in accounts if item["market"] == "TW"), None),
            "accounts": accounts,
            "markets": markets,
            "captured_at": snapshot.captured_at,
            "source_as_of": min(source_times) if source_times else None,
            "market_value": broker_market_value.quantize(MONEY_QUANT),
            "native_market_values": {
                currency: value.quantize(MONEY_QUANT)
                for currency, value in native_market_values.items()
            },
            "fx": (
                {
                    "status": fx_read.status,
                    "read_mode": fx_read.read_mode,
                    "base_currency": fx_fact.base_currency,
                    "quote_currency": fx_fact.quote_currency,
                    "rate": fx_fact.rate,
                    "effective_at": fx_fact.effective_at,
                    "provider": fx_fact.provider,
                    "quality": fx_fact.quality,
                    "effective_precision": fx_fact.effective_precision,
                }
                if fx_read and fx_fact
                else {"status": fx_read.status, "read_mode": fx_read.read_mode}
                if fx_read
                else None
            ),
            "position_count": len(broker_rows),
            "matched_count": matched_count,
            "quantity_mismatch_count": mismatch_count,
            "broker_only_count": broker_only_count,
            "unmapped_count": unmapped_count,
            "ledger_only_count": ledger_only_count,
            "policy": (
                "read-time TW/US overlay; USD enters TWD totals only with a traceable FX fact"
            ),
        },
        warnings=tuple(dict.fromkeys(warnings)),
    )


def _broker_scopes(
    snapshot: BrokerSnapshot | BrokerSnapshotV2,
) -> tuple[BrokerMarketScopeV2, ...]:
    if isinstance(snapshot, BrokerSnapshotV2):
        return snapshot.scopes
    positions = tuple(
        BrokerPositionV2(
            market="TW",
            symbol=item.symbol,
            name=item.name,
            currency="TWD",
            settlement_currency="TWD",
            position_type=item.position_type,
            quantity=item.quantity,
            average_cost=item.average_cost,
        )
        for item in snapshot.positions
    )
    valuations = tuple(
        BrokerValuationV2(
            market="TW",
            symbol=item.symbol,
            name=item.name,
            currency="TWD",
            last_price=item.last_price,
            native_market_value=item.broker_market_value,
            price_as_of=snapshot.source_as_of if item.last_price is not None else None,
            price_quality="broker_reported" if item.last_price is not None else "missing",
            broker_unrealized_pnl_native=item.broker_unrealized_pnl,
            broker_unrealized_pnl_twd=item.broker_unrealized_pnl_twd,
        )
        for item in snapshot.valuations
    )
    tw_scope = BrokerMarketScopeV2(
        market="TW",
        account=snapshot.account,
        status=snapshot.status,
        source="kgi.inventory_sum",
        source_as_of=snapshot.source_as_of,
        positions=positions,
        valuations=valuations,
        warnings=snapshot.warnings,
    )
    return (tw_scope,)


def _normalized_symbol(value: str) -> str:
    return value.strip().upper()
