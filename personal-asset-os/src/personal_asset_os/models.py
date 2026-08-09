from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Enum,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from personal_asset_os.database import Base, UTCDateTime
from personal_asset_os.domain.enums import (
    AccountKind,
    AccountSubtype,
    ApprovalSource,
    AuditAction,
    FinancialEventKind,
    FinancialEventStatus,
    PriceQuality,
    TradeSide,
    TransactionStatus,
)
from personal_asset_os.temporal import utc_now


def new_id() -> str:
    return str(uuid.uuid4())


MONEY = Numeric(20, 6)
QUANTITY = Numeric(24, 8)


class Account(Base):
    __tablename__ = "accounts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    kind: Mapped[AccountKind] = mapped_column(
        Enum(AccountKind, native_enum=False, create_constraint=True), nullable=False
    )
    subtype: Mapped[AccountSubtype] = mapped_column(
        Enum(AccountSubtype, native_enum=False, create_constraint=True), nullable=False
    )
    institution: Mapped[str | None] = mapped_column(String(120))
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="TWD")
    is_liquid: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_system: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utc_now)

    postings: Mapped[list[Posting]] = relationship(back_populates="account")


class LedgerTransaction(Base):
    __tablename__ = "transactions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    occurred_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utc_now)
    description: Mapped[str] = mapped_column(String(240), nullable=False)
    source: Mapped[str] = mapped_column(String(60), nullable=False, default="manual")
    status: Mapped[TransactionStatus] = mapped_column(
        Enum(TransactionStatus, native_enum=False, create_constraint=True),
        nullable=False,
        default=TransactionStatus.POSTED,
    )
    reversal_of_id: Mapped[str | None] = mapped_column(
        ForeignKey("transactions.id", ondelete="RESTRICT"), unique=True
    )
    idempotency_key: Mapped[str | None] = mapped_column(String(120), unique=True)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_by: Mapped[str] = mapped_column(String(80), nullable=False, default="local_user")

    postings: Mapped[list[Posting]] = relationship(
        back_populates="transaction", cascade="all, delete-orphan", order_by="Posting.id"
    )
    trade: Mapped[Trade | None] = relationship(back_populates="transaction", uselist=False)
    reversal_of: Mapped[LedgerTransaction | None] = relationship(
        remote_side="LedgerTransaction.id", foreign_keys=[reversal_of_id]
    )
    financial_event_links: Mapped[list[FinancialEventTransactionLink]] = relationship(
        back_populates="transaction"
    )


