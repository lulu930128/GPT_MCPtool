from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Literal, Protocol, Self

import httpx
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from personal_asset_os.settings import Settings
from personal_asset_os.temporal import ensure_utc, utc_now

BrokerReadStatus = Literal[
    "disabled", "unavailable", "complete", "partial", "explicit_empty", "stale"
]
BrokerReadMode = Literal["disabled", "live", "memory_cache", "memory_fallback", "unavailable"]


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("broker datetime must include a timezone")
    return value.astimezone(UTC)


def _finite(value: Decimal | None) -> Decimal | None:
    if value is not None and not value.is_finite():
        raise ValueError("broker decimal must be finite")
    return value


def _broker_symbol(value: str) -> str:
    normalized = value.strip().upper()
    if not normalized:
        raise ValueError("broker symbol must not be empty")
    return normalized


def _broker_name(value: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError("broker name must not be empty")
    return normalized


def _broker_quantity(value: Decimal) -> Decimal:
    if not value.is_finite() or value == 0:
        raise ValueError("broker quantity must be finite and non-zero")
    return value


def _broker_average_cost(value: Decimal | None) -> Decimal | None:
    if value is not None and (not value.is_finite() or value <= 0):
        raise ValueError("broker average cost must be finite and positive")
    return value


def _broker_price(value: Decimal | None) -> Decimal | None:
    if value is not None and (not value.is_finite() or value <= 0):
        raise ValueError("broker last price must be finite and positive")
    return value


def _broker_market_value(value: Decimal | None) -> Decimal | None:
    if value is not None and (not value.is_finite() or value < 0):
        raise ValueError("broker market value must be finite and non-negative")
    return value


class _BrokerContract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class BrokerAccount(_BrokerContract):
    opaque_id: str = Field(pattern=r"^kgi_[0-9a-f]{24}$")
    masked_label: str = Field(min_length=4, max_length=40)


class BrokerPosition(_BrokerContract):
    market: Literal["TW"]
    symbol: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=120)
    currency: Literal["TWD"]
    position_type: Literal["cash", "margin", "short", "odd_lot"]
    quantity: Decimal
    average_cost: Decimal | None = None

    @field_validator("symbol")
    @classmethod
    def normalize_symbol(cls, value: str) -> str:
        return _broker_symbol(value)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        return _broker_name(value)

    @field_validator("quantity")
    @classmethod
    def validate_quantity(cls, value: Decimal) -> Decimal:
        return _broker_quantity(value)

    @field_validator("average_cost")
    @classmethod
    def validate_average_cost(cls, value: Decimal | None) -> Decimal | None:
        return _broker_average_cost(value)


class BrokerValuation(_BrokerContract):
    market: Literal["TW"]
    symbol: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=120)
    currency: Literal["TWD"]
    last_price: Decimal | None = None
    broker_market_value: Decimal | None = None
    broker_unrealized_pnl: Decimal | None = None
    broker_unrealized_pnl_twd: Decimal | None = None

    @field_validator("symbol")
    @classmethod
    def normalize_symbol(cls, value: str) -> str:
        return _broker_symbol(value)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        return _broker_name(value)

    @field_validator("last_price")
    @classmethod
    def validate_last_price(cls, value: Decimal | None) -> Decimal | None:
        return _broker_price(value)

    @field_validator("broker_market_value")
    @classmethod
    def validate_market_value(cls, value: Decimal | None) -> Decimal | None:
        return _broker_market_value(value)

    _validate_pnl = field_validator(
        "broker_unrealized_pnl", "broker_unrealized_pnl_twd"
    )(_finite)


