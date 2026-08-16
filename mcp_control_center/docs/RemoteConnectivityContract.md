# Remote Connectivity Contract

`component-connectivity-v1` 是 MCP Control Center 對 local runtime、remote tunnel registration
與 ChatGPT connector 證據的 additive 狀態契約。它不改變 `unified-lifecycle-v3` ownership，
也不授權 manager 讀取 tunnel identity、credential、workspace scope 或 MCP payload。

## Evidence layers

每個 component state 保留相容的 `status`，並新增：

```json
{
  "localStatus": "Ready",
  "readinessScope": "local",
  "connectivity": {
    "contractVersion": "component-connectivity-v1",
    "localTunnel": {
      "scope": "local_tunnel",
      "status": "Ready",
      "checkedAt": "2026-08-14T12:00:00Z",
      "errorCode": null,
      "source": "loopback_probe"
    },
    "remoteRegistration": {
      "scope": "remote_registration",
      "status": "NotChecked",
      "observedStatus": "NotChecked",
      "checkedAt": null,
      "validUntil": null,
      "errorCode": null,
      "source": "none"
    },
    "chatgptConnector": {
      "scope": "chatgpt_connector",
      "status": "NotChecked",
      "observedStatus": "NotChecked",
      "checkedAt": null,
      "validUntil": null,
      "errorCode": null,
      "source": "none"
    }
  }
}
```

- `localStatus`：只由 component root、fixed action、loopback probes 與 ownership 決定。
- `localTunnel`：只代表 component-owned local tunnel daemon／admin readiness。
- `remoteRegistration`：代表 component-owned bounded diagnostic 對 remote tunnel metadata、
  authorization 與 association 的證據；不代表 ChatGPT 已成功 initialize MCP。
- `chatgptConnector`：只可由明確的 host-side／ChatGPT E2E 驗證產生；remote metadata lookup
  不能把它設為 `Ready`。

## Status and TTL

Remote evidence status 只允許：

- `Ready`
- `Failed`
- `Unknown`
- `NotChecked`
- `Stale`

`Ready`、`Failed`、`Unknown` evidence 必須包含有效的 UTC `checkedAt` 與 `validUntil`。
超過 `validUntil` 後，Control Center 投影為 `Stale`，並保留原始 `observedStatus`；不得讓
過期成功或失敗永久控制目前狀態。缺欄、非法狀態、非法 timestamp 或不安全 errorCode
投影為 `Unknown`／`REMOTE_EVIDENCE_INVALID`。

`readinessScope` 表示目前最高已驗證範圍：

- `none`：local runtime 未證實。
- `core`：core 可用，但 local tunnel 未 Ready。
- `local`：core 與 local tunnel 已 Ready；remote 尚未證實。
- `remote_registration`：remote registration evidence 在 TTL 內為 Ready。
- `end_to_end`：明確 ChatGPT connector E2E evidence 在 TTL 內為 Ready。

## Top-level compatibility

- 現有 `status` 欄位保留，避免破壞 tray、state reader 與既有 automation。
- 沒有 remote evidence、`Unknown`、`NotChecked` 或 `Stale` 不會自行觸發 lifecycle mutation。
- 當 local `Ready` 且 TTL 內的 `remoteRegistration` 或 `chatgptConnector` 明確為 `Failed`，
  top-level `status` 投影為 `Degraded`；`localStatus` 仍保留 `Ready`，讓 consumer 看出故障層級。
- `OwnershipMismatch`、`Unhealthy`、`Stopped`、`Misconfigured`、`NotInstalled` 等 local failure
  優先於 remote evidence，不得被 remote Ready 遮蔽。

## Producer boundary

- Control Center `Status` 只做既有 loopback probe，不解密 credential、不查 external control plane。
- Remote evidence 必須由 component-owned bounded action 產生，使用 fixed executable／profile、
  bounded timeout、bounded output 與 component 自己的 credential handling。
- Manager 只接收 allowlisted status、UTC timestamps、safe errorCode 與固定 source label。
- 不接受 raw remote response、tunnel ID、organization／workspace ID、account metadata、URL、token、
  credential path、log excerpt 或任意 message。
- Component 可在 descriptor 的 `connectivityEvidence.remoteEvidencePath` 宣告一個 component-relative
  `.json` 交換檔。路徑解析後必須仍在 component root 內；Control Center 不接受絕對路徑或逃逸路徑。
- Producer 應以原子替換寫入交換檔。Control Center 每次 Status 最多讀取 8192 bytes，並只接受
  `component-connectivity-v1`、`remoteRegistration`／`chatgptConnector` 與各 scope 的
  `status`、`checkedAt`、`validUntil`、`errorCode`、`source` 欄位。
- 額外欄位、無效 JSON、錯誤 contract 或超大檔案都 fail closed 為 `Unknown`／
  `REMOTE_EVIDENCE_INVALID`；不會把原始內容複製到 state 或 log。過期的合法證據投影為 `Stale`。

## Repair boundary

- 只有 local connectivity transient failure 可成為 automatic `repair_connectivity` 候選。
- `RemoteRegistration Failed`、`ChatGPTConnector Failed`、`Unknown`、`NotChecked`、`Stale`、
  configuration failure 與 ownership failure 一律不因本契約自動 restart core／tunnel。
- Remote failure 的 repair／setup 必須是 component-owned explicit action，並在需要外部 credential
  或 metadata mutation 時要求使用者確認。
