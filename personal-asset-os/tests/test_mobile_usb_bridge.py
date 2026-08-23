from __future__ import annotations

import asyncio
import json
from collections import deque
from pathlib import Path

import pytest

from personal_asset_os.services.mobile_usb_bridge import (
    AdbCommandResult,
    MobileUsbBridge,
)
from personal_asset_os.settings import Settings


class FakeAdbRunner:
    def __init__(self, results: list[AdbCommandResult]) -> None:
        self.results = deque(results)
        self.calls: list[tuple[str, ...]] = []

    async def run(self, arguments: tuple[str, ...]) -> AdbCommandResult:
        self.calls.append(tuple(arguments))
        return self.results.popleft()


def result(stdout: str = "", *, returncode: int = 0) -> AdbCommandResult:
    return AdbCommandResult(returncode=returncode, stdout=stdout, stderr="")


def bridge_settings(tmp_path: Path, **overrides: object) -> Settings:
    adb_path = tmp_path / "adb.exe"
    adb_path.touch()
    values: dict[str, object] = {
        "_env_file": None,
        "data_dir": tmp_path / "data",
        "broker_bridge_enabled": False,
        "daily_snapshot_enabled": False,
        "mobile_usb_bridge_enabled": True,
        "mobile_adb_path": adb_path,
        "mobile_adb_serial": "device-one",
    }
    values.update(overrides)
    return Settings(**values)


def test_bridge_repairs_and_verifies_exact_reverse_mapping(tmp_path: Path) -> None:
    runner = FakeAdbRunner(
        [
            result("List of devices attached\ndevice-one\tdevice\n"),
            result(),
            result(),
            result("device-one tcp:18876 tcp:18876\n"),
        ]
    )
    bridge = MobileUsbBridge(bridge_settings(tmp_path), runner=runner)

    asyncio.run(bridge.check_once())

    snapshot = bridge.snapshot()
    assert snapshot["status"] == "reverse_ready"
    assert snapshot["ready"] is True
    assert snapshot["device_count"] == 1
    assert runner.calls == [
        ("devices",),
        ("-s", "device-one", "reverse", "--list"),
        ("-s", "device-one", "reverse", "tcp:18876", "tcp:18876"),
        ("-s", "device-one", "reverse", "--list"),
    ]
    assert "device-one" not in json.dumps(snapshot)


def test_bridge_recovers_when_configured_device_reconnects(tmp_path: Path) -> None:
    runner = FakeAdbRunner(
        [
            result("List of devices attached\n"),
            result("List of devices attached\ndevice-one\tdevice\n"),
            result(),
            result(),
            result("device-one tcp:18876 tcp:18876\n"),
        ]
    )
    bridge = MobileUsbBridge(bridge_settings(tmp_path), runner=runner)

    asyncio.run(bridge.check_once())
    assert bridge.snapshot()["status"] == "waiting_for_device"

    asyncio.run(bridge.check_once())
    assert bridge.snapshot()["status"] == "reverse_ready"
    assert bridge.snapshot()["last_ready_at"] is not None


def test_bridge_fails_closed_when_multiple_unconfigured_devices_exist(
    tmp_path: Path,
) -> None:
    runner = FakeAdbRunner(
        [result("List of devices attached\ndevice-one\tdevice\ndevice-two\tdevice\n")]
    )
    bridge = MobileUsbBridge(
        bridge_settings(tmp_path, mobile_adb_serial=None), runner=runner
    )

    asyncio.run(bridge.check_once())

    assert bridge.snapshot()["status"] == "multiple_devices"
    assert bridge.snapshot()["ready"] is False
    assert runner.calls == [("devices",)]


def test_bridge_reports_missing_adb_without_affecting_core_settings(
    tmp_path: Path,
) -> None:
    settings = bridge_settings(tmp_path, mobile_adb_path=tmp_path / "missing-adb.exe")
    bridge = MobileUsbBridge(settings)

    asyncio.run(bridge.check_once())

    assert bridge.snapshot()["status"] == "adb_unavailable"
    assert bridge.snapshot()["error_code"] == "ADB_UNAVAILABLE"


def test_mobile_adb_socket_must_remain_loopback(tmp_path: Path) -> None:
    settings = bridge_settings(
        tmp_path, mobile_adb_server_socket="tcp:localhost:15037"
    )
    assert settings.mobile_adb_server_socket == "tcp:localhost:15037"
    with pytest.raises(ValueError, match="tcp:localhost"):
        bridge_settings(tmp_path, mobile_adb_server_socket="tcp:192.168.1.10:5037")
