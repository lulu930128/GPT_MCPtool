from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Literal, Self

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_serializer,
    field_validator,
    model_validator,
)


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("datetime must include a timezone")
    return value.astimezone(UTC)


def _decimal_text(value: Decimal | None) -> str | None:
    return None if value is None else format(value, "f")


def _symbol(value: str) -> str:
    normalized = value.strip().upper()
    if not normalized:
        raise ValueError("symbol must not be empty")
    return normalized


def _name(value: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError("name must not be empty")
    return normalized


def _quantity(value: Decimal) -> Decimal:
    if not value.is_finite() or value == 0:
        raise ValueError("quantity must be a finite non-zero Decimal")
    return value


def _average_cost(value: Decimal | None) -> Decimal | None:
    if value is not None and (not value.is_finite() or value <= 0):
        raise ValueError("average_cost must be a finite positive Decimal")
    return value


def _last_price(value: Decimal | None) -> Decimal | None:
    if value is not None and (not value.is_finite() or value <= 0):
        raise ValueError("last_price must be a finite positive Decimal")
    return value


def _market_value(value: Decimal | None) -> Decimal | None:
    if value is not None and (not value.is_finite() or value < 0):
        raise ValueError("market value must be a finite non-negative Decimal")
    return value


def _pnl(value: Decimal | None) -> Decimal | None:
    if value is not None and not value.is_finite():
        raise ValueError("broker PnL must be a finite Decimal")
    return value


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class HealthStatus(StrEnum):
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    NOT_CONFIGURED = "not_configured"
    AUTH_FAILED = "auth_failed"
    CA_FAILED = "ca_failed"
    ACCOUNT_UNAVAILABLE = "account_unavailable"
    TIMEOUT = "timeout"
    DISCONNECTED = "disconnected"
    INTERNAL_ERROR = "internal_error"


class SnapshotStatus(StrEnum):
    COMPLETE = "complete"
    EXPLICIT_EMPTY = "explicit_empty"


class AggregateSnapshotStatus(StrEnum):
    COMPLETE = "complete"
    PARTIAL = "partial"
    EXPLICIT_EMPTY = "explicit_empty"


class MarketScopeStatus(StrEnum):
    COMPLETE = "complete"
    EXPLICIT_EMPTY = "explicit_empty"
    UNAVAILABLE = "unavailable"


class PriceQuality(StrEnum):
    BROKER_REPORTED = "broker_reported"
    BROKER_SNAPSHOT = "broker_snapshot"
    BROKER_CLOSE = "broker_close"
    MISSING = "missing"


class PositionType(StrEnum):
    CASH = "cash"
    MARGIN = "margin"
    SHORT = "short"
    ODD_LOT = "odd_lot"


class BrokerHealth(ContractModel):
    schema_version: Literal["broker.health.v1"] = "broker.health.v1"
    broker: Literal["KGI"] = "KGI"
    status: HealthStatus
    package_version: str | None = None
    login: bool | None = None
    ca: bool | None = None
    account: bool | None = None
    quote: bool | None = None
    positions: bool | None = None
    checked_at: datetime
    last_success_at: datetime | None = None
    warnings: tuple[str, ...] = Field(default_factory=tuple)

    _normalize_checked_at = field_validator("checked_at")(_utc)
    _normalize_last_success_at = field_validator("last_success_at")(
        lambda value: None if value is None else _utc(value)
    )


class BrokerAccountRef(ContractModel):
    opaque_id: str = Field(pattern=r"^kgi_[0-9a-f]{24}$")
    masked_label: str = Field(min_length=4, max_length=40)


class BrokerPosition(ContractModel):
    market: Literal["TW"] = "TW"
    symbol: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=120)
    currency: Literal["TWD"] = "TWD"
    position_type: PositionType
    quantity: Decimal
    average_cost: Decimal | None = None

    @field_validator("symbol")
    @classmethod
    def normalize_symbol(cls, value: str) -> str:
        return _symbol(value)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        return _name(value)

    @field_validator("quantity")
    @classmethod
    def quantity_must_be_nonzero(cls, value: Decimal) -> Decimal:
        return _quantity(value)

    @field_validator("average_cost")
    @classmethod
    def average_cost_must_be_positive(cls, value: Decimal | None) -> Decimal | None:
        return _average_cost(value)

    @field_serializer("quantity", when_used="json")
    def serialize_quantity(self, value: Decimal) -> str:
        return format(value, "f")

    @field_serializer("average_cost", when_used="json")
    def serialize_average_cost(self, value: Decimal | None) -> str | None:
        return _decimal_text(value)


