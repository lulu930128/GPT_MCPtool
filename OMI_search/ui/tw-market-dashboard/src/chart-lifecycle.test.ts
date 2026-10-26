import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import vm from "node:vm";

test("chart effects preserve instance and viewport on refresh, reset only on identity, and clean up", async () => {
  // Execute the actual component effects with controlled React hooks and chart
  // APIs. This checks lifecycle behavior, not a second implementation of it.
  let cursor = 0;
  const slots: any[] = [];
  let effects: (() => void)[] = [];
  const same = (a: unknown[], b: unknown[]) => a?.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const hooks = {
    useRef(value: unknown) { const index = cursor++; return slots[index] ??= { current: value }; },
    useState(value: unknown) { const index = cursor++; slots[index] ??= value; return [slots[index], (next: unknown) => { slots[index] = next; }]; },
    useMemo(fn: () => unknown, deps: unknown[]) { const index = cursor++; if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { deps, value: fn() }; return slots[index].value; },
    useEffect(fn: () => (() => void) | undefined, deps: unknown[]) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].deps, deps)) effects.push(() => {
        slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: fn() };
      });
    },
  };
  const charts: any[] = [];
  const chartApi = {
    createChart() {
      const chart = {
        removed: 0, range: null as null | { from: number; to: number }, series: [] as any[],
        addSeries() { const series = { data: [] as any[], writes: 0, setData(data: any[]) { this.data = data; this.writes++; } }; this.series.push(series); return series; },
        timeScale() { return { getVisibleLogicalRange: () => chart.range, setVisibleLogicalRange: (range: any) => { chart.range = range; }, fitContent: () => { chart.range = { from: 0, to: chart.series[0].data.length }; } }; },
        priceScale() { return { applyOptions() {} }; },
        subscribeCrosshairMove() {}, applyOptions() {}, remove() { this.removed++; },
      };
      charts.push(chart); return chart;
    },
  };
  const output = await build({
    entryPoints: [new URL("./InteractiveMarketChart.tsx", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")],
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    plugins: [{ name: "controlled-effects", setup(builder) {
      builder.onResolve({ filter: /^(react(?:\/jsx-runtime)?|lightweight-charts)$/ }, (args) => ({ path: args.path, namespace: "controlled" }));
      builder.onLoad({ filter: /.*/, namespace: "controlled" }, (args) => ({ contents: args.path === "react"
        ? "export const {useEffect,useMemo,useRef,useState}=globalThis.hooks;"
        : args.path === "react/jsx-runtime" ? "export const jsx=(type,props)=>({type,props}); export const jsxs=jsx; export const Fragment='fragment';"
        : "export const {createChart}=globalThis.chartApi; export const CandlestickSeries='candle',HistogramSeries='volume',LineSeries='line',ColorType={Solid:'solid'},CrosshairMode={MagnetOHLC:1};" }));
    } }],
  });
  const module = { exports: {} as any };
  vm.runInNewContext(output.outputFiles[0].text, { module, exports: module.exports, hooks, chartApi, ResizeObserver: class { observe() {} disconnect() {} } });
  const component = module.exports.default;
  const attach = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (node.props?.ref) node.props.ref.current = { clientWidth: 800, clientHeight: 400 };
    const children = node.props?.children;
    (Array.isArray(children) ? children : [children]).forEach(attach);
  };
  const points = Array.from({ length: 100 }, (_, i) => ({ time: new Date(Date.UTC(2026, 0, i + 1)).toISOString(), open: 10, high: 12, low: 8, close: 11, volume: 10 }));
  const render = (stockId: string, data = points, timeframe = "daily", averages: any[] = []) => {
    cursor = 0; effects = []; const tree = component({ stockId, timeframe, points: data, averages }); attach(tree); effects.forEach((effect) => effect()); return tree;
  };
  render("2330", []);
  assert.equal(charts.length, 1, "empty first paint still mounts the chart container");
  render("2330");
  charts[0].range = { from: 12, to: 38 };
  render("2330", [...points], "daily", [{ time: points[20].time, ma5: 11 }]);
  assert.equal(charts.length, 1);
  assert.equal(charts[0].removed, 0);
  assert.equal(JSON.stringify(charts[0].range), JSON.stringify({ from: 12, to: 38 }));
  assert.equal(charts[0].series[2].data[0].value, 11);
  render("2330", points.slice(1));
  assert.equal(JSON.stringify(charts[0].range), JSON.stringify({ from: 11, to: 37 }), "rolling window keeps the same time anchor");
  render("2330", []);
  render("2330", points.slice(1));
  assert.equal(JSON.stringify(charts[0].range), JSON.stringify({ from: 11, to: 37 }));
  render("2317");
  assert.equal(charts.length, 2);
  assert.equal(charts[0].removed, 1);
  assert.equal(JSON.stringify(charts[1].range), JSON.stringify({ from: 10, to: 102 }));
  render("2317", points, "weekly");
  assert.equal(charts.length, 3);
  assert.equal(charts[1].removed, 1);
  for (const slot of slots) slot?.cleanup?.();
  assert.equal(charts[2].removed, 1);
});
