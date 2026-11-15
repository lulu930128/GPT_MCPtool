import { useEffect, useState } from "react";
import type { CandidateBridge } from "./candidate-state";
import { deskCall } from "./desk-contract";
import { isRecord, type UnknownRecord } from "./state";
import { TradeDetails } from "./TradeFeedback";

const record = (value: unknown): UnknownRecord => isRecord(value) ? value : {};
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("zh-TW", { maximumFractionDigits: 2 }) : "未提供";
export type OrderResearchCache = Map<string, Promise<UnknownRecord>>;
export function orderTechnicalView(data: UnknownRecord | undefined) {
  const summary = record(data?.technical_summary), report = record(data?.technical);
  const daily = record(record(report.timeframes).daily), completed = record(daily.completed);
  const quality = record(daily.input_quality), ma = record(completed.ma);
  const time = typeof summary.time === "string" ? summary.time : null;
  const available = !!time && summary.basis === "daily_indicator" && completed.time === time
    && typeof completed.close === "number" && Number.isFinite(completed.close) && summary.close === completed.close
    && completed.bar_status === "completed" && daily.decision_usable === true && quality.decision_usable !== false
    && completed.indicator_eligible !== false && completed.official_final !== false && completed.is_partial !== true;
  const compare = (days: number) => { const value = ma[`ma${days}`];
    return typeof value === "number" && Number.isFinite(value) ? `收盤 ${number(completed.close)} 在 ${days} 日均線${Number(completed.close) > value ? "之上" : Number(completed.close) < value ? "之下" : "附近（相同值）"}（${number(value)}）。` : `缺少 ${days} 日均線，無法判讀此段趨勢。`; };
  const narrative = typeof report.summary === "string" && report.summary.trim() ? report.summary
    : typeof daily.description === "string" && daily.description.trim() ? daily.description : null;
  return { available, points: [
    `日線背景 · 截至 ${time ?? "未提供"}；不作今日盤中結論。`,
    ...(narrative ? [narrative] : []), compare(20), compare(60),
  ] };
}

// Only explicit expansion reads research. Cards for the same symbol share the
// same in-flight/completed evidence, with its as-of visible and manual refresh.
export function OrderTechnicalSummary({ bridge, symbol, market, cache }: { bridge: CandidateBridge; symbol: string; market: string; cache: OrderResearchCache }) {
  const [open, setOpen] = useState(false), [data, setData] = useState<UnknownRecord>();
  const [loading, setLoading] = useState(false), [error, setError] = useState(false), [revision, setRevision] = useState(0);
  const key = JSON.stringify([market, symbol, "daily"]);
  useEffect(() => {
    if (!open || market !== "TW") return;
    let disposed = false;
    setLoading(true); setError(false); setData(undefined);
    let read = cache.get(key);
    if (!read) {
      read = deskCall(bridge, "omi_read_tw_stock_research", { stock_id: symbol, timeframe: "daily", projection: "technical" }).then(value => {
        if (!isRecord(value) || value.kind !== "omi.tw_stock_research" || value.version !== "omi.tw_stock_research.technical.v2"
          || value.stock_id !== symbol || value.timeframe !== "daily" || record(value.technical).stock_id !== symbol) throw Error("Research identity mismatch");
        return value;
      });
      cache.set(key, read);
    }
    void read.then(value => { if (!disposed) setData(value); }).catch(() => { if (!disposed) setError(true); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [bridge, cache, key, market, symbol, open, revision]);
  const view = orderTechnicalView(data);
  return <details className="workspace-order-details" onToggle={event => setOpen(event.currentTarget.open)}><summary>技術摘要</summary>
    {open && <>{loading ? <p>讀取摘要中…</p> : view.available ? <ul className="workspace-technical-points">{view.points.map(point => <li key={point}>{point}</li>)}</ul> : <p>無可用摘要{error ? "，請重新讀取" : market !== "TW" ? "；此市場尚未提供" : "；缺少合格的完成日線證據"}。</p>}
    {market === "TW" && <button type="button" disabled={loading} onClick={() => { cache.delete(key); setRevision(value => value + 1); }}>更新摘要</button>}
    {data && <TradeDetails value={data}/>}</>}
  </details>;
}