class BrokerInstrumentValuation(ContractModel):
    market: Literal["TW"] = "TW"
    symbol: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=120)
    currency: Literal["TWD"] = "TWD"
    last_price: Decimal | None = None
    broker_market_value: Decimal | None = None
    broker_unrealized_pnl: Decimal | None = None
    broker_unrealized_pnl_twd: Decimal | None = None

    @field_validator("symbol")
    @classmethod
    def normalize_symbol(cls, value: str) -> str:
        return _symbol(value)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        return _name(value)

    @field_validator("last_price")
    @classmethod
    def last_price_must_be_positive(cls, value: Decimal | None) -> Decimal | None:
        return _last_price(value)

    @field_validator("broker_market_value")
    @classmethod
    def market_value_must_be_nonnegative(cls, value: Decimal | None) -> Decimal | None:
        return _market_value(value)

    @field_validator("broker_unrealized_pnl", "broker_unrealized_pnl_twd")
    @classmethod
    def pnl_must_be_finite(cls, value: Decimal | None) -> Decimal | None:
        return _pnl(value)

    @field_serializer(
        "last_price",
        "broker_market_value",
        "broker_unrealized_pnl",
        "broker_unrealized_pnl_twd",
        when_used="json",
    )
    def serialize_decimal(self, value: Decimal | None) -> str | None:
        return _decimal_text(value)


class BrokerPositionSnapshot(ContractModel):
    schema_version: Literal["broker.position.v1"] = "broker.position.v1"
    broker: Literal["KGI"] = "KGI"
    account: BrokerAccountRef
    captured_at: datetime
    source_as_of: datetime
    status: SnapshotStatus
    source: Literal["kgi.inventory_sum"] = "kgi.inventory_sum"
    positions: tuple[BrokerPosition, ...] = Field(default_factory=tuple)
    valuations: tuple[BrokerInstrumentValuation, ...] = Field(default_factory=tuple)
    warnings: tuple[str, ...] = Field(default_factory=tuple)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")

    _normalize_captured_at = field_validator("captured_at")(_utc)
    _normalize_source_as_of = field_validator("source_as_of")(_utc)

    @model_validator(mode="after")
    def validate_snapshot_shape(self) -> Self:
        if self.status is SnapshotStatus.EXPLICIT_EMPTY:
            if self.positions or self.valuations:
                raise ValueError("explicit_empty snapshot cannot contain positions or valuations")
            return self
        if not self.positions:
            raise ValueError("complete snapshot must contain at least one position")
        position_symbols = {item.symbol for item in self.positions}
        valuation_symbols = {item.symbol for item in self.valuations}
        if position_symbols != valuation_symbols:
            raise ValueError("complete snapshot must contain one valuation row per symbol")
        position_keys = [(item.symbol, item.position_type) for item in self.positions]
        if len(position_keys) != len(set(position_keys)):
            raise ValueError("snapshot contains duplicate position keys")
        if len(valuation_symbols) != len(self.valuations):
            raise ValueError("snapshot contains duplicate valuation symbols")
        return self


class BrokerPositionV2(ContractModel):
    market: Literal["TW", "US"]
    symbol: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=120)
    currency: Literal["TWD", "USD"]
    settlement_currency: str | None = Field(default=None, max_length=12)
    position_type: PositionType
    quantity: Decimal
    average_cost: Decimal | None = None

    _normalize_symbol = field_validator("symbol")(_symbol)
    _normalize_name = field_validator("name")(_name)
    _validate_quantity = field_validator("quantity")(_quantity)
    _validate_average_cost = field_validator("average_cost")(_average_cost)

    @model_validator(mode="after")
    def validate_market_currency(self) -> Self:
        expected = "TWD" if self.market == "TW" else "USD"
        if self.currency != expected:
            raise ValueError(f"{self.market} positions must use {expected}")
        return self

    @field_serializer("quantity", "average_cost", when_used="json")
    def serialize_decimal(self, value: Decimal | None) -> str | None:
        return _decimal_text(value)


class BrokerInstrumentValuationV2(ContractModel):
    market: Literal["TW", "US"]
    symbol: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=120)
    currency: Literal["TWD", "USD"]
    last_price: Decimal | None = None
    native_market_value: Decimal | None = None
    price_as_of: datetime | None = None
    price_quality: PriceQuality
    broker_unrealized_pnl_native: Decimal | None = None
    broker_unrealized_pnl_twd: Decimal | None = None

    _normalize_symbol = field_validator("symbol")(_symbol)
    _normalize_name = field_validator("name")(_name)
    _validate_last_price = field_validator("last_price")(_last_price)
    _validate_market_value = field_validator("native_market_value")(_market_value)
    _validate_pnl = field_validator(
        "broker_unrealized_pnl_native", "broker_unrealized_pnl_twd"
    )(_pnl)
    _normalize_price_as_of = field_validator("price_as_of")(
        lambda value: None if value is None else _utc(value)
    )

    @model_validator(mode="after")
    def validate_valuation(self) -> Self:
        expected = "TWD" if self.market == "TW" else "USD"
        if self.currency != expected:
            raise ValueError(f"{self.market} valuations must use {expected}")
        if self.price_quality is PriceQuality.MISSING:
            if self.last_price is not None or self.price_as_of is not None:
                raise ValueError("missing price quality cannot carry price facts")
        elif self.last_price is None or self.price_as_of is None:
            raise ValueError("priced valuations require price and price_as_of")
        return self

    @field_serializer(
        "last_price",
        "native_market_value",
        "broker_unrealized_pnl_native",
        "broker_unrealized_pnl_twd",
        when_used="json",
    )
    def serialize_decimal(self, value: Decimal | None) -> str | None:
        return _decimal_text(value)


