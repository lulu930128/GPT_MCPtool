# Control Center Integration

Personal Asset OS uses the shared `unified-lifecycle-v3` contract while keeping
its financial-data and user-interface authority inside this component.

## Managed roles

- `server`: repository virtual-environment Python runner. The HTTP listener may
  be the runner itself or a verified descendant.
- `tunnel`: exact Secure MCP Tunnel process and listener.

The controller starts server then tunnel and stops tunnel then server.
`RestartCore` preserves the tunnel; `ReloadRuntime` replaces both roles.

The optional Mobile USB Bridge runs as a component-owned task inside the server lifespan. Control
Center neither invokes ADB nor reads its device identity; restarting the core naturally recreates
the bounded monitor while preserving the shared ADB daemon.

## Data boundary

The controller probes only `/api/health`, `/api/readyz` and tunnel `/readyz`.
It does not open the database or read accounts, transactions, postings,
financial events, holdings, reports, balances or backups. Formal data remains
under `%LOCALAPPDATA%\PersonalAssetOS` or the explicitly configured external
`PAOS_DATA_DIR`; controller state stays in the ignored repository `.tmp` tree.

Status, SelfTest, owner metadata and audit events omit the formal data path,
database path, backup path, credentials and tunnel identifier.

## UI boundary

The dashboard is the primary component-owned UI. The optional diagnostic tray
may open dashboard, health, logs, data/backup folders and the
component-owned backup action. Closing the diagnostic tray only closes that UI
and never stops runtime.

`component-menu-v1` restores the dashboard, verified
backup, app URL, data-folder and backup-folder actions directly in the Control
Center submenu. The manager delegates a fixed action ID to
`scripts/control-center-ui.ps1` and requires confirmation before the backup
action. The component performs the backup and shows its result locally; no
formal data path, backup path or financial payload is returned to Control
Center.

## Rollback

The legacy tray and VBS launchers remain present. To roll back, restore the
legacy descriptor, reload only Control Center, then reopen the legacy tray.
Do not delete or alter the formal data directory during rollback.
