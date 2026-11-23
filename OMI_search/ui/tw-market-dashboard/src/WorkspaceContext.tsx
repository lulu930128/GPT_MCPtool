import { useEffect, useRef, useState } from "react";
import { StockName } from "./StockName";
import { ProtectionFields } from "./OrderProtection";
import { ResearchPanel } from "./ResearchPanel";
import { CandidatePanel } from "./CandidatePanel";
import type { CandidateBridge } from "./candidate-state";
import type { UnknownRecord } from "./state";
import { deskCall, deskError, definitiveRejection, intentStage, readStaged, stageRecord } from "./desk-contract";
import { BrokerReadback, DeskOrders, DeskStatus, orderStatus } from "./DeskOrders";

const conditions = [["CASH", "現股"], ["CASH_SELLING", "現先賣"], ["MARGIN", "融資"], ["SHORT_SELLING", "融券"]] as const;
type Condition = typeof conditions[number][0];
export type StagedNavigation = { stageId: string; origin: "manual" | "research" | "candidate"; lifecycle?: string };

export function orderQuantityShares(lot: string, input: string): number | null {
  if (!/^[1-9]\d*$/.test(input) || !["Common", "Odd", "Shares"].includes(lot)) return null;
  const shares = Number(input) * (lot === "Common" ? 1000 : 1);
  return Number.isSafeInteger(shares) ? shares : null;
}

