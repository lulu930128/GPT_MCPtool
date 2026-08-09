# Control Center integration

Japanese Study uses the `unified-lifecycle-v3` component contract. The Control
Center calls `scripts/runtime-control.ps1`; the controller remains inside this
component and owns only these runtime roles:

1. Japanese Study Hub runner (`uv`) and its descendant health listener.
2. Japanese Study MCP adapter.
3. Secure MCP Tunnel.

Startup order is Hub -> MCP -> tunnel. Shutdown order is tunnel -> MCP -> Hub.
`RestartCore` reloads Hub and MCP while preserving the tunnel process;
`ReloadRuntime` reloads all three roles. Every mutation requires exact owner
metadata, executable identity, command identity and listener lineage.

The controller probes only bounded loopback health identity. It does not read
Hub data, SQLite, study items, practice sessions, source material, Anki or MCP
tool payloads. It never exposes the tunnel id, runtime key, DPAPI path or
generated profile content.

The legacy tray and launchers remain available for rollback. Under v3,
`scripts/show-diagnostic-tray.vbs` opens the same component UI in diagnostic
mode: it does not auto-start or own runtime processes, its reload action
delegates to the controller, and Exit closes only that UI.

The `component-menu-v1` adapter at `scripts/control-center-ui.ps1` restores the
original connection actions, the read-only Japanese Study desktop browser,
Hub health, tunnel-key prompt and key-status dialog directly in the Control
Center submenu. The descriptor contains only
fixed action IDs and labels. Tunnel IDs, DPAPI values and study data stay in
the component process and are never returned to the manager.

Targeted validation:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests\test-runtime-control.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\runtime-control.ps1 -Action SelfTest
```
