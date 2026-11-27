import { isRecord, type UnknownRecord } from "./state";
import type { PaneState } from "./workspace-state";
import type { PresentationEvidence } from "./workspace-evidence";
import { chartSession } from "./workspace-chart-session";

type KeyedPane = PaneState & { key: string | null };
const record = (value: unknown): UnknownRecord => isRecord(value) ? value : {};
const records = (value: unknown): UnknownRecord[] => Array.isArray(value) ? value.filter(isRecord) : [];
const text = (value: unknown) => typeof value === "string" && value ? value : "—";
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const numeric = (value: unknown) => finite(value)?.toLocaleString("zh-TW", { maximumFractionDigits: 2 }) ?? "—";

// Narrow the backend's open technical.data object without coercion or formulas.
function indicatorValues(value: unknown) {
  const indicator = record(value);
  const methodValue = (value: unknown, prefix: string) => {
    const values = record(value);
    const key = Object.keys(values).find((key) => key.startsWith(prefix));
    return key ? finite(values[key]) : null;
  };
  return {
    time: typeof indicator.time === "string" && indicator.time ? indicator.time : null,
    close: finite(indicator.close), changePct: finite(indicator.change_pct),
    rsi: finite(record(indicator.rsi).rsi14),
    macdLine: finite(record(indicator.macd).macd),
    macdSignal: finite(record(indicator.macd).signal),
    macdHistogram: finite(record(indicator.macd).histogram),
    k9: finite(record(indicator.kd).k9), d9: finite(record(indicator.kd).d9),
    atr: methodValue(indicator.atr, "atr"), adx: methodValue(indicator.adx, "adx"),
    plusDi: methodValue(indicator.adx, "plus_di"), minusDi: methodValue(indicator.adx, "minus_di"),
    obv: finite(indicator.obv),
  };
}

function requestMatches(pane: KeyedPane): boolean {
  if (!pane.key || pane.dataKey !== pane.key || !pane.data) return false;
  try {
    const request = record(JSON.parse(pane.key));
    return typeof request.stock_id === "string" && request.stock_id === pane.data.stock_id
      && typeof request.timeframe === "string" && request.timeframe === pane.data.timeframe;
  } catch { return false; }
}