// A local manual_stage is persisted by Backend; Native submission belongs to DeskOrders.
export function ManualOrderForm({ symbol, bridge, onStaged }: { symbol?: string; bridge?: CandidateBridge; onStaged?: (target: StagedNavigation) => void }) {
  const [market, setMarket] = useState("TW");
  const [settlement, setSettlement] = useState("MUT");
  const [protection, setProtection] = useState<UnknownRecord>({ enabled: false, stop_loss: null, take_profit: null, exit_limit_price: "", direction: 1, targets: [], stop_limit_price: null, protection_mode: "LOCAL_SYNTHETIC" });
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
  const markDirty = () => { setDirty(true); setStaged(false); setStageNotice(""); };
  useEffect(() => { if (!dirty) setTicketSymbol(symbol ?? ""); }, [symbol, dirty]);
  const commonOnly = condition !== "CASH";
  const creditClose = (condition === "MARGIN" && action === "Sell") || (condition === "SHORT_SELLING" && action === "Buy");
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
  const accepted = (row: UnknownRecord) => {
    const local = row.lifecycle === "STAGED";
    intent.current = null; setUncertain(false); setStaged(local); setQuantity("");
    setStageNotice(local ? "已加入待送單，尚未送交券商。" : `已讀回原委託：${orderStatus(row.lifecycle, true)}。`);
    onStaged?.({ stageId: String(row.id), origin: "manual", lifecycle: String(row.lifecycle) });
  };
  const readIntent = async () => {
    if (!bridge || !intent.current) return false;
    const original = intent.current;
    const row = intentStage(await readStaged(bridge), original);
    if (!row) return false;
    accepted(row); return true;
  };
  const add = async () => {
    if (!bridge || inFlight.current || uncertain) return;
    if (!ticketSymbol.trim() || quantityShares === null || !/^\d+(?:\.\d+)?$/.test(price) || Number(price) <= 0 || !Number.isFinite(Number(price))) { setStageNotice("請填寫標的、正數限價與可換算的數量。"); return; }
    inFlight.current = true; setStaging(true); setStageNotice("");
    try {
      intent.current ??= { client_intent_id: crypto.randomUUID(), symbol: ticketSymbol.trim(), action, condition, lot, quantity_shares: quantityShares, price, market, ...(market === "US" ? { settlement_mode: settlement } : {}), ...(!creditClose ? { protection: { ...protection, direction: action === "Buy" ? 1 : -1, exit_limit_price: protection.exit_limit_price || price } } : {}) };
      const result = stageRecord(await deskCall(bridge, "omi_create_desk_draft", intent.current), intent.current);
      accepted(result);
    } catch (err) {
      if (!intent.current || definitiveRejection(err)) { intent.current = null; setStageNotice(deskError(err)); }
      else {
        setUncertain(true); setStageNotice(`UNKNOWN · client_intent_id=${intent.current?.client_intent_id} · ${deskError(err)}；只讀回原意圖，不重送。`);
        try { await readIntent(); } catch (readError) { setStageNotice(previous => `${previous}\n讀回：${deskError(readError)}`); }
      }
    } finally { inFlight.current = false; setStaging(false); }
  };
  return <form className="workspace-order-form" aria-label="一般委託表單" onSubmit={(event) => { event.preventDefault(); void add(); }}>
    <p className="workspace-ticket-note">先儲存為待送單，核對並確認送出後才會送交券商。</p>
    {stageNotice && <p role="status" className="workspace-ticket-retained">{uncertain ? "結果待確認，請讀回原掛單，不會自動重送。" : staged || stageNotice.startsWith("已讀回原委託") ? stageNotice : "無法加入掛單，請檢查股票、正數限價與數量。"}</p>}
    {uncertain && <button type="button" onClick={() => void readIntent().catch(err => setStageNotice(deskError(err)))}>讀回原意圖（不重送）</button>}
    <fieldset className="workspace-order-inputs" disabled={staging || uncertain}>
    {ticketSymbol !== (symbol ?? "") && <div className="workspace-ticket-retained" role="status">表單保留 {ticketSymbol || "未填標的"}；工作台 {symbol || "未選股"}。<button type="button" onClick={() => { setTicketSymbol(symbol ?? ""); setPrice(""); markDirty(); }}>使用目前選股並清空價格</button></div>}
    <label>市場<select value={market} onChange={event => { const next = event.target.value; setMarket(next); setCondition("CASH"); chooseLot(next === "US" ? "Shares" : "Common"); setTicketSymbol(""); setPrice(""); }}><option value="TW">台股</option><option value="US">美股</option></select></label>
    {market === "US" && <label>交割方式<select value={settlement} onChange={e => { setSettlement(e.target.value); markDirty(); }}><option value="MUT">外幣交割</option><option value="TWD">台幣交割</option></select></label>}
    <label>股票代碼<input aria-label="委託股票代碼" value={ticketSymbol} maxLength={20} onChange={(event) => { setTicketSymbol(event.target.value); setPrice(""); markDirty(); }} placeholder="請選股或輸入代碼"/></label>
    <p className="workspace-ticket-identity">{ticketSymbol || "尚未填寫股票"}<StockName bridge={bridge} symbol={ticketSymbol.trim()} market={market}/></p>
    <fieldset><legend>交易類別</legend><div className="workspace-order-modes">{conditions.filter(([key]) => market === "TW" || key === "CASH").map(([key, name]) => <button type="button" key={key} data-condition={key} aria-pressed={condition === key} onClick={() => chooseCondition(key)}>{name}</button>)}</div></fieldset>
    <fieldset><legend>買賣方向</legend><div className="workspace-order-pair">{[["Buy", "買進"], ["Sell", "賣出"]].map(([key, name]) => <button type="button" key={key} className="workspace-order-side-toggle" data-side={key} aria-pressed={action === key} disabled={condition === "CASH_SELLING" && key === "Buy"} onClick={() => { setAction(key); markDirty(); }}>{name}</button>)}</div></fieldset>
    <fieldset><legend>交易單位</legend><div className="workspace-order-pair">{(market === "US" ? [["Shares", "股"]] : [["Common", "整股"], ["Odd", "零股"]]).map(([key, name]) => <button type="button" key={key} data-lot={key} aria-pressed={lot === key} disabled={commonOnly && key === "Odd"} onClick={() => chooseLot(key)}>{name}</button>)}</div>{commonOnly && <small>信用交易使用整股；資格由券商核對。</small>}</fieldset>
    <div className="workspace-order-fields"><label>委託價格<input aria-label="委託價格" type="number" min="0" step="any" inputMode="decimal" value={price} placeholder="手動輸入" onChange={(event) => { setPrice(event.target.value); markDirty(); }}/></label><label>數量（{lot === "Common" ? "張" : "股"}）<input aria-label="委託數量" aria-describedby="workspace-quantity-unit" type="number" min="1" step="1" inputMode="numeric" value={quantity} placeholder={lot === "Common" ? "張數" : "股數"} onChange={(event) => { setQuantity(event.target.value); setUnitNotice(""); markDirty(); }}/></label></div>
    <p id="workspace-quantity-unit" aria-live="polite">{unitNotice || (market === "US" ? "美股以股數輸入，限價為 USD" : lot === "Common" ? "整股 1 張 = 1,000 股" : "零股以股數輸入")}{quantity && <span> · {quantityShares === null ? "請輸入可安全換算的正整數" : quantityLabel}</span>}</p>
    {condition === "CASH_SELLING" && <p>現先賣僅能選擇賣出。</p>}
    {creditClose ? <p>此筆為{condition === "MARGIN" ? "資賣" : "券買"}，不建立反向新倉保護。可用信用部位與數量由券商確認。</p> : <details className="workspace-order-details"><summary>停損停利設定 · {protection.enabled === true ? "已啟用" : "未啟用"}</summary><ProtectionFields value={protection} onChange={value => { setProtection(value); markDirty(); }}/></details>}
    <p className="workspace-ticket-note">尚無可驗證的即時報價與價格上下限；圖表收盤價不填入委託。以上僅編輯表單，不會送單。</p>
    <div className="workspace-order-review workspace-order-tint" data-side={action}><span><strong className="workspace-order-direction">{action === "Buy" ? "買進" : "賣出"}</strong> · {ticketSymbol || "未填標的"} · {conditions.find(([key]) => key === condition)?.[1]}</span><span>{market === "US" ? "美股" : lot === "Common" ? "整股" : "零股"} · {quantityLabel} · 限價 {price || "—"} {market === "US" ? "USD" : "TWD"}</span></div>
    </fieldset>
    {!bridge && <p role="status">交易連線尚未提供，請重新開啟工作台。</p>}
    <button type="submit" className="workspace-order-submit" data-side={action} aria-busy={staging} aria-label={staging || uncertain ? undefined : `加入掛單 · ${action === "Buy" ? "買進" : "賣出"}`} disabled={!bridge || staging || uncertain}>{staging ? "建立待送中…" : uncertain ? "待確認 · 請讀回" : "加入掛單"}</button>
    <details className="workspace-order-details"><summary>詳細資訊與技術紀錄</summary><p>USER_SPACE / MANUAL / MCP</p>{stageNotice && <pre>{stageNotice}</pre>}</details>
  </form>;
}

