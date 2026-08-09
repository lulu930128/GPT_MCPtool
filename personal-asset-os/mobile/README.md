# Personal Asset OS Mobile

Android-first、offline-first 的 Personal Asset OS 快速記錄 App。v0.1 把 TWD 支出／收入保存到手機 SQLite outbox，並可透過 USB/ADB loopback 手動同步到桌面的 Financial Event 待審核區；不會直接寫入正式帳本。

## 產品邊界

- 手機 outbox 是 staging，不是 `transactions + postings` 正式帳本。
- 每筆記錄包含 device ID、local sequence、idempotency key、canonical payload 與 SHA-256 hash。
- 每筆同步都要取得相同 event ID、payload hash 與 `ingest_only` 確認才標記成功。
- 桌面端只保存裝置 token 的 SHA-256 hash；手機 token 只放在 Expo SecureStore／Android Keystore。
- USB 版只允許 `127.0.0.1`／`localhost` cleartext；其他 HTTP destination 維持封鎖。
- 正式入帳、沖銷、投資、月結、備份與裝置管理仍由桌面端負責。
- Android 版本使用 app sandbox 內的 SQLite；SQLCipher 需改用自訂 dev client，尚未啟用。

## Expo 開發

```powershell
cd C:\GPT_MCPtool\personal-asset-os\mobile
npm install
npm run android:lan
```

在 Android 安裝 Expo Go，並讓手機與電腦使用同一個網路；原生 SecureStore 與 USB network policy 的驗收應使用 standalone APK。

## USB 配對與同步

先啟動 loopback server，並把手機的 `127.0.0.1:8876` 經 ADB reverse 對應到電腦：

```powershell
cd C:\GPT_MCPtool\personal-asset-os
uv run --frozen personal-asset-os serve --host 127.0.0.1 --port 8876

C:\work\bin\adb.cmd reverse tcp:8876 tcp:8876
C:\work\bin\adb.cmd reverse --list
```

另開 PowerShell 產生 10 分鐘有效、只能用一次的配對碼：

```powershell
cd C:\GPT_MCPtool\personal-asset-os
uv run --frozen personal-asset-os mobile-pair
```

在 App 的「我的手機」輸入配對碼。配對後，到「待同步」按「立即同步到桌面」。桌面端只會建立 `source=mobile_sync` 的 pending Financial Event。

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
6. 配對後經 USB 同步，桌面 Pending Inbox 出現同一 event，手機顯示「已同步」。
7. 重送同一 event 不新增第二筆；撤銷裝置後舊 token 失效。
