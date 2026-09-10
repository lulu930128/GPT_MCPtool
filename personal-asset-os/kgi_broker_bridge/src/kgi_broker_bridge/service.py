from __future__ import annotations

from dataclasses import dataclass

from kgi_broker_bridge.account_state import AccountState
from kgi_broker_bridge.contracts import (
    BrokerHealth,
    BrokerPositionSnapshot,
    BrokerPositionSnapshotV2,
)
from kgi_broker_bridge.ports import BrokerAdapter


@dataclass(frozen=True, slots=True)
class BrokerBridgeService:
    adapter: BrokerAdapter

    def close(self) -> None:
        self.adapter.close()

    def get_health(self) -> BrokerHealth:
        return self.adapter.get_health()

    def get_positions(self) -> BrokerPositionSnapshot:
        return self.adapter.get_positions()

    def get_positions_v2(self) -> BrokerPositionSnapshotV2:
        return self.adapter.get_positions_v2()

    def get_account_state(self) -> AccountState:
        return self.adapter.get_account_state()
