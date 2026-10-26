import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { WorkspaceStatusPanel, SourceDetails, sourceCategory, collectProvenance, type StatusSource } from "./workspace-evidence";
import { technicalSummary, technicalPresentation, TechnicalSummary } from "./workspace-technical";
import { WorkspaceApp } from "./WorkspaceApp";
import type { McpAppsBridge } from "./bridge";
import type { UnknownRecord } from "./state";

const pane = (data: UnknownRecord | null, key: string | null = "key") => ({ data, dataKey: data ? key : null, key, error: null as string | null, loading: false });
const source = (data: UnknownRecord | null, extra = {}): StatusSource => ({ id: "header", name: "市場 header", pane: { ...pane(data), ...extra } });

test("source counts classify once, distinguish absent evidence, loading and retained failures", () => {
  for (const [data, expected] of [[null, "未確認"], [{}, "未確認"], [{ status: "ready" }, "未確認"], [{ status: "ready", freshness: { status: "fresh" } }, "正常"], [{ status: "partial", warnings: ["a", "b"] }, "部分受限"], [{ freshness: { status: "stale" } }, "警告"], [{ status: "blocked" }, "錯誤"], [{ status: "missing" }, "部分受限"], [{ chart: { data_quality: "degraded" } }, "警告"]] as const) {
    assert.equal(sourceCategory(source(data as UnknownRecord | null)), expected);
  }
  const healthy = { status: "ready", freshness: { status: "fresh" } };
  assert.equal(sourceCategory(source(healthy, { error: "timeout" })), "錯誤");
  assert.equal(sourceCategory(source(healthy, { loading: true })), "未確認");
  assert.equal(sourceCategory(source(healthy, { key: "next" })), "未確認");
  assert.equal(sourceCategory(source(null, { key: null })), "未請求");
  assert.equal(sourceCategory(source({ observation_received_freshness: "stale" })), "警告");
  assert.equal(sourceCategory(source({ status: "ERROR" })), "錯誤");
  assert.equal(sourceCategory(source({ ok: false })), "錯誤");
  const html = renderToStaticMarkup(createElement(WorkspaceStatusPanel, { sources: [source({ status: "partial", warnings: Array(1200).fill("DETAIL_ONLY") })] }));
  assert.match(html, /正常 0 · 警告 0 · 錯誤 0 · 部分受限 1/);
  assert.equal((html.match(/<details/g) ?? []).length, 1);
  assert.doesNotMatch(html, /DETAIL_ONLY|<pre|open=|workspace-status-scroll/);
});

test("expanded source retains all diagnostics, separate times, request identity and cached update errors", () => {
  const data = { generated_at: "2026-10-09T10:00", freshness: { status: "stale" }, resolved_indices: [{ event_time: "2026-10-08T13:30", source: "official" }], warnings: ["HEADER_WARNING"], chart: { limitations: ["CHART_LIMIT"] } };
  const entry = source(data, { key: "new", error: "retry timeout" });
  assert.equal(entry.pane.data, data);
  const html = renderToStaticMarkup(createElement(SourceDetails, { source: entry }));
  for (const value of ["2026-10-09T10:00", "2026-10-08T13:30", "stale", "official", "HEADER_WARNING", "CHART_LIMIT", "retry timeout", "上次快取", "舊選取快取"]) assert.ok(html.includes(value), value);
  assert.match(html, /role="alert"/);
  assert.doesNotMatch(html, /<pre/);
  assert.ok(collectProvenance(data).some((row) => row.path === "resolved_indices[0].event_time"));
});

