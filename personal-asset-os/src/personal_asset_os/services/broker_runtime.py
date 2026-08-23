from __future__ import annotations

import logging
import os
import subprocess
import time
from collections.abc import Mapping
from typing import Any, cast

import httpx

from personal_asset_os.settings import Settings

logger = logging.getLogger(__name__)


class BrokerBridgeRuntime:
    """Own an exact-path Bridge child when PAOS is configured to autostart it."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._process: subprocess.Popen[bytes] | None = None

    def start(self) -> None:
        if not (
            self._settings.broker_bridge_configured
            and self._settings.broker_bridge_autostart
        ):
            return
        if self._healthy():
            logger.info("Using an existing healthy KGI Broker Bridge loopback runtime")
            return
        python_path = self._settings.broker_bridge_python
        project_root = self._settings.broker_bridge_project_root
        env_path = project_root / ".env"
        if not python_path.is_file() or not env_path.is_file():
            logger.warning("KGI Broker Bridge autostart prerequisites are missing")
            return
        environment = os.environ.copy()
        environment["PYTHONUTF8"] = "1"
        popen_kwargs: dict[str, Any] = {
            "args": [str(python_path), "-m", "kgi_broker_bridge.cli"],
            "cwd": str(project_root),
            "env": environment,
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
        }
        if os.name == "nt":
            popen_kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        try:
            self._process = subprocess.Popen(**popen_kwargs)
        except OSError:
            logger.warning("KGI Broker Bridge child could not be started")
            return
        deadline = time.monotonic() + self._settings.broker_bridge_startup_timeout_seconds
        while time.monotonic() < deadline:
            if self._process.poll() is not None:
                logger.warning("KGI Broker Bridge child exited before becoming healthy")
                self._process = None
                return
            if self._healthy():
                logger.info("Started owned KGI Broker Bridge child PID %s", self._process.pid)
                return
            time.sleep(0.2)
        logger.warning("KGI Broker Bridge child did not become healthy before timeout")
        self.stop()

    def stop(self) -> None:
        process = self._process
        self._process = None
        if process is None or process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)

    def _healthy(self) -> bool:
        try:
            response = httpx.get(
                f"{self._settings.broker_bridge_url}/api/health",
                timeout=1.0,
                trust_env=False,
            )
            if response.status_code != 200:
                return False
            body = cast(Mapping[str, object], response.json())
            return bool(
                body.get("schema_version") == "broker.health.v1"
                and body.get("broker") == "KGI"
            )
        except (httpx.HTTPError, ValueError, TypeError):
            return False
