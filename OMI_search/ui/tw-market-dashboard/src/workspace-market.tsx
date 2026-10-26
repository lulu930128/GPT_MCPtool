import { isRecord, type UnknownRecord } from "./state";
import type { PaneState } from "./workspace-state";
import { StatusBadge } from "./workspace-evidence";

const markets = [["TAIEX", "TWSE", "加權指數"], ["TPEX", "TPEX", "櫃買指數"]] as const;
const record = (value: unknown): UnknownRecord => isRecord(value) ? value : {};
const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("zh-TW", { maximumFractionDigits: 2 }) : "—";

// Backend session vocabulary only; no calendar or local-clock inference.
export function sessionLabel(session: UnknownRecord): string {
  const date = typeof session.trade_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(session.trade_date) ? session.trade_date.slice(5).replace("-", "/") : "交易日未提供";
  const phases: Record<string, string> = { market_closed: "收盤", regular_trading: "盤中", pre_open: "盤前", opening_auction: "開盤集合競價", closing_auction: "收盤集合競價" };
  const states: Record<string, string> = { previous_session: "前一交易日", current_session: "本交易日" };
  return `${date} ${phases[String(session.phase)] ?? states[String(session.presentation_state)] ?? "時段未確認"}`;
}

export function changeTone(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value > 0 ? "workspace-up" : value < 0 ? "workspace-down" : "" : "";
}

// Only pair backend read fields; do not derive session, quality or market totals.
export function MarketCards({ pane }: { pane: PaneState & { retry: () => void } }) {
  const indices = Array.isArray(pane.data?.resolved_indices) ? pane.data.resolved_indices.filter(isRecord) : [];
  const session = record(pane.data?.session);
  return <div className="workspace-market-cards" aria-label="市場摘要">
    {markets.map(([indexId, market, name]) => {
      const index = indices.find((item) => item.index_id === indexId);
      const breadth = record(record(pane.data?.resolved_breadth)[market]);
      return <section key={indexId} className="workspace-pane workspace-market-card" aria-label={`${indexId} ${name}`} aria-busy={pane.loading}>
        <div className="workspace-pane-heading"><h2>{indexId} <span>{name}</span></h2><button type="button" onClick={pane.retry} disabled={pane.loading}>{pane.error ? "重試" : "重新讀取"}</button></div>
        {pane.loading && <p role="status" className="workspace-loading">讀取中…{pane.data ? " 保留上次結果" : ""}</p>}
        {pane.error && <p role="alert" className="workspace-error">讀取失敗{pane.data ? " · 保留上次結果" : ""}</p>}
        <div className="workspace-market-quote"><p className="workspace-session">{sessionLabel(session)}</p><div className="workspace-index-value"><strong>{numeric(index?.value)}</strong><span className={changeTone(index?.change)}>漲跌 {numeric(index?.change)} / {numeric(index?.change_pct)}{numeric(index?.change_pct) !== "—" ? "%" : ""}</span></div></div>
        <dl className="workspace-market-breadth" aria-label={`${market} 市場廣度`}>
          {[["漲", breadth.advance], ["跌", breadth.decline], ["平", breadth.unchanged], ["未知", breadth.unknown]].map(([name, value]) => <div key={String(name)}><dt>{String(name)}</dt><dd>{numeric(value)}</dd></div>)}
        </dl>
        <p className="workspace-market-quality">廣度覆蓋 {numeric(breadth.coverage)} / {numeric(breadth.universe)}</p>
        <div className="workspace-market-notices">
          {index?.authority === "derived_proxy" && <small className="workspace-proxy">代理指數</small>}
          <StatusBadge data={index ?? null} prefix="指數：" />
          <StatusBadge data={Object.keys(breadth).length ? breadth : null} prefix="廣度：" />
        </div>
      </section>;
    })}
  </div>;
}
