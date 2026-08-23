from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from personal_asset_os.domain.enums import (
    AccountKind,
    AccountSubtype,
    FinancialEventKind,
    PriceQuality,
    TradeSide,
)
from personal_asset_os.temporal import ensure_utc, utc_now


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class AccountCreate(StrictModel):
    name: str = Field(min_length=1, max_length=120)
    kind: AccountKind
    subtype: AccountSubtype
    institution: str | None = Field(default=None, max_length=120)
    currency: str = Field(default="TWD", min_length=3, max_length=3)
    is_liquid: bool = False


class EventRequest(StrictModel):
    occurred_at: datetime = Field(default_factory=utc_now)
    description: str = Field(min_length=1, max_length=240)
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=120)

    @field_validator("occurred_at")
    @classmethod
    def normalize_occurred_at(cls, value: datetime) -> datetime:
        return ensure_utc(value)


class OpeningBalanceRequest(EventRequest):
    account_id: str
    amount: Decimal = Field(gt=0)


class ExpenseRequest(EventRequest):
    payment_account_id: str
    expense_account_id: str | None = None
    amount: Decimal = Field(gt=0)


class IncomeRequest(EventRequest):
    destination_account_id: str
    income_account_id: str | None = None
    amount: Decimal = Field(gt=0)


class TransferRequest(EventRequest):
    from_account_id: str
    to_account_id: str
    amount: Decimal = Field(gt=0)


class CardPaymentRequest(EventRequest):
    bank_account_id: str
    card_account_id: str
    amount: Decimal = Field(gt=0)


class ReversalRequest(StrictModel):
    reason: str = Field(min_length=1, max_length=240)
    occurred_at: datetime = Field(default_factory=utc_now)
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=120)

    @field_validator("occurred_at")
    @classmethod
    def normalize_occurred_at(cls, value: datetime) -> datetime:
        return ensure_utc(value)


class TransactionReportingAnnotationUpsert(StrictModel):
    category: str = Field(min_length=1, max_length=120)
    note: str | None = Field(default=None, max_length=500)
    expected_version: int = Field(ge=0)
    reason: str = Field(min_length=1, max_length=240)


class InstrumentCreate(StrictModel):
    symbol: str = Field(min_length=1, max_length=32)
    market: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=120)
    asset_class: str = Field(default="equity", min_length=1, max_length=40)
    currency: str = Field(default="TWD", min_length=3, max_length=3)


class TradeRequest(EventRequest):
    instrument_id: str
    investment_account_id: str
    cash_account_id: str
    side: TradeSide
    quantity: Decimal = Field(gt=0)
    execution_price: Decimal = Field(gt=0)
    fee: Decimal = Field(default=Decimal("0"), ge=0)
    tax: Decimal = Field(default=Decimal("0"), ge=0)


class PriceCreate(StrictModel):
    instrument_id: str
    price: Decimal = Field(gt=0)
    price_at: datetime = Field(default_factory=utc_now)
    provider: str = Field(default="manual", min_length=1, max_length=80)
    quality: PriceQuality = PriceQuality.MANUAL

    @field_validator("price_at")
    @classmethod
    def normalize_price_at(cls, value: datetime) -> datetime:
        return ensure_utc(value)


class BalanceObservationCreate(StrictModel):
    account_id: str
    reported_balance: Decimal
    observed_at: datetime = Field(default_factory=utc_now)
    source: str = Field(min_length=1, max_length=80)
    notes: str | None = Field(default=None, max_length=240)
    reconciled: bool = False

    @field_validator("observed_at")
    @classmethod
    def normalize_observed_at(cls, value: datetime) -> datetime:
        return ensure_utc(value)


class MonthCloseRequest(StrictModel):
    period_key: str = Field(pattern=r"^\d{4}-\d{2}$")
    as_of: datetime

    @field_validator("as_of")
    @classmethod
    def normalize_as_of(cls, value: datetime) -> datetime:
        return ensure_utc(value)


class ReservedCashUpdate(StrictModel):
    value: Decimal = Field(ge=0)


class FinancialEventCreate(StrictModel):
    id: UUID | None = None
    event_kind: FinancialEventKind = FinancialEventKind.EXPENSE
    occurred_at: datetime = Field(default_factory=utc_now)
    amount: Decimal = Field(gt=0)
    currency: str = Field(default="TWD", min_length=3, max_length=3)
    description: str = Field(min_length=1, max_length=240)
    merchant: str | None = Field(default=None, max_length=120)
    note: str | None = Field(default=None, max_length=500)
    category_hint: str | None = Field(default=None, max_length=120)
    payment_hint: str | None = Field(default=None, max_length=120)
    idempotency_key: str = Field(min_length=8, max_length=120)

    @field_validator("occurred_at")
    @classmethod
    def normalize_event_occurred_at(cls, value: datetime) -> datetime:
        return ensure_utc(value)


