"""Local runtime evidence only: no database, SDK payload, or credentials."""
from __future__ import annotations

import hashlib
import os
import tempfile
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from personal_asset_os.services.broker_read import (
    BrokerMarketScopeV2,
    BrokerPositionV2,
    BrokerReadResult,
    BrokerSnapshot,
    BrokerSnapshotV2,
    BrokerValuationV2,
    _utc,
)

Market = Literal["TW", "US"]


class MarketState(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    market: Market
    last_good: BrokerMarketScopeV2 | None = None
    captured_at: datetime | None = None
    empty_count: int = Field(default=0, ge=0, le=20, strict=True)
    empty_account: str | None = Field(default=None, pattern=r"^kgi_[0-9a-f]{24}$")

    _captured_utc = field_validator("captured_at")(
        lambda value: None if value is None else _utc(value)
    )

    @model_validator(mode="after")
    def validate_state(self) -> Self:
        if (self.last_good is None) != (self.captured_at is None):
            raise ValueError("last-good capture time missing")
        if self.last_good is not None:
            if self.last_good.market != self.market or self.last_good.status != "complete":
                raise ValueError("last-good must be complete for this market")
            if self.last_good.warnings:
                raise ValueError("runtime evidence cannot contain upstream warning text")
            if self.last_good.account is None or self.last_good.account.masked_label != "****":
                raise ValueError("runtime evidence only retains opaque account identity")
            if self.empty_account and self.empty_account != self.last_good.account.opaque_id:
                raise ValueError("empty confirmation account mismatch")
        if bool(self.empty_count) != bool(self.empty_account):
            raise ValueError("empty confirmation identity missing")
        return self


class GuardState(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal["paos.broker-last-good.v1"]
    markets: tuple[MarketState, ...]

    @model_validator(mode="after")
    def validate_markets(self) -> Self:
        if len(self.markets) != 2 or {item.market for item in self.markets} != {"TW", "US"}:
            raise ValueError("runtime evidence requires unique TW and US states")
        return self


def unavailable_scope(market: Market) -> BrokerMarketScopeV2:
    return BrokerMarketScopeV2(
        market=market, status="unavailable",
        source="kgi.inventory_sum" if market == "TW" else "kgi.stock_position_report",
        positions=(), valuations=(), warnings=(), error_code="live_unavailable",
    )


def normalize_v1(snapshot: BrokerSnapshot) -> tuple[BrokerMarketScopeV2, ...]:
    """Apply the same guard when an older bridge only exposes the TW v1 route."""
    tw = BrokerMarketScopeV2(
        market="TW", account=snapshot.account, status=snapshot.status,
        source=snapshot.source, source_as_of=snapshot.source_as_of,
        positions=tuple(BrokerPositionV2(**item.model_dump()) for item in snapshot.positions),
        valuations=tuple(
            BrokerValuationV2(
                market="TW", symbol=item.symbol, name=item.name, currency="TWD",
                last_price=item.last_price, native_market_value=item.broker_market_value,
                price_as_of=snapshot.source_as_of if item.last_price is not None else None,
                price_quality="broker_reported" if item.last_price is not None else "missing",
                broker_unrealized_pnl_native=item.broker_unrealized_pnl,
                broker_unrealized_pnl_twd=item.broker_unrealized_pnl_twd,
            ) for item in snapshot.valuations
        ),
        warnings=snapshot.warnings,
    )
    return tw, unavailable_scope("US")


class BrokerSnapshotGuard:
    """Owned by the single BrokerBridgeClient and serialized by its read lock."""

    def __init__(self, path: Path, *, empty_confirmations: int) -> None:
        self.path = path
        self.empty_confirmations = empty_confirmations
        self._loaded = False
        self._dirty = False
        self._load_warning: tuple[str, ...] = ()
        self._state = GuardState(
            schema_version="paos.broker-last-good.v1",
            markets=(MarketState(market="TW"), MarketState(market="US")),
        )

    def _load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        try:
            # Bound untrusted/corrupt local evidence before JSON parsing.
            with self.path.open("rb") as stream:
                data = stream.read(8 * 1024 * 1024 + 1)
            if len(data) > 8 * 1024 * 1024:
                raise ValueError("runtime snapshot too large")
            self._state = GuardState.model_validate_json(data)
        except FileNotFoundError:
            pass
        except (OSError, ValueError):
            self._load_warning = ("KGI 本機保底快照損壞、不相容或無法讀取，已忽略；未推定空倉",)

    def _publish(self, state: GuardState) -> None:
        # Validate before publication, then replace on the same filesystem.
        data = GuardState.model_validate_json(state.model_dump_json()).model_dump_json()
        if len(data.encode("utf-8")) > 8 * 1024 * 1024:
            raise ValueError("runtime snapshot too large")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=self.path.parent,
                prefix=f".{self.path.name}.", suffix=".tmp", delete=False,
            ) as stream:
                temporary = Path(stream.name)
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def apply(self, read: BrokerReadResult) -> BrokerReadResult:
        self._load()
        snapshot = read.snapshot
        scopes = (
            snapshot.scopes if isinstance(snapshot, BrokerSnapshotV2)
            else normalize_v1(snapshot) if isinstance(snapshot, BrokerSnapshot)
            else (unavailable_scope("TW"), unavailable_scope("US"))
        )
        warnings = list(read.warnings + self._load_warning)
        next_states: list[MarketState] = []
        selected: list[BrokerMarketScopeV2] = []
        fallback: list[str] = []
        capture_times: list[datetime] = []
        for scope in scopes:
            old = next(item for item in self._state.markets if item.market == scope.market)
            if scope.account and old.last_good and old.last_good.account != scope.account:
                # Compare opaque identity, not the presentation-only masked label.
                assert old.last_good.account is not None
                if old.last_good.account.opaque_id != scope.account.opaque_id:
                    old = MarketState(market=scope.market)
                    warnings.append(f"KGI {scope.market} 帳戶已變更，已停用舊帳戶保底快照")
            if scope.status == "complete":
                assert scope.account is not None and snapshot is not None
                safe_scope = scope.model_copy(update={
                    "warnings": (),
                    "account": scope.account.model_copy(update={"masked_label": "****"}),
                })
                state = MarketState(
                    market=scope.market, last_good=safe_scope, captured_at=snapshot.captured_at,
                )
            elif scope.status == "explicit_empty":
                assert scope.account is not None
                account = scope.account.opaque_id
                count = min(
                    (old.empty_count if old.empty_account == account else 0) + 1,
                    self.empty_confirmations,
                )
                confirmed = count >= self.empty_confirmations
                state = MarketState(
                    market=scope.market,
                    last_good=None if confirmed else old.last_good,
                    captured_at=None if confirmed else old.captured_at,
                    empty_count=count, empty_account=account,
                )
                if not confirmed:
                    warnings.append(
                        f"KGI {scope.market} 空倉待確認 {count}/{self.empty_confirmations}"
                        + ("；尚無最後有效快照可回退" if old.last_good is None else "")
                    )
            else:
                # Failure interrupts the sequence; empty + error + empty is not consecutive.
                state = old.model_copy(update={"empty_count": 0, "empty_account": None})
            next_states.append(state)
            if scope.status != "complete" and state.last_good is not None:
                selected.append(state.last_good)
                fallback.append(scope.market)
                assert state.captured_at is not None
                capture_times.append(state.captured_at)
                warnings.append(f"KGI {scope.market} 使用本機最後有效快照，資料過舊且非即時")
            else:
                selected.append(scope)
                if snapshot is not None:
                    capture_times.append(snapshot.captured_at)

        next_state = GuardState(
            schema_version="paos.broker-last-good.v1", markets=tuple(next_states),
        )
        if next_state != self._state or self._dirty:
            try:
                self._publish(next_state)
                self._load_warning = ()
                self._dirty = False
            except (OSError, ValueError):
                self._dirty = True
                warnings.append("KGI 本機保底快照無法原子保存；本次狀態僅在記憶體，重啟恢復未保證")
                # Do not accept empty until its deletion has been durably published.
                for index, state in enumerate(next_states):
                    previous = next(s for s in self._state.markets if s.market == state.market)
                    if (
                        state.empty_count and previous.last_good and state.last_good is None
                        and previous.last_good.account is not None
                        and previous.last_good.account.opaque_id == state.empty_account
                    ):
                        next_states[index] = previous.model_copy(
                            update={"empty_count": 0, "empty_account": None},
                        )
                        selected[index] = previous.last_good
                        fallback.append(state.market)
                        assert previous.captured_at is not None
                        capture_times.append(previous.captured_at)
                        warnings.append(f"KGI {state.market} 空倉清除未保存，繼續使用最後有效快照")
                next_state = GuardState(
                    schema_version="paos.broker-last-good.v1", markets=tuple(next_states),
                )
            self._state = next_state
        if snapshot is None and not fallback:
            return replace(read, warnings=tuple(warnings))
        aggregate: Literal["complete", "partial", "explicit_empty"] = (
            "partial" if any(scope.status == "unavailable" for scope in selected)
            else "explicit_empty" if all(scope.status == "explicit_empty" for scope in selected)
            else "complete"
        )
        combined = BrokerSnapshotV2(
            schema_version="broker.position.v2", broker="KGI",
            captured_at=min(capture_times), status=aggregate, scopes=tuple(selected),
            warnings=(), payload_hash="0" * 64,
        )
        # The combined object is normalized evidence, never the live payload's hash.
        combined = combined.model_copy(update={
            "payload_hash": hashlib.sha256(combined.model_dump_json().encode()).hexdigest(),
        })
        return replace(
            read, snapshot=combined, warnings=tuple(warnings),
            status="stale" if fallback else "stale" if read.status == "stale" else aggregate,
            read_mode="persistent_fallback" if fallback else read.read_mode,
            fallback_markets=tuple(fallback),
            stale_markets=tuple(sorted(set(read.stale_markets) | set(fallback))),
        )