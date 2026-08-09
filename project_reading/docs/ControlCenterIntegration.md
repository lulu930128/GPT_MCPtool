# Project Reading Control Center Integration

Project Reading is the reference implementation for a tunnel-enabled
`unified-lifecycle-v3` component. Its public Control Center contract is
`control-center/component.json`.

## Standard facade

- `scripts/runtime-control.ps1` is the only lifecycle controller entrypoint.
- `scripts/component-runtime.psm1` is the stable New Component Kit facade.
- `scripts/project-reading-runtime.psm1` retains the component-specific exact-path
  process ownership, PID metadata, retry and shutdown implementation.
- `tests/test-runtime-control.ps1` is the standard targeted-test entrypoint and
  delegates to the existing isolated lifecycle matrix.

The facade must not weaken Project Reading's read-only MCP boundary, broaden
`WORKSPACE_MCP_ROOTS`, read tunnel credentials, or duplicate lifecycle logic.

## Capabilities and traits

The descriptor declares `tunnel` and `diagnostic-ui`. The controller provides:

- `ensure_running`
- `repair_connectivity`
- `restart_core`
- `reload_runtime`
- `shutdown_runtime`
- `show_diagnostic_tray`

The optional diagnostic tray is component-owned. Closing it does not stop the
MCP server or tunnel. Control Center never reads workspace payloads, local
settings, tunnel profiles, DPAPI data or component runtime logs.

The descriptor also declares `component-menu-v1`. Control Center renders the
original Copy MCP URL, Copy health URL, Copy tunnel ID, Open MCP health, Open
tunnel UI and Open runtime logs entries, then delegates only the selected fixed
action ID to `scripts/control-center-ui.ps1`. Clipboard values and tunnel
configuration remain inside the component process and are never returned to
the manager.

## Validation

```powershell
cd C:\GPT_MCPtool\project_reading
npm test
npm run runtime:selftest
npm run runtime:test
npm run component:test
npm run tray:selftest

cd C:\GPT_MCPtool
powershell -NoProfile -ExecutionPolicy Bypass `
  -File mcp_control_center\scripts\Test-McpComponent.ps1 `
  -ComponentRoot C:\GPT_MCPtool\project_reading
```

Lifecycle mutation tests use an isolated temporary component root. Live
acceptance is read-only unless a separate migration or recovery action is
explicitly approved.
