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
| Original file return is not enabled | `fetch_asset` has a separate egress allowlist | Add only reviewed asset scope ids to `WORKSPACE_MCP_FILE_RETURN_SCOPES`. |
| Office file rejected | Macro, ActiveX, encryption, embedded object, unsafe relationship, zip-bomb, or output limit | Run `inspect_asset`; do not rename or unpack the container to bypass validation. |

`search_text` uses fixed-string matching by default. Set `fixedString=false` only when a regular
expression is intended. If `rg` is unavailable, the bounded fallback may be slower and support a
smaller practical search surface.

## Local MCP diagnosis

Check health, then protocol discovery:

```powershell
Invoke-RestMethod http://127.0.0.1:18787/health
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
.\scripts\runtime-control.ps1 -Action RestartCore
```

For controller diagnostics:

```powershell
npm run runtime:selftest
npm run runtime:test
npm run tray:selftest
```

`RepairConnectivity` must not restart a healthy MCP core. `RestartCore` must not replace the
tunnel. A foreign listener or unverifiable PID must fail closed and be investigated manually.

## Bounded diagnostics from ChatGPT

Use `check_tcp_port({host:"127.0.0.1",port:18787})`, then
`http_health_check({url:"http://127.0.0.1:18787/health"})`. Query
`list_listening_ports({port:18787})` and `inspect_port_owner({port:18787})` for TCP/PID/image-name
evidence. Use `resolve_dns({hostname:"example.com",family:"ipv4"})` for DNS and
`ping_host({host:"127.0.0.1"})` for one ICMP probe. No tool can restart/kill a process or run a command.

- `TIMEOUT` or `OUTPUT_LIMIT`: evidence is incomplete; narrow filters or retry a single bounded
  observation. Do not infer no listener from partial results.
- `state=no_listener` requires a completed listener snapshot. `identityStatus=unavailable` can
  indicate a race or inaccessible process. If tasklist is denied, a complete listener snapshot
  keeps ok=true/complete=true with partial=true, identityComplete=false and identityCode.
  Identity failure does not invalidate the observed PID; it also never proves executable ownership.
  Never use this snapshot as authority to kill a PID.
- `healthy=false` with a statusCode is an HTTP result (including 3xx/4xx/5xx); redirects are
  intentionally not followed. Check the exact health URL. TCP reachability alone is not health.
- DNS family errors are reported separately. DNS records can differ from OS hosts-file lookup.
- ICMP can be blocked while TCP/HTTP work. Ping output is localized; `echoReplyObserved` only
  recognizes TTL/hlim evidence and may not establish IPv6 echo success. Inspect bounded output.
- `UNSUPPORTED_PLATFORM`: Windows listener/owner/ping implementation is unavailable; native
  TCP/DNS/HTTP remain usable. `DIAGNOSTICS_BUSY`: wait for active probes to finish.

After an authorized build/restart, run `npm run smoke:live` and `npm run smoke:live:diagnostics`.
The latter checks tools/list, annotations, all six calls, the on-disk build fingerprint and runtime
start time. Set `WORKSPACE_MCP_SMOKE_PREVIOUS_STARTED_AT` to the prior workspace_info value to
assert restart adoption. Use the existing operator token via `WORKSPACE_MCP_SMOKE_TOKEN` when
required; never print it. A successful local MCP/tunnel smoke does not prove the ChatGPT action
cache refreshed; refresh/reconnect ChatGPT if the six tools are missing there.

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
