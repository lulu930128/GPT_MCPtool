# English Study Control Center integration

The component uses `unified-lifecycle-v3` and owns exactly three loopback roles:

1. English Study Hub at `127.0.0.1:18887`.
2. English Study MCP at `127.0.0.1:18886`.
3. Secure MCP Tunnel readiness at `127.0.0.1:18888`.

Startup is Hub, MCP, then tunnel. Shutdown is tunnel, MCP, then Hub. PID files live in the
ignored component `.tmp` directory, and every stop/restart verifies executable,
command line, managed PID, and listener PID before acting. There is no
kill-by-name behavior.

The Control Center may read only health identity and ownership metadata. It
never reads the project-local SQLite database, study content, practice payload,
or credentials. Registration starts disabled; after isolated lifecycle, live
MCP smoke, and fixed-port validation pass, the component is enabled with
auto-start under the Control Center lifecycle.

The descriptor declares `scripts\start-english-study-desktop.vbs` as the
primary UI. The tray's `Open English Study` action launches the Hub-owned,
read-only Tkinter desktop and pins its child-process API endpoint to
`http://127.0.0.1:18887`. Control Center still does not read or project domain
payloads.

The tunnel binary is component-local and ignored by Git. Its generated profile
lives under ignored `.tunnel-client`, while the control-plane key is stored as
current-user DPAPI ciphertext under ignored `.secrets`. Control Center never
reads either value. `Repair connectivity` only replaces the owned tunnel;
`Restart core` replaces Hub and MCP while preserving the tunnel process.

Local tunnel readiness does not prove remote registration or ChatGPT connector
availability. Those require separate evidence.

Validation:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests\test-runtime-control.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\runtime-control.ps1 -Action SelfTest
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\runtime-control.ps1 -Action Status
```
