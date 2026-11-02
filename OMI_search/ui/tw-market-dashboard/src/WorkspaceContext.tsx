import { useEffect, useRef, useState } from "react";
import { CandidatePanel } from "./CandidatePanel";
import type { CandidateBridge } from "./candidate-state";
import type { UnknownRecord } from "./state";
import { deskCall, deskError, definitiveRejection, intentStage, readStaged, stageRecord } from "./desk-contract";
import { BrokerReadback, DeskOrders, DeskStatus } from "./DeskOrders";

const conditions = [["CASH", "現股"], ["CASH_SELLING", "現先賣"], ["MARGIN", "融資"], ["SHORT_SELLING", "融券"]] as const;
type Condition = typeof conditions[number][0];

export function orderQuantityShares(lot: string, input: string): number | null {
  if (!/^[1-9]\d*$/.test(input) || !["Common", "Odd"].includes(lot)) return null;
  const shares = Number(input) * (lot === "Common" ? 1000 : 1);
  return Number.isSafeInteger(shares) ? shares : null;
}

// A local manual_stage is persisted by Backend; Native submission belongs to DeskOrders.
export function ManualOrderForm({ symbol, bridge, onStaged }: { symbol?: string; bridge?: CandidateBridge; onStaged?: () => void }) {
  const [ticketSymbol, setTicketSymbol] = useState(symbol ?? "");
  const [dirty, setDirty] = useState(false);
  const [condition, setCondition] = useState<Condition>("CASH");
  const [action, setAction] = useState("Buy");
  const [lot, setLot] = useState("Common");
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unitNotice, setUnitNotice] = useState("");
  const [staging, setStaging] = useState(false), [uncertain, setUncertain] = useState(false), [staged, setStaged] = useState(false), [stageNotice, setStageNotice] = useState("");
  const intent = useRef<UnknownRecord | null>(null), inFlight = useRef(false);
  const markDirty = () => { setDirty(true); setStaged(false); };
  useEffect(() => { if (!dirty) setTicketSymbol(symbol ?? ""); }, [symbol, dirty]);
  const commonOnly = condition !== "CASH";
  const quantityShares = orderQuantityShares(lot, quantity);
  const quantityLabel = quantityShares === null ? "數量未完成" : lot === "Common"
    ? `${Number(quantity).toLocaleString("zh-TW")} 張 / ${quantityShares.toLocaleString("zh-TW")} 股`
    : `${quantityShares.toLocaleString("zh-TW")} 股`;
  const chooseLot = (next: string) => {
    if (next !== lot) { setQuantity(""); setUnitNotice("交易單位已切換，請重新輸入數量。"); }
    setLot(next); markDirty();
  };
  const chooseCondition = (next: Condition) => {
    markDirty(); setCondition(next);
    setAction(next === "CASH_SELLING" || next === "SHORT_SELLING" ? "Sell" : "Buy");
    if (next !== "CASH") chooseLot("Common");
  };
  const readIntent = async () => {
    if (!bridge || !intent.current) return false;
    const original = intent.current;
    const row = intentStage(await readStaged(bridge), original);
    if (!row) return false;
    setUncertain(false); setStaged(true); setStageNotice(`已按原 client_intent_id 讀回本地待送單；狀態 ${String(row.lifecycle)}。`); intent.current = null; onStaged?.(); return true;
  };
  const add = async () => {
    if (!bridge || inFlight.current || uncertain || staged) return;
    if (!ticketSymbol.trim() || quantityShares === null || !/^\d+(?:\.\d+)?$/.test(price) || Number(price) <= 0 || !Number.isFinite(Number(price))) { setStageNotice("請填寫標的、正數限價與可換算的數量。"); return; }
    inFlight.current = true; setStaging(true); setStageNotice("");
    intent.current ??= { client_intent_id: crypto.randomUUID(), symbol: ticketSymbol.trim(), action, condition, lot, quantity_shares: quantityShares, price };
    try {
      const result = stageRecord(await deskCall(bridge, "omi_create_desk_draft", intent.current), intent.current);
      intent.current = null; setStaged(true); setStageNotice(`已加入本地待送單；狀態 ${String(result.lifecycle)}，尚未送單。`); onStaged?.();
    } catch (err) {
      if (definitiveRejection(err)) { intent.current = null; setStageNotice(deskError(err)); }
      else {
        setUncertain(true); setStageNotice(`UNKNOWN · client_intent_id=${intent.current?.client_intent_id} · ${deskError(err)}；只讀回原意圖，不重送。`);
        try { await readIntent(); } catch (readError) { setStageNotice(previous => `${previous}\n讀回：${deskError(readError)}`); }
      }
    } finally { inFlight.current = false; setStaging(false); }
  };
  return <form className="workspace-order-form" aria-label="一般委託表單" onSubmit={(event) => { event.preventDefault(); void add(); }}>
    <p className="workspace-ticket-note">加入掛單會先儲存在本地；到掛單頁確認送單後，才會送交券商。</p>
    {stageNotice && <p role="status" className="workspace-ticket-retained">{uncertain ? "結果待確認，請讀回原掛單，不會自動重送。" : staged ? "已加入本地掛單，尚未送出。" : "無法加入掛單，請檢查股票、正數限價與數量，並查看詳細資訊。"}</p>}
    <details className="workspace-order-details"><summary>詳細資訊與技術紀錄</summary><p>USER_SPACE / MANUAL / MCP</p>{stageNotice && <pre>{stageNotice}</pre>}</details>
    {uncertain && <button type="button" onClick={() => void readIntent().catch(err => setStageNotice(deskError(err)))}>讀回原意圖（不重送）</button>}
    <fieldset className="workspace-order-inputs" disabled={staging || uncertain}>
    {ticketSymbol !== (symbol ?? "") && <div className="workspace-ticket-retained" role="status">表單保留 {ticketSymbol || "未填標的"}；工作台 {symbol || "未選股"}。<button type="button" onClick={() => { setTicketSymbol(symbol ?? ""); setPrice(""); markDirty(); }}>使用目前選股並清空價格</button></div>}
    <label>股票代碼<input aria-label="委託股票代碼" value={ticketSymbol} maxLength={20} onChange={(event) => { setTicketSymbol(event.target.value); setPrice(""); markDirty(); }} placeholder="請選股或輸入代碼"/></label>
    <fieldset><legend>交易類別</legend><div className="workspace-order-modes">{conditions.map(([key, name]) => <button type="button" key={key} data-condition={key} aria-pressed={condition === key} onClick={() => chooseCondition(key)}>{name}</button>)}</div></fieldset>
    <fieldset><legend>買賣方向</legend><div className="workspace-order-pair">{[["Buy", "買進"], ["Sell", "賣出"]].map(([key, name]) => <button type="button" key={key} data-side={key} aria-pressed={action === key} disabled={(condition === "MARGIN" && key === "Sell") || ((condition === "CASH_SELLING" || condition === "SHORT_SELLING") && key === "Buy")} onClick={() => { setAction(key); markDirty(); }}>{name}</button>)}</div></fieldset>
    <fieldset><legend>交易單位</legend><div className="workspace-order-pair">{[["Common", "整股"], ["Odd", "零股"]].map(([key, name]) => <button type="button" key={key} data-lot={key} aria-pressed={lot === key} disabled={commonOnly && key === "Odd"} onClick={() => chooseLot(key)}>{name}</button>)}</div>{commonOnly && <small>此交易類別僅提供整股；實際資格尚未接線。</small>}</fieldset>
    <div className="workspace-order-fields"><label>委託價格<input aria-label="委託價格" type="number" min="0" step="any" inputMode="decimal" value={price} placeholder="手動輸入" onChange={(event) => { setPrice(event.target.value); markDirty(); }}/></label><label>數量（{lot === "Common" ? "張" : "股"}）<input aria-label="委託數量" aria-describedby="workspace-quantity-unit" type="number" min="1" step="1" inputMode="numeric" value={quantity} placeholder={lot === "Common" ? "張數" : "股數"} onChange={(event) => { setQuantity(event.target.value); setUnitNotice(""); markDirty(); }}/></label></div>
    <p id="workspace-quantity-unit" aria-live="polite">{unitNotice || (lot === "Common" ? "整股 1 張 = 1,000 股" : "零股以股數輸入")}{quantity && <span> · {quantityShares === null ? "請輸入可安全換算的正整數" : quantityLabel}</span>}</p>
    <div className="workspace-price-shortcuts" role="group" aria-label="價位快捷">{["跌停", "平盤", "漲停", "市價"].map((name) => <button type="button" key={name} disabled title="尚未接線：沒有可驗證的券商價格或市價委託契約">{name}</button>)}</div>
    <p className="workspace-ticket-note">尚無可驗證的即時報價與價格上下限；圖表收盤價不填入委託。以上僅編輯表單，不會送單。</p>
    <div className="workspace-order-review"><span>{ticketSymbol || "未填標的"} · {conditions.find(([key]) => key === condition)?.[1]} · {action === "Buy" ? "買進" : "賣出"}</span><span>{lot === "Common" ? "整股" : "零股"} · {quantityLabel} · {price || "—"}</span></div>
    </fieldset>
    <button type="submit" className="workspace-order-submit" disabled={!bridge || staging || uncertain || staged}>{staging ? "建立待送中…" : staged ? "已加入掛單" : uncertain ? "待確認 · 請讀回" : "加入掛單"}</button>
  </form>;
}

