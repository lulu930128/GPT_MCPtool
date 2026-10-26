"""Execute actual adapter source with only SDK imports omitted; no SDK/host claim."""
import ast
from pathlib import Path
from types import SimpleNamespace


def runtime_status_body(owner_id):
    """Synthetic values in the current backend-owned shape; never live evidence.

    Source: routers/runtime_control.py, RuntimeCoordinator.restart_preflight,
    scripts/omi-runtime-control.ps1 and OmiRuntimeControl.cs in the OMI repo.
    Opaque extension fields deliberately test forward compatibility, not schema.
    """
    return {
        "schema": "omi.runtime-control.v1", "owner_id": owner_id,
        "launcher": {"status": "observed", "identity": "PIPE_SERVER_PID_AND_CREATION",
                     "pid": 101, "created_at": "2026-10-15T00:00:00Z"},
        "backend": {"status": "unknown", "identity": "UNATTESTED", "pid": None,
                    "created_at": None, "readiness": "UNATTESTED",
                    "selected_host": "127.0.0.1", "selected_port": 8400},
        "frontend": {"status": "unknown", "identity": "UNATTESTED", "readiness": "UNATTESTED"},
        "mcp_dependency": {"status": "unknown", "identity": "UNATTESTED",
                           "reason": "EXTERNAL_ADAPTER_NOT_ATTESTED"},
        "serving_backend": {"runtime_started": True, "database_readiness": "not_checked",
                            "readiness": "UNATTESTED", "writer_preflight": {
                                "schema": "omi.restart-preflight.v1", "runtime_started": True,
                                "registered_drain_state": "NOT_REQUESTED",
                                "all_writers_drained": False, "unknown_writer_count": 3,
                            }},
        "restart": {"available": False, "reason": "ALL_WRITERS_DRAIN_UNAVAILABLE", "blockers": [
            "OWNER_NOT_ATTESTED", "WRITER_ADMISSION_NOT_ATTESTED", "ALL_WRITERS_DRAIN_UNAVAILABLE",
            "OWNER_APPROVAL_REQUIRED", "GRACEFUL_TRANSPORT_UNAVAILABLE", "SAFE_START_UNAVAILABLE",
            "READINESS_NOT_ATTESTED", "SOURCE_ADOPTION_NOT_ATTESTED",
        ]},
        "source": {"build_id_scope": "runtime_control_bundle_only", "disk_build_id": "d" * 64,
                   "import_time_build_id": "e" * 64, "disk_matches_import": False,
                   "loaded_release_identity": "UNATTESTED"},
        "opaque_future": {"unknown": None, "values": [False, 0, 1.25, "保留", {"next": []}]},
    }


def runtime_receipt_body(request_id, owner_id, state):
    status = runtime_status_body(owner_id)
    identity = {"pid": 102, "created_at": "2026-10-15T00:00:01Z", "attestation": "PROCESS_IDENTITY"}
    return {
        "schema": "omi.runtime-control.v1", "request_id": request_id, "owner_id": owner_id,
        "action": "RestartBackend", "state": state,
        "reason": {"accepted": "ACCEPTED", "blocked": "ALL_WRITERS_DRAIN_UNAVAILABLE",
                   "unknown": "CONTROLLER_UNAVAILABLE"}[state],
        "before": identity, "after": None, "updated_at": "2026-10-15T00:00:02Z",
        "loaded_release_identity": "UNATTESTED",
        "backend_preflight": status["serving_backend"]["writer_preflight"],
        "backend_preflight_identity": dict(identity),
        "blockers": status["restart"]["blockers"][1:] if state == "blocked" else None,
        "opaque_future": status["opaque_future"],
    }


def load_source():
    path = Path(__file__).resolve().parents[1] / "server.py"
    tree = ast.parse(path.read_text(encoding="utf-8"))
    tree.body = [node for node in tree.body if not (
        isinstance(node, (ast.Import, ast.ImportFrom)) and any(
            name == "anyio" or name == "mcp" or name.startswith("mcp.")
            for name in ([node.module or ""] if isinstance(node, ast.ImportFrom)
                         else [alias.name for alias in node.names])
        )
    )]
    namespace = {"__file__": str(path), "__name__": "runtime_control_source_fixture"}
    exec(compile(tree, str(path), "exec"), namespace)
    return SimpleNamespace(**namespace)