class BrokerSnapshot(_BrokerContract):
    schema_version: Literal["broker.position.v1"]
    broker: Literal["KGI"]
    account: BrokerAccount
    captured_at: datetime
    source_as_of: datetime
    status: Literal["complete", "explicit_empty"]
    source: Literal["kgi.inventory_sum"]
    positions: tuple[BrokerPosition, ...]
    valuations: tuple[BrokerValuation, ...]
    warnings: tuple[str, ...]
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")

    _normalize_captured_at = field_validator("captured_at")(_utc)
    _normalize_source_as_of = field_validator("source_as_of")(_utc)

    @model_validator(mode="after")
    def validate_shape(self) -> Self:
        if self.status == "explicit_empty":
            if self.positions or self.valuations:
                raise ValueError("explicit_empty broker snapshot must not contain positions")
            return self
        if not self.positions:
            raise ValueError("complete broker snapshot must contain positions")
        position_symbols = {item.symbol.strip().upper() for item in self.positions}
        valuation_symbols = {item.symbol.strip().upper() for item in self.valuations}
        if position_symbols != valuation_symbols:
            raise ValueError("broker snapshot valuation symbols do not match positions")
        if len(valuation_symbols) != len(self.valuations):
            raise ValueError("broker snapshot contains duplicate valuation symbols")
        position_keys = [
            (item.symbol.strip().upper(), item.position_type) for item in self.positions
        ]
        if len(position_keys) != len(set(position_keys)):
            raise ValueError("broker snapshot contains duplicate position keys")
        return self


class BrokerPositionV2(_BrokerContract):
    market: Literal["TW", "US"]
    symbol: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=120)
    currency: Literal["TWD", "USD"]
    settlement_currency: str | None = None
    position_type: Literal["cash", "margin", "short", "odd_lot"]
    quantity: Decimal
    average_cost: Decimal | None = None

    _normalize_symbol = field_validator("symbol")(_broker_symbol)
    _normalize_name = field_validator("name")(_broker_name)
    _validate_quantity = field_validator("quantity")(_broker_quantity)
    _validate_average_cost = field_validator("average_cost")(_broker_average_cost)

    @model_validator(mode="after")
    def validate_market_currency(self) -> Self:
        expected = "TWD" if self.market == "TW" else "USD"
        if self.currency != expected:
            raise ValueError("broker market/currency mismatch")
        return self


class BrokerValuationV2(_BrokerContract):
    market: Literal["TW", "US"]
    symbol: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=120)
    currency: Literal["TWD", "USD"]
    last_price: Decimal | None = None
    native_market_value: Decimal | None = None
    price_as_of: datetime | None = None
    price_quality: Literal[
        "broker_reported", "broker_snapshot", "broker_close", "missing"
    ]
    broker_unrealized_pnl_native: Decimal | None = None
    broker_unrealized_pnl_twd: Decimal | None = None

    _normalize_symbol = field_validator("symbol")(_broker_symbol)
    _normalize_name = field_validator("name")(_broker_name)
    _validate_last_price = field_validator("last_price")(_broker_price)
    _validate_market_value = field_validator("native_market_value")(_broker_market_value)
    _validate_pnl = field_validator(
        "broker_unrealized_pnl_native", "broker_unrealized_pnl_twd"
    )(_finite)
    _normalize_price_as_of = field_validator("price_as_of")(
        lambda value: None if value is None else _utc(value)
    )

    @model_validator(mode="after")
    def validate_shape(self) -> Self:
        expected = "TWD" if self.market == "TW" else "USD"
        if self.currency != expected:
            raise ValueError("broker market/currency mismatch")
        if self.price_quality == "missing":
            if self.last_price is not None or self.price_as_of is not None:
                raise ValueError("missing valuation cannot include price facts")
        elif self.last_price is None or self.price_as_of is None:
            raise ValueError("priced valuation requires price and timestamp")
        return self


