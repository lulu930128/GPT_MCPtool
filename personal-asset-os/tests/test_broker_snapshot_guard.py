from __future__ import annotations

import asyncio
import json
from datetime import timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from mcp import Client
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from personal_asset_os.app import create_app
from personal_asset_os.database import Database
from personal_asset_os.mcp_server import create_mcp_server
from personal_asset_os.models import AuditLog, LedgerTransaction, Posting, PriceFact, Trade
from personal_asset_os.services import portfolio, reporting
from personal_asset_os.services.broker_read import BrokerBridgeClient, BrokerSnapshotV2
from personal_asset_os.services.broker_snapshot_guard import GuardState
from personal_asset_os.settings import Settings
from tests.broker_helpers import broker_result
from tests.test_broker_overlay import FakeFxProvider, us_broker_result
from tests.test_broker_read import NOW, TOKEN, payload


def both() -> dict[str, Any]:
    result = payload()
    us = us_broker_result().snapshot
    assert isinstance(us, BrokerSnapshotV2)
    result["scopes"][1] = us.scopes[1].model_dump(mode="json")  # type: ignore[index]
    return result


def changed(market: str, status: str) -> dict[str, Any]:
    result = both()
    scope = next(item for item in result["scopes"] if item["market"] == market)
    scope["status"] = status
    if status != "complete":
        scope.update(positions=[], valuations=[])
    if status == "unavailable":
        scope.update(account=None, source_as_of=None, error_code="provider_unavailable")
        result["status"] = "partial"
    return result


