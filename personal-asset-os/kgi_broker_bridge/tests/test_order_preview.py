"""Synthetic only: the SDK exists solely as a fake defined in this file."""
from __future__ import annotations

import builtins
import json
import socket
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from enum import Enum
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from pydantic import ValidationError
from pydantic_settings import BaseSettings

from kgi_broker_bridge.kgi_worker import _stock_account
from kgi_broker_bridge.order_cli import main
from kgi_broker_bridge.order_preview import (
    FixedOrder,
    OfflineConflict,
    OfflineSettings,
    State,
    SyntheticAttempt,
    SyntheticReceipt,
    preview,
    sdk_arguments,
)


@pytest.fixture(autouse=True)
def offline_fence(monkeypatch: pytest.MonkeyPatch) -> None:
    original_import = builtins.__import__

    def guarded_import(name: str, *args: Any, **kwargs: Any) -> Any:
        if name.split(".")[0] == "kgisuperpy":
            raise AssertionError("native_sdk_import_forbidden")
        return original_import(name, *args, **kwargs)

    def forbidden(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("network_or_environment_settings_forbidden")

    monkeypatch.setattr(builtins, "__import__", guarded_import)
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)
    monkeypatch.setattr(socket.socket, "sendto", forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(socket, "getaddrinfo", forbidden)
    monkeypatch.setattr(BaseSettings, "__init__", forbidden)


class Action(Enum):
    Buy = "B"


class TimeInForce(Enum):
    ROD = 0


class OrderCond(Enum):
    CASH = 0


class OddLot(Enum):
    Odd = 4


class FakeSDK:
    Action = Action
    TimeInForce = TimeInForce
    OrderCond = OrderCond
    OddLot = OddLot

    def __init__(self, *, timeout: bool = False) -> None:
        self.Order = self
        self.timeout = timeout
        self.calls: list[dict[str, object]] = []
        self.events: list[str] = []
        self.selected: str | None = None

    def login(self, person_id: str, password: str, simulation: bool) -> FakeSDK:
        assert (person_id, password, simulation) == ("FAKE-PERSON", "FAKE-PASSWORD", False)
        self.events.append("login")
        return self

    def show_account(self) -> list[dict[str, str]]:
        return [{"account_flag": "期貨", "account": "SYNTHETIC-FUTURES"},
                {"account_flag": "證券", "account": "SYNTHETIC-STOCK"}]

    def set_Account(self, account: str) -> None:  # noqa: N802
        self.selected = account
        self.events.append("set_Account")

    def create_order(
        self, action: Action, symbol: str, qty: int, price: int,
        time_in_force: TimeInForce, order_cond: OrderCond, odd_lot: OddLot, name: str,
    ) -> object:
        assert self.selected == "SYNTHETIC-STOCK"
        self.calls.append({"action": action, "symbol": symbol, "qty": qty, "price": price,
                           "time_in_force": time_in_force, "order_cond": order_cond,
                           "odd_lot": odd_lot, "name": name})
        self.events.append("create_order")
        if self.timeout:
            raise TimeoutError("SYNTHETIC-VENDOR-DETAIL")
        # Merely returning a Trade-like object must not mean accepted or filled.
        return SimpleNamespace(status="pending")

    def logout(self) -> None:
        self.events.append("logout")


def fake_worker(directory: Path, sdk: FakeSDK, attempt_id: str = "fake-first") -> SyntheticAttempt:
    """Test-only session owner; never shipped as a callable production send adapter."""
    assert type(sdk) is FakeSDK
    attempt = SyntheticAttempt.claim(directory, FixedOrder(), attempt_id, existing_orders=())
    session = sdk.login("FAKE-PERSON", "FAKE-PASSWORD", OfflineSettings().simulation)
    try:
        session.set_Account(_stock_account(session, None))
        try:
            session.Order.create_order(**sdk_arguments(FixedOrder(), sdk))  # type: ignore[arg-type]
        except TimeoutError:
            pass  # Claim remains UNKNOWN; no retry and no vendor exception in receipts.
    finally:
        session.logout()
    return attempt


def receipt(attempt: SyntheticAttempt, **changes: Any) -> SyntheticReceipt:
    return SyntheticReceipt(**{
        "intent_sha256": attempt.intent_sha256, "attempt_id": attempt.attempt_id,
        "broker_order_id": "fake-order-1", "state": State.BROKER_ACCEPTED, **changes,
    })


def test_exact_sdk_mapping_and_owned_fake_session(tmp_path: Path) -> None:
    sdk = FakeSDK()
    attempt = fake_worker(tmp_path, sdk)
    assert sdk.events == ["login", "set_Account", "create_order", "logout"]
    assert sdk.calls == [{"action": Action.Buy, "symbol": "2330", "qty": 1, "price": 2160,
                          "time_in_force": TimeInForce.ROD, "order_cond": OrderCond.CASH,
                          "odd_lot": OddLot.Odd, "name": ""}]
    assert type(sdk.calls[0]["qty"]) is int
    assert type(sdk.calls[0]["price"]) is int
    assert attempt.reconcile(()) == State.UNKNOWN


@pytest.mark.parametrize("changes", [
    {"symbol": "2303"}, {"action": "SELL"}, {"quantity_shares": 1000},
    {"quantity_shares": 0}, {"quantity_shares": -1}, {"quantity_shares": True},
    {"quantity_shares": 1.0}, {"quantity_shares": "1"}, {"price": Decimal("2159")},
    {"price": Decimal("2160.01")}, {"price": Decimal("NaN")}, {"price": Decimal("Infinity")},
    {"price": 2160.0}, {"price": None}, {"odd_lot": True}, {"odd_lot": "OddLot.Odd_AfterMarket"},
    {"time_in_force": "IOC"}, {"order_cond": "MARGIN"}, {"price_type": "MARKET"},
    {"account": "unexpected"},
])
def test_fixed_scope_rejects_drift_before_fake_call(changes: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        FixedOrder(**changes)


def test_mapping_revalidates_constructed_order() -> None:
    with pytest.raises(ValidationError):
        sdk_arguments(FixedOrder.model_construct(symbol="2303"), FakeSDK())


@pytest.mark.parametrize("timeout", [False, True])
@pytest.mark.parametrize("next_id", ["fake-first", "fake-another"])
def test_duplicate_never_opens_second_session(tmp_path: Path, timeout: bool, next_id: str) -> None:
    first = FakeSDK(timeout=timeout)
    attempt = fake_worker(tmp_path, first)
    second = FakeSDK()
    with pytest.raises(OfflineConflict, match="duplicate_or_unknown_attempt"):
        fake_worker(tmp_path, second, next_id)
    assert len(first.calls) == 1
    assert second.events == []
    # A newly constructed owner cannot infer no-send from absent broker evidence.
    restored = SyntheticAttempt(tmp_path, attempt.intent_sha256, attempt.attempt_id)
    assert restored.reconcile(()) == State.UNKNOWN


def test_concurrent_claim_has_one_owner(tmp_path: Path) -> None:
    def claim(index: int) -> str:
        try:
            SyntheticAttempt.claim(tmp_path, FixedOrder(), f"fake-{index}", existing_orders=())
            return "owned"
        except OfflineConflict:
            return "blocked"

    with ThreadPoolExecutor(max_workers=4) as pool:
        outcomes = list(pool.map(claim, range(8)))
    assert outcomes.count("owned") == 1
    assert outcomes.count("blocked") == 7


def test_crash_during_claim_remains_unknown_and_blocks_retry(tmp_path: Path) -> None:
    fingerprint = FixedOrder().fingerprint()
    (tmp_path / f"{fingerprint}.claim.json").write_text("{", encoding="utf-8")
    restored = SyntheticAttempt(tmp_path, fingerprint, "fake-first")
    assert restored.reconcile(()) == State.UNKNOWN
    with pytest.raises(OfflineConflict):
        fake_worker(tmp_path, FakeSDK())


def test_unknown_reconciles_only_exact_synthetic_receipt(tmp_path: Path) -> None:
    attempt = fake_worker(tmp_path, FakeSDK(timeout=True))
    accepted = receipt(attempt)
    filled = receipt(attempt, state=State.FILLED, filled_shares=1)
    assert attempt.reconcile((accepted,)) == State.BROKER_ACCEPTED
    assert attempt.reconcile((filled,)) == State.FILLED
    assert attempt.reconcile(()) == State.UNKNOWN
    assert attempt.reconcile((accepted, filled)) == State.UNKNOWN
    assert attempt.reconcile((receipt(attempt, attempt_id="fake-other"),)) == State.UNKNOWN
    assert attempt.reconcile((receipt(attempt, intent_sha256="wrong"),)) == State.UNKNOWN
    assert attempt.reconcile((receipt(attempt, state=State.FILLED),)) == State.UNKNOWN
    assert attempt.reconcile((receipt(attempt, filled_shares=1),)) == State.UNKNOWN
    assert attempt.reconcile((accepted.model_copy(update={"account": "wrong"}),)) == State.UNKNOWN
    with pytest.raises(OfflineConflict):
        fake_worker(tmp_path, FakeSDK(), "fake-new-request")


def test_foreign_owner_cannot_reconcile(tmp_path: Path) -> None:
    owned = fake_worker(tmp_path, FakeSDK())
    foreign = SyntheticAttempt(tmp_path, owned.intent_sha256, "fake-foreign")
    assert foreign.reconcile((receipt(foreign),)) == State.UNKNOWN


def test_existing_orders_or_missing_snapshot_prevent_first_attempt(tmp_path: Path) -> None:
    prior = SyntheticAttempt(tmp_path, FixedOrder().fingerprint(), "fake-prior")
    for snapshot in (None, (receipt(prior),)):
        with pytest.raises(OfflineConflict, match="existing_order"):
            SyntheticAttempt.claim(tmp_path, FixedOrder(), "fake-new", existing_orders=snapshot)
    assert list(tmp_path.iterdir()) == []


def test_disk_claim_blocks_another_process(tmp_path: Path) -> None:
    import os
    import subprocess
    import sys

    fake_worker(tmp_path, FakeSDK(timeout=True))
    source = Path(__file__).resolve().parents[1] / "src"
    code = """
import sys
def fence(event, args):
    if event.startswith('socket.') or (event == 'import' and
            str(args[0]).split('.')[0] == 'kgisuperpy'):
        raise RuntimeError('offline_fence')
sys.addaudithook(fence)
sys.path.insert(0, sys.argv[1])
from pathlib import Path
from kgi_broker_bridge.order_preview import FixedOrder, SyntheticAttempt, OfflineConflict
try:
    SyntheticAttempt.claim(Path(sys.argv[2]), FixedOrder(), 'fake-restart', existing_orders=())
except OfflineConflict:
    print('DUPLICATE_BLOCKED')
else:
    raise AssertionError('duplicate_claim_allowed')
"""
    env = {key: os.environ[key] for key in ("SYSTEMROOT", "TEMP", "TMP") if key in os.environ}
    completed = subprocess.run(
        [sys.executable, "-I", "-X", "utf8", "-c", code, str(source), str(tmp_path)],
        env=env, capture_output=True, text=True, timeout=15, check=False,
    )
    assert completed.returncode == 0, completed.stderr
    assert completed.stdout.strip() == "DUPLICATE_BLOCKED"


@pytest.mark.parametrize("args", [[], ["--dry-run"]])
def test_cli_preview_has_no_settings_io_or_sdk_effects(
    args: list[str], capsys: pytest.CaptureFixture[str], tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.chdir(tmp_path)
    # Synthetic poison file: BaseSettings initialization is forbidden by offline_fence.
    (tmp_path / ".env").write_text("KGI_BRIDGE_PERSON_PASSWORD=FAKE-POISON", encoding="utf-8")
    monkeypatch.setenv("KGI_BRIDGE_PERSON_PASSWORD", "FAKE-POISON")
    assert main(args) == 0
    output = capsys.readouterr().out
    result = json.loads(output)
    assert result["state"] == "PREVIEW"
    assert result["submission_state"] == "NOT_SENT"
    assert result["account"] == "NOT_SELECTED"
    assert result["send_attempted"] is result["login_attempted"] is result["sdk_imported"] is False
    assert result["order"]["price"] == "2160"
    assert result["order"]["quantity_shares"] == 1
    assert result["session_plan"]["simulation"] is False
    assert "FAKE-POISON" not in output
    assert len(list(tmp_path.iterdir())) == 1  # No audit/claim/runtime file created.


@pytest.mark.parametrize("args", [
    ["--symbol", "2303"], ["--action", "SELL"], ["--price", "2150"],
    ["--price", "NaN"], ["--quantity-shares", "1000"], ["--quantity-shares", "1.0"],
    ["--send"], ["--simulation"], ["--password", "FAKE-PRIVATE"],
])
def test_cli_rejects_drift_and_send_without_echoing_input(
    args: list[str], capsys: pytest.CaptureFixture[str],
) -> None:
    assert main(args) == 2
    output = capsys.readouterr().out
    assert json.loads(output)["state"] == "NOT_SENT"
    assert "FAKE-PRIVATE" not in output


def test_preview_fingerprint_stable_and_secret_free() -> None:
    first = preview(OfflineSettings(), FixedOrder())
    second = preview(OfflineSettings(), FixedOrder(price=Decimal("2160.00")))
    assert first["intent_sha256"] == second["intent_sha256"]
    assert first["sdk_arguments"]["odd_lot"] == "OddLot.Odd"  # type: ignore[index]
    assert first["broker_receipt"] == "UNVERIFIED"


def test_no_write_routes_or_send_calls_in_shipped_modules() -> None:
    import ast

    package = Path(__file__).resolve().parents[1] / "src" / "kgi_broker_bridge"
    for name in ("order_preview.py", "order_cli.py"):
        tree = ast.parse((package / name).read_text(encoding="utf-8"))
        calls = [node.func.attr for node in ast.walk(tree)
                 if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)]
        assert not {"login", "create_order", "cancel_order", "modify_order", "Popen"} & set(calls)
    api = ast.parse((package / "api.py").read_text(encoding="utf-8"))
    routes = [node.func.attr for node in ast.walk(api)
              if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
              and isinstance(node.func.value, ast.Name) and node.func.value.id == "app"]
    assert not {"post", "put", "patch", "delete"} & set(routes)
