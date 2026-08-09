# GPT MCP Tool Workspace

本 repository 是六個 MCP 元件與一個 Windows runtime 中樞的 source-only monorepo。

## 工作邊界

- 修改任何元件前，先閱讀該目錄內的 `AGENTS.md` 與 `README.md`。
- 六個頂層元件維持獨立的依賴、測試、MCP contract 與資料邊界。
- 不要為了整理 repository 而 flatten、搬移或重新命名元件；現有 Windows lifecycle
  script、Startup shortcut 與本機設定可能依賴絕對路徑。
- 跨元件共用 runtime 資源時，必須在根 README 與元件 README 說明，不得把資料層
  或 domain logic 複製到 adapter。
- `mcp_control_center` 只能協調既有 lifecycle、probe 與營運紀錄；不得成為第七個 MCP、
  讀取 domain payload、保存 secret，或用 kill-by-name 取代 component exact-path ownership。

## 公開安全

- GitHub repository 是 public；不得 commit secret、token、DPAPI 密文、tunnel
  profile、私人資料、SQLite、backup、export、log、PID、cache、虛擬環境、
  dependency folder、編譯輸出或下載的 executable。
- `.env.example` 只能保留不可用的 placeholder。
- `Memory Core/data/` 永遠是本機 system-of-record state，不屬於 source archive。
- `personal-asset-os` 的正式資料永遠位於 `%LOCALAPPDATA%\PersonalAssetOS` 或明確指定的
  repo-external `PAOS_DATA_DIR`；不得把財務資料、備份或 runtime secret 放進 repository。
- 不得使用 `git add -f` 繞過安全忽略規則。
- commit 與 push 前必須檢查 staged file list、staged diff、secret pattern 與大型檔案。

## Git

- 根目錄是唯一 Git repository；元件目錄不得各自保留 nested `.git`。
- 未經使用者明確確認，不執行 commit 或 push。
- 保留 unrelated local runtime state，不為了乾淨 worktree 刪除 ignored 檔案。
