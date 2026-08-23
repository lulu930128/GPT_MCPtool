from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime

from kgi_broker_bridge.contracts import (
    BrokerHealth,
    BrokerPositionSnapshot,
    BrokerPositionSnapshotV2,
    HealthStatus,
)
from kgi_broker_bridge.errors import AdapterNotConfiguredError


def _utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True, slots=True)
class DisabledBrokerAdapter:
    package_version: str | None = None
    clock: Callable[[], datetime] = _utc_now

    def get_health(self) -> BrokerHealth:
        return BrokerHealth(
            status=HealthStatus.NOT_CONFIGURED,
            package_version=self.package_version,
            login=None,
            ca=None,
            account=None,
            quote=None,
            positions=False,
            checked_at=self.clock(),
            warnings=("live_kgi_adapter_not_configured",),
        )

    def get_positions(self) -> BrokerPositionSnapshot:
        raise AdapterNotConfiguredError

    def get_positions_v2(self) -> BrokerPositionSnapshotV2:
        raise AdapterNotConfiguredError
