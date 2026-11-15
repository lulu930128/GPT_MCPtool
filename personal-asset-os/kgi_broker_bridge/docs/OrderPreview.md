# 一次性訂單離線工程交接

## 目標與授權範圍

本輪只完成 Source、離線 FakeSDK 測試、可稽核 dry-run。最終使用者目標仍是正式
凱基生產環境 `simulation=False` 的 SDK 登入 → 委託 → 回執 E2E：2330 台積電、
BUY、限價 2160 TWD、1 股、`OddLot.Odd` 盤中零股、ROD、CASH。
目的是技術路徑驗證，**正式委託即使主觀上只是技術測試，也可能成交**。
成交不是本輪或最終技術驗證必須追求的結果，券商受理與成交必須分開判斷。

先前正式提交的工具平台拒絕仍有效。本輪不重送、不換工具或名稱繞過，不新增
live send 路由、CLI 選項、SDK loader 或正式交易執行器。後續是否能進行正式 E2E
仍取決於平台允許與各 Gate 的獨立驗收；本文件不構成解除拒絕或執行授權。

## 本輪計畫與完成條件

1. 靜態核對既有 Settings、worker 登入與帳戶選擇、唯讀 API，以及安裝 SDK 2.1.0 的介面。
2. 新增獨立 CLI 與固定訂單合約，預覽不讀秘密、不產生交易、不改既有 inventory 流程。
3. 用合成帳戶與 FakeSDK 驗證精確參數、錯單阻擋、既有委託、重送、UNKNOWN 對帳。
4. 執行定點測試、lint、型別與 diff 檢查，保存不含秘密的預覽與交接證據。

上述離線條件通過即可完成本輪；不得將它等同 native SDK 或正式 E2E 通過。

## 實作與操作

```powershell
cd C:\GPT_MCPtool\personal-asset-os\kgi_broker_bridge
.\.venv\Scripts\python.exe -I -X utf8 -m kgi_broker_bridge.order_cli --dry-run
.\.venv\Scripts\python.exe -I -X utf8 -m pytest -q tests/test_order_preview.py -p no:cacheprovider
.\.venv\Scripts\python.exe -I -X utf8 -m ruff check src/kgi_broker_bridge/order_preview.py src/kgi_broker_bridge/order_cli.py tests/test_order_preview.py
.\.venv\Scripts\python.exe -I -X utf8 -m mypy --follow-imports=silent src/kgi_broker_bridge/order_preview.py src/kgi_broker_bridge/order_cli.py
```

不帶 `--dry-run` 仍只預覽。錯標的、方向、價格、數量及未知選項回傳 exit 2／NOT_SENT；
成功預覽為 exit 0／PREVIEW，`submission_state=NOT_SENT`。沒有 send、simulation、
帳密或 CA 參數。CLI 只輸出 JSON，不寫 claim、正式 runtime、帳本或庫存。

`OfflineSettings` 讀取既有 Settings 類別的 `simulation=False` 非秘密預設，
但使用純 BaseModel：不能建構 `Settings()`／BaseSettings，因為建構時就可能讀取
ambient environment／`.env`。預覽內 session_plan 僅說明既有 worker 概念，`performed=false`。

FakeSDK 只存在於測試檔。測試 worker 對假登入結果重用既有 `_stock_account` 證券帳戶選擇，
依序 fake login、set_Account、create_order、finally logout，且僅接受該測試 FakeSDK 型別。
正式庫存 worker／gateway／HTTP API／PAOS 啟動與 OMI source 均未修改。

## SDK 映射依據

本輪只讀本機已安裝 `kgisuperpy-2.1.0.dist-info/METADATA`、
`kgisuperpy/trading/Order.py:59` 與 `_trade_base.py`，沒有 import 該 SDK 或載入原生 DLL。
安裝檔位於既有 `.venv-kgi`；離線測試使用 Bridge `.venv`，不啟動 `.venv-kgi`。

| create_order 欄位 | 固定映射 |
| --- | --- |
| action | `Action.Buy`，enum value `B` |
| symbol | `2330` |
| qty | 整數 `1`，本次為 1 股，沒有乘 1000 |
| price | 整數 `2160`；SDK 接受 numeric 作限價；不是 `PriceType.LMT` 或 None |
| time_in_force | `TimeInForce.ROD`，enum value `0` |
| order_cond | `OrderCond.CASH`，enum value `0` |
| odd_lot | `OddLot.Odd`，enum value `4`；不用會按時段轉換的 bool |
| name | 空字串；不假設它是券商冪等鍵 |

`create_order` 本身涉及送出委託，不能拿來建立預覽。Source 的 `sdk_arguments` 只映射參數；
實際方法呼叫僅出現在測試 FakeSDK。金額在合約為 Decimal、JSON 為字串；固定 SDK
數值 2160 轉為整數，不引入浮點金額誤差。qty 的 native／券商端實際單位仍待 E2E 確認。

## 狀態與重送規則

| 狀態 | 本輪含義 |
| --- | --- |
| PREVIEW | 可審閱意圖，未選帳號、未建 session |
| NOT_SENT | 確認這次 CLI 沒有發送；也用於參數拒絕 |
| UNKNOWN | synthetic claim 已占用、回覆缺失、pending、逾時、毀損或對帳不明；不得重送 |
| BROKER_ACCEPTED | 僅匹配的 synthetic 受理證據；不是成交，也不是正式券商證明 |
| FILLED | 僅匹配且 filled_shares=1 的 synthetic 成交證據；不代表真實成交 |