class FinancialEventUpdate(StrictModel):
    expected_version: int = Field(ge=1)
    event_kind: FinancialEventKind | None = None
    occurred_at: datetime | None = None
    amount: Decimal | None = Field(default=None, gt=0)
    description: str | None = Field(default=None, min_length=1, max_length=240)
    merchant: str | None = Field(default=None, max_length=120)
    note: str | None = Field(default=None, max_length=500)
    category_hint: str | None = Field(default=None, max_length=120)
    payment_hint: str | None = Field(default=None, max_length=120)

    @field_validator("occurred_at")
    @classmethod
    def normalize_optional_occurred_at(cls, value: datetime | None) -> datetime | None:
        return ensure_utc(value) if value is not None else None

    @field_validator("event_kind", "occurred_at", "amount", "description")
    @classmethod
    def required_patch_values_cannot_be_null(cls, value: object) -> object:
        if value is None:
            raise ValueError("修改欄位不可為 null")
        return value


class FinancialEventRejectRequest(StrictModel):
    expected_version: int = Field(ge=1)
    reason: str = Field(min_length=1, max_length=240)


class FinancialEventFinalizeRequest(StrictModel):
    expected_version: int = Field(ge=1)
    payment_account_id: str | None = None
    destination_account_id: str | None = None


class MobilePairRequest(StrictModel):
    pairing_code: str = Field(min_length=12, max_length=20)
    device_id: str = Field(min_length=1, max_length=80)
    display_name: str = Field(min_length=1, max_length=120)


class MobileEventIngestRequest(StrictModel):
    schema_version: Literal[1, 2, 3]
    id: str = Field(min_length=36, max_length=36)
    event_kind: Literal[FinancialEventKind.EXPENSE, FinancialEventKind.INCOME]
    occurred_at: str = Field(min_length=24, max_length=24)
    captured_at: str = Field(min_length=24, max_length=24)
    amount: str = Field(pattern=r"^(?:0|[1-9]\d{0,12})(?:\.\d?[1-9])?$")
    currency: Literal["TWD"]
    description: str = Field(default="", max_length=240)
    category_hint: str | None = Field(default=None, max_length=120)
    merchant: str | None = Field(default=None, max_length=120)
    note: str | None = Field(default=None, max_length=500)
    payment_hint: str | None = Field(default=None, max_length=120)
    source: Literal["mobile_sync"]
    device_id: str = Field(min_length=1, max_length=80)
    local_sequence: int = Field(ge=1)
    idempotency_key: str = Field(min_length=8, max_length=120)
    payload_hash: str = Field(pattern=r"^[0-9a-fA-F]{64}$")

    @field_validator("id")
    @classmethod
    def validate_canonical_event_id(cls, value: str) -> str:
        try:
            canonical = str(UUID(value))
        except ValueError as exc:
            raise ValueError("id 必須是 UUID") from exc
        if value != canonical:
            raise ValueError("id 必須使用標準小寫 UUID 格式")
        return value

    @field_validator("occurred_at", "captured_at")
    @classmethod
    def validate_mobile_timestamp(cls, value: str) -> str:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("時間必須是 UTC ISO 8601 格式") from exc
        canonical = parsed.astimezone(UTC).isoformat(timespec="milliseconds").replace(
            "+00:00", "Z"
        )
        if value != canonical:
            raise ValueError("時間必須是 UTC ISO 8601 毫秒格式")
        return value

    @field_validator("amount")
    @classmethod
    def validate_mobile_amount(cls, value: str) -> str:
        if Decimal(value) <= 0:
            raise ValueError("amount 必須大於零")
        return value

    @model_validator(mode="after")
    def validate_capture_copy(self) -> MobileEventIngestRequest:
        if self.schema_version >= 3:
            if not self.category_hint:
                raise ValueError("schema version 3 必須提供分類")
            return self
        if self.category_hint is not None:
            raise ValueError("舊版手機 payload 不支援分類欄位")
        if not self.description:
            raise ValueError("舊版手機 payload 必須提供描述")
        return self


class ErrorEnvelope(BaseModel):
    error: dict[str, object]
