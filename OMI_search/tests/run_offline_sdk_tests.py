"""Run bounded ASGI tests with the installed SDK and an available interpreter.

No install, listener, subprocess, credential, or live upstream IO. The optional
Win32 stub only blocks unused stdio/process entry points; SDK protocol, schemas,
runner, HTTP transport and application handlers are real.
"""
from contextlib import ExitStack
from importlib import metadata, util
from pathlib import Path
import os
import socket
import sys
import types
import unittest
from unittest.mock import patch


def blocked(*args, **kwargs):
    raise AssertionError("Live network / Windows process IO forbidden in offline SDK tests")


def main():
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root))
    sys.path.insert(0, str(root / "tests"))
    # Append, so compiled dependencies belong to the running interpreter's ABI.
    sys.path.append(str(root / ".venv" / "Lib" / "site-packages"))
    if sys.platform == "win32" and util.find_spec("pywintypes") is None:
        win = types.ModuleType("mcp.os.win32.utilities")
        for name in (
            "ServerProcess", "close_process_job", "create_windows_process",
            "get_windows_executable_command", "terminate_windows_process_tree",
            "rebind_std_handle_to_fd",
        ):
            setattr(win, name, blocked)
        sys.modules[win.__name__] = win
        print("Win32 stdio/process entry points: blocked (ASGI/in-memory only)")

    with ExitStack() as stack:
        stack.enter_context(patch.dict(os.environ, {
            "OMI_SEARCH_AI_TRUST_TOKEN": "", "OMI_MCP_AI_TRUST_TOKEN": "",
            "OMI_AI_TRUST_TOKEN": "", "OMI_SEARCH_RUNTIME_CONTROL_TOKEN": "",
            "OMI_SEARCH_API_BASE_URL": "http://127.0.0.1:8400",
        }))
        # Do not block socketpair: Windows asyncio uses it for its wakeup pipe.
        stack.enter_context(patch.object(socket, "create_connection", blocked))
        stack.enter_context(patch("subprocess.Popen", blocked))
        stack.enter_context(patch("anyio.connect_tcp", blocked))
        stack.enter_context(patch("urllib.request.urlopen", blocked))
        stack.enter_context(patch("urllib.request.build_opener", blocked))
        import mcp
        import mcp_types
        print(f"Python: {sys.version.split()[0]}; mcp: {metadata.version('mcp')}; "
              f"mcp-types: {metadata.version('mcp-types')}; pydantic: {metadata.version('pydantic')}")
        print(f"SDK source: {mcp.__file__}; types source: {mcp_types.__file__}")
        suite = unittest.TestSuite()
        for pattern in sys.argv[1:] or ["test_runtime_control_sdk.py"]:
            if not pattern.startswith("test_") or any(c in pattern for c in "*/\\"):
                raise ValueError("Specify exact test filenames or dotted test names")
            if pattern.endswith(".py"):
                suite.addTests(unittest.defaultTestLoader.discover(str(root / "tests"), pattern=pattern))
            else:
                suite.addTests(unittest.defaultTestLoader.loadTestsFromName(pattern))
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        # An unavailable SDK or skipped regression is not acceptance.
        return 0 if result.wasSuccessful() and result.testsRun and not result.skipped else 1


if __name__ == "__main__":
    raise SystemExit(main())
