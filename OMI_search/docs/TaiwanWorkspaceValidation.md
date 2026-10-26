# Taiwan workspace source 驗證紀錄

## 2026-10-08：中斷任務的 M0 UI source acceptance

本節為本輪結果；下方 2026-10-07 紀錄保留為歷史證據。本輪只修改 `WorkspaceApp.tsx`、`styles.css`、`workspace-ui.test.ts` 與本文件，保留其他既有 dirty WIP。

- 持股列僅顯示實際提供的記錄來源、價格狀態、時間及來源；缺欄不再補 `unknown`／時間未提供／來源未提供。Backend 明確提供的 `unknown` 或 `stale` 仍會顯示。
- 當前群組股票清單使用 280px 高度上限與內捲，可由鍵盤聚焦，100 筆仍在同一有界區域。沿用原本選股 callback 與 selected identity。
- 未修改持股讀取／錯誤／partial／stale 判定、群組樹 fade、diagnostics lazy、chart lifecycle 或 polling cadence。

已執行並通過：

```powershell
# C:\GPT_MCPtool\OMI_search\ui\tw-market-dashboard
npm run typecheck
npm test
npm run build

# C:\GPT_MCPtool\OMI_search；python 解析為 C:\miniconda3\python.exe
python -B tests/check_workspace_contract.py

# C:\GPT_MCPtool
git diff --check -- OMI_search
```

- TypeScript tests：38 passed、0 failed、0 skipped（既有 36 個，加 2 個 regression）。新增測試涵蓋缺少／無效／部分持股來源欄位，以及 100 筆股票的有界區域、選取標示與 callback identity。
- 既有測試涵蓋失敗／禁止存取／不完整／過期持股不冒充空持倉、77 群組、fade 在尾部解除及反向捲動恢復、resize／toggle／cleanup、1200 筆 diagnostics 預設只建立摘要 DOM，以及 chart lifecycle／late response cancellation。
- Build：成功產生 ignored `dist/index.html`（494111 bytes）。契約 checker：AST、generated GET/input/output contract、17 tools／2 resources、digest 與主 repo snapshot byte parity 全數通過；只讀取 generated snapshot，沒有 import 或修改 backend。
- Browser layout／實際點擊／diagnostics 展開互動：**unverified**。依先前 Chromium 失敗的限制，本輪不重試 fixture；Node render／callback／observer tests 不宣稱瀏覽器驗收。
- 本輪沒有 Python adapter unit／SDK／HTTP protocol 或 live host 驗證，沒有網路請求、provider IO、DB write、runtime restart／adoption、commit 或 push。正式 runtime 未操作；本機 source build 不代表其已採用新版。

## 2026-10-07：原始 progressive workspace source 驗證

日期：2026-10-07。這份紀錄只代表 source validation；沒有 restart、commit、push、provider call、DB 存取或市場 refresh/repair。

## 實作範圍

- 保留原本 11 tools 與舊 dashboard resource，新增 5 個 generated progressive data tools 與 `omi_open_tw_workspace`，合計 17 tools／2 resources。
- `WorkspaceApp.tsx` 立即 render shell；各 pane 直接呼叫 MCP Apps bridge，loading/error/retry 分離。Header/watchlist/chart 與 hot groups/research 無等待依賴。
- 選股保留舊圖並標示 pending target，chart/research 分開請求；generation 與 abort 阻止 late response 覆寫 selection。
- Chart instance 建立與資料更新分開；正常 points/MA refresh 使用 series refs/setData，保留 visible range，rolling bars 保留時間錨點。原 fullscreen 支援保留。
- `AGENTS.md`、README、PublicContract、ControlCenterIntegration 已更新。`AGENTS.md` 是本機 ignored 指引；未以 force-add 改變忽略規則。

## 已通過

在 `ui/tw-market-dashboard` 執行：

```powershell
npm run typecheck
npm test
npm run build
```

- typecheck 通過。
- 25 個 Node tests 通過；包含獨立 pane 載入／重試、stale-while-revalidate、late response/error 丟棄、unmount cancellation，以及實際 chart component effects 的受控 lifecycle 測試。
- lifecycle 測試驗證 refresh 不 create/remove、range 保留、rolling window 時間錨點、空資料恢復、symbol/timeframe 切換與 cleanup。Chart API 和 React hooks 使用測試替身；這不是瀏覽器 visual acceptance。
- production bundle 已完成，`dist/index.html` 是 ignored local artifact。

在 adapter 目錄使用已存在的有效 interpreter，僅執行標準庫檢查：

```powershell
& 'C:\project\Open Market Intelligence\.venv\Scripts\python.exe' -B tests/check_workspace_contract.py
```

AST、generated GET/input/output contract、static 17 tools／2 resources、digest 與主 repo byte parity 均通過；沒有 import MCP 或 OMI backend。實際 build 前重新複製主 repo snapshot，build 後再次確認 parity。

```text
schema digest: 5f8defdefb513730f0ab7d239fa745d79cda342b3d200c6ee0f9f91bffc8fb87
file SHA-256: 40b60034660deb30834e339865c394d21fea290a1ee8800fabeb51805c03b800
```

根 repo 的 `git diff --check -- OMI_search` 通過。Diff review 確認原 11 tools／舊 opener 仍保留，Python tests 的 count assertions 已更新為 17／2，且既有 `public_contract_snapshot.json` 與圖檔變更未被改寫。

## 未執行的驗證

Python adapter unit／SDK／HTTP protocol runtime suite **未執行**。既有 standalone `.venv` 指向已不存在的 Python 3.12 base interpreter。使用有效 Python 3.13 搭配 project-local `UV_CACHE_DIR`／隔離 validation venv 嘗試 `uv run --frozen` 時，下載 lockfile 要求的 `cryptography==50.0.1` 遭 network/socket `WinError 10013` 阻擋；測試尚未開始。已依使用者指示停止環境修復，不改使用者 Python 安裝、不拼接 site-packages。

新增 `tests/test_workspace.py` 涵蓋 generated schema equality、GET relay、query encoding、無 IO opener、resource mode 與 SDK workspace smoke；這些測試只有 AST 檢查，不能宣稱 runtime pass。既有 current／legacy HTTP protocol tests 同樣尚未執行。

沒有進行 live backend、ChatGPT host、fullscreen、browser layout／screenshot acceptance。後續仍需在可用且符合 lockfile 的 Python 環境執行：

```powershell
python -B -m unittest discover -s tests
```

再由使用者另行安排 backend／adapter adoption 與 host tool/resource refresh，驗證實際產品畫面。這輪不操作正式 runtime。
