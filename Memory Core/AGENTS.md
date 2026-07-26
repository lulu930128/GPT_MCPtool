# Memory Core AGENTS.md

本檔適用於 `C:\GPT_MCPtool\Memory Core`。

## 產品定位

- Memory Core 是 local-first、single-user、可審計的個人資料 system of record。
- FastAPI 與 Domain/Application Service 是唯一正式資料寫入邊界。
- MCP、Kuro、網站與未來工具都是 client，不得直接操作 SQLite。
- AI 或自動化產生的內容預設只能建立 candidate；未經具備 review scope 的 client 核准，不得成為正式資料。
- Kuro 的角色、thread、runtime 與 Briefing snapshot 不屬於 Memory Core 的長期正式資料；只有明確提案後才可進入 candidate lifecycle。

## 安全與資料底線

- 不保存 password、API key、token、cookie、private key 或其他 secrets。
- 不保存原始公司機密；只允許經人工確認的去識別摘要。
- `restricted` 資料必須另外具備 `restricted:read` / `restricted:write` scope。
- Public website 只能讀獨立 public snapshot，不得連接私人資料庫。
- Token 不得寫入 repo、log、audit details 或錯誤訊息。
- `data/`、`.env`、export、backup、SQLite/WAL、附件與 runtime logs 不得 commit。

## 架構邊界

- `src/memory_core/api/`：HTTP contract 與 dependency wiring。
- `src/memory_core/services/`：transaction 內的 application use cases。
- `src/memory_core/models.py`：SQLAlchemy persistence model；route 不直接組裝 ORM 寫入。
- `src/memory_core/security.py`：client token 與 scope enforcement。
- `src/memory_core/operations.py`：export、backup 等 bounded local operations。
- `migrations/`：所有正式 schema 變更；runtime 不自動執行 migration。

## 修改與驗證

- API、DB、candidate、revision、audit、scope 或 migration 變更屬 Tier 3；至少跑 targeted tests、完整 pytest、ruff 與 migration smoke。
- Migration 必須可從空 DB upgrade，並驗證 downgrade/upgrade round-trip；不得用刪除正式 data 方式驗證。
- 對 optimistic concurrency、soft delete、candidate idempotency、restricted filtering、backup 可讀性保留 regression tests。
- 不新增 domain-specific tables，除非實際 query contract 已證明通用 `records` / `entities` 加 versioned payload 不足。

## Git

- 未經使用者明確要求，不 commit、不 push。
- commit 前必須檢查 private data、client token、SQLite、WAL、export、backup 與 `.env` 未進入 staged diff。
