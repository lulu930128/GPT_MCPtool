from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal, Protocol

from kgi_broker_bridge.contracts import (
    BrokerHealth,
    BrokerPositionSnapshot,
    BrokerPositionSnapshotV2,
)


@dataclass(frozen=True, slots=True, repr=False)
class RawInventoryBatch:
    account_ref: str = field(repr=False)
    captured_at: datetime
    source_as_of: datetime
    rows: tuple[Mapping[str, object], ...]
    explicit_empty: bool = False
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True, repr=False)
class RawMarketInventoryScope:
    market: Literal["TW", "US"]
    account_ref: str | None = field(default=None, repr=False)
    source_as_of: datetime | None = None
    rows: tuple[Mapping[str, object], ...] = ()
    explicit_empty: bool = False
    warnings: tuple[str, ...] = ()
    error_code: str | None = None


@dataclass(frozen=True, slots=True, repr=False)
class RawBrokerSnapshotBatch:
    captured_at: datetime
    scopes: tuple[RawMarketInventoryScope, ...]
    warnings: tuple[str, ...] = ()


class InventoryGateway(Protocol):
    def get_health(self) -> BrokerHealth: ...

    def read_inventory(self, book_code: str) -> RawInventoryBatch: ...

    def read_positions_v2(self) -> RawBrokerSnapshotBatch: ...


class BrokerAdapter(Protocol):
    def get_health(self) -> BrokerHealth: ...

    def get_positions(self) -> BrokerPositionSnapshot: ...

    def get_positions_v2(self) -> BrokerPositionSnapshotV2: ...
