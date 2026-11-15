import { useEffect, useRef, useState } from "react";
import { CallError, type CandidateBridge } from "./candidate-state";
import { deskCall, deskError, deskOrderRead, protectionRequestObserved } from "./desk-contract";
import { TradeDetails, TradeError } from "./TradeFeedback";
import { isRecord, type UnknownRecord } from "./state";
import { brokerTerminal, cancelDeskOrder, deskCancelLatch, deskOrderCancellable, exactBrokerOrder, type BrokerOrderView } from "./broker-orders";

const record = (value: unknown): UnknownRecord => isRecord(value) ? value : {};
function useCancelLatch(bridge: CandidateBridge, id: string, market: string) {
  const latch = deskCancelLatch(bridge, id, market), [, redraw] = useState(0);
  useEffect(() => { const listener = () => redraw(value => value + 1); latch.listeners.add(listener); return () => { latch.listeners.delete(listener); }; }, [latch]);
  return latch;
}

export function BrokerOrderControls({ bridge, order, onRead }: { bridge: CandidateBridge; order: BrokerOrderView; onRead(): Promise<void> }) {
  const id = String(order.row.execution_id), market = "TW";
  const latch = useCancelLatch(bridge, id, market), lock = useRef(false);
  const [busy, setBusy] = useState(false), [data, setData] = useState<UnknownRecord | null>(null), [notice, setNotice] = useState("");
  const execution = record(data?.execution), terminal = brokerTerminal(execution.state) || brokerTerminal(order.state);
  const run = async (cancel: boolean) => {
    if (lock.current || latch.busy || (cancel && (!order.pin || latch.attempted))) return;
    lock.current = true; setBusy(true); setNotice("");
    try {
      const result = cancel ? await cancelDeskOrder(bridge, id, market, order.pin)
        : exactBrokerOrder(await deskCall(bridge, "omi_read_desk_order", { id, market }), id, market, order.pin);
      setData(result);
      setNotice(record(result.execution).cancel_stage === "NOT_SENT" ? "撤單前檢查未通過，未送交券商；核對後可再次手動撤單。" : brokerTerminal(record(result.execution).state) ? "此單已結案，正在更新委託清單。" : cancel ? "撤單已有回應；請核對此單的券商結果。" : "已精確讀回此單；請以更新後的清單與券商狀態為準。");
    } catch (err) { setNotice(`${latch.attempted ? "撤單結果待核對；不會重複撤單。" : "未發出撤單。"}${deskError(err)}`); }
    finally {
      try { await onRead(); } catch (err) { setNotice(`清單更新未完成；請核對此單。${deskError(err)}`); }
      finally { lock.current = false; setBusy(false); }
    }
  };
  return <div>
    <div className="workspace-order-actions">
      {order.pin && <button type="button" className="candidate-primary" disabled={busy || latch.busy || latch.attempted || terminal || (!!data && !deskOrderCancellable(data))} onClick={() => void run(true)}>{busy && latch.busy ? "核對／撤銷中…" : "撤銷剩餘委託"}</button>}
      <button type="button" disabled={busy || latch.busy} onClick={() => void run(false)}>核對此單</button>
    </div>
    {latch.attempted && !terminal && <p role="status" className="workspace-ticket-note">撤單已提出，僅能精確讀回確認結果；不會重複撤單。</p>}
    {notice && <p role="status" className="workspace-ticket-note">{notice}</p>}
    {data && <TradeDetails value={data}/>}
  </div>;
}

export function ProtectionFields({ value, onChange, disabled }: { value: UnknownRecord; onChange(value: UnknownRecord): void; disabled?: boolean }) {
  const targets = Array.isArray(value.targets) ? value.targets as UnknownRecord[] : [];
  return <fieldset disabled={disabled} className="workspace-order-inputs"><legend>此單停損停利</legend>
    <label><input type="checkbox" checked={value.enabled === true} onChange={e => onChange({ ...value, enabled: e.target.checked })}/>啟用出場規則</label>
    <div className="workspace-order-fields">{[["stop_loss", "停損觸發價"], ["stop_limit_price", "停損委託限價"]].map(([key, label]) => <label key={key}>{label}<input type="number" min="0" step="any" value={String(value[key] ?? "")} onChange={e => onChange({ ...value, [key]: e.target.value || null, ...(key === "stop_limit_price" ? { exit_limit_price: e.target.value } : {}) })}/></label>)}</div>
    {targets.map((target, index) => <div className="workspace-order-fields" key={index}>
      {[["price", `TP${index + 1} 觸發價`], ["limit_price", "委託限價"], ["fraction", "出場比例（0～1）"]].map(([key, label]) => <label key={key}>{label}<input type="number" min="0" step="any" value={String(target[key] ?? "")} onChange={e => { const next = targets.map((t, i) => i === index ? { ...t, [key]: e.target.value } : t); onChange({ ...value, targets: next, take_profit: next.at(-1)?.price ?? null }); }}/></label>)}
      <button type="button" onClick={() => { const next = targets.filter((_, i) => i !== index); onChange({ ...value, targets: next, take_profit: next.at(-1)?.price ?? null }); }}>移除目標</button>
    </div>)}
    <button type="button" onClick={() => onChange({ ...value, targets: [...targets, { price: "", limit_price: "", fraction: "" }] })}>增加停利目標</button>
    {!targets.length && <label>停利觸發價<input type="number" min="0" step="any" value={String(value.take_profit ?? "")} onChange={e => onChange({ ...value, take_profit: e.target.value || null })}/></label>}
    <small>依此單實際成交股數出場；台股整股按交易單位換算。出場使用設定的限價。</small>
  </fieldset>;
}

