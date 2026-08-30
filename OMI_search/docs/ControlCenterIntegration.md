# OMI Search Control Center Integration

OMI Search is a tunnel-enabled `unified-lifecycle-v3` component with an
external OMI backend dependency. Its public Control Center contract is
`control-center/component.json`.

## Ownership boundary

- `scripts/runtime-control.ps1` is the only lifecycle controller entrypoint.
- `scripts/component-runtime.psm1` is the stable New Component Kit facade.
- `scripts/omi-search-runtime.psm1` owns the component-specific implementation.
- The controller owns only the adapter HTTP server and Secure MCP Tunnel.
- The controller never starts, stops, imports, or reads domain data from the OMI
  backend. It consumes only the adapter's bounded `/upstream-health` result.
- PID, executable path, start time, command identity, listener ownership and
  expected source build must agree before a process can be mutated.

The tunnel executable and key-store script are reused from Project Reading as
documented in the workspace root README. Tunnel profiles, keys, logs and owner
records remain local ignored runtime state.

## Capabilities and traits

The descriptor declares `tunnel`, `external-dependency` and `diagnostic-ui`.
The controller provides:

- `ensure_running`
- `repair_connectivity`
- `restart_core`
- `reload_runtime`
- `shutdown_runtime`
- `show_diagnostic_tray`

The optional diagnostic tray delegates lifecycle actions to the controller.
Closing it never stops the adapter, tunnel, or OMI backend. The legacy launcher
is retained during migration as a rollback path but is not the v3 lifecycle
entrypoint.

`component-menu-v1` restores the original connection actions plus Save
`CONTROL_PLANE_API_KEY...` and Show key status directly in the Control Center
submenu. `scripts/control-center-ui.ps1` owns the DPAPI prompt and status dialog;
the manager receives only a fixed action ID and bounded success metadata. It
never receives the key, secret path, tunnel ID or OMI domain payload.

## Validation

```powershell
cd C:\GPT_MCPtool\OMI_search
.\.venv\Scripts\python.exe -B -m unittest discover -s tests
powershell -NoProfile -ExecutionPolicy Bypass `
  -File tests\test-runtime-control.ps1
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts\tray.ps1 -SelfTest -DiagnosticOnly

cd C:\GPT_MCPtool
powershell -NoProfile -ExecutionPolicy Bypass `
  -File mcp_control_center\scripts\Test-McpComponent.ps1 `
  -ComponentRoot C:\GPT_MCPtool\OMI_search
```

The lifecycle regression uses an isolated temporary root, dynamic loopback
ports, a fake backend, and a fake tunnel. It proves `BlockedUpstream` semantics,
exact foreign-listener refusal, secret redaction, and that shutdown leaves the
external backend untouched.
