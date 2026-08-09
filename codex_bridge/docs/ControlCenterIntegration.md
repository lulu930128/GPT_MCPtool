# Codex Bridge Control Center Integration

Codex Bridge is an `approval-sensitive`, tunnel-enabled
`unified-lifecycle-v3` component. Its public descriptor is
`control-center/component.json`.

## Ownership and job boundary

- `scripts/runtime-control.ps1` is the only lifecycle entrypoint.
- `scripts/component-runtime.psm1` is the stable New Component Kit facade.
- `scripts/codex-bridge-runtime.psm1` implements exact process ownership.
- The controller owns only the Bridge HTTP server and Secure MCP Tunnel.
- It never reads the job store, project allowlist contents, requests, messages,
  diffs, results, project paths or approval details.
- It has no job dispatch, turn, steering, cancellation or approval-decision API.

Before `restart_core`, `reload_runtime` or `shutdown_runtime` can stop the core,
the bounded health contract must report controller `idle`, zero active jobs and
zero awaiting approvals. Otherwise the action fails closed and preserves both
runtime PIDs. An actual server restart retains the existing application rule:
active work becomes interrupted and pending approvals expire; work is never
resubmitted automatically.

## Capabilities and UI

The component declares `tunnel`, `approval-sensitive` and `diagnostic-ui`, with
the standard six capabilities. `repair_connectivity` never restarts the Bridge
core. The optional diagnostic tray may open health, tunnel UI, runtime logs and
the component-owned jobs folder. Closing it only closes the UI.

`component-menu-v1` exposes those original connection actions and Open jobs
folder directly in the Control Center submenu. The manager delegates only a
declared action ID to `scripts/control-center-ui.ps1`; it never reads the jobs
directory, project allowlist, tunnel ID, job payload or approval state.

## Validation

```powershell
cd C:\GPT_MCPtool\codex_bridge
npm test
npm run component:test
npm run tray:selftest
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts\tray.ps1 -SelfTest -DiagnosticOnly

cd C:\GPT_MCPtool
powershell -NoProfile -ExecutionPolicy Bypass `
  -File mcp_control_center\scripts\Test-McpComponent.ps1 `
  -ComponentRoot C:\GPT_MCPtool\codex_bridge
```

The isolated lifecycle test uses dynamic ports, a fake Bridge health server and
a fake tunnel. It proves active-work refusal, PID preservation, exact foreign
owner refusal and audit redaction without consuming a Codex turn or touching
`C:\CodexBridge`.
