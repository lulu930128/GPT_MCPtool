# Japanese Study MCP Adapter

This repository exposes the bounded Japanese Study Hub contract to ChatGPT and
other MCP clients. Domain rules and persistent data belong to
`C:\project\japanese-study-hub`.

## Safety rules

- Do not read user study-material directories, Anki, Kuro progress JSON, Word documents, Excel workbooks, or SQLite directly from MCP tools.
- All study data access must go through the versioned Hub HTTP API.
- Never expose arbitrary HTTP requests, filesystem browsing, SQL, shell execution, delete, reset, or admin-import tools.
- Every tool must declare `readOnlyHint`, `destructiveHint`, and `openWorldHint`; retry-safe writes should also declare `idempotentHint`.
- Require explicit stable item ids for mutations. Search results alone must not trigger bulk labels when matches are ambiguous.
- Multi-question practice writes must preserve the full Hub submission contract
  and remain atomic and idempotent. Preview before writing, reuse
  `submissionId` on retry, and never synthesize manual labels from practice
  evidence.
- Keep general resolver, evidence rebuild, and catalog administration in the
  Hub CLI. MCP may expose bounded read-only target previews and an explicit
  item-id-only apply operation protected by a preview fingerprint and stable
  operation id. Search selectors are candidate-only and must never auto-apply.
- Preserve Hub domain error `code`, HTTP `status`, `retryable`, and bounded
  `details` fields across the MCP boundary.
- MCP health must identify the loaded `contractVersion`, `toolCount`, and
  artifact `buildId`. Launcher health checks must compare those values rather
  than treating HTTP 200 as current deployment proof.
- Practice score-policy overrides require an explicit per-question
  `gradingOverrideReason`; never synthesize one in the adapter.
- Keep tunnel ids, API keys, bearer tokens, generated profiles, logs, and pid files out of Git.
- Store the tunnel runtime key only through `scripts/tunnel.ps1 -Action SaveKeyPrompt`; keep its DPAPI ciphertext out of Git.
- Refuse non-loopback MCP binding unless `JSTUDY_MCP_HTTP_TOKEN` is configured.
- Do not log authorization headers, tokens, full study content, or tool payloads.
- STDIO mode must not print logs to stdout.

## Validation

- `npm run build`
- `npm test`
- `npm run smoke:http`
- With Hub running: `npm run smoke:hub`
- `npm run tunnel:selftest`
- `npm run tray:selftest`
- Run `npm run tunnel:doctor` only after a DPAPI key is present.
