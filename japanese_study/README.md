# Japanese Study MCP

Private, tool-only MCP adapter for the authoritative Japanese Study Hub at
`C:\project\japanese-study-hub`. ChatGPT and Kuro can use the same bounded tool
contract without reading source files or legacy progress data directly.

## Documentation

- [Architecture](docs/Architecture.md): adapter/Hub ownership, runtime identity, network and data
  boundaries.
- [Tool contract](docs/ToolContract.md): all public tools, annotations, retry rules and errors.
- [Practice lifecycle](docs/PracticeLifecycle.md): preview, record, target repair, supersede and
  idempotent retry.
- [Troubleshooting](docs/Troubleshooting.md): Hub, build, MCP, tunnel and ChatGPT cache diagnosis.
- [ChatGPT setup](docs/ChatGPT-Setup.md): Developer Mode and private tunnel setup.

## Current tools

| Tool | Effect |
| --- | --- |
| `study_get_summary` | Read item, label, and attempt counts |
| `study_search_items` | Read bounded vocabulary/grammar/question matches |
| `study_get_item` | Read one exact stable item id |
| `study_get_plan` | Read a bounded prioritized study list |
| `study_set_manual_labels` | Retry-safe upsert of known/unknown/uncertain/suspended labels |
| `study_record_attempt` | Append one retry-safe attempt using a caller event id |
| `study_preview_practice_record` | Validate a complete practice session without writing |
| `study_record_practice` | Atomically store a complete retry-safe practice session |
| `study_preview_target_resolution` | Normalize new selectors and read bounded candidates |
| `study_list_practice_sessions` | List sessions with filters, score summaries, and cursor pagination |
| `study_preview_practice_target_resolution` | Preview unresolved targets, evidence, duplicates, and fingerprint |
| `study_apply_practice_target_overrides` | Apply confirmed exact item ids with a retry-stable operation id |
| `study_supersede_practice_session` | Link an immutable corrected session as the current revision |
| `study_get_practice_session` | Read immutable questions, answers, targets, evidence, and score |

There are intentionally no file browser, SQL, delete, reset, bulk import, shell,
Anki write, general batch resolver, evidence rebuild, catalog admin, or
legacy-migration MCP tools. Search selectors return candidates only. Target
repair writes require exact stable item ids from a prior fingerprinted preview.

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

`npm run smoke:practice` is a write test and refuses to run unless
`JSTUDY_ALLOW_TEST_WRITE=1` is explicitly set. Point it only at a loopback MCP
instance backed by a disposable Hub database.

Defaults:

- Hub: `http://127.0.0.1:8791`
- MCP: `http://127.0.0.1:8790/mcp`
- Health: `http://127.0.0.1:8790/health`

The health response identifies the loaded contract and artifact with
`contractVersion`, `toolCount`, and `buildId`. A plain HTTP 200 is not enough
to prove that ChatGPT is using the latest tool schema.

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

After rebuilding the adapter, double-click `scripts\\Restart-Tray.cmd`. This
uses the exact-path `-ReplaceExisting` flow and reloads Hub, MCP, and tunnel
without broad process-name termination. The normal Start entry remains
non-destructive and does not replace an already-running instance.

托盤使用 `unified-always-on-v2` 契約。正式啟動會一起準備 Hub、MCP adapter 與
Secure MCP Tunnel；選單不提供 Start／Stop 或 tunnel restart。`Restart MCP server`
只重啟 Hub + adapter，Hub health 與 DPAPI key 操作位於 `Exit` 上方的元件特有區。
`Exit` 會完整停止 Hub、adapter、tunnel 與 tray。

The tray refuses to start MCP when `src` is newer than `dist`, and it verifies
MCP version, contract version, tool count, and the current core-artifact hash.

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

Practice previews may warn when `answerResult` and `awardedPoints` do not match
the default scoring policy. Recording rejects that mismatch unless the caller
provides a non-empty per-question `gradingOverrideReason`; the Hub preserves
that reason as grading provenance.
