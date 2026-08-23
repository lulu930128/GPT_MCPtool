from __future__ import annotations

from fastapi import FastAPI

from kgi_broker_bridge.adapters.disabled import DisabledBrokerAdapter
from kgi_broker_bridge.adapters.kgi_inventory import KGIInventoryAdapter
from kgi_broker_bridge.adapters.kgisuperpy_gateway import KGISuperPySubprocessGateway
from kgi_broker_bridge.api import create_app
from kgi_broker_bridge.identity import AccountIdentityProjector
from kgi_broker_bridge.ports import BrokerAdapter
from kgi_broker_bridge.service import BrokerBridgeService
from kgi_broker_bridge.settings import Settings


def create_runtime_app(settings: Settings) -> FastAPI:
    adapter: BrokerAdapter
    if settings.adapter_mode == "kgisuperpy":
        assert settings.person_id is not None
        assert settings.person_password is not None
        assert settings.account_hash_key is not None
        assert settings.sdk_python is not None
        settings.runtime_dir.mkdir(parents=True, exist_ok=True)
        gateway = KGISuperPySubprocessGateway(
            sdk_python=settings.sdk_python,
            person_id=settings.person_id,
            person_password=settings.person_password,
            simulation=settings.simulation,
            stock_account=settings.stock_account,
            sub_account=settings.sub_account,
            timeout_seconds=settings.sdk_timeout_seconds,
            working_directory=settings.runtime_dir,
        )
        adapter = KGIInventoryAdapter(
            gateway=gateway,
            identity=AccountIdentityProjector(
                settings.account_hash_key.get_secret_value()
            ),
        )
    else:
        adapter = DisabledBrokerAdapter()
    service = BrokerBridgeService(adapter=adapter)
    return create_app(service, api_token=settings.api_token)
