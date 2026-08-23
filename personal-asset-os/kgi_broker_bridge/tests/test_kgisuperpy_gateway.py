from __future__ import annotations

import json
import subprocess
from collections.abc import Mapping
from pathlib import Path

import pytest
from pydantic import SecretStr

from kgi_broker_bridge.adapters.kgisuperpy_gateway import (
    RESULT_PREFIX,
    KGISuperPySubprocessGateway,
)
from kgi_broker_bridge.contracts import HealthStatus
from kgi_broker_bridge.errors import KGIUpstreamError

PERSON_ID = "SYNTHETIC-PERSON-ID"
PASSWORD = "SYNTHETIC-PASSWORD"
ACCOUNT = "SYNTHETIC-ACCOUNT-0001"


def _success_payload() -> dict[str, object]:
    return {
        "ok": True,
        "account_ref": ACCOUNT,
        "captured_at": "2026-08-20T01:02:03+00:00",
        "source_as_of": "2026-08-20T01:02:03+00:00",
        "explicit_empty": False,
        "rows": [
            {
                "Symbol": "0050",
                "SymbolName": "合成測試 ETF",
                "NETQTY0": "1000",
            }
        ],
        "warnings": ["source_as_of_inferred_from_capture_time"],
        "package_version": "2.1.0",
    }


def _v2_success_payload() -> dict[str, object]:
    captured_at = "2026-08-20T01:02:03+00:00"
    return {
        "ok": True,
        "captured_at": captured_at,
        "scopes": [
            {
                "market": "TW",
                "account_ref": ACCOUNT,
                "source_as_of": captured_at,
                "explicit_empty": True,
                "rows": [],
                "warnings": [],
                "error_code": None,
            },
            {
                "market": "US",
                "account_ref": None,
                "source_as_of": None,
                "explicit_empty": False,
                "rows": [],
                "warnings": [],
                "error_code": "account_unavailable",
            },
        ],
        "warnings": ["one_shot_worker_session"],
        "package_version": "2.1.0",
    }


class FakeRunner:
    def __init__(self, payload: Mapping[str, object], *, returncode: int = 0) -> None:
        self.payload = payload
        self.returncode = returncode
        self.command: tuple[str, ...] | None = None
        self.environment: Mapping[str, str] | None = None
        self.working_directory: Path | None = None
        self.timeout_seconds: float | None = None

    def __call__(
        self,
        command: tuple[str, ...],
        *,
        env: Mapping[str, str],
        cwd: Path,
        timeout_seconds: float,
    ) -> subprocess.CompletedProcess[str]:
        self.command = command
        self.environment = env
        self.working_directory = cwd
        self.timeout_seconds = timeout_seconds
        stdout = "vendor output must be ignored\n" + RESULT_PREFIX + json.dumps(self.payload)
        return subprocess.CompletedProcess(command, self.returncode, stdout, "private stderr")


def _gateway(runner: FakeRunner) -> KGISuperPySubprocessGateway:
    return KGISuperPySubprocessGateway(
        sdk_python=Path("C:/synthetic/python.exe"),
        person_id=SecretStr(PERSON_ID),
        person_password=SecretStr(PASSWORD),
        stock_account=SecretStr(ACCOUNT),
        working_directory=Path("C:/synthetic/runtime"),
        process_runner=runner,
    )


def test_gateway_passes_secrets_only_in_bounded_child_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("UNRELATED_API_SECRET", "MUST-NOT-BE-INHERITED")
    runner = FakeRunner(_success_payload())
    gateway = _gateway(runner)
    batch = gateway.read_inventory("B")

    assert batch.account_ref == ACCOUNT
    assert runner.command is not None
    assert PERSON_ID not in " ".join(runner.command)
    assert PASSWORD not in " ".join(runner.command)
    assert runner.environment is not None
    assert runner.environment["KGI_BRIDGE_PERSON_ID"] == PERSON_ID
    assert runner.environment["KGI_BRIDGE_PERSON_PASSWORD"] == PASSWORD
    assert runner.working_directory == Path("C:/synthetic/runtime")
    assert "UNRELATED_API_SECRET" not in runner.environment
    assert PERSON_ID not in repr(gateway)
    assert PASSWORD not in repr(gateway)
    assert gateway.get_health().status is HealthStatus.HEALTHY


@pytest.mark.parametrize(
    ("reason", "health_status", "http_status"),
    [
        ("auth_failed", HealthStatus.AUTH_FAILED, 502),
        ("ca_failed", HealthStatus.CA_FAILED, 502),
        ("account_unavailable", HealthStatus.ACCOUNT_UNAVAILABLE, 502),
        ("timeout", HealthStatus.TIMEOUT, 504),
        ("sdk_unavailable", HealthStatus.NOT_CONFIGURED, 503),
    ],
)
def test_gateway_maps_worker_failures_to_safe_errors(
    reason: str, health_status: HealthStatus, http_status: int
) -> None:
    gateway = _gateway(FakeRunner({"ok": False, "error_code": reason}, returncode=1))

    with pytest.raises(KGIUpstreamError) as captured:
        gateway.read_inventory("B")

    assert captured.value.code == f"kgi_{reason}"
    assert captured.value.http_status == http_status
    assert PERSON_ID not in captured.value.message
    assert PASSWORD not in captured.value.message
    assert gateway.get_health().status is health_status


def test_gateway_rejects_missing_or_malformed_worker_result() -> None:
    class InvalidRunner(FakeRunner):
        def __call__(
            self,
            command: tuple[str, ...],
            *,
            env: Mapping[str, str],
            cwd: Path,
            timeout_seconds: float,
        ) -> subprocess.CompletedProcess[str]:
            return subprocess.CompletedProcess(command, 1, "vendor output only", "")

    gateway = _gateway(InvalidRunner({}))
    with pytest.raises(KGIUpstreamError) as captured:
        gateway.read_inventory("B")
    assert captured.value.code == "kgi_worker_protocol_invalid"
    assert gateway.get_health().status is HealthStatus.INTERNAL_ERROR


def test_gateway_parses_v2_partial_market_scopes() -> None:
    runner = FakeRunner(_v2_success_payload())
    gateway = _gateway(runner)

    batch = gateway.read_positions_v2()

    assert runner.command is not None and runner.command[-1] == "positions-v2"
    assert {scope.market for scope in batch.scopes} == {"TW", "US"}
    assert batch.scopes[1].error_code == "account_unavailable"
    assert gateway.get_health().status is HealthStatus.DEGRADED
