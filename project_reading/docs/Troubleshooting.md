# Project Reading Troubleshooting

Diagnose from the innermost boundary outward:

```text
configured root -> path guard -> tool call -> local MCP -> tunnel -> ChatGPT action snapshot
```

A successful HTTP response at one layer does not prove the next layer is current.

## Build and source freshness

Run the source checks before investigating the tunnel:

```powershell
cd C:\GPT_MCPtool\project_reading
npm run build
npm test
```

If source is newer than `dist`, rebuild before restarting the HTTP runtime. After a build, verify
the live `tools/list`; a new local file alone does not prove the running process loaded it.

## Root and path errors

| Symptom | Likely cause | Check |
| --- | --- | --- |
| Unknown root id | `WORKSPACE_MCP_ROOTS` does not define the requested id | Call `workspace_info` and use one returned id. |
| Path escapes configured root | `..`, absolute input, symlink, or junction resolves outside the root | Use a relative path whose real target stays inside the selected root. |
| Path includes denied directory or extension | Global or root-specific deny policy matched | Inspect `workspace_info.denyPolicy`; do not bypass the guard. |
| File is too large | `WORKSPACE_MCP_MAX_FILE_BYTES` or an asset limit was exceeded | Read a smaller text file or narrow the asset/range. |
| Asset scope is unknown | Workspace roots and asset scopes are separate | Configure `WORKSPACE_MCP_ASSET_SCOPES` explicitly. |
| Office file rejected | Macro, ActiveX, encryption, embedded object, unsafe relationship, zip-bomb, or output limit | Run `inspect_asset`; do not rename or unpack the container to bypass validation. |

`search_text` uses fixed-string matching by default. Set `fixedString=false` only when a regular
expression is intended. If `rg` is unavailable, the bounded fallback may be slower and support a
smaller practical search surface.

## Local MCP diagnosis

Check health, then protocol discovery:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
cd C:\GPT_MCPtool\project_reading
npm run smoke:live
```

`/health` proves the local HTTP process answered. `smoke:live` additionally checks MCP
initialization, tool discovery, UTF-8 handling, root access, and deny behavior.

If the listener is occupied by another process, stop and identify the listener owner. Do not kill
all `node.exe` or `powershell.exe` processes. The component lifecycle requires listener PID,
exact executable, PID metadata, and process start time to agree before replacement.

## Tunnel diagnosis

```powershell
npm run tunnel:selftest
npm run tunnel:key:status
npm run tunnel:doctor
```

- `tunnel:selftest` validates local files and configuration without revealing the tunnel id.
- `tunnel:key:status` reports presence, not credential content.
- `tunnel:doctor` requires a configured DPAPI key and checks the control-plane path.

Treat these as distinct failures:

- local MCP unhealthy: fix the build, root configuration, or local listener first;
- local MCP healthy but tunnel not ready: inspect the tunnel profile, key status, and readiness;
- tunnel ready but ChatGPT cannot connect: verify workspace association, permissions, and the
  selected tunnel in ChatGPT Developer Mode;
- connection works but tools are old: refresh actions, reconnect, or open a new conversation.

## Lifecycle recovery

Normal startup is non-destructive:

```powershell
.\scripts\Start-Tray.cmd
```

After a source rebuild, use the exact-path replacement entry:

```powershell
.\scripts\Restart-Tray.cmd
```

For controller diagnostics:

```powershell
npm run runtime:selftest
npm run runtime:test
npm run tray:selftest
```

`RepairConnectivity` must not restart a healthy MCP core. `RestartCore` must not replace the
tunnel. A foreign listener or unverifiable PID must fail closed and be investigated manually.

## What to capture in a bug report

Include only non-secret evidence:

- component version and build result;
- root id, relative path shape, and exact error text with private names redacted;
- `/health` status without credentials;
- whether `initialize` and `tools/list` succeeded;
- tunnel readiness state without tunnel id or key;
- whether ChatGPT actions were refreshed.

Never attach `.env`, `.secrets`, tunnel profiles, DPAPI files, private file contents, full logs, or
an unrestricted directory listing.
