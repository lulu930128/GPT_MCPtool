# Control Center Integration

Memory Core implements the shared `unified-lifecycle-v3` contract without
moving its system-of-record, credentials, UI or lifecycle implementation into
Control Center.

## Managed roles

- `backend`: the FastAPI service root and its verified loopback listener.
- `mcp`: the MCP adapter root and its verified loopback listener.
- `tunnel`: the exact Secure MCP Tunnel process and listener.

The controller is a stateless facade over `memory_core_stack.ps1`. The existing
component stack remains the only implementation that starts backend -> MCP ->
tunnel, stops tunnel -> MCP -> backend, performs bounded retries and requires
stable readiness. `RestartCore` preserves the tunnel; `ReloadRuntime` replaces
all three roles.

## Data and credential boundary

The controller only obtains sanitized health and ownership state from the
component stack. It never opens SQLite or reads records, entities, revisions,
audit events, candidates, batches, collections, exports, backups, attachments,
DPAPI values, tunnel profiles or credential status.

Existing ignored `data/runtime/*.pid` files remain component-owned runtime
authority. Controller audit state is limited to the ignored repository `.tmp`
tree and omits URLs, absolute data paths, secret state, tunnel identifiers and
domain payloads.

## UI boundary

The Tkinter viewer remains the primary component-owned UI. The optional
diagnostic tray can open health, viewer, tunnel UI, logs and component-owned key
management. In diagnostic mode it never auto-starts or owns runtime processes,
and closing it only closes that UI.

The same original actions are now rendered directly by Control Center through
`component-menu-v1`: connection copy/open actions, Open Memory Core viewer, backend
API docs, Replace tunnel runtime key and Show key status. Control Center passes
only a declared action ID to `scripts/control-center-ui.ps1`; the adapter opens
the existing viewer or stack prompt and returns no credential, storage path or
Memory Core record content.

## Rollback

The legacy tray and launchers remain present. To roll back, restore the legacy
descriptor, reload only Control Center, then reopen the legacy tray. Do not
move or modify `data/`, credentials or runtime PID authority during rollback.