export function WorkspaceContext({ symbol, bridge }: { symbol?: string; bridge?: CandidateBridge }) {
  const [page, setPage] = useState("trade");
  const [mode, setMode] = useState("manual");
  const [space, setSpace] = useState("USER_SPACE");
  const [candidateId, setCandidateId] = useState<string | undefined>(), [refreshKey, setRefreshKey] = useState(0);
  return <aside id="workspace-trade-area" className="workspace-context" aria-label="交易工作台">
    <header className="workspace-trade-heading"><div><h2>交易工作台</h2><span>{symbol || "尚未選股"}</span></div><small>新單加入我的交易；送出結果以券商回報為準。</small></header>
    {bridge && <DeskStatus bridge={bridge}/>}
    <div className="workspace-space"><div className="workspace-order-pair" role="group" aria-label="工作環境">{[["USER_SPACE", "我的交易"], ["AGENT_SPACE", "AI 候選"]].map(([value, label]) => <button type="button" key={value} aria-pressed={space === value} onClick={() => setSpace(value)}>{label}</button>)}</div><small>AI 候選供檢視與管理；切換不改變新單歸屬。</small></div>
    <div className="workspace-trade-tabs" role="group" aria-label="交易頁面">{[["trade", "交易"], ["orders", "掛單"], ["fills", "成交"], ["inventory", "庫存"]].map(([key, name]) => <button type="button" key={key} aria-pressed={page === key} aria-controls={`workspace-broker-${key}`} onClick={() => setPage(key)}>{name}</button>)}</div>
    <div id="workspace-broker-trade" hidden={page !== "trade"}>
      <div className="workspace-trade-mode" role="group" aria-label="委託模式"><button type="button" aria-pressed={mode === "manual"} aria-controls="workspace-manual-content" onClick={() => setMode("manual")}>一般</button><button type="button" aria-pressed={mode === "conditional"} aria-controls="workspace-candidate-content" onClick={() => setMode("conditional")}>條件交易</button></div>
      <div id="workspace-manual-content" hidden={mode !== "manual"}><ManualOrderForm symbol={symbol} bridge={bridge} onStaged={() => { setRefreshKey(previous => previous + 1); setPage("orders"); }}/></div>
      <div id="workspace-candidate-content" hidden={mode !== "conditional"}>
        <p className="workspace-candidate-boundary">研究候選管理 · 保存不會送出券商委託；研究 Pending 不是券商掛單。</p>
        {/* Keep one mounted session across tabs, modes and responsive layouts. */}
        {bridge && <CandidatePanel bridge={bridge} symbol={symbol} space={space} active={page === "trade" && mode === "conditional"} onShowPending={id => { setCandidateId(id); setPage("orders"); }}/>}
      </div>
    </div>
    <div id="workspace-broker-orders" hidden={page !== "orders"}>{bridge ? <DeskOrders bridge={bridge} active={page === "orders"} candidateId={candidateId} refreshKey={refreshKey}/> : <p>掛單 API 尚未接線</p>}</div>
    <div id="workspace-broker-fills" hidden={page !== "fills"}>{bridge && <BrokerReadback bridge={bridge} active={page === "fills"} kind="fills"/>}</div>
    <div id="workspace-broker-inventory" hidden={page !== "inventory"}>{bridge && <BrokerReadback bridge={bridge} active={page === "inventory"} kind="inventory"/>}</div>
  </aside>;
}