class BrokerMarketScopeV2(_BrokerContract):
    market: Literal["TW", "US"]
    account: BrokerAccount | None = None
    status: Literal["complete", "explicit_empty", "unavailable"]
    source: Literal["kgi.inventory_sum", "kgi.stock_position_report"]
    source_as_of: datetime | None = None
    positions: tuple[BrokerPositionV2, ...]
    valuations: tuple[BrokerValuationV2, ...]
    warnings: tuple[str, ...]
    error_code: str | None = None

    _normalize_source_as_of = field_validator("source_as_of")(
        lambda value: None if value is None else _utc(value)
    )

    @model_validator(mode="after")
    def validate_shape(self) -> Self:
        expected_source = (
            "kgi.inventory_sum" if self.market == "TW" else "kgi.stock_position_report"
        )
        if self.source != expected_source:
            raise ValueError("broker scope source mismatch")
        if self.status == "unavailable":
            if self.account or self.source_as_of or self.positions or self.valuations:
                raise ValueError("unavailable scope cannot contain facts")
            if not self.error_code:
                raise ValueError("unavailable scope requires error_code")
            return self
        if self.account is None or self.source_as_of is None or self.error_code is not None:
            raise ValueError("available scope requires account and timestamp")
        if self.status == "explicit_empty":
            if self.positions or self.valuations:
                raise ValueError("explicit_empty scope cannot contain facts")
            return self
        if not self.positions:
            raise ValueError("complete scope requires positions")
        symbols = {item.symbol for item in self.positions}
        valuation_symbols = {item.symbol for item in self.valuations}
        if symbols != valuation_symbols or len(valuation_symbols) != len(self.valuations):
            raise ValueError("scope valuation symbols do not match positions")
        keys = [(item.symbol, item.position_type) for item in self.positions]
        if len(keys) != len(set(keys)):
            raise ValueError("scope contains duplicate position keys")
        return self


class BrokerSnapshotV2(_BrokerContract):
    schema_version: Literal["broker.position.v2"]
    broker: Literal["KGI"]
    captured_at: datetime
    status: Literal["complete", "partial", "explicit_empty"]
    scopes: tuple[BrokerMarketScopeV2, ...]
    warnings: tuple[str, ...]
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")

    _normalize_captured_at = field_validator("captured_at")(_utc)

    @model_validator(mode="after")
    def validate_shape(self) -> Self:
        if {scope.market for scope in self.scopes} != {"TW", "US"} or len(self.scopes) != 2:
            raise ValueError("v2 broker snapshot requires TW and US scopes")
        unavailable = any(scope.status == "unavailable" for scope in self.scopes)
        all_empty = all(scope.status == "explicit_empty" for scope in self.scopes)
        expected = "partial" if unavailable else "explicit_empty" if all_empty else "complete"
        if self.status != expected:
            raise ValueError("broker aggregate status mismatch")
        return self


@dataclass(frozen=True, slots=True)
class BrokerReadResult:
    status: BrokerReadStatus
    read_mode: BrokerReadMode
    retrieved_at: datetime
    snapshot: BrokerSnapshot | BrokerSnapshotV2 | None = None
    warnings: tuple[str, ...] = ()

    @classmethod
    def disabled(cls, *, now: datetime | None = None) -> BrokerReadResult:
        return cls(
            status="disabled",
            read_mode="disabled",
            retrieved_at=ensure_utc(now or utc_now()),
        )


class BrokerSnapshotProvider(Protocol):
    def read(self, *, now: datetime | None = None) -> BrokerReadResult: ...