class BrokerMarketScopeV2(ContractModel):
    market: Literal["TW", "US"]
    account: BrokerAccountRef | None = None
    status: MarketScopeStatus
    source: Literal["kgi.inventory_sum", "kgi.stock_position_report"]
    source_as_of: datetime | None = None
    positions: tuple[BrokerPositionV2, ...] = Field(default_factory=tuple)
    valuations: tuple[BrokerInstrumentValuationV2, ...] = Field(default_factory=tuple)
    warnings: tuple[str, ...] = Field(default_factory=tuple)
    error_code: str | None = Field(default=None, max_length=80)

    _normalize_source_as_of = field_validator("source_as_of")(
        lambda value: None if value is None else _utc(value)
    )

    @model_validator(mode="after")
    def validate_scope_shape(self) -> Self:
        expected_source = (
            "kgi.inventory_sum" if self.market == "TW" else "kgi.stock_position_report"
        )
        if self.source != expected_source:
            raise ValueError("market scope source does not match market")
        if self.status is MarketScopeStatus.UNAVAILABLE:
            if self.account or self.source_as_of or self.positions or self.valuations:
                raise ValueError("unavailable scope cannot publish broker facts")
            if not self.error_code:
                raise ValueError("unavailable scope requires an error code")
            return self
        if self.account is None or self.source_as_of is None or self.error_code is not None:
            raise ValueError("available scope requires account/as_of and no error code")
        if self.status is MarketScopeStatus.EXPLICIT_EMPTY:
            if self.positions or self.valuations:
                raise ValueError("explicit_empty scope cannot contain positions or valuations")
            return self
        if not self.positions:
            raise ValueError("complete scope must contain positions")
        if any(item.market != self.market for item in self.positions + self.valuations):
            raise ValueError("scope contains a different market")
        position_symbols = {item.symbol for item in self.positions}
        valuation_symbols = {item.symbol for item in self.valuations}
        if position_symbols != valuation_symbols:
            raise ValueError("complete scope requires one valuation per symbol")
        position_keys = [(item.symbol, item.position_type) for item in self.positions]
        if len(position_keys) != len(set(position_keys)):
            raise ValueError("scope contains duplicate position keys")
        if len(valuation_symbols) != len(self.valuations):
            raise ValueError("scope contains duplicate valuation symbols")
        return self


class BrokerPositionSnapshotV2(ContractModel):
    schema_version: Literal["broker.position.v2"] = "broker.position.v2"
    broker: Literal["KGI"] = "KGI"
    captured_at: datetime
    status: AggregateSnapshotStatus
    scopes: tuple[BrokerMarketScopeV2, ...]
    warnings: tuple[str, ...] = Field(default_factory=tuple)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")

    _normalize_captured_at = field_validator("captured_at")(_utc)

    @model_validator(mode="after")
    def validate_snapshot_shape(self) -> Self:
        markets = [scope.market for scope in self.scopes]
        if set(markets) != {"TW", "US"} or len(markets) != 2:
            raise ValueError("v2 snapshot requires exactly one TW and one US scope")
        unavailable = any(
            scope.status is MarketScopeStatus.UNAVAILABLE for scope in self.scopes
        )
        all_empty = all(
            scope.status is MarketScopeStatus.EXPLICIT_EMPTY for scope in self.scopes
        )
        expected = (
            AggregateSnapshotStatus.PARTIAL
            if unavailable
            else AggregateSnapshotStatus.EXPLICIT_EMPTY
            if all_empty
            else AggregateSnapshotStatus.COMPLETE
        )
        if self.status is not expected:
            raise ValueError("aggregate status does not match market scopes")
        return self


class BridgeErrorBody(ContractModel):
    code: str = Field(min_length=1, max_length=80)
    message: str = Field(min_length=1, max_length=240)


class BridgeErrorEnvelope(ContractModel):
    error: BridgeErrorBody
