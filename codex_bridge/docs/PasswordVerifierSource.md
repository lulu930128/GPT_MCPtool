# 本機密碼驗證核心：歷史 Source 證據與現行實作目標

> **2026-10-15 現行指示：解除 Source-only 施工限制。** 可修改 `password.ts` 及正式 enrollment、受保護 Host、持久化 Secret Store、單筆驗證、IPC／Runner 所需的全部相關程式碼；允許使用唯讀 PowerShell 檢查與正常工程編譯，不再因「本輪只做離線 verifier」而停工。正式 PowerShell 寫入／管理員驗收只能由使用者明確發起、逐筆確認並通過所需 OS 授權。仍禁止讀取 `.env`／其他 Secrets，也不可將模型可見的同意替代受保護本機驗證。詳見 [現行工程決策](RemotePowerShellApprovalPlan.md)。

唯一既有 credential verification module 是 `src/powershell-approval/password.ts`。
**2026-10-14 歷史 Runtime：** Production 尚未啟用，當時回 `TRUSTED_HOST_PROVIDER_REQUIRED`。這是既有實作缺口，不是後續禁止接線的規則；正式 Source 完成前不得僅以修改旗標假稱已完成。

- `createPasswordVerifierRecord(Buffer)` 只建立記憶體內的離線 record，不執行實機
  enrollment。v1 固定 `scrypt(N=16384, r=8, p=1, maxmem=33554432)`、32-byte 隨機
  salt、32-byte hash；兩者皆使用恰好 64 字元的小寫 hex。schema 不接受額外欄位、
  accessor、Proxy、繼承欄位、未知版本、可變 KDF 參數或非 canonical encoding。
- 密碼必須是合法 UTF-8，至少 16 個 Unicode scalar values、最多 256 bytes。
  不 trim、不 normalize、不產生明文 JS string。函式取得 Buffer 所有權，呼叫端
  不得再使用它；原輸入在首次 await 前清零，內部副本與 KDF 暫存於 finally 清零。
  SharedArrayBuffer 被拒絕。這不保證清除呼叫端既存副本、JS immutable record hex
  字串、native crypto 內部記憶體或 OS paging；record hash 不得輸出到 log／MCP。
- `isPasswordVerifierRecord` 僅檢查 schema，**不證明來源可信**。
  `offlinePasswordVerifierFromRecord` 僅接受本模組當次建立的原始 frozen object，
  且僅能綁定一次。JSON、checkout、環境變數、MCP payload、複製物件、
  caller 自報的 `protected=true` 或 provider 都無法啟用驗證能力。
  WeakMap 僅標記離線物件來源與是否已綁定，不是 OS 保護證明或第二份 credential DB。
- 每個 verifier 連續 3 次失敗鎖定 30 秒；格式錯誤計入失敗。鎖定中不計算 KDF、
  不延長期限；期限到達後重新允許嘗試，成功會清除連續失敗數。
  同時只接受一個 KDF，其餘呼叫立即拒絕並清除輸入，不排隊保存密碼。
- 每次嘗試及 KDF 完成時檢查時間；回撥、非整數、溢位或 clock/KDF 例外會永久
  fail-closed。hash 以 Node `timingSafeEqual` 比對；時間使用固定 8-byte／8 次迴圈
  比較，不依第一個相異 byte 提前返回。JavaScript/JIT 不提供整段程式或時間比較的
  硬體 constant-time 保證；不把拒絕路徑或整個 API 宣稱為等時。
- 舊 `offlinePasswordVerifier(enrollment)` 的 async factory／callable boolean
  契約保留，並新增 `dispose()` 清除保留的 salt/hash Buffer。此核心只回傳密碼是否
  相符，不建立 approval、grant、journal、dispatch 或執行能力。

## 正式接線前置條件

目前沒有 trusted Host provider，也沒有 Production factory 或持久化 record 匯入入口。
可寫 checkout 中的程式不能自行認證自身為 protected Host。以下條件必須由既有受保護
Host 完成並獨立驗證，不能以這裡的測試、boolean flag 或 callback 自證取代：

1. Host 的 executable、dependency、載入來源及 operator identity 具有獨立 OS 保護證據；
   credential record 從 Host 所擁有的 OS protected storage 取得，對實際開啟物件核對
   owner／ACL／完整性，拒絕可寫 checkout、重解析導向或 caller 指定來源。
2. enrollment／rotation 只接受 Host 本機可信輸入與明確操作意圖；載入既有 record
   必須保留來源驗證與版本檢查，不能只將 JSON parse 的成功視為 enrollment authority。
   此 source 刻意不提供匯入這類 record 的捷徑。
3. Host 以既有 credential owner 原子管理並保存 attempts、lockout 與可信時間下限，
   防止重啟、多程序、重建 verifier 或 credential rotation 繞過限制；持久化失敗、
   state rollback、時間不可信均 fail-closed。本模組的離線記憶體限制不跨重啟保存。
4. 由 Host 持有密碼驗證呼叫與結果，維持既有單筆核准 owner；驗證成功不是核准權杖。
   2026-10-14 該輪工作未接線執行、Runner、IPC、Runtime 或服務生命週期；**2026-10-15 起允許後續工程實作這些接線**，但不能省略正式 OS 身分與逐筆核准，也不能將尚未部署冒充已部署。

## 最小驗證

於 `codex_bridge` 使用既有 TypeScript，只編譯 module 與 focused test 到新的 ignored
`.tmp/password-focused-<唯一識別>/`，不寫入 live `dist`：

```text
node node_modules/typescript/bin/tsc --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --esModuleInterop --forceConsistentCasingInFileNames --skipLibCheck --noEmitOnError --rootDir . --outDir .tmp/password-focused-<唯一識別> src/powershell-approval/password.ts tests/password.test.ts
node --test --test-isolation=none .tmp/password-focused-<唯一識別>/tests/password.test.js
```

測試不載入 broker／runtime、不啟動 child process、不做 OS storage 或 enrollment 操作，
也不執行 G0/G1 suite。任何 sandbox／權限拒絕都停止測試，不切換工具或權限重試。
