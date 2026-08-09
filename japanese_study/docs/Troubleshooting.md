# Japanese Study MCP Troubleshooting

Diagnose in this order:

```text
Hub database/service -> Hub HTTP API -> adapter build -> local MCP -> tunnel -> ChatGPT cache
```

## Source and build

```powershell
cd C:\GPT_MCPtool\japanese_study
npm run build
npm test
npm run smoke:http
```

The tray refuses to start the adapter when `src` is newer than `dist`. Rebuild before restarting.
After restart, compare health `contractVersion`, `toolCount`, and `buildId`; HTTP 200 alone is not
deployment proof.

## Common failures

### Hub unavailable

Verify the authoritative Hub first:

```powershell
cd C:\project\japanese-study-hub
uv run python -m japanese_study_hub.cli serve
```

Then run:

```powershell
cd C:\GPT_MCPtool\japanese_study
npm run smoke:hub
```

Check `JSTUDY_HUB_BASE_URL`, timeout, and Hub authentication without printing the token. A remote
Hub URL must use HTTPS and cannot embed credentials.

### Tool schema or count is stale

1. Build the adapter.
2. Restart only this component through `scripts\Restart-Tray.cmd`.
3. Check health identity and raw MCP `tools/list`.
4. Refresh ChatGPT Actions, reconnect, or open a new conversation.

Do not add duplicate compatibility code merely because a host cached the old schema.

### A write was duplicated or rejected

- Practice record: reuse the original `submissionId` for the same payload.
- Single attempt: reuse the original caller event id.
- Target override: reuse the original `operationId`, fingerprint, and exact overrides.
- If the same id now carries different content, surface the idempotency conflict; do not generate a
  replacement id automatically.

### Target repair says fingerprint is stale

Fetch the current session and run `study_preview_practice_target_resolution` again. Show the new
evidence and ask for exact confirmation again. Do not reuse old approval intent across a changed
fingerprint.

### Practice scoring mismatch

If `answerResult` and `awardedPoints` differ from policy, add a truthful, explicit per-question
`gradingOverrideReason`. The adapter must not invent one.

### MCP listener bind fails

The default listener is loopback. A non-loopback bind requires `JSTUDY_MCP_HTTP_TOKEN`; otherwise
startup fails intentionally. Do not weaken this check to work around a port or tunnel problem.

Identify a conflicting listener by port, executable path, command line, and component ownership.
Do not kill all Node processes by name.

## Tunnel and ChatGPT

```powershell
npm run tunnel:selftest
npm run tunnel:key:status
npm run tunnel:doctor
```

The DPAPI key and tunnel profile are local secrets/state. Report only whether they are configured
and whether readiness succeeded.

If local `initialize`, `tools/list`, and a representative call work but ChatGPT does not, inspect
tunnel workspace association and Developer Mode app selection. If tools are old, refresh actions.

## Write smoke warning

`npm run smoke:practice` and `npm run smoke:hub:write` can mutate Hub data. They require explicit
opt-in and must target a disposable loopback Hub database. Normal documentation or source changes
do not justify running them against production study data.

## Safe evidence for a report

Include adapter version/build id, contract version, tool count, bounded Hub error code/status, and
the affected tool name. Redact study content, stable ids when private, tokens, tunnel ids, profiles,
logs, and authorization headers.
