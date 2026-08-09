# OMI Search Troubleshooting

Trace the request in this order:

```text
MCP client -> adapter HTTP/STDIO -> selected OMI backend -> public ask contract -> provider/data
```

Do not patch the adapter until the failing boundary is identified.

## Source and unit checks

```powershell
cd C:\GPT_MCPtool\OMI_search
python -B -m unittest discover -s tests
python -B -c "import ast, pathlib; [ast.parse(p.read_text(encoding='utf-8'), filename=str(p)) for p in pathlib.Path('.').rglob('*.py')]; print('syntax ok')"
```

These prove source behavior only. They do not prove the tray, listener, backend, tunnel, or ChatGPT
action snapshot is current.

## Health layers

| Probe | What it proves | What it does not prove |
| --- | --- | --- |
| `GET /health` | Adapter process, build id, local configuration shape | OMI backend data or provider freshness |
| `GET /upstream-health` | Bounded connectivity to the selected OMI backend | Public schema parity or fresh market data |
| MCP `initialize` + `tools/list` | Protocol and currently loaded tool surface | A representative business call succeeds |
| MCP `tools/call` | End-to-end adapter and backend contract | ChatGPT has refreshed its cached actions |
| Tunnel `/readyz` | Tunnel client is ready | The selected ChatGPT workspace can use it |

## Common failures

### Adapter is healthy but OMI is unavailable

Check `/upstream-health` and the backend URL reported by `/health`. The OMI launcher may select a
different loopback port when its preferred port is unavailable. Do not hard-code a remembered port
or restart unrelated Python processes.

Identify the OMI launcher-selected URL and exact listener owner before changing
`OMI_SEARCH_API_BASE_URL` or restarting the adapter.

### `tools/list` shows an old schema

1. Compare live backend `GET /api/ai/tools` with `public_contract_snapshot.json`.
2. Regenerate the snapshot from the OMI repository; do not hand-edit it.
3. Restart only the exact-path adapter runtime if its loaded build is stale.
4. In ChatGPT, Refresh Actions, reconnect the app, or start a new conversation.

A PID change or HTTP 200 alone is not schema adoption proof.

### `refresh_if_missing` did not fetch data

The argument must be boolean `true`. Even then, the backend may refuse, bound, time out, or find no
new data. Inspect `execution.refresh_reconciliation`, `freshness`, `limitations`, `warnings`,
`missing`, and status. Do not infer success from request acceptance.

### `TARGET_NOT_FOUND` appears as a result

This is a structured business outcome and should remain `isError=false`. Check the target type and
id supplied to the backend. Do not convert it into an MCP transport error or add adapter-side target
guessing.

### MCP calls fail after `initialize`

Preserve the `Mcp-Session-Id` response header and send it on later requests. A generic PowerShell
HTTP wrapper can lose session headers; use the repository protocol test or another raw client when
diagnosing session behavior.

### Local MCP works but ChatGPT cannot connect

Check the tunnel key status, profile, readiness, workspace association, and Developer Mode app
selection. Never paste the runtime key, tunnel profile, token, or full authorization error into an
issue or chat.

## Safe runtime recovery

Use the component launchers:

```powershell
.\scripts\Start-Tray.cmd
.\scripts\Restart-Tray.cmd
```

Start is non-destructive. Restart must replace only processes whose command line, entry path,
listener, and component-owned metadata match this adapter. Do not kill by `python.exe` or
`powershell.exe` name, and do not restart the OMI backend merely because the adapter is stale.

## Useful evidence

Collect:

- adapter `buildId` and reported backend URL;
- `initialize` and `tools/list` result;
- backend public contract digest or schema version;
- one representative structured business result with market payload redacted;
- tunnel readiness state and whether ChatGPT actions were refreshed.

Exclude credentials, tunnel ids, authorization headers, full market payloads that are not needed,
private logs, PIDs, and local secret paths.