`SyntheticReceipt` 固定 `evidence=SYNTHETIC`、假帳戶與假委託 ID。未實作真實 Trade／
callback 解析器，不會把 SDK 方法正常 return、pending 或沒有例外解讀成受理。

`SyntheticAttempt` 僅供離線合約測試。每個明確提供的測試目錄，以固定意圖 SHA-256
做 exclusive-create claim；claim 在 FakeSDK 呼叫前 flush／fsync，初始即 UNKNOWN。
同 key、不同 request ID、同程序併發或新程序都不能覆寫 claim。缺少既有委託快照或
快照非空，一律先阻擋；不以改 request ID 取得第二次機會。

對帳必須同時匹配假帳戶、完整意圖 fingerprint、attempt ID、唯一假券商委託 ID、
狀態與股數。空結果、多筆／衝突回執、錯識別、毀損 claim 保持 UNKNOWN。
接受或成交的 synthetic 對帳結果也不刪 claim、不授權再送。

這不是 production order journal：對帳結果不持久化成正式回執歷史；重啟後若沒有重新
提供精確證據，保守回到 UNKNOWN。換目錄不共享 fence，未實作帳戶跨程序正式 mutex、
交易日 partition、callback 的單調狀態歷史、正式委託查詢新鮮度與 durable recovery。
不能把此測試 store 接上真實交易。未新增常駐 worker、排程或自動重試。

## 尚缺的驗收 Gate

| Gate | 狀態與缺口 |
| --- | --- |
| Source／離線 FakeSDK／dry-run | PASS：45 個定點測試、lint、2 個 Source 檔型別檢查與 PREVIEW／NOT_SENT；僅離線工程證據 |
| PAOS／唯讀 Bridge runtime health | Reviewer 最新交接：Healthy，2026-10-28 11:38（Asia/Taipei）有新的成功資料；先前 timeout 不再列為目前阻塞。本輪未重測，唯讀成功不等於送單驗收 |
| native SDK | UNVERIFIED：2.1.0 僅靜態檢查；DLL／ABI 初始化與正確 interpreter 待驗證 |
| CA／登入 | UNVERIFIED：本輪未讀帳密或 CA、未登入任何環境；舊 README 的歷史唯讀 qualification 不證明當前交易 session 可用 |
| 正式證券帳戶與權限 | UNVERIFIED：精確 account 選擇、交易權限、API 文件與 CA 綁定待確認 |
| 正式委託查詢／去重／owner | UNVERIFIED：需正式 durable intent、單一 owner、完整既有委託對帳、崩潰後 UNKNOWN recovery；fake claim 不可替代 |
| `simulation=False` create_order | BLOCKED／未執行：先前平台拒絕仍有效；本 CLI 沒有此能力 |
| 正式受理回執／callback | UNVERIFIED：沒有券商 order ID、受理證據、callback lineage 或真實委託狀態 |
| 成交 | UNVERIFIED／非必要驗收結果；正式委託可能成交，不可承諾不成交 |

最後受影響 diff 自我檢查未發現新增實質缺陷；沿用 45/45 pytest、Ruff／Mypy 與
PREVIEW／NOT_SENT 證據，不重跑已通過測試、不擴大安全或架構修改。
目前主要剩餘 Gate 為正式送單及對應回執；上列 native／CA／登入缺口指獨立 order path
尚未取得的驗收證據，不否定 Reviewer 提供的既有唯讀 Bridge 成功資料。

## 官方模擬環境：可選的前置 E2E

最終目標仍為上述 production E2E；`simulation=True` 是獨立且可選的前置測試路徑，
不是改寫最終目標，也不是本輪已授權執行的網路測試。
官方說明 `simulation=False` 連正式環境；功能測試需向凱基申請測試帳號，測試前須簽署
API 相關文件。不得假設正式帳號可直接登入模擬環境。
來源：[登入說明](https://superpy.kgieworld.com.tw/kgipythonapi/guide/tw/inAccount)、
[服務條款與測試規範](https://superpy.kgieworld.com.tw/kgipythonapi/guide/tw/terms)
（2026-10-28 只讀文件核對；未連線券商 session）。

後續官方測試環境 checklist（全部尚未驗證）：

- 確認測試帳號已申請、API 文件已簽署，並由凱基確認帳號所屬環境及測試資格。
- 確認測試 CA／ServiSign 要求、帳號與憑證綁定、SDK 版本與原生初始化。
- 確認明確 `simulation=True`，不採預設、不 fallback 到正式環境，不挪用正式帳密。
- 確認官方服務時段與台灣 IP 限制；股票／期貨分開，符合官方測試間隔要求。
- 驗證 login、證券帳戶選擇、session owner 與 bounded logout，不以 health 代替登入證據。
- 在另行允許的測試範圍驗證 create_order、callback 註冊與關聯、pending／受理／拒絕／
  模擬成交語義、get_trades 或回報查詢完整度、斷線後 UNKNOWN 對帳與防重送。
- 保留去識別回執與環境證據；模擬驗證通過仍不代表 production login、CA、order 或 receipt 通過。
