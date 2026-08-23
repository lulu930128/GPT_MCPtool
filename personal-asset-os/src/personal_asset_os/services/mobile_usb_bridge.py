from __future__ import annotations

import asyncio
import logging
import os
import subprocess
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

from personal_asset_os.settings import Settings

logger = logging.getLogger(__name__)

TRANSPORT_SCHEMA_VERSION = "paos.mobile_usb_transport.v1"


@dataclass(frozen=True)
class AdbCommandResult:
    returncode: int
    stdout: str
    stderr: str


class AdbCommandRunner(Protocol):
    async def run(self, arguments: Sequence[str]) -> AdbCommandResult: ...


class SubprocessAdbCommandRunner:
    def __init__(
        self,
        adb_path: Path,
        *,
        server_socket: str | None,
        timeout_seconds: float,
    ) -> None:
        self._adb_path = adb_path
        self._server_socket = server_socket
        self._timeout_seconds = timeout_seconds

    async def run(self, arguments: Sequence[str]) -> AdbCommandResult:
        return await asyncio.to_thread(self._run, tuple(arguments))

    def _run(self, arguments: tuple[str, ...]) -> AdbCommandResult:
        environment = os.environ.copy()
        if self._server_socket:
            environment["ADB_SERVER_SOCKET"] = self._server_socket
        completed = subprocess.run(
            [str(self._adb_path), *arguments],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=environment,
            timeout=self._timeout_seconds,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return AdbCommandResult(
            returncode=completed.returncode,
            stdout=completed.stdout,
            stderr=completed.stderr,
        )


@dataclass(frozen=True)
class MobileUsbBridgeSnapshot:
    enabled: bool
    status: str
    ready: bool
    configured_device: bool
    device_count: int
    last_checked_at: str | None
    last_ready_at: str | None
    error_code: str | None

    def as_dict(self) -> dict[str, object]:
        return {
            "schema_version": TRANSPORT_SCHEMA_VERSION,
            "enabled": self.enabled,
            "status": self.status,
            "ready": self.ready,
            "configured_device": self.configured_device,
            "device_count": self.device_count,
            "last_checked_at": self.last_checked_at,
            "last_ready_at": self.last_ready_at,
            "error_code": self.error_code,
        }


class MobileUsbBridge:
    def __init__(
        self,
        settings: Settings,
        *,
        runner: AdbCommandRunner | None = None,
    ) -> None:
        self._settings = settings
        self._runner = runner
        if runner is None and settings.mobile_adb_path is not None:
            self._runner = SubprocessAdbCommandRunner(
                settings.mobile_adb_path,
                server_socket=settings.mobile_adb_server_socket,
                timeout_seconds=settings.mobile_adb_command_timeout_seconds,
            )
        initial_status = "starting" if settings.mobile_usb_bridge_enabled else "disabled"
        self._snapshot = MobileUsbBridgeSnapshot(
            enabled=settings.mobile_usb_bridge_enabled,
            status=initial_status,
            ready=False,
            configured_device=settings.mobile_adb_serial is not None,
            device_count=0,
            last_checked_at=None,
            last_ready_at=None,
            error_code=None,
        )

    def snapshot(self) -> dict[str, object]:
        return self._snapshot.as_dict()

    async def run(self, stop_event: asyncio.Event) -> None:
        if not self._settings.mobile_usb_bridge_enabled:
            await stop_event.wait()
            return
        while not stop_event.is_set():
            await self.check_once()
            try:
                await asyncio.wait_for(
                    stop_event.wait(),
                    timeout=self._settings.mobile_usb_bridge_poll_seconds,
                )
            except TimeoutError:
                continue

    async def check_once(self) -> None:
        checked_at = datetime.now(UTC).isoformat()
        adb_path = self._settings.mobile_adb_path
        if self._runner is None or adb_path is None or not adb_path.is_file():
            self._set_snapshot(
                status="adb_unavailable",
                device_count=0,
                checked_at=checked_at,
                error_code="ADB_UNAVAILABLE",
            )
            return

        try:
            devices_result = await self._runner.run(("devices",))
            if devices_result.returncode != 0:
                self._set_snapshot(
                    status="probe_failed",
                    device_count=0,
                    checked_at=checked_at,
                    error_code="ADB_DEVICES_FAILED",
                )
                return
            devices = _parse_devices(devices_result.stdout)
            selected, failure_status = self._select_device(devices)
            if selected is None:
                self._set_snapshot(
                    status=failure_status,
                    device_count=len(devices),
                    checked_at=checked_at,
                    error_code=_status_error_code(failure_status),
                )
                return

            serial = selected[0]
            reverse_arguments = ("-s", serial, "reverse", "--list")
            reverse_result = await self._runner.run(reverse_arguments)
            if reverse_result.returncode != 0:
                self._set_snapshot(
                    status="probe_failed",
                    device_count=len(devices),
                    checked_at=checked_at,
                    error_code="ADB_REVERSE_LIST_FAILED",
                )
                return
            if not self._has_expected_mapping(reverse_result.stdout):
                port = self._settings.port
                repair_result = await self._runner.run(
                    ("-s", serial, "reverse", f"tcp:{port}", f"tcp:{port}")
                )
                if repair_result.returncode != 0:
                    self._set_snapshot(
                        status="repair_failed",
                        device_count=len(devices),
                        checked_at=checked_at,
                        error_code="ADB_REVERSE_REPAIR_FAILED",
                    )
                    return
                verified = await self._runner.run(reverse_arguments)
                if verified.returncode != 0 or not self._has_expected_mapping(
                    verified.stdout
                ):
                    self._set_snapshot(
                        status="repair_failed",
                        device_count=len(devices),
                        checked_at=checked_at,
                        error_code="ADB_REVERSE_VERIFY_FAILED",
                    )
                    return
            self._set_snapshot(
                status="reverse_ready",
                device_count=len(devices),
                checked_at=checked_at,
                error_code=None,
            )
        except (OSError, subprocess.SubprocessError, TimeoutError) as exc:
            logger.warning(
                "Mobile USB bridge probe failed (%s)", type(exc).__name__
            )
            self._set_snapshot(
                status="probe_failed",
                device_count=0,
                checked_at=checked_at,
                error_code="ADB_COMMAND_FAILED",
            )

    def _select_device(
        self, devices: list[tuple[str, str]]
    ) -> tuple[tuple[str, str] | None, str]:
        configured_serial = self._settings.mobile_adb_serial
        if configured_serial is not None:
            selected = next(
                (device for device in devices if device[0] == configured_serial), None
            )
            if selected is None:
                return None, "waiting_for_device"
            if selected[1] == "device":
                return selected, "reverse_ready"
            if selected[1] == "unauthorized":
                return None, "device_unauthorized"
            return None, "device_offline"

        if not devices:
            return None, "waiting_for_device"
        if len(devices) > 1:
            return None, "multiple_devices"
        selected = devices[0]
        if selected[1] == "device":
            return selected, "reverse_ready"
        if selected[1] == "unauthorized":
            return None, "device_unauthorized"
        return None, "device_offline"

    def _has_expected_mapping(self, value: str) -> bool:
        expected = f"tcp:{self._settings.port}"
        for line in value.splitlines():
            fields = line.strip().split()
            if len(fields) >= 2 and fields[-2:] == [expected, expected]:
                return True
        return False

    def _set_snapshot(
        self,
        *,
        status: str,
        device_count: int,
        checked_at: str,
        error_code: str | None,
    ) -> None:
        ready = status == "reverse_ready"
        self._snapshot = MobileUsbBridgeSnapshot(
            enabled=True,
            status=status,
            ready=ready,
            configured_device=self._settings.mobile_adb_serial is not None,
            device_count=device_count,
            last_checked_at=checked_at,
            last_ready_at=checked_at if ready else self._snapshot.last_ready_at,
            error_code=error_code,
        )


def _parse_devices(value: str) -> list[tuple[str, str]]:
    devices: list[tuple[str, str]] = []
    for line in value.splitlines():
        normalized = line.strip()
        if not normalized or normalized.startswith("List of devices attached"):
            continue
        fields = normalized.split()
        if len(fields) >= 2:
            devices.append((fields[0], fields[1]))
    return devices


def _status_error_code(status: str) -> str | None:
    return {
        "waiting_for_device": None,
        "device_unauthorized": "ADB_DEVICE_UNAUTHORIZED",
        "device_offline": "ADB_DEVICE_OFFLINE",
        "multiple_devices": "ADB_MULTIPLE_DEVICES",
    }.get(status, "ADB_DEVICE_UNAVAILABLE")