export function LiveOrderControls({ bridge, id, market, cancelAllowed = true }: { bridge: CandidateBridge; id: string; market: string; cancelAllowed?: boolean }) {
  const [data, setData] = useState<UnknownRecord | null>(null), [rules, setRules] = useState<UnknownRecord | null>(null);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const lock = useRef(false), request = useRef<UnknownRecord | null>(null);
  const [unresolved, setUnresolved] = useState(false);
  const cancelLatch = useCancelLatch(bridge, id, market);
  const run = async (action: () => Promise<unknown>) => { if (lock.current) return; lock.current = true; setBusy(true); setNotice(""); try { const result = deskOrderRead(await action(), id, market); setData(result); setRules(record(result.protection).rules as UnknownRecord ?? null); } catch (err) { setNotice(deskError(err)); } finally { lock.current = false; setBusy(false); } };
  const read = async () => {
    const result = deskOrderRead(await deskCall(bridge, "omi_read_desk_order", { id, market }), id, market);
    if (request.current && protectionRequestObserved(result, request.current)) { request.current = null; setUnresolved(false); }
    return result;
  };
  const execution = record(data?.execution), protection = record(data?.protection);
  const state = ({ OPEN: "未完成", FILLED: "已成交", PARTIALLY_FILLED: "部分成交", ACCEPTED: "已受理", PENDING: "券商結果待確認", CANCEL_PENDING: "撤銷處理中", CANCELLED: "已撤銷", REJECTED: "遭拒絕", UNKNOWN: "結果待確認", RECONCILING: "核對中" } as Record<string, string>)[String(execution.state)] ?? "狀態待確認";
  const terminal = ["CANCELLED", "FILLED", "REJECTED"].includes(String(execution.state));
  const hasBrokerId = typeof execution.broker_order_id === "string" && !!execution.broker_order_id;
  return <details className="workspace-order-details"><summary>券商委託與停損停利</summary>
    <button disabled={busy} onClick={() => void run(read)}>{busy ? "處理中…" : "讀取此單"}</button>
    {data && <><p>委託狀態：{state} · 成交 {String(execution.filled_shares ?? "待回報")} 股</p>
      {cancelAllowed && <button disabled={busy || cancelLatch.busy || cancelLatch.attempted || terminal || !deskOrderCancellable(data)} onClick={() => {
        void run(() => cancelDeskOrder(bridge, id, market));
      }}>撤銷券商委託</button>}
      {cancelLatch.attempted && !terminal && <p role="status">撤單已提出，請讀取此單確認券商結果；不會重複撤單。</p>}
      {execution.cancel_stage === "NOT_SENT" && <p role="status">撤單前檢查未通過，未送交券商；核對後可再次手動撤單。</p>}
      {!hasBrokerId && !terminal && <p>尚無可核對的券商委託編號，暫不能撤單。</p>}
      {rules && <form onSubmit={e => { e.preventDefault(); if (unresolved) return; void run(async () => {
        const payload = { id, market, rules, request_id: crypto.randomUUID(), expected_revision: protection.strategy_revision };
        request.current = { ...payload, strategy_id: protection.strategy_id };
        try { const result = deskOrderRead(await deskCall(bridge, "omi_revise_order_protection", payload), id, market);
          if (!protectionRequestObserved(result, request.current)) throw Error("修改回應尚未包含本次請求的精確紀錄，請讀回確認。");
          request.current = null; return result; }
        catch (err) { if (err instanceof CallError && err.tool === "omi_revise_order_protection" && err.uncertain === false && [400, 403, 404, 405, 422].includes(err.httpStatus ?? 0)) request.current = null; else setUnresolved(true); throw err; }
      }); }}><ProtectionFields value={rules} onChange={setRules} disabled={busy || unresolved}/><button disabled={busy || unresolved}>套用此單停損停利</button></form>}
      {unresolved && <p>修改結果待確認，請讀取此單。</p>}
      {rules && <p>保護股數：{String(protection.protected_quantity ?? "尚未確認")} 股。此規則由本機執行，成交與出場均以券商回報為準。</p>}
      {!rules && <p>此單未提供可修改的保護設定。</p>}
      <TradeDetails value={data}/>
    </>}
    <TradeError error={notice}/>
  </details>;
}