// Presentation projection only. No indicator formula, previous-bar inference or
// fallback to another timeframe. Chart and research keep independent clocks.
export function technicalSummary(chart: KeyedPane, research: KeyedPane, previousSession = false, expectedTradeDate?: string) {
  const data = chart.data;
  const timeframe = data?.timeframe;
  const historical = record(data?.chart);
  const chartMatches = typeof data?.stock_id === "string" && !!data.stock_id
    && (timeframe === "today" || (["daily", "weekly", "monthly"].includes(String(timeframe))
      && historical.stock_id === data.stock_id && historical.timeframe === timeframe));
  const session = chartSession(data ?? {}, previousSession, expectedTradeDate);
  const active = chartMatches ? record(timeframe === "today" ? { ...record(data?.intraday_chart), points: session.points } : historical) : {};
  const point = record(Array.isArray(active.points) ? active.points.at(-1) : null);
  const time = typeof point.time === "string" && point.time ? point.time : null;
  const average = time && !session.prior && !previousSession ? records(data?.moving_averages).find((row) => row.time === time) ?? {} : {};
  const envelopeMatches = requestMatches(chart) && requestMatches(research)
    && !!data && research.data?.stock_id === data.stock_id && research.data?.timeframe === timeframe;
  const report = record(research.data?.technical);
  const bounded = research.data?.version === "omi.tw_stock_research.technical.v2";
  const current = !previousSession && !(timeframe === "today" && session.prior)
    && envelopeMatches && report.stock_id === data?.stock_id && (bounded || report.timeframe === timeframe);
  const technical = current ? report : {};
  const reportData = bounded ? record(record(technical.timeframes)[String(timeframe)]) : record(technical.data);
  // Workspace's typed summary is authoritative even when absent/malformed;
  // only legacy full envelopes may use the original technical.data fields.
  const typed = current && (research.data?.version === "omi.tw_stock_research.workspace.v1"
    || Object.hasOwn(research.data ?? {}, "technical_summary"));
  const summary = record(current ? research.data?.technical_summary : null);
  const expectedBasis = timeframe === "daily" ? "daily_indicator"
    : timeframe === "weekly" || timeframe === "monthly" ? "indicator" : null;
  const basisMatches = !typed || (expectedBasis !== null && summary.basis === expectedBasis);
  // today has only daily background; it has no corresponding minute indicator.
  const indicator = indicatorValues(typed ? summary : expectedBasis ? reportData[expectedBasis] : null);
  const sourceTime = indicator.time;
  const period = record(reportData.period);
  const partial = point.is_partial === true || point.finalized === false || point.official_final === false || point.indicator_eligible === false
    || (period.status === "current_partial" && !!time && period.latest_period_start === time);
  // Use the backend's percentage only when its completed bar is exactly the
  // displayed bar (both timestamp and close). Never calculate it from a nearby
  // bar, a quote, or the report's provisional/current price context.
  const sameBar = current && timeframe !== "today" && basisMatches && !!time && time === sourceTime && finite(point.close) !== null && finite(point.close) === indicator.close && !partial;
  const mismatch = previousSession || (timeframe === "today" && session.prior) ? "上一交易日檢視；不套用當日均線或研究。"
    : timeframe === "today" && !time ? "今日尚無合格分 K；獨立研究僅作標示日期的日線背景。"
    : !chartMatches ? "圖表標的／週期不符。"
    : !current ? "研究尚未對應目前選取。"
    : timeframe === "today" ? "未提供分 K RSI／MACD／K/D；日線背景不套用於分 K。"
    : !basisMatches ? "研究指標基準與圖表週期不符或未提供。"
    : !sourceTime ? "研究未提供此週期的結構化指標時間。"
    : time !== sourceTime ? "研究與 K 棒時間不同；舊研究不混入目前 K 棒。"
    : finite(point.close) === null || indicator.close === null ? "缺少可核對的收盤價。"
    : finite(point.close) !== indicator.close ? "研究與 K 棒收盤不符。"
    : partial ? "部分 K 棒不套用已完成週期指標。" : null;
  const changePct = sameBar ? indicator.changePct : null;
  return {
    active, time, current, partial, sourceTime, sameBar, mismatch,
    basis: typed ? summary.basis : expectedBasis,
    periodStatus: period.status,
    decisionSnapshot: reportData.decision_snapshot,
    generatedAt: current ? technical.generated_at : null,
    open: time ? finite(point.open) : null, high: time ? finite(point.high) : null, low: time ? finite(point.low) : null,
    close: time ? finite(point.close) : null, volume: time ? finite(point.volume) : null, changePct,
    tradeValue: time && timeframe !== "today" ? finite(point.trade_value) : null,
    ma5: partial ? null : finite(average.ma5), ma20: partial ? null : finite(average.ma20), ma60: partial ? null : finite(average.ma60),
    rsi: sameBar ? indicator.rsi : null,
    macdLine: sameBar ? indicator.macdLine : null, macdSignal: sameBar ? indicator.macdSignal : null,
    macdHistogram: sameBar ? indicator.macdHistogram : null,
    k9: sameBar ? indicator.k9 : null, d9: sameBar ? indicator.d9 : null,
    atr: sameBar ? indicator.atr : null, adx: sameBar ? indicator.adx : null,
    plusDi: sameBar ? indicator.plusDi : null, minusDi: sameBar ? indicator.minusDi : null,
    obv: sameBar ? indicator.obv : null,
    researchData: current ? research.data : null,
  };
}

