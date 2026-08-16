# English Study MCP

This is the independent bounded MCP adapter for
`C:\project\english-study-hub`. It does not share source, data, runtime,
ports, or tool identity with Japanese Study.

The current application release is `0.2.0`. The `english-learning-v1`
contract version evolves independently from the package release.

V1 exposes twelve tools:

- `english_get_summary`
- `english_search_items`
- `english_get_item`
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

- Hub: `http://127.0.0.1:8831`
- MCP: `http://127.0.0.1:8830/mcp`
- MCP health: `http://127.0.0.1:8830/health`

Health reports version, contract version, tool count, and build id. A 200 alone
does not prove the current MCP artifact is loaded.

The Control Center component remains disabled until local Hub/MCP validation is
complete. Secure tunnel provisioning is a separate adoption step because it
requires a private profile and DPAPI-protected key.
