# GPT MCP Tool Workspace

本 repository 是四個 MCP 元件的 source-only monorepo。

## 工作邊界

- 修改任何元件前，先閱讀該目錄內的 `AGENTS.md` 與 `README.md`。
- 四個頂層元件維持獨立的依賴、測試、MCP contract 與資料邊界。
- 不要為了整理 repository 而 flatten、搬移或重新命名元件；現有 Windows lifecycle
  script、Startup shortcut 與本機設定可能依賴絕對路徑。
- 跨元件共用 runtime 資源時，必須在根 README 與元件 README 說明，不得把資料層
  或 domain logic 複製到 adapter。

## 公開安全

- GitHub repository 是 public；不得 commit secret、token、DPAPI 密文、tunnel
  profile、私人資料、SQLite、backup、export、log、PID、cache、虛擬環境、
  dependency folder、編譯輸出或下載的 executable。
- `.env.example` 只能保留不可用的 placeholder。
- `Memory Core/data/` 永遠是本機 system-of-record state，不屬於 source archive。
- 不得使用 `git add -f` 繞過安全忽略規則。
- commit 與 push 前必須檢查 staged file list、staged diff、secret pattern 與大型檔案。

## Git

- 根目錄是唯一 Git repository；元件目錄不得各自保留 nested `.git`。
- 未經使用者明確確認，不執行 commit 或 push。
- 保留 unrelated local runtime state，不為了乾淨 worktree 刪除 ignored 檔案。
