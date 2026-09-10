"""Account evidence projection. Unqualified cash never becomes an asset."""
from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import field_validator

from kgi_broker_bridge.contracts import BrokerAccountRef, ContractModel
from kgi_broker_bridge.identity import AccountIdentityProjector


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


def normalize_account_state(
    raw: Mapping[str, object], captured_at: datetime, identity: AccountIdentityProjector
) -> AccountState:
    source_time = raw.get("captured_at")
    if source_time is not None:
        try:
            captured_at = datetime.fromisoformat(str(source_time))
            if captured_at.tzinfo is None:
                raise ValueError("timezone")
        except ValueError:
            return AccountState(captured_at=datetime.now(UTC), status="unavailable",
                                warnings=("account_state_timestamp_invalid",))
    warnings = ["settlement_pending_semantics_unqualified"]
    entries: list[SettlementEntry] = []
    account = None
    try:
        reference = raw.get("account_ref")
        if not isinstance(reference, str) or not reference.strip():
            raise ValueError("account unavailable")
        account = identity.project(reference)
        rows = raw.get("rows")
        if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
            raise ValueError("ambiguous settlement response")
        row = rows[0]
        for slot in (1, 2, 3):
            entries.append(SettlementEntry(
                slot=slot,
                trade_date=datetime.strptime(str(row[f"DealDate{slot}"]), "%Y%m%d").date(),
                settlement_date=datetime.strptime(str(row[f"CDate{slot}"]), "%Y%m%d").date(),
                currency=row["CURRENCY"],
                amount=Decimal(str(row[f"CSRPAMT{slot}"]).replace(",", "")),
                settle_mark=row[f"SettleMark{slot}"],
            ))
    except (KeyError, ValueError, TypeError, ArithmeticError):
        entries = []
        warnings.append("kgi_settlement_unavailable")
    liquidity_account = None
    buying_power = withdrawable = None
    cash_candidate = None
    try:
        liquidity = raw["liquidity"]
        if not isinstance(liquidity, dict):
            raise ValueError("liquidity")
        liquidity_rows = liquidity["rows"]
        if not isinstance(liquidity_rows, list) or len(liquidity_rows) != 1:
            raise ValueError("liquidity rows")
        item = liquidity_rows[0]
        if item["currency"] != "USD":
            raise ValueError("currency")
        liquidity_account = identity.project(liquidity["account_ref"])
        def amount(field: str) -> Decimal | None:
            try:
                value = Decimal(str(item[field]).replace(",", ""))
                if value.is_finite():
                    return value
            except (KeyError, ValueError, TypeError, ArithmeticError):
                pass
            warnings.append(f"kgi_{field}_unavailable")
            return None

        buying_power = amount("pp3")
        withdrawable = amount("pp5")
        # User-qualified USD response semantics; the vendor field name is misleading.
        cash_candidate = amount("balance_twd")
    except (KeyError, ValueError, TypeError, ArithmeticError, AttributeError):
        buying_power = withdrawable = None
        warnings.append("kgi_liquidity_unavailable")
    return AccountState(
        captured_at=captured_at,
        status="partial" if entries or any(value is not None for value in (
            cash_candidate, buying_power, withdrawable
        )) else "unavailable",
        account=account, settlements=tuple(entries),
        liquidity_account=liquidity_account, buying_power=buying_power,
        cash_candidate=cash_candidate, settled_cash=cash_candidate,
        cash_candidate_currency="USD",
        cash_quality="qualified" if cash_candidate is not None else "unavailable",
        withdrawable_cash=withdrawable,
        liquidity_quality="broker_reported" if buying_power is not None else "unavailable",
        settlement_status="reported" if entries else "unavailable", warnings=tuple(warnings),
    )