class Live:
    def __init__(self) -> None:
        self.response: dict[str, Any] | int = both()
        self.calls = 0

    def handle(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/account-state":
            return httpx.Response(404)
        self.calls += 1
        if self.response == 0:
            raise httpx.ReadTimeout("synthetic sensitive text must not escape")
        if isinstance(self.response, int):
            return httpx.Response(self.response)
        return httpx.Response(200, json=self.response)

    def client(self, path: Path, *, ttl: float = 0) -> BrokerBridgeClient:
        return BrokerBridgeClient(
            Settings(
                _env_file=None, data_dir=path, broker_bridge_enabled=True,
                broker_bridge_api_token=TOKEN, broker_cache_ttl_seconds=ttl,
            ),
            transport=httpx.MockTransport(self.handle),
        )


def saved(path: Path) -> GuardState:
    return GuardState.model_validate_json((path / "runtime/broker-last-good-v1.json").read_bytes())


@pytest.mark.parametrize("market", ["TW", "US"])
def test_complete_empty_complete_and_consecutive_confirmation(tmp_path: Path, market: str) -> None:
    live = Live()
    client = live.client(tmp_path)
    first = client.read(now=NOW)
    live.response = changed(market, "explicit_empty")
    pending = client.read(now=NOW)
    assert pending.status == "stale" and pending.read_mode == "persistent_fallback"
    assert pending.fallback_markets == (market,)
    assert pending.snapshot is not None and first.snapshot is not None
    assert [s.positions for s in pending.snapshot.scopes] == [  # type: ignore[union-attr]
        s.positions for s in first.snapshot.scopes  # type: ignore[union-attr]
    ]
    live.response = both()
    assert client.read(now=NOW).read_mode == "live"
    assert all(s.empty_count == 0 for s in saved(tmp_path).markets)
    live.response = changed(market, "explicit_empty")
    for count in (1, 2):
        # A new client must retain the pending count across process lifetimes.
        pending = live.client(tmp_path).read(now=NOW)
        assert pending.fallback_markets == (market,)
        assert next(s for s in saved(tmp_path).markets if s.market == market).empty_count == count
    accepted = live.client(tmp_path).read(now=NOW)
    assert accepted.read_mode == "live"
    state = next(s for s in saved(tmp_path).markets if s.market == market)
    assert state.last_good is None and state.captured_at is None
    live.response = 503
    failed = live.client(tmp_path).read(now=NOW)
    assert market not in failed.fallback_markets
    assert failed.snapshot is not None
    assert next(s for s in failed.snapshot.scopes if s.market == market).positions == ()  # type: ignore[union-attr]


@pytest.mark.parametrize("failure", [0, 502, 503, "contract", "unavailable"])
@pytest.mark.parametrize("market", ["TW", "US"])
def test_failure_resets_empty_sequence_and_preserves_other_market(
    tmp_path: Path, market: str, failure: int | str,
) -> None:
    live = Live()
    client = live.client(tmp_path)
    first = client.read(now=NOW)
    live.response = changed(market, "explicit_empty")
    client.read(now=NOW)
    if failure == "contract":
        live.response = both()
        next(s for s in live.response["scopes"] if s["market"] == market)["positions"][0][
            "quantity"
        ] = "0"
    elif failure == "unavailable":
        live.response = changed(market, "unavailable")
    else:
        assert isinstance(failure, int)
        live.response = failure
    result = live.client(tmp_path).read(now=NOW + timedelta(days=2))
    assert result.status == "stale" and result.read_mode == "persistent_fallback"
    assert market in result.fallback_markets
    assert result.snapshot is not None and first.snapshot is not None
    retained = next(s for s in result.snapshot.scopes if s.market == market)  # type: ignore[union-attr]
    original = next(s for s in first.snapshot.scopes if s.market == market)  # type: ignore[union-attr]
    assert retained.source_as_of == original.source_as_of
    assert retained.valuations == original.valuations
    assert next(s for s in saved(tmp_path).markets if s.market == market).empty_count == 0
    assert not any("synthetic sensitive" in warning for warning in result.warnings)
    live.response = changed(market, "explicit_empty")
    assert live.client(tmp_path).read(now=NOW).fallback_markets == (market,)
    assert next(s for s in saved(tmp_path).markets if s.market == market).empty_count == 1


@pytest.mark.parametrize("market", ["TW", "US"])
def test_mixed_market_live_values_and_quality(
    session: Session, tmp_path: Path, market: str,
) -> None:
    live = Live()
    client = live.client(tmp_path)
    client.read(now=NOW)
    live.response = changed(market, "unavailable")
    fresh = next(s for s in live.response["scopes"] if s["market"] != market)
    fresh["valuations"][0]["native_market_value"] = "9000"
    read = client.read(now=NOW)
    assert read.fallback_markets == (market,)
    # No FX fact: TW valuation remains live even when US is stale/unavailable.
    result = portfolio.portfolio_read_model(session, broker_read=read, as_of=NOW)
    scopes = {s["market"]: s for s in result.broker["markets"]}
    assert scopes[market]["read_mode"] == "persistent_fallback"
    assert scopes[market]["stale"] is True
    other = "US" if market == "TW" else "TW"
    assert scopes[other]["read_mode"] == "live" and scopes[other]["stale"] is False
    row = next(row for row in result.positions if row["market"] == other)
    assert row["native_market_value"] == 9000
    if other == "TW":
        assert row["valuation_status"] == "broker_live"


def test_complete_replaces_persistent_values_and_no_credentials(tmp_path: Path) -> None:
    live = Live()
    client = live.client(tmp_path)
    client.read(now=NOW)
    live.response = both()
    live.response["scopes"][0]["valuations"][0]["native_market_value"] = "15000"
    live.response["scopes"][0]["warnings"] = ["synthetic raw warning never persisted"]
    client.read(now=NOW)
    assert saved(tmp_path).markets[0].last_good.valuations[0].native_market_value == 15000
    content = (tmp_path / "runtime/broker-last-good-v1.json").read_text(encoding="utf-8")
    assert TOKEN not in content and "synthetic raw" not in content and "****1234" not in content
    assert list(tmp_path.rglob("*.*")) == [tmp_path / "runtime/broker-last-good-v1.json"]


@pytest.mark.parametrize(
    "corruption", ["json", "version", "missing_version", "extra", "cross_market", "nan"],
)
def test_corrupt_snapshot_fail_closed(tmp_path: Path, corruption: str) -> None:
    live = Live()
    live.client(tmp_path).read(now=NOW)
    path = tmp_path / "runtime/broker-last-good-v1.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    if corruption == "version":
        data["schema_version"] = "unknown"
    elif corruption == "missing_version":
        del data["schema_version"]
    elif corruption == "extra":
        data["credential"] = "not-allowed"
    elif corruption == "cross_market":
        data["markets"][0]["market"] = "US"
    elif corruption == "nan":
        data["markets"][0]["last_good"]["positions"][0]["quantity"] = "NaN"
    path.write_text("{" if corruption == "json" else json.dumps(data), encoding="utf-8")
    live.response = 503
    result = live.client(tmp_path).read(now=NOW)
    assert result.status == "unavailable" and result.snapshot is None
    assert any("快照損壞" in warning for warning in result.warnings)


def test_no_history_empty_warns_without_inventing_positions(tmp_path: Path) -> None:
    live = Live()
    live.response = changed("TW", "explicit_empty")
    result = live.client(tmp_path).read(now=NOW)
    assert result.snapshot is not None
    assert result.snapshot.scopes[0].positions == ()  # type: ignore[union-attr]
    assert any("TW 空倉待確認 1/3；尚無" in warning for warning in result.warnings)


def test_cache_does_not_confirm_empty_or_claim_fallback_live(tmp_path: Path) -> None:
    live = Live()
    live.client(tmp_path).read(now=NOW)
    live.response = changed("US", "explicit_empty")
    client = live.client(tmp_path, ttl=20)
    client.read(now=NOW)
    calls = live.calls
    for _ in range(4):
        result = client.read(now=NOW)
        assert result.status == "stale" and result.read_mode == "persistent_fallback"
        assert result.cache_hit
    assert live.calls == calls and saved(tmp_path).markets[1].empty_count == 1


def test_atomic_failure_keeps_published_file_and_unconfirmed_holdings(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    live = Live()
    client = live.client(tmp_path)
    client.read(now=NOW)
    live.response = changed("TW", "explicit_empty")
    client.read(now=NOW)
    client.read(now=NOW)
    path = tmp_path / "runtime/broker-last-good-v1.json"
    before = path.read_bytes()

    def fail_replace(*_args: object) -> None:
        raise PermissionError("synthetic secret should not escape")

    with monkeypatch.context() as patch:
        patch.setattr("personal_asset_os.services.broker_snapshot_guard.os.replace", fail_replace)
        result = client.read(now=NOW)
    assert result.fallback_markets == ("TW",) and result.status == "stale"
    assert path.read_bytes() == before
    assert list(path.parent.iterdir()) == [path]
    assert any("無法原子保存" in warning for warning in result.warnings)
    assert not any("synthetic secret" in warning for warning in result.warnings)
    client.read(now=NOW)
    assert saved(tmp_path).markets[0].empty_count == 1


def test_account_switch_does_not_restore_another_accounts_holdings(tmp_path: Path) -> None:
    live = Live()
    client = live.client(tmp_path)
    client.read(now=NOW)
    live.response = changed("TW", "explicit_empty")
    live.response["scopes"][0]["account"]["opaque_id"] = "kgi_" + "f" * 24
    result = client.read(now=NOW)
    assert result.fallback_markets == ()
    assert saved(tmp_path).markets[0].last_good is None


def test_account_switch_with_write_failure_does_not_reuse_other_account(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    live = Live()
    client = live.client(tmp_path)
    client.read(now=NOW)
    live.response = changed("TW", "explicit_empty")
    live.response["scopes"][0]["account"]["opaque_id"] = "kgi_" + "f" * 24

    def fail_replace(*_args: object) -> None:
        raise PermissionError("synthetic failure")

    monkeypatch.setattr("personal_asset_os.services.broker_snapshot_guard.os.replace", fail_replace)
    result = client.read(now=NOW)
    assert result.fallback_markets == ()
    assert result.snapshot is not None and result.snapshot.scopes[0].positions == ()


def test_v1_compatibility_uses_same_guard(tmp_path: Path) -> None:
    snapshot = broker_result(as_of=NOW).snapshot
    assert snapshot is not None
    live = Live()
    live.response = snapshot.model_dump(mode="json")
    live.client(tmp_path).read(now=NOW)
    live.response = 503
    result = live.client(tmp_path).read(now=NOW)
    assert result.fallback_markets == ("TW",) and result.status == "stale"


def test_fallback_preserves_total_assets_and_database(session: Session, tmp_path: Path) -> None:    from decimal import Decimal

    from personal_asset_os.services.fx_rates import FxRateFact, FxReadResult

    live = Live()
    client = live.client(tmp_path)
    fx = FakeFxProvider(FxReadResult(
        status="complete", read_mode="live", retrieved_at=NOW,
        fact=FxRateFact(
            base_currency="USD", quote_currency="TWD", rate=Decimal("32"),
            effective_at=NOW, provider="taifex.daily_fx", quality="official_reference",
            effective_precision="date", retrieved_at=NOW,
        ),
    ))
    models = (LedgerTransaction, Posting, Trade, PriceFact, AuditLog)
    before = [session.scalar(select(func.count()).select_from(model)) for model in models]
    first = reporting.dashboard(
        session, broker_read=client.read(now=NOW), fx_provider=fx, as_of=NOW,
    )
    live.response = changed("US", "explicit_empty")
    result = reporting.dashboard(
        session, broker_read=client.read(now=NOW), fx_provider=fx, as_of=NOW,
    )
    for metric in ("broker_market_value", "investment_market_value", "provisional_net_worth"):
        assert result["metrics"][metric] == first["metrics"][metric]
    assert [session.scalar(select(func.count()).select_from(model)) for model in models] == before
    assert not session.new and not session.dirty and not session.deleted


def test_rest_serializes_persistent_fallback(settings: Settings) -> None:
    live = Live()
    reader = live.client(settings.data_dir)
    reader.read(now=NOW)
    live.response = 503
    app = create_app(settings.model_copy(update={"fx_enabled": False}), broker_reader=reader)
    with TestClient(app) as api:
        response = api.get("/api/dashboard")
        assert response.status_code == 200
        broker = response.json()["broker"]
        assert broker["read_mode"] == "persistent_fallback" and broker["status"] == "stale"
        assert all(scope["stale"] for scope in broker["markets"])


def test_mcp_serializes_fallback_without_ledger_mutation(
    database: Database, settings: Settings,
) -> None:
    live = Live()
    live.client(settings.data_dir).read(now=NOW)
    live.response = 503
    reader = live.client(settings.data_dir)
    server = create_mcp_server(
        database, settings.model_copy(update={"fx_enabled": False}), reader,
    )
    models = (LedgerTransaction, Posting, Trade, PriceFact, AuditLog)
    with database.session() as session:
        before = [session.scalar(select(func.count()).select_from(model)) for model in models]

    async def exercise() -> None:
        async with Client(server, raise_exceptions=True) as client:
            tools = (await client.list_tools()).tools
            assert len(tools) == 7
            assert all(tool.annotations and tool.annotations.read_only_hint for tool in tools)
            for name in ("get_asset_overview", "list_asset_positions"):
                result = await client.call_tool(name, {})
                assert result.is_error is False and result.structured_content is not None
                broker = result.structured_content["broker"]
                assert broker["status"] == "stale" and broker["read_mode"] == "persistent_fallback"
                assert all(
                    scope["read_mode"] == "persistent_fallback" for scope in broker["markets"]
                )
                assert all(scope["source_as_of"] for scope in broker["markets"])
                assert result.structured_content["warnings"]

    asyncio.run(exercise())
    with database.session() as session:
        after = [session.scalar(select(func.count()).select_from(model)) for model in models]
    assert before == after