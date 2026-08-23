# Personal Asset OS Mobile

Android-first、offline-first 的 Personal Asset OS 快速記錄 App。使用金額、分類、描述（選填）記錄 TWD 支出／收入，先保存到手機 SQLite outbox，再透過 USB/ADB loopback 送出核准意圖；桌面驗證成功後直接計入唯一活動資金帳戶。分類使用可捲動下拉選單，依本機保存次數與最近使用時間排序；自訂分類成功保存一次後會自動成為後續選項。

## 產品邊界

- 手機 outbox 是離線待送資料，不是 `transactions + postings` 正式帳本。
- 每筆記錄包含 device ID、local sequence、idempotency key、canonical payload 與 SHA-256 hash。
- 每筆同步都要取得相同 event ID／payload hash、`matched` 狀態、`paired_mobile` 核准來源與正式 transaction ID 才標記成功。
- 新記錄使用 schema v3，分類會納入 canonical payload/hash 並直接入帳；描述可留空，桌面會以分類作正式交易描述 fallback。升級前已存在的 v2 row 仍依原 direct-finalize contract 重送，v1 row 仍只會安全送進桌面待處理區。
- 桌面端只保存裝置 token 的 SHA-256 hash；手機 token 只放在 Expo SecureStore／Android Keystore。
- USB 版只允許 `127.0.0.1`／`localhost` cleartext；其他 HTTP destination 維持封鎖。
- 桌面端負責唯一活動資金解析、正式入帳、沖銷、投資、月結、備份與裝置管理；手機不直接接觸 SQLite。
- Android 版本使用 app sandbox 內的 SQLite；SQLCipher 需改用自訂 dev client，尚未啟用。

## Expo 開發

```powershell
cd C:\GPT_MCPtool\personal-asset-os\mobile
npm install
npm run android:lan
```

在 Android 安裝 Expo Go，並讓手機與電腦使用同一個網路；原生 SecureStore 與 USB network policy 的驗收應使用 standalone APK。

## USB 配對與同步

先啟動 loopback server，並把手機的 `127.0.0.1:18876` 經 ADB reverse 對應到電腦：

```powershell
cd C:\GPT_MCPtool\personal-asset-os
uv run --frozen personal-asset-os serve --host 127.0.0.1 --port 18876

C:\work\bin\adb.cmd reverse tcp:18876 tcp:18876
C:\work\bin\adb.cmd reverse --list
```

正式本機環境建議讓 PAOS server 自動維護 mapping。先接上唯一且已授權的手機，再執行：

```powershell
cd C:\GPT_MCPtool\personal-asset-os
.\.venv\Scripts\python.exe scripts\configure-mobile-usb-bridge.py `
  --adb-path C:\work\mobile-dev\android-sdk\platform-tools\adb.exe `
  --server-socket tcp:localhost:15037
```

重啟 PAOS 後，server 會在手機重新接線或 ADB daemon 重建後自動恢復固定 mapping。手機頁面會
分開顯示配對狀態與真實連線狀態；同步前的 session preflight 不會建立事件或正式交易。

另開 PowerShell 產生 10 分鐘有效、只能用一次的配對碼：

```powershell
cd C:\GPT_MCPtool\personal-asset-os
uv run --frozen personal-asset-os mobile-pair
```

先在桌面「帳戶」建立唯一活動資金帳戶，再於 App 的「我的手機」輸入配對碼。配對後，保存記錄會立即嘗試同步；App 回到前景或在前景時接上 USB，也會每 10 秒檢查尚未送出的 pending 記錄。已明確失敗的記錄不會被計時器反覆撞擊，仍可到「待同步」按「立即同步到桌面」手動重送。桌面端會在同一 transaction 內建立 `source=mobile_sync` Financial Event 與正式平衡交易；設定未就緒時手機會保留原資料供重試。

列出或撤銷裝置：

```powershell
uv run --frozen personal-asset-os mobile-devices
uv run --frozen personal-asset-os mobile-revoke <device-id>
```

撤銷後，下一次手機請求會收到 401 並清除本機失效 token，必須用新的配對碼重新配對。現有 Secure MCP Tunnel 只服務 read-only `/mcp`，不承載這些 mobile write routes。

## 本機 standalone APK

首次先產生原生 Android 工程；本機 `C:\work\bin\mobile-dev-env.cmd` 已提供 Android SDK、Java 17 與 alternate ADB server 設定：

```powershell
cd C:\GPT_MCPtool\personal-asset-os\mobile
npx expo prebuild --platform android

$env:ANDROID_HOME = 'C:\work\mobile-dev\android-sdk'
$env:ANDROID_SDK_ROOT = 'C:\work\mobile-dev\android-sdk'
$env:JAVA_HOME = 'C:\work\mobile-dev\jdk-17'
$env:NODE_ENV = 'production'
cd android
.\gradlew.bat app:assembleRelease -PreactNativeArchitectures=arm64-v8a
```

內部測試 APK 位於 `android\app\build\outputs\apk\release\app-release.apk`。目前 release variant 仍使用 debug key，只能本機試用，不能發布至 Google Play：

```powershell
C:\work\bin\adb.cmd install -r .\app\build\outputs\apk\release\app-release.apk
```

## 驗證

```powershell
npm test
npm run lint
npm run typecheck
npm run export:android
```

實機 smoke 必須確認：

1. 建立支出與收入記錄。
2. 成功頁顯示「已安全保存」。
3. 待同步頁顯示真實 SQLite 記錄。
4. Reload App 後記錄仍存在。
5. 未配對時同步按鈕引導到配對，不會顯示不存在的成功。
6. 配對後經 USB 同步，桌面活動資金餘額正確增減，手機顯示「已同步」。
7. 未建立或有多個活動資金候選時不入帳，手機保留可重試資料。
8. 重送同一 event 不新增第二筆交易；撤銷裝置後舊 token 失效。
