import os
import subprocess
import sys
from pathlib import Path

import pytest

from kgi_broker_bridge.session_process import SessionProcess


def test_process_reused_then_exact_handle_closed(tmp_path: Path) -> None:
    script = tmp_path / "synthetic_worker.py"
    script.write_text(
        'import sys\nfor line in sys.stdin:\n'
        ' if line.strip() == "close": break\n'
        ' print(\'KGI_BRIDGE_RESULT_V1={"ok":true}\', flush=True)\n', encoding="utf-8",
    )
    session = SessionProcess((sys.executable, str(script)), os.environ, tmp_path)
    try:
        pid = session.process.pid
        assert '"ok":true' in session.read(5).stdout
        assert '"ok":true' in session.read(5).stdout
        assert session.process.pid == pid
    finally:
        session.close()
    assert session.process.poll() is not None


def test_timeout_can_be_closed_without_leaving_worker(tmp_path: Path) -> None:
    script = tmp_path / "synthetic_blocked.py"
    script.write_text("import time\ntime.sleep(60)\n", encoding="utf-8")
    session = SessionProcess((sys.executable, str(script)), os.environ, tmp_path)
    try:
        with pytest.raises(subprocess.TimeoutExpired):
            session.read(0.05)
    finally:
        session.close()
    assert session.process.poll() is not None
