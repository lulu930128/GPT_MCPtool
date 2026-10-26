# Taiwan Workspace 緊湊版面驗證

日期：2026-10-09。範圍僅 OMI_search UI、測試與本文；保留既有 dirty WIP，未 commit/push，未改 backend、SDK、交易或 lifecycle。

本文保留上一輪 69 項測試與 bundle 的歷史證據；後續 iframe 高度回授修復及最新驗證見 [TaiwanWorkspaceIframeHeight.md](TaiwanWorkspaceIframeHeight.md)。

## 版面與資料責任

- Desktop 共用 grid：左欄跨兩列，頂端與右側兩張市場卡齊平；下列為中央 chart 與 **360px** 研究／M2 SYNTHETIC。市場區沒有第三張全寬 Pane。
- TAIEX 卡只配 TWSE 廣度，TPEX 卡只配 TPEX 廣度；指數與廣度品質分開顯示，`derived_proxy` 保留明確標示。缺值顯示 `—`／`missing`，不補零、不推算成交量或成交額。
- 全域 warnings、limitations、freshness 與完整 header 原始資料只有一個「整體市場來源、時間與原始資料」disclosure，位於第一張卡底部，預設收合。外顯警告有「整體市場」前綴。傳入 Evidence 的是原始 header reference，沒有改寫或縮減 backend envelope。
- 側欄搜尋／持股在上方；原先的 viewport-height sticky 規則已由 [iframe 高度修復](TaiwanWorkspaceIframeHeight.md) 取代。所有 display mode 共用安全界限：寬度 >650px 側欄 820px，上方兩區各自最多 25%，群組樹填滿其餘空間；≤650px 側欄自然高度、群組樹 400px。整個側欄採一般文件流，短 iframe 可捲到各區塊。
- 群組與股票使用透明文字列、細線縮排、淡 hover 與藍色選取線；保留 chevron／名稱兩個 native button、focus-visible、內部滾動與底部淡化。股票名稱單行截斷、價格第二行，品質警告不被截斷。
- ≤1150px：研究／SYNTHETIC 排在 chart 下方；≤650px：市場雙卡、側欄、chart、context 依序排列，sidebar 不使用 sticky。
- Group 45 原地股票、祖先展開、`dataKey === key`、單一 direct-watchlist request、header/watchlist/chart 30s、research 120s、chart pan/zoom 與 M2 模擬邊界均保留。

## 本輪變更檔案

- `ui/tw-market-dashboard/src/WorkspaceApp.tsx`
- `ui/tw-market-dashboard/src/styles.css`
- `ui/tw-market-dashboard/src/workspace-evidence.tsx`
- `ui/tw-market-dashboard/src/workspace-market.tsx`（新增）
- `ui/tw-market-dashboard/src/workspace-market.test.ts`（新增）
- `ui/tw-market-dashboard/scripts/check-workspace-browser.mjs`
- `ui/tw-market-dashboard/scripts/workspace-browser-fixture.tsx`
- `tests/check_workspace_resource.py`（新增）
- `docs/TaiwanWorkspaceCompactLayout.md`（新增，本文）

本機 `ui/tw-market-dashboard/dist/index.html` 已更新，屬 ignored build artifact。

## Source 驗證

在 `C:\GPT_MCPtool\OMI_search\ui\tw-market-dashboard`：

```powershell
npm run typecheck
npm test
npm run build
```

全部通過；Node **69/69**（原本 60，新增 9）。包含兩卡／grid SSR、正確市場配對、缺資料與品質、共享原始 header reference／單次警告、文字樹 CSS、360px 右欄、responsive 宣告、UTF-8，以及既有 Group 45、late response、native button handler 與 M2 regression。這些是 source/SSR/handler/CSS 證據，不等於 browser geometry 或 native keyboard 視覺驗收。

Build：`dist/index.html` **522,007 bytes**。

在 `C:\GPT_MCPtool\OMI_search`：

```powershell
python -B tests/check_workspace_contract.py
python -B tests/check_workspace_resource.py
```

Generated snapshot digest：`5f8defdefb513730f0ab7d239fa745d79cda342b3d200c6ee0f9f91bffc8fb87`。AST、17 tools／2 resources、主 repo generated snapshot byte parity 通過；沒有改動主 repo。

## Live 唯讀 Resource 驗證

Loopback MCP `127.0.0.1:18797`，未 restart，未執行 `tools/call`：

| 呼叫 | 結果 | elapsed_ms |
| --- | --- | ---: |
| initialize | 成功；協商 `2025-11-25` | 1.60 |
| notifications/initialized | 成功 | 18.91 |
| resources/list | 2 resources | 1.27 |
| tools/list | 17 tools；五個 progressive tools input/output schema 與 snapshot 相同 | 95.35 |
| resources/read | HTML 與最新 transformed dist 逐字一致 | 899.52 |

Resource URI：`ui://omi/tw-workspace/v1.html`。MIME 為 `text/html;profile=mcp-app`；CSP `connectDomains`／`resourceDomains` 仍為空。

Resource **522,033 bytes**，SHA-256：`3d8529cf4371e7dd53a866a39bfde1c2f5e870d0efe60695ec1d18d72de53ca1`。比 dist 多出的 26 bytes 是既有 `data-omi-workspace="true"` marker。

Health：`ok=true`、application `1.2.0`、SDK `2.1.1`、runtime 原 buildId `e3d1b48ccb8d2d36`。Resource handler 每次讀 dist；本次相等證據不代表重啟、buildId 更新或已開啟的 ChatGPT iframe 自動更新。

## Browser／host 尚未驗收

僅嘗試一次：

```powershell
node scripts/check-workspace-browser.mjs 'C:\Program Files\Google\Chrome\Application\chrome.exe'
```

第一個 1440px probe 在 20 秒限時得到 `spawnSync ... ETIMEDOUT`，沒有 DOM PASS 或可驗收 screenshot；未繼續 1150／650／390px，未再嘗試其他 browser。後續 reviewer 的共享 evidence 與 360px 修正已通過 source tests/build/live Resource，沒有重跑 browser。

請重新開啟 ChatGPT Taiwan Workspace，確認 desktop 齊頂／樹列與 360px M2，再檢查窄螢幕、native keyboard、iframe/fullscreen resizing。ChatGPT live visual acceptance 仍未驗證。
