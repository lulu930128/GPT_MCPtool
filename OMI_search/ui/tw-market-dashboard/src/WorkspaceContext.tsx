import { useState, type ReactNode } from "react";
import { SyntheticOrderPanel } from "./SyntheticOrderPanel";

export function WorkspaceContext({ symbol, children }: { symbol?: string; children: ReactNode }) {
  const [tab, setTab] = useState<"research" | "order">("research");
  return <aside className="workspace-context">
    <details className="workspace-context-disclosure" open>
      <summary>研究／手動委託（SYNTHETIC）· 可收合</summary>
      <div className="workspace-context-tabs" role="group" aria-label="右欄分頁">
        <button type="button" aria-pressed={tab === "research"} aria-controls="workspace-research-content" onClick={() => setTab("research")}>研究</button>
        <button type="button" aria-pressed={tab === "order"} aria-controls="workspace-order-content" onClick={() => setTab("order")}>委託 · SYNTHETIC</button>
      </div>
      <div id="workspace-research-content" hidden={tab !== "research"}>{children}</div>
      <div id="workspace-order-content" hidden={tab !== "order"}>
        <SyntheticOrderPanel key={symbol ?? ""} symbol={symbol}/>
      </div>
    </details>
  </aside>;
}
