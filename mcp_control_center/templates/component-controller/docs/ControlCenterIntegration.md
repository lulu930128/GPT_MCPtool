# __DISPLAY_NAME_MARKDOWN__ Control Center Integration

## Identity

- Component ID: `__COMPONENT_ID__`
- Descriptor: `control-center/component.json`
- Controller: `scripts/runtime-control.ps1`
- Component menu adapter: `scripts/control-center-ui.ps1`
- Core health port: `__CORE_PORT__`

## Before registration

- Replace the safe `not_implemented` runtime module with exact-path, bounded lifecycle logic.
- Follow `mcp_control_center/docs/LifecycleOwnershipPolicy.md`; a PID is only a locator, never complete process identity.
- Persist atomic owner metadata containing at least `schemaVersion`, role, PID, executable path, process start time, command identity and recording time.
- Query the expected listener before stale cleanup. Listener-free stale or reused PIDs may remove only guarded component metadata; a live foreign listener must fail closed without takeover or process termination.
- Guard PID and owner-file cleanup against lifecycle races so an older controller cannot delete evidence written by a newer instance.
- Keep PID files, logs, cache, credentials and domain data outside Git.
- Update probe `expected` fields and ownership fragments to match the real runtime.
- Keep `component-menu-v1` action IDs fixed, bounded and implemented only by the component-owned adapter.
- Run `tests/test-runtime-control.ps1` and the central `Test-McpComponent.ps1`.
- Require isolated functional regression for missing-process stale PID, live unrelated PID reuse, same executable with a different start time/command, stale PID plus foreign listener, owned process without listener, valid owned lineage, repeated lifecycle actions and cleanup races.
- Every ownership regression must assert that unrelated processes remain alive and that no duplicate listener is created.
- Do not enable or auto-start the component until isolated lifecycle and ownership tests pass.

## Trust boundary

- Control Center may invoke only declared lifecycle capabilities, safe navigation and fixed component menu action IDs.
- Control Center must not read domain payload, secret, credential, database, backup or private log content.
- Component menu output must remain bounded metadata; values copied to the clipboard or shown in component UI must never be returned to the manager.
- Shutdown remains component-owned and requires per-component confirmation in the manager UI.
