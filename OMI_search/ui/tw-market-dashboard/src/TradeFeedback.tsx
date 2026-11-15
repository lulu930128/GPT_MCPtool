import { useState, type ReactNode } from "react";

export function TradeDetails({ value, children, label = "開發診斷" }: { value?: unknown; children?: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  return <details className="workspace-order-details" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{label}</summary>{open && <>{children}{value !== undefined && <pre>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>}</>}
  </details>;
}

export function TradeError({ error, message = "操作未完成，資料已保留。請重新讀取後核對。" }: { error: string; message?: string }) {
  if (!error) return null;
  const friendly = /409|REVISION|版本/.test(error) ? "資料版本已變更，請重新讀取後核對。"
    : /403|Method not found|Unknown tool|尚未接線/.test(error) ? "目前 MCP 介面無法使用這個操作，請更新元件或確認連線。"
    : /timeout|timed out|逾時|超時/i.test(error) ? "等待回應逾時，結果尚未確認。請讀回原項目，不要重複操作。" : message;
  return <div className="workspace-operation-error"><p role="alert">{friendly}</p><TradeDetails value={error} label="查看錯誤詳情"/></div>;
}
