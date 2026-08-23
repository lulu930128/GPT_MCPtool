# English Study MCP

This is the independent bounded MCP adapter for
`C:\project\english-study-hub`. It does not share source, data, runtime,
ports, or tool identity with Japanese Study.

The current application release is `0.3.0`. The `english-learning-v1`
contract version evolves independently from the package release.

V1 exposes fifteen tools:

- `english_get_summary`
- `english_search_items`
- `english_get_item`
- `english_search_reference_entries`
- `english_get_reference_entry`
- `english_preview_item_enrichment`
- `english_preview_item_creation`
- `english_create_item`
- `english_get_due_reviews`
- `english_get_plan`
- `english_set_manual_labels`
- `english_record_attempt`
- `english_preview_practice_record`
- `english_record_practice`
- `english_get_practice_session`

There are intentionally no file, SQL, shell, delete/reset, bulk import, audio,
speech-recognition, Anki, or migration/admin tools.

The three reference tools read the separately rebuildable catalog owned by the
Hub. Search results preserve source version, license, and attribution and never
authorize an automatic study-item write. Source downloads and catalog rebuilds
remain local Hub administration commands and are not exposed through MCP.
`npm run smoke:reference` performs initialize, tools/list, bounded reference
search, and exact reference detail against the live managed component.

## Setup

Start the Hub first:

```powershell
cd C:\project\english-study-hub
uv run python -m english_study_hub serve
```

Then run the adapter:

```powershell
cd C:\GPT_MCPtool\english_study
npm install
npm test
npm run start:http
```

Defaults:

- Hub: `http://127.0.0.1:18887`
- MCP: `http://127.0.0.1:18886/mcp`
- MCP health: `http://127.0.0.1:18886/health`
- Tunnel readiness: `http://127.0.0.1:18888/readyz`

Health reports version, contract version, tool count, and build id. A 200 alone
does not prove the current MCP artifact is loaded.

The Control Center component is enabled and auto-starts Hub, MCP, and its own
Secure MCP Tunnel. The ignored `.tunnel-client` profile and `.secrets` key are
component-local runtime state. The key is encrypted with Windows DPAPI for the
current user and is injected only into the tunnel child process.

The component also declares the read-only English Study desktop as its primary
UI. Use `Open English Study` from the Control Center tray, or run
`scripts\start-english-study-desktop.vbs`. The launcher injects the managed Hub
endpoint `http://127.0.0.1:18887` into the desktop child process; the UI reads
only the Hub API and never opens the SQLite database.

Tunnel operations use the same component-owned pattern as the other MCPs:

```powershell
npm run tunnel:selftest
npm run tunnel:key:save
npm run tunnel:init
npm run tunnel:doctor
npm run tunnel:health
```

Do not put the control-plane key in `.env`, the generated YAML profile, source,
logs, or Git. Local `/readyz`, remote registration, and ChatGPT connector proof
are separate validation scopes.