class BrokerBridgeClient:
    def __init__(
        self,
        settings: Settings,
        *,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._enabled = settings.broker_bridge_configured
        self._v2_url = f"{settings.broker_bridge_url}/api/v2/positions"
        self._v1_url = f"{settings.broker_bridge_url}/api/v1/positions"
        self._token = (
            settings.broker_bridge_api_token.get_secret_value().strip()
            if settings.broker_bridge_api_token
            else ""
        )
        self._timeout = settings.broker_bridge_timeout_seconds
        self._cache_ttl = settings.broker_cache_ttl_seconds
        self._fallback_ttl = settings.broker_memory_fallback_seconds
        self._max_source_age = settings.broker_price_max_age_seconds
        self._transport = transport
        self._lock = threading.Lock()
        self._cached: BrokerReadResult | None = None
        self._cached_monotonic: float | None = None

    def read(self, *, now: datetime | None = None) -> BrokerReadResult:
        checked_at = ensure_utc(now or utc_now())
        if not self._enabled:
            return BrokerReadResult.disabled(now=checked_at)
        with self._lock:
            monotonic_now = time.monotonic()
            cache_age = self._cache_age(monotonic_now)
            if self._cached and cache_age is not None and cache_age <= self._cache_ttl:
                return BrokerReadResult(
                    status=self._cached.status,
                    read_mode="memory_cache",
                    retrieved_at=checked_at,
                    snapshot=self._cached.snapshot,
                    warnings=self._cached.warnings,
                )
            try:
                result = self._read_live(checked_at)
            except Exception as exc:
                warning = self._safe_failure_warning(exc)
                if (
                    self._cached
                    and self._cached.snapshot is not None
                    and cache_age is not None
                    and cache_age <= self._fallback_ttl
                ):
                    return BrokerReadResult(
                        status="stale",
                        read_mode="memory_fallback",
                        retrieved_at=checked_at,
                        snapshot=self._cached.snapshot,
                        warnings=self._cached.warnings
                        + (warning, "KGI 即時讀取失敗，暫用本次 PAOS 程序記憶體內的上次成功快照"),
                    )
                return BrokerReadResult(
                    status="unavailable",
                    read_mode="unavailable",
                    retrieved_at=checked_at,
                    warnings=(warning,),
                )
            self._cached = result
            self._cached_monotonic = monotonic_now
            return result

    def _cache_age(self, monotonic_now: float) -> float | None:
        if self._cached_monotonic is None:
            return None
        return max(monotonic_now - self._cached_monotonic, 0.0)

    def _read_live(self, checked_at: datetime) -> BrokerReadResult:
        with httpx.Client(
            timeout=self._timeout,
            transport=self._transport,
            trust_env=False,
        ) as client:
            response = client.get(
                self._v2_url,
                headers={"Authorization": f"Bearer {self._token}"},
            )
            if response.status_code == 404:
                response = client.get(
                    self._v1_url,
                    headers={"Authorization": f"Bearer {self._token}"},
                )
            response.raise_for_status()
        payload = response.json()
        if payload.get("schema_version") == "broker.position.v2":
            v2_snapshot = BrokerSnapshotV2.model_validate(payload)
            snapshot: BrokerSnapshot | BrokerSnapshotV2 = v2_snapshot
            source_times = [
                scope.source_as_of
                for scope in v2_snapshot.scopes
                if scope.source_as_of is not None
            ]
            warnings = v2_snapshot.warnings + tuple(
                warning for scope in v2_snapshot.scopes for warning in scope.warnings
            )
        else:
            v1_snapshot = BrokerSnapshot.model_validate(payload)
            snapshot = v1_snapshot
            source_times = [v1_snapshot.source_as_of]
            warnings = v1_snapshot.warnings
        stale = any(
            max((checked_at - source_as_of).total_seconds(), 0.0) > self._max_source_age
            for source_as_of in source_times
        )
        status: BrokerReadStatus = "stale" if stale else snapshot.status
        if stale:
            warnings += (
                f"KGI 券商資料時間已超過 {int(self._max_source_age)} 秒，未標示為即時",
            )
        return BrokerReadResult(
            status=status,
            read_mode="live",
            retrieved_at=checked_at,
            snapshot=snapshot,
            warnings=warnings,
        )

    @staticmethod
    def _safe_failure_warning(exc: Exception) -> str:
        if isinstance(exc, httpx.HTTPStatusError):
            return f"KGI Bridge 回傳 HTTP {exc.response.status_code}，已保留 PAOS 原估值"
        if isinstance(exc, httpx.TimeoutException):
            return "KGI Bridge 讀取逾時，已保留 PAOS 原估值"
        if isinstance(exc, httpx.RequestError):
            return "KGI Bridge 無法連線，已保留 PAOS 原估值"
        return "KGI Bridge 回傳格式不符合契約，已保留 PAOS 原估值"
