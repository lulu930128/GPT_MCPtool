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

## Taiwan workspace source and adoption

The additive workspace exposes 17 public tools and 2 versioned MCP Apps resources.
`omi_open_tw_workspace` binds `ui://omi/tw-workspace/v1.html`; the legacy opener keeps
`ui://omi/tw-market-dashboard/v2.html`. Both resources use the existing dashboard
production bundle. The generated snapshot and `dist/index.html` already participate
in source build identity; no additional lifecycle process or Control Center data
access is needed. Progressive reads remain backend-owned cache-only tool calls.

Building or validating source does not adopt it into the running adapter or refresh
the host action cache. This workspace job does not restart services. Adoption must
be performed separately through the existing lifecycle owner after the backend is
ready, followed by host resource/tool refresh and live product verification. See
[source validation and outstanding gates](TaiwanWorkspaceValidation.md).

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

### V3 runtime credential adoption

The component controller reads `OMI_SEARCH_RUNTIME_CONTROL_TOKEN` using
`[Environment]::GetEnvironmentVariable(..., 'User')` under its actual process
account, once per new Core process. The existing HKCU per-user setting is the
only source: no inherited Process fallback, cross-account hive lookup, registry
write, token rotation, or persistent credential copy. A different controller
account uses its own User store; missing/unreadable/invalid settings disable only
restart authorization. A valid token from a different account still requires the
Backend's matching hash; the adapter cannot attest that pairing.

The exact case-sensitive `\A[0-9a-f]{64}\z` check does not trim. The Core's isolated
`ProcessStartInfo.EnvironmentVariables` receives the valid User token, overriding
stale inherited state. Every other child, including the dependency probe and
Secure MCP Tunnel, has the raw token removed. The existing child-spawn helper uses
`UseShellExecute=false`, hidden/no-window creation, and proxy removal without
transient parent environment changes. Existing executable/creation-time/listener
and venv redirector lineage checks remain authoritative. The separate HTTP bearer
token and tunnel control-plane key retain their existing behavior.

Long-lived Core/Tunnel use the private `OmiSearchChildProcess.cs` launch primitive
inside that same helper. It consumes the prepared `ProcessStartInfo` environment,
uses `CreateProcessW` with an explicit executable and Unicode environment, and
allows only a `NUL` standard-IO handle to be inherited. It neither changes parent
standard handles nor leaves unread output pipes behind. The process is briefly
created suspended to retain a managed handle before resume; no shell, wrapper
process, lifecycle action, PID policy or process manager is added. Native handles
are closed and the entire temporary native environment block is zeroed after
creation. Core console output is detached; the tunnel's existing `--log.file`
remains in place. The short-lived dependency probe drains its redirected output
before returning and never receives the runtime-control credential.

The lifecycle regression bounds each controller process to 45 seconds and then
requires stdout/stderr EOF within 2 seconds while its owned children remain alive.
Additional health requests after controller exit force new stdout/stderr writes
in both fixture children; readiness must survive. This detects both inherited
controller pipes and broken-pipe workarounds.

`.tmp/runtime-control-auth.log` is overwritten with one local-only fixed code per
Core credential attempt: `RUNTIME_CONTROL_AUTH_USER_VALID` or
`RUNTIME_CONTROL_AUTH_USER_UNAVAILABLE`. It contains no value, hash, account, or
exception details and is not included in lifecycle JSON, health, receipts, desktop
notifications or Control Center. Failure to write this diagnostic does not block
market startup. `VALID` proves local format acceptance only, not Backend hash
adoption, authorization, or successful restart. The Python protected POST remains
user-approved, fixed-header, no-redirect and no-retry; the 20 tools / 2 resources
and v4 market forwarding are unchanged.

Credential tests replace the private User-store reader before use, exclusively
with synthetic fixtures; they never access the runner's HKCU. The lifecycle test
copies the existing controller and Core into a temporary root, substitutes only
the private reader and fixture environment assertions, and uses a fake backend,
fake tunnel and fake key store. Missing/invalid/inaccessible User settings must
still reach `Ready` with no inherited restart authority. Run each script in a
disposable PowerShell process:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests\test-runtime-credential.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests\test-runtime-control.ps1
python -B tests\run_offline_sdk_tests.py test_runtime_control.py test_runtime_control_sdk.py
```

When the managed Python base interpreter is unavailable, an explicit available
Python can exercise a disposable Windows venv redirector without installation:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests\test-runtime-control.ps1 `
  -PythonPath C:\miniconda3\python.exe -UseDisposablePython
```

This option uses the supplied interpreter's existing compiled packages, appends
the installed adapter SDK packages, and blocks unavailable Win32 SDK stdio/process
entry points. HTTP SDK, Python Core, process creation and ownership checks remain
real. It is fixture evidence, not proof of the production interpreter or runtime
adoption. The separately managed OMI Launcher must adopt the matching
`OMI_RUNTIME_CONTROL_TOKEN_SHA256`; this repair neither reads nor changes it.

### Existing lifecycle and conformance checks

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
