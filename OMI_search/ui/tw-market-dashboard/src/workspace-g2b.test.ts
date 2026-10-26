import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { readToolData } from "./workspace-state";
import { technicalSummary, technicalPresentation } from "./workspace-technical";
import type { UnknownRecord } from "./state";

const frames = ["today", "daily", "weekly", "monthly"] as const;
type Frame = typeof frames[number];
const time = "2026-10-01";
const values = { time, close: 123, change_pct: 1.25, rsi: { rsi14: 54 },
  macd: { macd: 3, signal: 2, histogram: 1 }, kd: { k9: 60, d9: 50 } };
const pane = (data: UnknownRecord, args: UnknownRecord) => ({ data, key: JSON.stringify(args), dataKey: JSON.stringify(args), loading: false, error: null });
function pair(frame: Frame) {
  const identity = { stock_id: "2330", timeframe: frame };
  const point = { time, close: 123, open: 120, high: 125, low: 119, volume: 10 };
  const chartData: UnknownRecord = { ...identity, [frame === "today" ? "intraday_chart" : "chart"]: { ...identity, points: [point] } };
  const summary: UnknownRecord = { ...structuredClone(values), basis: frame === "today" ? "daily_background" : frame === "daily" ? "daily_indicator" : "indicator" };
  const reportData: UnknownRecord = { daily_indicator: { ...values, change_pct: 99 }, indicator: { ...values, change_pct: 99 }, period: { status: "completed" } };
  const technical: UnknownRecord = { ...identity, title: "Backend title", summary: "Backend summary", phase: "Backend phase", rows: [], data: reportData };
  const researchData: UnknownRecord = { ...identity, kind: "omi.tw_stock_research", version: "omi.tw_stock_research.workspace.v1", projection: "workspace", technical_summary: summary, technical };
  return { chart: pane(chartData, identity), research: pane(researchData, { ...identity, projection: "workspace" }), summary, technical, reportData, point };
}
function noIndicators(view: ReturnType<typeof technicalSummary>) {
  for (const key of ["changePct", "rsi", "macdLine", "macdSignal", "macdHistogram", "k9", "d9"] as const) assert.equal(view[key], null, key);
}

test("research allows exactly full v1 and workspace v1; unrelated kinds and newer versions fail closed", () => {
  for (const version of ["omi.tw_stock_research.v1", "omi.tw_stock_research.workspace.v1"]) {
    const data = { kind: "omi.tw_stock_research", version, warnings: ["KEEP"] };
    assert.equal(readToolData({ structuredContent: data }, data.kind), data);
  }
  for (const kind of ["omi.tw_stock_chart", "omi.tw_workspace_header", "omi.tw_workspace_watchlist", "omi.tw_workspace_hot_groups", "omi.tw_symbol_search"]) {
    assert.equal(readToolData({ kind, version: `${kind}.v1` }, kind).kind, kind);
    for (const version of [`${kind}.workspace.v1`, `${kind}.v2`, "omi.tw_stock_research.workspace.v1", undefined]) {
      assert.throws(() => readToolData({ kind, version }, kind), /格式不符/);
    }
  }
  for (const version of ["omi.tw_stock_research.workspace.v2", "omi.tw_stock_research.v2", null]) {
    assert.throws(() => readToolData({ kind: "omi.tw_stock_research", version }, "omi.tw_stock_research"), /格式不符/);
  }
  assert.throws(() => readToolData({ kind: "wrong", version: "omi.tw_stock_research.workspace.v1" }, "omi.tw_stock_research"), /格式不符/);
});

for (const frame of frames) {
  test(`${frame} typed summary wins over raw fields with exact point identity`, () => {
    const p = pair(frame), view = technicalSummary(p.chart, p.research);
    if (frame === "today") noIndicators(view);
    else {
      assert.equal(view.sameBar, true);
      assert.deepEqual([view.changePct, view.rsi, view.macdLine, view.macdSignal, view.macdHistogram, view.k9, view.d9], [1.25, 54, 3, 2, 1, 60, 50]);
      assert.equal(view.researchData?.technical, p.technical);
    }
    assert.equal(view.basis, p.summary.basis);
    assert.equal(view.sourceTime, time);
    assert.ok(technicalPresentation(view).facts.some(f => f.label === "研究指標基準" && f.value === p.summary.basis));
  });

  test(`${frame} missing or malformed summary never falls back to full raw fields`, () => {
    for (const bad of [undefined, null, {}, "wrong", [], { ...values, basis: "unknown" }, { ...values, basis: "daily_background" }]) {
      const p = pair(frame);
      p.research.data.technical_summary = bad;
      if (bad === undefined) delete p.research.data.technical_summary;
      noIndicators(technicalSummary(p.chart, p.research));
    }
  });

  test(`${frame} time, close, identity, old selection and partial guards apply to typed values`, () => {
    for (const patch of [{ time: "other" }, { time: null }, { close: 124 }, { close: "123" }, { close: NaN }, { close: null }]) {
      const p = pair(frame); Object.assign(p.summary, patch);
      noIndicators(technicalSummary(p.chart, p.research));
    }
    for (const field of ["stock_id", "timeframe"]) {
      for (const owner of ["envelope", "technical"]) {
        const p = pair(frame); (owner === "envelope" ? p.research.data : p.technical)[field] = "other";
        noIndicators(technicalSummary(p.chart, p.research));
      }
    }
    for (const owner of ["chart", "research"] as const) {
      const p = pair(frame); p[owner].key = "next selection";
      noIndicators(technicalSummary(p.chart, p.research));
    }
    for (const flag of [{ is_partial: true }, { finalized: false }]) {
      const p = pair(frame); Object.assign(p.point, flag);
      noIndicators(technicalSummary(p.chart, p.research));
    }
  });
}