test("status panel is the final sidebar sibling outside the tree, with an independent bounded scroll", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { openai: {} } });
  try {
    const bridge = { getPresentationDiagnostic: () => ({ actualDisplayMode: "inline" }) } as unknown as McpAppsBridge;
    const html = renderToStaticMarkup(createElement(WorkspaceApp, { bridge }));
    assert.match(html, /class="workspace-status-panel"[\s\S]*?<\/details><\/section><\/aside>/);
    assert.equal((html.match(/workspace-status-panel/g) ?? []).length, 1);
    assert.doesNotMatch(html, /workspace-evidence|資料狀態、時間與來源/);
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  assert.match(css, /workspace-status-scroll \{ max-height: 280px; overflow-y: auto/);
  assert.match(css, /workspace-status-panel \{ flex: 0 0 auto/);
});

const frames = ["today", "daily", "weekly", "monthly"] as const;
type Frame = typeof frames[number];
const times = { today: "2026-10-08T13:24:00+08:00", daily: "2026-10-08", weekly: "2026-10-05", monthly: "2026-10-01" };
const indicatorKey = (frame: Frame) => frame === "daily" ? "daily_indicator" : "indicator";

// Field-level fixture from the 2026-10-09 cache-only MCP 2330 daily read.
// Monthly cases below are synthetic contract fixtures, not live monthly proof.
const dailyIndicator = {
  time: times.daily, close: 2550, change_pct: -1.354,
  ma: { ma5: 2559, ma20: 2476.5, ma60: 2413.6667 },
  rsi: { rsi14: 61.5111 }, macd: { macd: 40.703, signal: 30.5897, histogram: 10.1133 },
  kd: { k9: 83.5116, d9: 85.1391, j9: 80.2566 },
};
function pair(timeframe: Frame) {
  const time = times[timeframe];
  const indicator = { ...dailyIndicator, time };
  const chart = pane({ stock_id: "2330", timeframe,
    [timeframe === "today" ? "intraday_chart" : "chart"]: {
      stock_id: "2330", timeframe, interval: "1m",
      points: [{ time, open: 2550, high: 2575, low: 2550, close: 2550, volume: 23145193, trade_value: 59167379273 }],
      volume_unit: "shares", trade_value_unit: "TWD",
    },
    moving_averages: [{ time, ma5: 2559, ma20: 2476.5, ma60: 2413.6666666666665 }],
  }, JSON.stringify({ stock_id: "2330", timeframe, bars: 240 }));
  const research = pane({ stock_id: "2330", timeframe, technical: {
    stock_id: "2330", timeframe, generated_at: "2026-10-09T13:20:12.910819+08:00",
    data: timeframe === "today" ? { intraday: {}, daily_background: dailyIndicator } : {
      [indicatorKey(timeframe)]: indicator, decision_snapshot: "completed",
      ...(timeframe === "daily" ? {} : { period: { status: "completed" } }),
      // Conflicting context/narrative must never override the nested indicator.
      change_pct: 99, decision_change_pct: 88,
    },
    rows: [{ key: "momentum", value: 1, direction: 2, basis: timeframe + " RSI, MACD histogram, and ROC" }],
  } }, JSON.stringify({ stock_id: "2330", timeframe }));
  return { chart, research };
}
type Pair = ReturnType<typeof pair>;
function withIndicator(research: Pair["research"], frame: Frame, indicator: unknown) {
  const technical = research.data!.technical as UnknownRecord;
  return { ...research, data: { ...research.data, technical: { ...technical,
    data: { ...technical.data as UnknownRecord, [indicatorKey(frame)]: indicator },
  } } };
}
function withPoint(chart: Pair["chart"], patch: UnknownRecord) {
  const key = chart.data!.timeframe === "today" ? "intraday_chart" : "chart";
  const active = chart.data![key] as UnknownRecord;
  return { ...chart, data: { ...chart.data, [key]: { ...active, points: [{ ...(active.points as UnknownRecord[])[0], ...patch }] } } };
}
const rendered = (value: Pair) => renderToStaticMarkup(createElement(TechnicalSummary, { view: technicalSummary(value.chart, value.research) }));
const details = (value: Pair, owner: "chart" | "research" = "research") => renderToStaticMarkup(createElement(SourceDetails, { source: {
  id: owner, name: owner, pane: value[owner], presentation: technicalPresentation(technicalSummary(value.chart, value.research)),
} }));
function noIndicators(view: ReturnType<typeof technicalSummary>) {
  for (const key of ["rsi", "macdLine", "macdSignal", "macdHistogram", "k9", "d9", "changePct"] as const) assert.equal(view[key], null, key);
}

test("compact metrics keep every value, units and a single clock; mismatch evidence stays lazy", () => {
  for (const frame of frames) {
    const value = pair(frame);
    const view = technicalSummary(value.chart, value.research);
    const html = rendered(value);
    assert.match(html, /class="workspace-metrics-grid"/);
    assert.equal((html.match(/class="workspace-metric"/g) ?? []).length, 16);
    assert.equal((html.match(/<time /g) ?? []).length, 1);
    assert.doesNotMatch(html, /研究資料時間|報告產生|研究快照|週期狀態|2026-10-09T13:20/);
    const entry = { id: "chart", name: "圖表／研究對應", pane: value.chart, presentation: technicalPresentation(view) };
    const closed = renderToStaticMarkup(createElement(WorkspaceStatusPanel, { sources: [entry] }));
    assert.doesNotMatch(closed, /K 棒原始時間|未提供分 K|<pre|open=/);
    const expanded = renderToStaticMarkup(createElement(SourceDetails, { source: entry }));
    for (const text of [times[frame], "shares", "TWD", "2026-10-09T13:20:12.910819+08:00"]) assert.ok(expanded.includes(text));
    if (view.mismatch) { assert.ok(expanded.includes(view.mismatch)); assert.match(html, /指標受限/); }
  }
});

test("presentation mismatch cannot classify a healthy transport as normal", () => {
  const entry = { ...source({ status: "ready", freshness: { status: "fresh" } }), presentation: { notice: "研究與 K 棒收盤不符。", facts: [] } };
  assert.equal(sourceCategory(entry), "部分受限");
  for (const status of ["unknown", "decision_unusable", "stale", "partial", "blocked", "missing", "error"]) {
    assert.notEqual(sourceCategory(source({ status: "ready", freshness: { status: "fresh" }, nested: { status } })), "正常");
  }
});

for (const frame of frames) {
  test(frame + " maps exact chart OHLCV, amount, units and backend MA without calculations", () => {
    const value = pair(frame), view = technicalSummary(value.chart, value.research);
    assert.equal(view.time, times[frame]);
    assert.deepEqual([view.open, view.high, view.low, view.close, view.volume], [2550, 2575, 2550, 2550, 23145193]);
    assert.deepEqual([view.ma5, view.ma20, view.ma60], [2559, 2476.5, 2413.6666666666665]);
    assert.equal(view.tradeValue, frame === "today" ? null : 59167379273);
    assert.equal(view.active.volume_unit, "shares");
    if (frame === "today") noIndicators(view);
    else {
      assert.deepEqual([view.rsi, view.macdLine, view.macdSignal, view.macdHistogram, view.k9, view.d9, view.changePct],
        [61.5111, 40.703, 30.5897, 10.1133, 83.5116, 85.1391, -1.354]);
      const html = rendered(value);
      for (const [label, text] of [["RSI14", "61.51"], ["MACD 線", "40.7"], ["MACD Signal", "30.59"], ["MACD Histogram", "10.11"], ["K9", "83.51"], ["D9", "85.14"]]) {
        assert.ok(html.includes(label + "</dt><dd>" + text), label);
      }
    }
    assert.doesNotMatch(rendered(value), /K\/D：目前來源未提供/);
  });

  test(frame + " missing technical and failed reads retain only chart evidence", () => {
    const { chart, research } = pair(frame);
    for (const data of [null, {}, { stock_id: "2330", timeframe: frame, technical: null }]) {
      const changed = { ...research, data, error: "read failed" };
      noIndicators(technicalSummary(chart, changed));
      const html = rendered({ chart, research: changed });
      assert.doesNotMatch(html, /read failed/);
      assert.match(details({ chart, research: changed }), /read failed/);
      assert.match(html, /指標受限/);
      assert.match(html, /K9<\/dt><dd>—/);
    }
  });

  test(frame + " never mixes old symbol, request key, report identity or another timeframe", () => {
    const { chart, research } = pair(frame), technical = research.data!.technical as UnknownRecord;
    for (const other of frames.filter(other => other !== frame)) noIndicators(technicalSummary(chart, pair(other).research));
    for (const changed of [
      { chart: { ...chart, key: null }, research },
      { chart: { ...chart, key: "next" }, research },
      { chart, research: { ...research, key: "next", error: "timeout" } },
      { chart, research: { ...research, data: { ...research.data, stock_id: "2317" } } },
      { chart, research: { ...research, data: { ...research.data, technical: { ...technical, stock_id: "2317" } } } },
      { chart, research: { ...research, data: { ...research.data, technical: { ...technical, timeframe: "unknown" } } } },
      // Even if dataKey==key, the actual request target must agree with payload.
      { chart, research: { ...research, key: '{"stock_id":"2317","timeframe":"daily"}', dataKey: '{"stock_id":"2317","timeframe":"daily"}' } },
    ]) {
      noIndicators(technicalSummary(changed.chart, changed.research));
      assert.equal(technicalSummary(changed.chart, changed.research).close, 2550);
    }
    assert.match(details({ chart: { ...chart, key: "next" }, research }, "chart"), /舊選取快取/);
  });

  test(frame + " missing chart time, empty points, nonfinite values and wrong MA time remain unknown", () => {
    const { chart, research } = pair(frame);
    for (const time of [null, "", undefined]) {
      const view = technicalSummary(withPoint(chart, { time }), research);
      for (const key of ["open", "high", "low", "close", "volume", "tradeValue", "ma5", "ma20", "ma60"] as const) assert.equal(view[key], null);
      noIndicators(view);
    }
    for (const bad of [null, undefined, NaN, Infinity, "0"]) {
      const view = technicalSummary(withPoint(chart, { open: bad, high: bad, low: bad, close: bad, volume: bad, trade_value: bad }), research);
      assert.deepEqual([view.open, view.high, view.low, view.close, view.volume, view.tradeValue], [null, null, null, null, null, null]);
      noIndicators(view);
    }
    const empty = { ...chart, data: { ...chart.data, [frame === "today" ? "intraday_chart" : "chart"]: { stock_id: "2330", timeframe: frame, points: [] } } };
    assert.equal(technicalSummary(empty, research).time, null);
    const malformedLast = { ...chart, data: { ...chart.data, [frame === "today" ? "intraday_chart" : "chart"]: { stock_id: "2330", timeframe: frame, points: [{ time: times[frame], close: 2550 }, null] } } };
    assert.equal(technicalSummary(malformedLast, research).time, null, "do not silently choose an older valid point");
    const mismatched = { ...chart, data: { ...chart.data, moving_averages: [{ time: "1999-01-01", ma5: 100, ma20: 200, ma60: 300 }] } };
    assert.deepEqual([technicalSummary(mismatched, research).ma5, technicalSummary(mismatched, research).ma20, technicalSummary(mismatched, research).ma60], [null, null, null]);
  });

  test(frame + " incomplete history does not invent MA60 or replace it with research MA", () => {
    const { chart, research } = pair(frame);
    const changed = { ...chart, data: { ...chart.data, moving_averages: [{ time: times[frame], ma5: 10, ma20: 20, ma60: null }] } };
    const view = technicalSummary(changed, research);
    assert.deepEqual([view.ma5, view.ma20, view.ma60], [10, 20, null]);
    assert.match(rendered({ chart: changed, research }), /MA60<\/dt><dd>—/);
    changed.data!.moving_averages = [{ time: times[frame], ma5: NaN, ma20: Infinity, ma60: null }];
    const invalid = technicalSummary(changed, research);
    assert.deepEqual([invalid.ma5, invalid.ma20, invalid.ma60], [null, null, null]);
  });

  test(frame + " zeros survive and missing units are not guessed or converted", () => {
    const { chart, research } = pair(frame);
    const zero = withPoint(chart, { open: 0, high: 0, low: 0, close: 0, volume: 0, trade_value: 0 });
    const activeKey = frame === "today" ? "intraday_chart" : "chart";
    (zero.data![activeKey] as UnknownRecord).volume_unit = null;
    (zero.data![activeKey] as UnknownRecord).trade_value_unit = "custom-unit";
    zero.data!.moving_averages = [{ time: times[frame], ma5: 0, ma20: 0, ma60: 0 }];
    const changed = withIndicator(research, frame, { time: times[frame], close: 0, change_pct: 0, rsi: { rsi14: 0 }, macd: { macd: 0, signal: 0, histogram: 0 }, kd: { k9: 0, d9: 0 } });
    const view = technicalSummary(zero, changed);
    assert.deepEqual([view.open, view.high, view.low, view.close, view.volume, view.ma5, view.ma20, view.ma60], Array(8).fill(0));
    assert.equal(view.tradeValue, frame === "today" ? null : 0);
    if (frame === "today") noIndicators(view);
    else assert.deepEqual([view.rsi, view.macdLine, view.macdSignal, view.macdHistogram, view.k9, view.d9, view.changePct], Array(7).fill(0));
    const html = rendered({ chart: zero, research: changed });
    assert.match(html, /量（—）<\/dt><dd>0/);
    assert.match(html, /成交金額（custom-unit）/);
  });

  test(frame + " same-selection refresh retains source clocks and exposes loading/error", () => {
    const { chart, research } = pair(frame);
    const retained = { ...research, loading: true, error: "refresh timeout" };
    const view = technicalSummary(chart, retained);
    assert.equal(view.rsi, frame === "today" ? null : 61.5111);
    const html = rendered({ chart, research: retained });
    assert.doesNotMatch(html, /refresh timeout|2026-10-09T13:20:12/);
    const expanded = details({ chart, research: retained });
    assert.match(expanded, /refresh timeout/); assert.match(expanded, /讀取中/);
    assert.match(expanded, /2026-10-09T13:20:12/);
    const newer = withPoint(chart, { time: "2026-11-01", close: 2600 });
    noIndicators(technicalSummary(newer, retained));
    if (frame !== "today") assert.match(details({ chart: newer, research: retained }), /研究與 K 棒時間不同/);
  });
}

for (const frame of ["daily", "weekly", "monthly"] as const) {
  test(frame + " nested numbers win even with missing or contradictory narrative and context", () => {
    const { chart, research } = pair(frame);
    for (const rows of [[], [{ key: "momentum", value: 999, direction: 888, basis: "translated description" }]]) {
      const changed = { ...research, data: { ...research.data, technical: { ...research.data!.technical as UnknownRecord, rows } } };
      const view = technicalSummary(chart, changed);
      assert.equal(view.rsi, 61.5111); assert.equal(view.macdHistogram, 10.1133); assert.equal(view.changePct, -1.354);
    }
  });

  test(frame + " missing, string, NaN and partial indicator members have no row fallback", () => {
    const { chart, research } = pair(frame);
    for (const bad of [null, undefined, NaN, Infinity, "42", {}, []]) {
      const view = technicalSummary(chart, withIndicator(research, frame, { time: times[frame], close: 2550, change_pct: bad, rsi: { rsi14: bad }, macd: { macd: bad, signal: bad, histogram: bad }, kd: { k9: bad, d9: bad } }));
      noIndicators(view);
    }
    const view = technicalSummary(chart, withIndicator(research, frame, { time: times[frame], close: 2550, macd: { signal: 7 }, kd: { d9: 9 } }));
    assert.equal(view.rsi, null); assert.equal(view.macdLine, null); assert.equal(view.macdHistogram, null);
    assert.equal(view.macdSignal, 7); assert.equal(view.k9, null); assert.equal(view.d9, 9);
  });

  test(frame + " timestamp and close mismatch, incomplete bar and missing time suppress all research numerics", () => {
    const { chart, research } = pair(frame);
    for (const patch of [{ time: "2026-09-01" }, { time: null }, { close: 2549 }, { close: null }, { close: NaN }]) {
      noIndicators(technicalSummary(chart, withIndicator(research, frame, { ...dailyIndicator, time: times[frame], ...patch })));
    }
    assert.match(details({ chart, research: withIndicator(research, frame, { ...dailyIndicator, time: times[frame], close: 2549 }) }), /收盤不符/);
    for (const patch of [{ is_partial: true }, { finalized: false }]) {
      const changed = withPoint(chart, patch);
      noIndicators(technicalSummary(changed, research));
      assert.match(rendered({ chart: changed, research }), /部分 K 棒/);
    }
  });

  test(frame + " inner chart identity cannot silently disagree with envelope", () => {
    const { chart, research } = pair(frame);
    for (const patch of [{ stock_id: "2317" }, { timeframe: "today" }]) {
      const changed = { ...chart, data: { ...chart.data, chart: { ...chart.data!.chart as UnknownRecord, ...patch } } };
      const view = technicalSummary(changed, research);
      assert.equal(view.close, null); assert.equal(view.ma5, null); noIndicators(view);
      assert.match(details({ chart: changed, research }), /圖表標的／週期不符/);
    }
  });
}

test("today never accepts daily background or accidental indicator, and never falls back to daily OHLCV/MA", () => {
  const { chart, research } = pair("today");
  const daily = pair("daily");
  chart.data!.chart = daily.chart.data!.chart;
  const poisoned = withIndicator(research, "today", { ...dailyIndicator, time: times.today });
  noIndicators(technicalSummary(chart, poisoned));
  const missingIntraday = { ...chart, data: { ...chart.data, intraday_chart: null, moving_averages: daily.chart.data!.moving_averages } };
  const view = technicalSummary(missingIntraday, poisoned);
  assert.equal(view.close, null); assert.equal(view.ma5, null); noIndicators(view);
  assert.match(details({ chart, research: poisoned }), /未提供分 K RSI／MACD／K\/D/);
});

test("weekly live-format indicator and chart use their period start, independent of report generation", () => {
  const { chart, research } = pair("weekly");
  const indicator = { time: times.weekly, close: 2550, change_pct: 2, rsi: { rsi14: 71.5151 },
    macd: { macd: 130.3711, signal: 143.3459, histogram: -12.9748 }, kd: { k9: 83.9538, d9: 78.5295 } };
  const view = technicalSummary(chart, withIndicator(research, "weekly", indicator));
  assert.deepEqual([view.rsi, view.macdLine, view.macdSignal, view.macdHistogram, view.k9, view.d9, view.changePct],
    [71.5151, 130.3711, 143.3459, -12.9748, 83.9538, 78.5295, 2]);
});

test("monthly current partial period never borrows previous completed period or current_partial_indicator", () => {
  const { chart, research } = pair("monthly");
  // 2026-10-09 direct local MCP monthly read: latest finalized period is September.
  const changed = withIndicator(research, "monthly", { time: "2026-09-01", close: 2480, change_pct: 3.1185,
    rsi: { rsi14: 81.0632 }, macd: { macd: 413.932, signal: 334.974, histogram: 78.958 },
    kd: { k9: 91.1786, d9: 89.9935, j9: 93.5486 }, ma: { ma5: 2415, ma20: 1637, ma60: 983.325 } });
  const data = (changed.data!.technical as UnknownRecord).data as UnknownRecord;
  data.period = { status: "current_partial", latest_period_start: times.monthly };
  data.current_partial_indicator = { ...dailyIndicator, time: times.monthly };
  const view = technicalSummary(chart, changed);
  noIndicators(view); assert.equal(view.sourceTime, "2026-09-01"); assert.equal(view.time, times.monthly);
  const html = rendered({ chart, research: changed });
  assert.doesNotMatch(html, /current_partial|舊研究不混入目前 K 棒|2026-09-01/);
  const expanded = details({ chart, research: changed });
  assert.match(expanded, /current_partial/); assert.match(expanded, /舊研究不混入目前 K 棒/);
  assert.match(expanded, /研究資料時間<\/dt><dd>2026-09-01/);
  assert.match(html, /部分 K 棒/);
  const historicalChart = withPoint(chart, { time: "2026-09-01", close: 2480 });
  const matched = technicalSummary(historicalChart, changed);
  assert.equal(matched.partial, false, "current period metadata must not label prior completed bar partial");
  assert.deepEqual([matched.rsi, matched.macdLine, matched.macdSignal, matched.macdHistogram, matched.k9, matched.d9, matched.changePct],
    [81.0632, 413.932, 334.974, 78.958, 91.1786, 89.9935, 3.1185]);
  assert.equal(matched.ma60, null, "October chart MA cannot be joined to September research");
});
