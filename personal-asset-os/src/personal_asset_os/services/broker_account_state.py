"""Account evidence projection. Unqualified cash never becomes an asset."""
from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class BrokerAccountRef(ContractModel):
    opaque_id: str = Field(pattern=r"^kgi_[0-9a-f]{24}$")
    masked_label: str = Field(min_length=4, max_length=40)


class SettlementEntry(ContractModel):
    slot: Literal[1, 2, 3]
    trade_date: date
    settlement_date: date
    currency: Literal["TWD"]
    amount: Decimal
    settle_mark: Literal["Y", "N", ""]
    settlement_status: Literal["unknown"] = "unknown"

    @field_validator("amount")
    @classmethod
    def finite(cls, value: Decimal) -> Decimal:
        if not value.is_finite():
            raise ValueError("nonfinite amount")
        return value


class AccountState(ContractModel):
    schema_version: Literal["broker.account_state.v1"] = "broker.account_state.v1"
    broker: Literal["KGI"] = "KGI"
    captured_at: datetime
    status: Literal["partial", "unavailable"]
    account: BrokerAccountRef | None = None
    settlement_status: Literal["reported", "unavailable"] = "unavailable"
    settlements: tuple[SettlementEntry, ...] = ()
    cash_quality: Literal["qualified", "unqualified", "unavailable"] = "unqualified"
    settled_cash: Decimal | None = None
    settled_cash_currency: Literal["USD"] = "USD"
    settled_cash_source_field: Literal["balance_twd"] = "balance_twd"
    cash_candidate: Decimal | None = None
    cash_candidate_source_field: Literal["balance_twd"] = "balance_twd"
    cash_candidate_currency: Literal["USD"] | None = None
    liquidity_account: BrokerAccountRef | None = None
    liquidity_currency: Literal["USD"] = "USD"
    liquidity_quality: Literal["broker_reported", "unavailable"] = "unavailable"
    buying_power_source_field: Literal["pp3"] = "pp3"
    withdrawable_source_field: Literal["pp5"] = "pp5"
    buying_power: Decimal | None = None
    withdrawable_cash: Decimal | None = None
    pending_receivable: None = None
    pending_payable: None = None
    settlement_net: None = None
    cash_after_settlement: None = None
    valuation_included: Literal[False] = False
    warnings: tuple[str, ...] = ()

    @field_validator("buying_power", "withdrawable_cash", "cash_candidate", "settled_cash")
    @classmethod
    def finite_money(cls, value: Decimal | None) -> Decimal | None:
        if value is not None and not value.is_finite():
            raise ValueError("nonfinite liquidity")
        return value

    @field_validator("captured_at")
    @classmethod
    def utc(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("timezone required")
        return value.astimezone(UTC)
