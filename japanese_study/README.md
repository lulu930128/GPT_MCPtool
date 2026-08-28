# Japanese Study MCP

Private, tool-only MCP adapter for the authoritative Japanese Study Hub at
`C:\project\japanese-study-hub`. ChatGPT and Kuro can use the same bounded tool
contract without reading source files or legacy progress data directly.

目前 application release 為 `1.2.1`；`learning-content-v8.1` 是獨立的 Hub/MCP contract 版本。除了既有 canonical/proposal 與 bounded alias/component 投影，v8.1 也提供 server-owned practice profile fallback、可直接解析的 typed diagnosis schema，以及 bounded canonical diagnosis catalog read。

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
| `study_preview_item_creation` | Preview stable identity and duplicate candidates |
| `study_create_item` | Create a confirmed vocabulary or grammar item retry-safely |
| `study_preview_item_revision` | Preview editable content/tags before and after |
| `study_apply_item_revision` | Apply a confirmed revision with audit history |
| `study_preview_item_lifecycle` | Preview reversible retire/restore state |
| `study_apply_item_lifecycle` | Apply confirmed retire/restore without deletion |
| `study_get_quality_inbox` | Read missing, incomplete, proposed, and unresolved work |
| `study_get_due_reviews` | Read the SM-2 style due queue |
| `study_list_study_lists` | Read bounded imported, inbox, and custom lists |
| `study_create_study_list` | Create one typed custom list retry-safely |
| `study_add_study_list_items` | Add exact same-kind item ids to a list |
| `study_preview_question_candidates` | Generate deterministic pending candidates |
| `study_save_question_candidate` | Save a confirmed candidate without promotion |
| `study_promote_question_candidate` | Promote a human-reviewed candidate |
| `study_retire_question_candidate` | Retire a rejected candidate while retaining audit |
| `study_get_plan` | Read a bounded prioritized study list |
| `study_get_learner_policy` | Read the learner-owned generation and recording policy |
| `study_set_learner_policy` | Replace that policy only after an explicit user request |
| `study_get_learning_context` | Read bounded weak/recent context for question generation |
| `study_get_diagnosis_catalog` | Search bounded canonical diagnosis definitions without taxonomy mutation |
| `study_set_manual_labels` | Retry-safe upsert of known/unknown/uncertain/suspended labels |
| `study_record_attempt` | Append one retry-safe attempt using a caller event id |
| `study_preview_practice_record` | Validate a complete practice session without writing |
| `study_record_practice` | Atomically store a complete retry-safe practice session |
| `study_record_practice_revision` | Atomically record and supersede a corrected session |
| `study_preview_target_resolution` | Normalize new selectors and read bounded candidates |
| `study_list_practice_sessions` | List sessions with filters, score summaries, and cursor pagination |
| `study_preview_practice_target_resolution` | Preview unresolved targets, evidence, duplicates, and fingerprint |
| `study_apply_practice_target_overrides` | Apply confirmed exact item ids with a retry-stable operation id |
| `study_supersede_practice_session` | Link an immutable corrected session as the current revision |
| `study_get_practice_session` | Read immutable questions, answers, targets, evidence, and score |

There are 34 tools. There are intentionally no file browser, SQL, delete, reset, bulk import, shell,
Anki write, general batch resolver, evidence rebuild, catalog admin, or
legacy-migration MCP tools. Search selectors return candidates only. Target
repair writes require exact stable item ids from a prior fingerprinted preview.
Word and Anki integrations remain local Hub admin CLI workflows.

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

- Hub: `http://127.0.0.1:18791`
- MCP: `http://127.0.0.1:18790/mcp`
- Health: `http://127.0.0.1:18790/health`

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

The component-local executable remains an explicit runtime choice. Control
Center inventories its path, version, and SHA-256 but never upgrades or switches
it automatically. The controller removes ambient HTTP(S) proxy variables only
while spawning Hub, MCP, and tunnel children, sets a loopback bypass, and then
restores the parent environment. Any required corporate outbound proxy must be
configured explicitly for this component.

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

既有托盤 source 使用 `unified-always-on-v2` 契約。正式啟動會一起準備 Hub、MCP adapter 與
Secure MCP Tunnel；選單不提供 Start／Stop 或 tunnel restart。`Restart MCP server`
只重啟 Hub + adapter，Hub health 與 DPAPI key 操作位於 `Exit` 上方的元件特有區。
`Exit` 會完整停止 Hub、adapter、tunnel 與 tray。

Control Center 的正式整合使用 `unified-lifecycle-v3`。元件自己的 stateless controller
依序管理 Hub、MCP adapter 與 tunnel，並以 exact PID／executable／command／listener
lineage 驗證 ownership；中樞不讀取任何學習資料。既有 tray source 與 launcher 保留作
rollback，`show-diagnostic-tray.vbs` 只開啟不持有 runtime 的診斷 UI。完整邊界與驗證方式見
[`docs/ControlCenterIntegration.md`](docs/ControlCenterIntegration.md)。

`component-menu-v1` 會在中樞子選單直接顯示原本的 connection、唯讀 Japanese Study
browser、Hub health、Save tunnel key 與 Show key status。實際前端啟動、clipboard、DPAPI 與 tunnel profile 操作仍由本元件的
`scripts/control-center-ui.ps1` 執行，不會讓中樞讀取學習資料或 credential。

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
