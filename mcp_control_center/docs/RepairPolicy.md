# Bounded Repair Policy

Control Center 的 automatic repair 只處理已驗證為 local transient connectivity failure 的
`Degraded` component。這個 policy 不擴張 manager ownership，也不把 remote、configuration
或 core failure 偽裝成 tunnel restart 問題。

## Decision contract

只有同時符合以下條件，Reconcile 才會規劃 `RepairConnectivity`：

- component 為 auto-start，且宣告 `repair_connectivity` capability；
- top-level `status=Degraded` 且 `localStatus=Degraded`；
- required core probes 全部成功；
- `connectivity.localTunnel.status=Failed`，errorCode 為 `HTTP_ERROR`、`TIMEOUT`、
  `EXPECTED_MISMATCH` 或 `TUNNEL_NOT_READY`；
- 沒有 `MONITOR_EXCEPTION`、ownership、active-work、credential、profile、tunnel identity
  或 configuration issue；
- 若失敗的 tunnel port 仍開啟，listener ownership 必須明確且符合 descriptor；
- remote registration 與 ChatGPT connector 沒有新鮮的 explicit `Failed` evidence。

其他狀態一律 `ManualAttention`。主要分類如下：

| Failure layer | Decision | Mutation |
| --- | --- | --- |
| Local transient tunnel, core healthy, ownership safe | `RepairConnectivity` | component-owned tunnel only |
| Remote registration／ChatGPT connector | `ManualAttention` | none |
| Tunnel ID／profile／credential／configuration | `ManualAttention` | none |
| Fixed port in Windows dynamic／excluded range | `ManualAttention` (`Misconfigured`) | none |
| Ownership unknown／mismatch | `ManualAttention` | none |
| Active work／pending approval | `ManualAttention` | none |
| Core unhealthy／monitor evidence incomplete | `ManualAttention` | none |

## Retry and timeout ownership

- Manager 每次 Reconcile 最多委派一次 `repair_connectivity`；`managerAttemptLimit=1`。
- Retry/backoff 由 component controller 擁有，controller 必須自行限制 attempt count 與每次等待。
- Manager 仍以 registry／descriptor 的 `controllerActionTimeoutSeconds` 強制總 action 上限；目前
  production 預設為 180 秒。
- Manager 不在 controller 外層再次重試，避免兩層 retry 相乘。
- Repair 後必須重新通過 component running acceptance state；失敗會產生 bounded failure row，
  但不阻止後續 component reconciliation。

## Evidence and audit

Reconcile plan 會輸出 `classification`、`reasonCode`、`managerAttemptLimit`、`retryOwner` 與
`controllerTimeoutSeconds`。成功事件只記錄 decision、before／after、attempt bound 與 retry owner；
不記 raw health response、remote metadata、tunnel identity 或 credential。ManualAttention 只呈現
安全 reason code，且不觸發 restart core 或 full reload。