export function technicalPresentation(view: ReturnType<typeof technicalSummary>): PresentationEvidence {
  return { notice: view.mismatch, facts: [
    { label: "K 棒原始時間", value: view.time ?? "未提供" },
    { label: "研究資料時間", value: view.sourceTime ?? "未提供" },
    { label: "研究指標基準", value: text(view.basis) },
    { label: "報告產生", value: text(view.generatedAt) },
    { label: "研究快照", value: text(view.decisionSnapshot) },
    { label: "週期狀態", value: text(view.periodStatus) },
    { label: "成交量單位", value: text(view.active.volume_unit) },
    { label: "成交金額單位", value: text(view.active.trade_value_unit) },
  ] };
}

export function TechnicalSummary({ view }: { view: ReturnType<typeof technicalSummary> }) {
  const fields: [string, string][] = [
    ["開盤", numeric(view.open)], ["最高", numeric(view.high)], ["最低", numeric(view.low)],
    ["收盤", numeric(view.close)], ["漲跌幅", view.changePct === null ? "—" : `${numeric(view.changePct)}%`],
    [`量（${text(view.active.volume_unit)}）`, numeric(view.volume)],
    [`成交金額（${text(view.active.trade_value_unit)}）`, numeric(view.tradeValue)],
    ["MA5", numeric(view.ma5)], ["MA20", numeric(view.ma20)], ["MA60", numeric(view.ma60)],
    ["RSI14", numeric(view.rsi)], ["MACD 線", numeric(view.macdLine)], ["MACD Signal", numeric(view.macdSignal)],
    ["MACD Histogram", numeric(view.macdHistogram)], ["K9", numeric(view.k9)], ["D9", numeric(view.d9)],
    ["ATR", numeric(view.atr)], ["ADX", numeric(view.adx)], ["+DI", numeric(view.plusDi)],
    ["−DI", numeric(view.minusDi)], ["OBV（股）", numeric(view.obv)],
  ];
  return <section className="workspace-technical-summary" aria-label="圖表技術摘要">
    <div className="workspace-summary-clock">K 棒 <time dateTime={view.time ?? undefined}>{view.time?.replace("T", " ").replace(/:\d{2}(?:\.\d+)?(?:[+-]\d{2}:\d{2}|Z)$/, "") ?? "—"}</time>{view.partial ? " · 部分 K 棒" : ""}</div>
    {!view.time ? <p role="status">無可用摘要。{view.mismatch}</p> : <ul className="workspace-technical-points">
      <li>{view.time ? `資料截至 ${view.time}${view.partial ? "，暫定／部分 K 棒。" : "。"}` : "目前沒有對應 K 棒，暫不提供價格結論。"}</li>
      <li>{view.close === null ? "收盤與高低價證據不足。" : `收盤 ${numeric(view.close)}；本根範圍 ${numeric(view.low)}～${numeric(view.high)}。`}</li>
      <li>{view.ma5 !== null || view.ma20 !== null ? `完成 K 棒均線：MA5 ${numeric(view.ma5)}、MA20 ${numeric(view.ma20)}、MA60 ${numeric(view.ma60)}。` : view.partial ? "暫定 K 棒不套用完成均線。" : "此根尚無可對應的完成均線。"}</li>
      <li>{view.mismatch ?? (view.rsi !== null || view.macdHistogram !== null ? `同根指標：RSI14 ${numeric(view.rsi)}；MACD Histogram ${numeric(view.macdHistogram)}。` : "同根 RSI／MACD 證據尚未提供。")}</li>
    </ul>}
    {view.mismatch && <small role="status" className="workspace-quality-badge">指標受限 · 詳見資料狀態</small>}
    <details><summary>查看技術數值</summary><dl className="workspace-metrics-grid">{fields.map(([label, value]) => <div className="workspace-metric" key={label}><dt title={label}>{label}</dt><dd>{value}</dd></div>)}</dl></details>
  </section>;
}
