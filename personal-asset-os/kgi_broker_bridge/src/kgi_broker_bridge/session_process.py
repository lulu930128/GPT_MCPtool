"""Exact-handle subprocess session, serialized by the gateway's existing lock."""
from __future__ import annotations

import queue
import subprocess
import threading
from collections.abc import Mapping
from pathlib import Path

PREFIX = "KGI_BRIDGE_RESULT_V1="
LIMIT = 2_000_000


class SessionProcess:
    def __init__(self, command: tuple[str, ...], env: Mapping[str, str], cwd: Path) -> None:
        self.command = command
        self.process = subprocess.Popen(
            command, env=dict(env), cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, encoding="utf-8", errors="replace",
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        self.results: queue.Queue[str | None] = queue.Queue(maxsize=2)
        threading.Thread(target=self._receive, daemon=True).start()

    def _receive(self) -> None:
        stream = self.process.stdout
        if stream is None:
            return
        try:
            while True:
                line = stream.readline(LIMIT + 1)
                if not line or len(line) > LIMIT:
                    self.results.put_nowait(None)
                    return
                if line.startswith(PREFIX):
                    self.results.put_nowait(line)
        except (OSError, ValueError, queue.Full):
            return

    def read(self, timeout: float) -> subprocess.CompletedProcess[str]:
        stream = self.process.stdin
        if stream is None:
            raise OSError("session stdin unavailable")
        stream.write("read\n")
        stream.flush()
        try:
            result = self.results.get(timeout=timeout)
        except queue.Empty as exc:
            raise subprocess.TimeoutExpired(self.command, timeout) from exc
        if result is None:
            raise OSError("session ended")
        return subprocess.CompletedProcess(self.command, 0, result, "")

    def close(self) -> None:
        process = self.process
        if process.poll() is None:
            try:
                if process.stdin:
                    process.stdin.write("close\n")
                    process.stdin.flush()
                process.wait(timeout=3)
            except (OSError, ValueError, subprocess.TimeoutExpired):
                process.kill()
                process.wait(timeout=3)
        for stream in (process.stdin, process.stdout):
            if stream:
                stream.close()
