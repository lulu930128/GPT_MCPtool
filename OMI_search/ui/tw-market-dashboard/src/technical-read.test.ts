import assert from "node:assert/strict";
import test from "node:test";
import { readToolData } from "./workspace-state";
import { technicalSummary } from "./workspace-technical";
import type { UnknownRecord } from "./state";

const pane = (data: UnknownRecord, args: UnknownRecord) => ({ data, key: JSON.stringify(args),
  dataKey: JSON.stringify(args), loading: false, error: null });

test("technical v2 decodes bounded values with zero, negative OBV and null intact", () => {
  const identity = { stock_id: "2330", timeframe: "daily" };
  const point = { time: "2026-11-10", close: 123, atr: { atr14: 0 },
    adx: { adx14: null, plus_di14: 0, minus_di14: 12 }, obv: -1000 };
  const data = { ...identity, kind: "omi.tw_stock_research", version: "omi.tw_stock_research.technical.v2",
    projection: "technical", technical_summary: { ...point, basis: "daily_indicator" },
    technical: { stock_id: "2330", timeframes: { daily: { completed: point, period: { status: "completed" } } } } };
  assert.equal(readToolData({ structuredContent: data }, data.kind), data);
  const chart = pane({ ...identity, chart: { ...identity, points: [point] } }, identity);
  const research = pane(data, { ...identity, projection: "technical" });
  const view = technicalSummary(chart, research);
  assert.equal(view.sameBar, true);
  assert.deepEqual([view.atr, view.adx, view.plusDi, view.minusDi, view.obv], [0, null, 0, 12, -1000]);
  research.key = JSON.stringify({ ...identity, stock_id: "2603", projection: "technical" });
  assert.equal(technicalSummary(chart, research).obv, null);
});

test("technical read errors preserve typed code, stage and request identity", () => {
  assert.throws(() => readToolData({ isError: true, structuredContent: {
    code: "TECHNICAL_VERSION_CONFLICT", stage: "backend_http", request_id: "fixture-request",
  } }, "omi.tw_stock_research"), /TECHNICAL_VERSION_CONFLICT.*backend_http.*fixture-request/);
  assert.throws(() => readToolData({ kind: "omi.tw_stock_research", version: "omi.tw_stock_research.technical.v3" },
    "omi.tw_stock_research"), /格式不符/);
});
