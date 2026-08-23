from __future__ import annotations

import json
import os
import subprocess
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from pydantic import SecretStr

from kgi_broker_bridge.contracts import BrokerHealth, HealthStatus
from kgi_broker_bridge.errors import KGIUpstreamError
from kgi_broker_bridge.ports import (
    RawBrokerSnapshotBatch,
    RawInventoryBatch,
    RawMarketInventoryScope,
)

RESULT_PREFIX = "KGI_BRIDGE_RESULT_V1="
MAX_WORKER_OUTPUT_CHARS = 2_000_000
CHILD_ENV_ALLOWLIST = {
    "APPDATA",
    "COMSPEC",
    "LOCALAPPDATA",
    "OS",
    "PATH",
    "PATHEXT",
    "PROGRAMDATA",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR",
}


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _run_worker_process(
    command: tuple[str, ...],
    *,
    env: Mapping[str, str],
    cwd: Path,
    timeout_seconds: float,
) -> subprocess.CompletedProcess[str]:
    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=dict(env),
        cwd=cwd,
        timeout=timeout_seconds,
        creationflags=creation_flags,
    )


@dataclass(slots=True, repr=False)
class KGISuperPySubprocessGateway:
    sdk_python: Path
    person_id: SecretStr = field(repr=False)
    person_password: SecretStr = field(repr=False)
    simulation: bool = False
    stock_account: SecretStr | None = field(default=None, repr=False)
    sub_account: SecretStr | None = field(default=None, repr=False)
    timeout_seconds: float = 45.0
    working_directory: Path = field(default_factory=Path.cwd)
    worker_path: Path = field(
        default_factory=lambda: Path(__file__).resolve().parents[1] / "kgi_worker.py"
    )
    clock: Callable[[], datetime] = _utc_now
    process_runner: Callable[..., subprocess.CompletedProcess[str]] = field(
        default=_run_worker_process,
        repr=False,
    )
    _lock: threading.RLock = field(default_factory=threading.RLock, init=False, repr=False)
    _status: HealthStatus = field(default=HealthStatus.DISCONNECTED, init=False, repr=False)
    _package_version: str | None = field(default=None, init=False, repr=False)
    _last_success_at: datetime | None = field(default=None, init=False, repr=False)
    _warning: str = field(default="live_inventory_check_not_run", init=False, repr=False)

    def get_health(self) -> BrokerHealth:
        with self._lock:
            status = self._status
            login = None
            ca = None
            account = None
            positions = None
            if status is HealthStatus.HEALTHY:
                login, ca, account, positions = True, True, True, True
            elif status is HealthStatus.AUTH_FAILED:
                login, positions = False, False
            elif status is HealthStatus.CA_FAILED:
                login, ca, positions = False, False, False
            elif status is HealthStatus.ACCOUNT_UNAVAILABLE:
                login, ca, account, positions = True, True, False, False
            elif status is HealthStatus.DEGRADED:
                login, ca, account, positions = True, True, True, False
            elif status is HealthStatus.TIMEOUT:
                positions = False
            return BrokerHealth(
                status=status,
                package_version=self._package_version,
                login=login,
                ca=ca,
                account=account,
                quote=None,
                positions=positions,
                checked_at=self.clock(),
                last_success_at=self._last_success_at,
                warnings=(self._warning,) if self._warning else (),
            )

    def read_inventory(self, book_code: str) -> RawInventoryBatch:
        if book_code != "B":
            raise KGIUpstreamError("internal_error")

        with self._lock:
            try:
                completed = self.process_runner(
                    self._command(),
                    env=self._worker_environment(),
                    cwd=self.working_directory,
                    timeout_seconds=self.timeout_seconds,
                )
            except subprocess.TimeoutExpired as exc:
                self._record_failure("timeout")
                raise KGIUpstreamError("timeout") from exc
            except OSError as exc:
                self._record_failure("sdk_unavailable")
                raise KGIUpstreamError("sdk_unavailable") from exc

            payload = self._parse_result(completed)
            if not payload.get("ok"):
                reason = self._safe_reason(payload.get("error_code"))
                self._record_failure(reason)
                raise KGIUpstreamError(reason)

            try:
                account_ref = str(payload["account_ref"])
                captured_at = datetime.fromisoformat(str(payload["captured_at"]))
                source_as_of = datetime.fromisoformat(str(payload["source_as_of"]))
                raw_rows = payload["rows"]
                raw_warnings = payload.get("warnings", [])
                explicit_empty = payload.get("explicit_empty", False)
                if captured_at.tzinfo is None or source_as_of.tzinfo is None:
                    raise ValueError("timezone")
                if not isinstance(raw_rows, list) or not all(
                    isinstance(row, dict) for row in raw_rows
                ):
                    raise ValueError("rows")
                if not isinstance(raw_warnings, list) or not all(
                    isinstance(item, str) for item in raw_warnings
                ):
                    raise ValueError("warnings")
                if not account_ref.strip():
                    raise ValueError("account_ref")
                if not isinstance(explicit_empty, bool):
                    raise ValueError("explicit_empty")
                batch = RawInventoryBatch(
                    account_ref=account_ref,
                    captured_at=captured_at.astimezone(UTC),
                    source_as_of=source_as_of.astimezone(UTC),
                    rows=tuple(raw_rows),
                    explicit_empty=explicit_empty,
                    warnings=tuple(raw_warnings),
                )
            except (KeyError, TypeError, ValueError) as exc:
                self._record_failure("worker_protocol_invalid")
                raise KGIUpstreamError("worker_protocol_invalid") from exc

            self._package_version = self._optional_text(payload.get("package_version"))
            self._status = HealthStatus.HEALTHY
            self._last_success_at = captured_at.astimezone(UTC)
            self._warning = "one_shot_worker_session"
            return batch

    def read_positions_v2(self) -> RawBrokerSnapshotBatch:
        with self._lock:
            try:
                completed = self.process_runner(
                    self._command("positions-v2"),
                    env=self._worker_environment(),
                    cwd=self.working_directory,
                    timeout_seconds=self.timeout_seconds,
                )
            except subprocess.TimeoutExpired as exc:
                self._record_failure("timeout")
                raise KGIUpstreamError("timeout") from exc
            except OSError as exc:
                self._record_failure("sdk_unavailable")
                raise KGIUpstreamError("sdk_unavailable") from exc

            payload = self._parse_result(completed)
            if not payload.get("ok"):
                reason = self._safe_reason(payload.get("error_code"))
                self._record_failure(reason)
                raise KGIUpstreamError(reason)
            try:
                captured_at = datetime.fromisoformat(str(payload["captured_at"]))
                raw_scopes = payload["scopes"]
                raw_warnings = payload.get("warnings", [])
                if captured_at.tzinfo is None:
                    raise ValueError("captured_at")
                if not isinstance(raw_scopes, list) or not isinstance(raw_warnings, list):
                    raise ValueError("scopes")
                if not all(isinstance(item, str) for item in raw_warnings):
                    raise ValueError("warnings")
                scopes: list[RawMarketInventoryScope] = []
                for raw_scope in raw_scopes:
                    if not isinstance(raw_scope, dict):
                        raise ValueError("scope")
                    market = str(raw_scope["market"])
                    if market not in {"TW", "US"}:
                        raise ValueError("market")
                    account_ref_value = raw_scope.get("account_ref")
                    account_ref = (
                        None
                        if account_ref_value is None
                        else str(account_ref_value).strip() or None
                    )
                    source_value = raw_scope.get("source_as_of")
                    source_as_of = (
                        None
                        if source_value is None
                        else datetime.fromisoformat(str(source_value)).astimezone(UTC)
                    )
                    rows = raw_scope.get("rows", [])
                    warnings = raw_scope.get("warnings", [])
                    explicit_empty = raw_scope.get("explicit_empty", False)
                    error_value = raw_scope.get("error_code")
                    error_code = None if error_value is None else self._safe_reason(error_value)
                    if not isinstance(rows, list) or not all(
                        isinstance(row, dict) for row in rows
                    ):
                        raise ValueError("rows")
                    if not isinstance(warnings, list) or not all(
                        isinstance(item, str) for item in warnings
                    ):
                        raise ValueError("warnings")
                    if not isinstance(explicit_empty, bool):
                        raise ValueError("explicit_empty")
                    scopes.append(
                        RawMarketInventoryScope(
                            market=market,  # type: ignore[arg-type]
                            account_ref=account_ref,
                            source_as_of=source_as_of,
                            rows=tuple(rows),
                            explicit_empty=explicit_empty,
                            warnings=tuple(warnings),
                            error_code=error_code,
                        )
                    )
                if {scope.market for scope in scopes} != {"TW", "US"} or len(scopes) != 2:
                    raise ValueError("markets")
            except (KeyError, TypeError, ValueError) as exc:
                self._record_failure("worker_protocol_invalid")
                raise KGIUpstreamError("worker_protocol_invalid") from exc

            self._package_version = self._optional_text(payload.get("package_version"))
            partial = any(scope.error_code for scope in scopes)
            self._status = HealthStatus.DEGRADED if partial else HealthStatus.HEALTHY
            self._last_success_at = captured_at.astimezone(UTC)
            self._warning = "partial_market_scope" if partial else "one_shot_worker_session"
            return RawBrokerSnapshotBatch(
                captured_at=captured_at.astimezone(UTC),
                scopes=tuple(scopes),
                warnings=tuple(raw_warnings),
            )

    def _command(self, worker_command: str = "positions") -> tuple[str, ...]:
        return (
            str(self.sdk_python),
            "-X",
            "utf8",
            str(self.worker_path),
            worker_command,
        )

    def _worker_environment(self) -> dict[str, str]:
        environment = {
            key: value
            for key, value in os.environ.items()
            if key.upper() in CHILD_ENV_ALLOWLIST
        }
        environment.update(
            {
                "PYTHONUTF8": "1",
                "PYTHONIOENCODING": "utf-8",
                "KGI_BRIDGE_PERSON_ID": self.person_id.get_secret_value(),
                "KGI_BRIDGE_PERSON_PASSWORD": self.person_password.get_secret_value(),
                "KGI_BRIDGE_SIMULATION": "true" if self.simulation else "false",
            }
        )
        if self.stock_account is not None:
            environment["KGI_BRIDGE_STOCK_ACCOUNT"] = (
                self.stock_account.get_secret_value()
            )
        else:
            environment.pop("KGI_BRIDGE_STOCK_ACCOUNT", None)
        if self.sub_account is not None:
            environment["KGI_BRIDGE_SUB_ACCOUNT"] = self.sub_account.get_secret_value()
        else:
            environment.pop("KGI_BRIDGE_SUB_ACCOUNT", None)
        return environment

    def _parse_result(
        self, completed: subprocess.CompletedProcess[str]
    ) -> dict[str, object]:
        if (
            len(completed.stdout) > MAX_WORKER_OUTPUT_CHARS
            or len(completed.stderr) > MAX_WORKER_OUTPUT_CHARS
        ):
            self._record_failure("worker_protocol_invalid")
            raise KGIUpstreamError("worker_protocol_invalid")

        result_line = next(
            (
                line[len(RESULT_PREFIX) :]
                for line in reversed(completed.stdout.splitlines())
                if line.startswith(RESULT_PREFIX)
            ),
            None,
        )
        if result_line is None:
            reason = "sdk_unavailable" if completed.returncode == 3 else "worker_protocol_invalid"
            self._record_failure(reason)
            raise KGIUpstreamError(reason)
        try:
            payload = json.loads(result_line)
        except json.JSONDecodeError as exc:
            self._record_failure("worker_protocol_invalid")
            raise KGIUpstreamError("worker_protocol_invalid") from exc
        if not isinstance(payload, dict):
            self._record_failure("worker_protocol_invalid")
            raise KGIUpstreamError("worker_protocol_invalid")
        if payload.get("ok") is True and completed.returncode != 0:
            self._record_failure("worker_protocol_invalid")
            raise KGIUpstreamError("worker_protocol_invalid")
        return payload

    def _record_failure(self, reason: str) -> None:
        status_by_reason = {
            "auth_failed": HealthStatus.AUTH_FAILED,
            "ca_failed": HealthStatus.CA_FAILED,
            "account_unavailable": HealthStatus.ACCOUNT_UNAVAILABLE,
            "inventory_fetch_failed": HealthStatus.DEGRADED,
            "sdk_unavailable": HealthStatus.NOT_CONFIGURED,
            "timeout": HealthStatus.TIMEOUT,
            "worker_protocol_invalid": HealthStatus.INTERNAL_ERROR,
            "internal_error": HealthStatus.INTERNAL_ERROR,
        }
        self._status = status_by_reason.get(reason, HealthStatus.INTERNAL_ERROR)
        self._warning = f"last_inventory_attempt_failed:{self._safe_reason(reason)}"

    @staticmethod
    def _safe_reason(value: object) -> str:
        reason = str(value)
        allowed = {
            "auth_failed",
            "ca_failed",
            "account_unavailable",
            "inventory_fetch_failed",
            "sdk_unavailable",
            "timeout",
            "worker_protocol_invalid",
            "internal_error",
        }
        return reason if reason in allowed else "internal_error"

    @staticmethod
    def _optional_text(value: object) -> str | None:
        if value is None:
            return None
        text = str(value).strip()
        return text or None