for (const frame of ["daily", "weekly", "monthly"] as const) {
  test(`${frame} missing indicator members remain unknown; explicit zeros survive`, () => {
    const p = pair(frame);
    for (const bad of [undefined, null, NaN, Infinity, "0"]) {
      Object.assign(p.summary, { change_pct: bad, rsi: { rsi14: bad }, macd: { macd: bad, signal: bad, histogram: bad }, kd: { k9: bad, d9: bad } });
      noIndicators(technicalSummary(p.chart, p.research));
    }
    Object.assign(p.summary, { change_pct: 0, rsi: { rsi14: 0 }, macd: { macd: 0, signal: 0, histogram: 0 }, kd: { k9: 0, d9: 0 } });
    const view = technicalSummary(p.chart, p.research);
    assert.deepEqual([view.changePct, view.rsi, view.macdLine, view.macdSignal, view.macdHistogram, view.k9, view.d9], Array(7).fill(0));
  });
}

for (const frame of ["weekly", "monthly"] as const) {
  test(`${frame} current partial metadata never becomes completed, while a matching prior completed bar remains usable`, () => {
    const p = pair(frame);
    p.reportData.period = { status: "current_partial", latest_period_start: time };
    p.reportData.current_partial_indicator = values;
    let view = technicalSummary(p.chart, p.research);
    assert.equal(view.partial, true); noIndicators(view);
    p.summary.time = "2026-09-01";
    noIndicators(technicalSummary(p.chart, p.research));
    p.point.time = "2026-09-01";
    view = technicalSummary(p.chart, p.research);
    assert.equal(view.partial, false); assert.equal(view.sameBar, true);
  });
}

test("WorkspaceApp's real pane effects request workspace for every frame and keep 30/120 second cadences", async () => {
  const output = await build({
    entryPoints: [fileURLToPath(new URL("./WorkspaceApp.tsx", import.meta.url))],
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    plugins: [{ name: "controlled-workspace", setup(builder) {
      builder.onResolve({ filter: /^react(?:\/jsx-runtime)?$/ }, args => ({ path: args.path, namespace: "controlled" }));
      builder.onLoad({ filter: /.*/, namespace: "controlled" }, args => ({ contents: args.path === "react"
        ? "export const {useState,useEffect,useRef,useMemo,useReducer,createContext}=globalThis.hooks;"
        : "export const jsx=(type,props)=>({type,props}); export const jsxs=jsx; export const Fragment='fragment';" }));
    } }],
  });
  for (const timeframe of frames) {
    const effects: (() => void)[] = [], calls: { name: string; args: UnknownRecord }[] = [], cadences: number[] = [];
    const hooks = {
      useState: (initial: any) => [typeof initial === "function" ? initial() : initial, () => {}],
      useMemo: (fn: () => unknown) => fn(), useRef: (current: unknown) => ({ current }),
      useEffect: (fn: () => void) => effects.push(fn), createContext: () => ({}),
    };
    const module = { exports: {} as any };
    const bridge = { getPresentationDiagnostic: () => ({}), subscribe: () => () => {}, subscribePresentation: () => () => {}, start() {}, stop() {},
      async callTool(name: string, args: UnknownRecord) {
        calls.push({ name, args });
        const kind = name.replace("omi_read_", "omi.");
        return { structuredContent: { ...args, kind, version: `${kind}${name.endsWith("research") ? ".workspace" : ""}.v1` } };
      } };
    vm.runInNewContext(output.outputFiles[0].text, { module, exports: module.exports, hooks,
      window: { openai: { toolInput: { stock_id: "2330", timeframe } } }, document: { hidden: false }, navigator: { userAgent: "node-test" }, AbortController,
      setTimeout: (_fn: unknown, ms: number) => { cadences.push(ms); return cadences.length; }, clearTimeout() {},
    });
    module.exports.WorkspaceApp({ bridge });
    const cleanups = effects.map(fn => fn());
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(call => call.name === "omi_read_tw_stock_research"))), [
      { name: "omi_read_tw_stock_research", args: { stock_id: "2330", timeframe, projection: "workspace" } },
    ]);
    assert.equal(calls.filter(call => call.name === "omi_read_tw_stock_chart").length, 1);
    assert.deepEqual(cadences.sort(), [30_000, 30_000, 30_000, 120_000, 120_000].sort());
    cleanups.forEach(fn => { if (typeof fn === "function") (fn as () => void)(); });
  }
});
