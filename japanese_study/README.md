# Japanese Study MCP

Private, tool-only MCP adapter for the authoritative Japanese Study Hub at
`C:\project\japanese-study-hub`. ChatGPT and Kuro can use the same bounded tool
contract without reading source files or legacy progress data directly.

## Current tools

| Tool | Effect |
| --- | --- |
| `study_get_summary` | Read item, label, and attempt counts |
| `study_search_items` | Read bounded vocabulary/grammar/question matches |
| `study_get_item` | Read one exact stable item id |
| `study_get_plan` | Read a bounded prioritized study list |
| `study_set_manual_labels` | Retry-safe upsert of known/unknown/uncertain/suspended labels |
| `study_record_attempt` | Append one retry-safe attempt using a caller event id |

There are intentionally no file browser, SQL, delete, reset, bulk import, shell,
Anki write, or legacy-migration MCP tools.

## Setup

Start the Hub first:

```powershell
cd C:\project\japanese-study-hub
uv run python -m japanese_study_hub.cli serve
```

Then install, validate, and run this adapter:

```powershell
cd C:\GPT_MCPtool\japanese_study
npm install
npm test
npm run smoke:http
npm run start:http
```

Defaults:

- Hub: `http://127.0.0.1:8791`
- MCP: `http://127.0.0.1:8790/mcp`
- Health: `http://127.0.0.1:8790/health`

Copy `.env.example` values into the process environment as needed. This project
does not automatically load `.env`, which avoids accidentally coupling runtime
secrets to the repository.

## Secure MCP Tunnel

The active tunnel identifier stays in the ignored generated profile. The tunnel
forwards only to the loopback MCP endpoint; the Hub database and HTTP API are
not exposed directly.

```powershell
cd C:\GPT_MCPtool\japanese_study
npm run tunnel:version
npm run tunnel:init
npm run tunnel:key:save
npm run tunnel:key:status
npm run tunnel:doctor
```

`tunnel:key:save` opens a masked local dialog and stores only Windows
current-user DPAPI ciphertext under `.secrets`. Never put the runtime key in a
command, `.env`, README, tunnel profile, or chat message.

For normal use, double-click `scripts\Start-Tray.cmd`. The tray owns the Hub,
MCP adapter, and tunnel processes and exposes health/status actions. After the
full chain is verified, install login startup with `npm run startup:install`.

## Kuro desktop pet

Kuro can later register the STDIO entry point without changing this adapter:

```json
{
  "command": "C:\\Program Files\\nodejs\\node.exe",
  "args": ["C:\\GPT_MCPtool\\japanese_study\\dist\\src\\index.js"]
}
```

Do not add this to Kuro until backend, MCP, and tunnel integration validation
has passed. The old tracker remains available during the transition.

## ChatGPT connection

The dedicated tunnel profile is configured locally. See `docs/ChatGPT-Setup.md`
for runtime validation and ChatGPT Developer Mode connection. Never paste
credentials into this README, `.env.example`, source files, command history, or
chat messages.
