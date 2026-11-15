import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chartSession } from "./workspace-chart-session";
import { technicalSummary, TechnicalSummary } from "./workspace-technical";
import { fillView } from "./broker-orders";
import { orderTechnicalView } from "./OrderTechnicalSummary";
import type { UnknownRecord } from "./state";

const fixtures = JSON.parse(readFileSync(new URL("../scripts/fixtures/backend-chart-cases.json", import.meta.url), "utf8"));
const pane = (data: UnknownRecord) => { const key = JSON.stringify({ stock_id: data.stock_id, timeframe: data.timeframe }); return { key, dataKey: key, data, loading: false, error: null }; };
const research = (frame: string) => pane({ stock_id: "2330", timeframe: frame, technical: { stock_id: "2330", timeframe: frame,
  title: "不得當今日結論", summary: "昨日偏強", generated_at: "2026-11-11T15:00:00+08:00",
  data: { daily_indicator: { time: "2026-11-12", close: 175, rsi: { rsi14: 99 } } } } });

test("actual service->dashboard schema fixture preserves provisional and excludes completed MA/RSI", () => {
  const data = fixtures.daily, view = technicalSummary(pane(data), research("daily"));
  assert.equal(view.partial, true); assert.equal(view.close, 175);
  assert.equal(view.ma5, null); assert.equal(view.rsi, null); assert.equal(view.sameBar, false);
  assert.equal(data.chart.base_official_final, true); assert.equal(data.chart.official_final, false);
  assert.equal(data.chart.trading_scope, "regular_session");
  assert.equal(fixtures.stale_quote.chart.intraday_overlay.delayed, true);
  const html = renderToStaticMarkup(createElement(TechnicalSummary, { view }));
  assert.equal((html.match(/<li>/g) ?? []).length, 4);
  assert.match(html, /暫定.*不套用完成均線/); assert.doesNotMatch(html, /RSI14 99/);
});

test("today empty never borrows yesterday research or MA; previous view is explicit", () => {
  const data = fixtures.today_missing;
  assert.equal(chartSession(data).points.length, 0);
  const current = technicalSummary(pane(data), research("today"));
  assert.equal(current.close, null); assert.equal(current.ma5, null); assert.equal(current.rsi, null);
  assert.match(current.mismatch!, /今日尚無.*日線背景/);
  const html = renderToStaticMarkup(createElement(TechnicalSummary, { view: current }));
  assert.doesNotMatch(html, /昨日偏強|不得當今日結論/);
  const old = chartSession(data, true);
  assert.equal(old.date, "2026-11-11"); assert.match(old.label, /上一交易日/); assert.equal(old.points.length, 75);
  const prior = technicalSummary(pane(data), research("today"), true);
  assert.equal(prior.current, false); assert.equal(prior.ma5, null); assert.equal(prior.rsi, null);
  assert.match(prior.mismatch!, /上一交易日.*不套用/);
  const legacy = structuredClone(data); legacy.intraday_chart = { session_relation: "previous_session", trade_date: "2026-11-11", points: old.points };
  assert.equal(chartSession(legacy).points.length, 0);
});

test("partial coverage and calendar-owned nontrading session stay labelled", () => {
  assert.match(chartSession(fixtures.today_partial).coverage, /75\/86/);
  const holiday = structuredClone(fixtures.today_partial);
  Object.assign(holiday.intraday_chart, { session_relation: "previous_session", presentation_state: "previous_session" });
  assert.match(chartSession(holiday).label, /上一交易日/);
  const wrong = structuredClone(fixtures.today_partial);
  wrong.intraday_chart.trade_date = "2026-11-13";
  assert.equal(chartSession(wrong).points.length, 0);
});

test("fill view uses backend trade date, preserves undated unknown and never filters inventory", () => {
  const data = { trade_date: "2026-11-12", fills: [{ fill_id: "today", broker_key: { trade_date: "2026-11-12" } },
    { fill_id: "old", broker_key: { trade_date: "2026-11-11" } }, { fill_id: "unknown", broker_key: {} }],
    inventory: { margin: { complete: false, items: null } } };
  const before = structuredClone(data);
  assert.deepEqual(fillView(data, "today").dated.map(row => row.fill_id), ["today"]);
  assert.deepEqual(fillView(data, "history", "2026-11-11").dated.map(row => row.fill_id), ["old"]);
  assert.equal(fillView(data, "today").undated.length, 1);
  assert.equal(fillView(data, "history").dated.length, 2);
  assert.deepEqual(data, before);
});

test("card narrative requires same completed evidence and qualification; missing averages stay missing", () => {
  const completed = { time: "2026-11-11", close: 101, bar_status: "completed", ma: { ma20: 100, ma60: 102 } };
  const data = { technical_summary: { ...completed, basis: "daily_indicator" },
    technical: { summary: "來源描述", timeframes: { daily: { completed, decision_usable: true, input_quality: { decision_usable: true } } } } };
  const view = orderTechnicalView(data);
  assert.equal(view.available, true); assert.equal(view.points.length, 4);
  assert.match(view.points.join(" "), /來源描述.*20 日均線之上.*60 日均線之下/);
  for (const corrupt of [
    (d: any) => d.technical_summary.time = "2026-11-12",
    (d: any) => d.technical_summary.close = 999,
    (d: any) => d.technical.timeframes.daily.decision_usable = false,
    (d: any) => d.technical.timeframes.daily.completed.bar_status = "current_partial",
    (d: any) => d.technical.timeframes.daily.completed.indicator_eligible = false,
    (d: any) => d.technical.timeframes.daily.input_quality.decision_usable = false,
  ]) { const changed = structuredClone(data); corrupt(changed); assert.equal(orderTechnicalView(changed).available, false); }
  const missing = structuredClone(data); delete (missing.technical.timeframes.daily.completed.ma as any).ma60;
  assert.match(orderTechnicalView(missing).points.join(" "), /缺少 60 日均線/);
});