export function WorkspaceContext({ symbol, bridge, active = true, onNavigateToStaged }: { symbol?: string; bridge?: CandidateBridge; active?: boolean; onNavigateToStaged?: (target: StagedNavigation) => void }) {
  const [page, setPage] = useState("trade");
  const [mode, setMode] = useState("manual");
  const [candidateId, setCandidateId] = useState<string | undefined>(), [refreshKey, setRefreshKey] = useState(0);
  const [stagedTarget, setStagedTarget] = useState<StagedNavigation>();
  const [brokerTarget, setBrokerTarget] = useState<{ id: string; market: string }>();
  const navigateBroker = (target: { id: string; market: string }) => { setBrokerTarget(target); setPage("orders"); onNavigateToStaged?.({ stageId: stagedTarget?.stageId ?? "", origin: "manual", lifecycle: "SUBMITTED" }); };
  const staged = (target: StagedNavigation) => { setCandidateId(undefined); setStagedTarget(target); setRefreshKey(value => value + 1); setPage(target.lifecycle && !["STAGED", "CANCELLED"].includes(target.lifecycle) ? "orders" : "staged"); onNavigateToStaged?.(target); };
  const continueAdding = () => { setPage("trade"); setMode("manual"); requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[aria-label="委託數量"]')?.focus()); };
  return <aside id="workspace-trade-area" className="workspace-context" aria-label="交易工作台">
    <header className="workspace-trade-heading"><div><h2>交易工作台</h2><span>{symbol || "尚未選股"}<StockName bridge={bridge} symbol={symbol ?? ""}/></span></div></header>
    {bridge && <DeskStatus bridge={bridge} active={active}/>}
    <nav className="workspace-trade-tabs" aria-label="交易頁面">{[["trade", "新增委託"], ["research", "研究預選"], ["staged", "待送單"], ["orders", "券商委託"], ["fills", "成交"], ["inventory", "庫存"]].map(([key, name]) => <button type="button" key={key} aria-pressed={page === key} aria-controls={`workspace-broker-${key === "staged" ? "orders" : key}`} onClick={() => setPage(key)}>{name}</button>)}</nav>
    <div id="workspace-broker-research" hidden={page !== "research"}>{bridge && <ResearchPanel bridge={bridge} active={active && page === "research"} onStaged={staged}/>}</div>
    <div id="workspace-broker-trade" hidden={page !== "trade"}>
      <div className="workspace-trade-mode" role="group" aria-label="委託模式"><button type="button" aria-pressed={mode === "manual"} aria-controls="workspace-manual-content" onClick={() => setMode("manual")}>一般</button><button type="button" aria-pressed={mode === "conditional"} aria-controls="workspace-candidate-content" onClick={() => setMode("conditional")}>條件交易</button></div>
      <div id="workspace-manual-content" hidden={mode !== "manual"}><ManualOrderForm symbol={symbol} bridge={bridge} onStaged={staged}/></div>
      <div id="workspace-candidate-content" hidden={mode !== "conditional"}>
        <p className="workspace-candidate-boundary">保存條件不會送交券商；準備完成後仍需核對並確認送出。</p>
        {/* A mounted session retains drafts and uncertain attempts across navigation. */}
        {bridge && <CandidatePanel bridge={bridge} symbol={symbol} space="USER_SPACE" active={active && page === "trade" && mode === "conditional"} onShowPending={id => { setCandidateId(id); setPage("staged"); onNavigateToStaged?.({ stageId: id, origin: "candidate" }); }}/>}
      </div>
    </div>
    <div id="workspace-broker-orders" hidden={page !== "orders" && page !== "staged"}>{page === "staged" && <button type="button" onClick={continueAdding}>繼續新增委託</button>}{bridge ? <DeskOrders bridge={bridge} active={active && (page === "orders" || page === "staged")} view={page === "orders" ? "orders" : "staged"} candidateId={candidateId} focusStageId={stagedTarget?.stageId} brokerTarget={brokerTarget} onNavigateBroker={navigateBroker} refreshKey={refreshKey}/> : <p>交易連線尚未提供，請重新開啟工作台。</p>}</div>
    <div id="workspace-broker-fills" hidden={page !== "fills"}>{bridge && <BrokerReadback bridge={bridge} active={active && page === "fills"} kind="fills"/>}</div>
    <div id="workspace-broker-inventory" hidden={page !== "inventory"}>{bridge && <BrokerReadback bridge={bridge} active={active && page === "inventory"} kind="inventory"/>}</div>
  </aside>;
}