class Posting(Base):
    __tablename__ = "postings"
    __table_args__ = (
        CheckConstraint("amount <> 0", name="ck_posting_amount_nonzero"),
        CheckConstraint("base_amount <> 0", name="ck_posting_base_amount_nonzero"),
        Index("ix_postings_account_transaction", "account_id", "transaction_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    transaction_id: Mapped[str] = mapped_column(
        ForeignKey("transactions.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    account_id: Mapped[str] = mapped_column(
        ForeignKey("accounts.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    base_amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    memo: Mapped[str | None] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utc_now)

    transaction: Mapped[LedgerTransaction] = relationship(back_populates="postings")
    account: Mapped[Account] = relationship(back_populates="postings")


class FinancialEvent(Base):
    __tablename__ = "financial_events"
    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_financial_event_amount_positive"),
        Index("ix_financial_events_status_occurred", "status", "occurred_at"),
        Index("ix_financial_events_device_sequence", "device_id", "local_sequence"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    event_kind: Mapped[FinancialEventKind] = mapped_column(
        Enum(FinancialEventKind, native_enum=False, create_constraint=True), nullable=False
    )
    occurred_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    captured_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utc_now)
    amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="TWD")
    description: Mapped[str] = mapped_column(String(240), nullable=False)
    merchant: Mapped[str | None] = mapped_column(String(120))
    note: Mapped[str | None] = mapped_column(String(500))
    category_hint: Mapped[str | None] = mapped_column(String(120))
    payment_hint: Mapped[str | None] = mapped_column(String(120))
    source: Mapped[str] = mapped_column(String(40), nullable=False, default="local_ui")
    source_reference: Mapped[str | None] = mapped_column(String(120))
    device_id: Mapped[str | None] = mapped_column(String(80))
    local_sequence: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[FinancialEventStatus] = mapped_column(
        Enum(FinancialEventStatus, native_enum=False, create_constraint=True),
        nullable=False,
        default=FinancialEventStatus.PENDING_MATCH,
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    idempotency_key: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    ingest_payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    finalization_hash: Mapped[str | None] = mapped_column(String(64))
    approval_source: Mapped[ApprovalSource | None] = mapped_column(
        Enum(ApprovalSource, native_enum=False, create_constraint=True)
    )
    approved_by: Mapped[str | None] = mapped_column(String(80))
    approved_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    matched_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    rejected_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    rejected_reason: Mapped[str | None] = mapped_column(String(240))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utc_now)

    transaction_links: Mapped[list[FinancialEventTransactionLink]] = relationship(
        back_populates="event", cascade="all, delete-orphan"
    )


class FinancialEventTransactionLink(Base):
    __tablename__ = "financial_event_transaction_links"
    __table_args__ = (
        Index(
            "uq_financial_event_transaction_relation",
            "event_id",
            "transaction_id",
            "relation_type",
            unique=True,
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    event_id: Mapped[str] = mapped_column(
        ForeignKey("financial_events.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    transaction_id: Mapped[str] = mapped_column(
        ForeignKey("transactions.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    relation_type: Mapped[str] = mapped_column(String(24), nullable=False, default="finalized")
    allocated_amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utc_now)

    event: Mapped[FinancialEvent] = relationship(back_populates="transaction_links")
    transaction: Mapped[LedgerTransaction] = relationship(back_populates="financial_event_links")


class Instrument(Base):
    __tablename__ = "instruments"
    __table_args__ = (Index("uq_instrument_symbol_market", "symbol", "market", unique=True),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    symbol: Mapped[str] = mapped_column(String(32), nullable=False)
    market: Mapped[str] = mapped_column(String(32), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    asset_class: Mapped[str] = mapped_column(String(40), nullable=False, default="equity")
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="TWD")
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utc_now)


class Trade(Base):
    __tablename__ = "trades"
    __table_args__ = (
        CheckConstraint("quantity > 0", name="ck_trade_quantity_positive"),
        CheckConstraint("execution_price > 0", name="ck_trade_price_positive"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    transaction_id: Mapped[str] = mapped_column(
        ForeignKey("transactions.id", ondelete="RESTRICT"), nullable=False, unique=True
    )
    instrument_id: Mapped[str] = mapped_column(
        ForeignKey("instruments.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    investment_account_id: Mapped[str] = mapped_column(
        ForeignKey("accounts.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    cash_account_id: Mapped[str] = mapped_column(
        ForeignKey("accounts.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    side: Mapped[TradeSide] = mapped_column(
        Enum(TradeSide, native_enum=False, create_constraint=True), nullable=False
    )
    quantity: Mapped[Decimal] = mapped_column(QUANTITY, nullable=False)
    execution_price: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    fee: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=Decimal("0"))
    tax: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=Decimal("0"))
    cost_basis_released: Mapped[Decimal] = mapped_column(
        MONEY, nullable=False, default=Decimal("0")
    )
    realized_pnl: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=Decimal("0"))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utc_now)

    transaction: Mapped[LedgerTransaction] = relationship(back_populates="trade")
    instrument: Mapped[Instrument] = relationship()
    investment_account: Mapped[Account] = relationship(foreign_keys=[investment_account_id])
    cash_account: Mapped[Account] = relationship(foreign_keys=[cash_account_id])


class PriceFact(Base):
    __tablename__ = "prices"
    __table_args__ = (
        CheckConstraint("price > 0", name="ck_price_positive"),
        Index("ix_prices_instrument_asof", "instrument_id", "price_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    instrument_id: Mapped[str] = mapped_column(
        ForeignKey("instruments.id", ondelete="RESTRICT"), nullable=False
    )
    price: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    price_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    provider: Mapped[str] = mapped_column(String(80), nullable=False)
    quality: Mapped[PriceQuality] = mapped_column(
        Enum(PriceQuality, native_enum=False, create_constraint=True), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utc_now)

    instrument: Mapped[Instrument] = relationship()


class BalanceObservation(Base):
    __tablename__ = "balance_observations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    account_id: Mapped[str] = mapped_column(
        ForeignKey("accounts.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    balance: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    observed_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    source: Mapped[str] = mapped_column(String(80), nullable=False)
    notes: Mapped[str | None] = mapped_column(String(240))
    reconciled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utc_now)

    account: Mapped[Account] = relationship()


class Snapshot(Base):
    __tablename__ = "snapshots"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    period_key: Mapped[str] = mapped_column(String(7), nullable=False, unique=True)
    as_of: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    metrics_json: Mapped[str] = mapped_column(Text, nullable=False)
    price_as_of: Mapped[datetime | None] = mapped_column(UTCDateTime())
    calculation_version: Mapped[str] = mapped_column(String(40), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utc_now)
    created_by: Mapped[str] = mapped_column(String(80), nullable=False, default="local_user")


class AuditLog(Base):
    __tablename__ = "audit_logs"
    __table_args__ = (Index("ix_audit_entity", "entity_type", "entity_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    entity_type: Mapped[str] = mapped_column(String(60), nullable=False)
    entity_id: Mapped[str] = mapped_column(String(36), nullable=False)
    action: Mapped[AuditAction] = mapped_column(
        Enum(AuditAction, native_enum=False, create_constraint=True), nullable=False
    )
    before_json: Mapped[str | None] = mapped_column(Text)
    after_json: Mapped[str | None] = mapped_column(Text)
    actor: Mapped[str] = mapped_column(String(80), nullable=False)
    reason: Mapped[str | None] = mapped_column(String(240))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utc_now)


class AppSetting(Base):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utc_now)
