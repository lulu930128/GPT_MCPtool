import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const chart = readFileSync(new URL("./InteractiveMarketChart.tsx", import.meta.url), "utf8");
const packageJson = readFileSync(new URL("../package.json", import.meta.url), "utf8");

test("keeps ChatGPT widget height independent from its assigned iframe viewport", () => {
  assert.doesNotMatch(styles, /min-height:\s*100(?:d)?vh/i);
  assert.match(styles, /html, body, #root\s*\{\s*min-height:\s*0;/i);
  assert.match(styles, /\.dashboard-shell\s*\{[^}]*min-height:\s*0;/is);
  assert.match(styles, /\.dashboard-shell\.is-mobile-layout\s*\{[^}]*min-height:\s*0;/is);
});

test("keeps button press feedback from changing document geometry", () => {
  assert.doesNotMatch(styles, /button:active[^\{]*\{[^}]*transform\s*:/is);
  assert.match(styles, /button:active[^\{]*\{[^}]*filter:\s*brightness/is);
});

test("mounts the redesigned workspace only after the host confirms fullscreen", () => {
  assert.match(
    app,
    /const isFullscreenLayout = presentationDiagnostic\.actualDisplayMode === "fullscreen";/,
  );
  assert.match(app, /if \(isFullscreenLayout\) \{\s*return \(\s*<main className="fullscreen-workspace"/s);
  assert.match(styles, /\.fullscreen-workspace\s*\{/);
});

test("keeps the fullscreen workspace aligned to the OMI desktop shell", () => {
  const fullscreenStart = app.indexOf("if (isFullscreenLayout)");
  const inlineStart = app.indexOf('className={`dashboard-shell', fullscreenStart);
  assert.notEqual(fullscreenStart, -1);
  assert.notEqual(inlineStart, -1);
  const fullscreenBranch = app.slice(fullscreenStart, inlineStart);

  assert.match(fullscreenBranch, /fullscreen-sidebar/);
  assert.match(fullscreenBranch, /<FullscreenMarketOverview/);
  assert.match(fullscreenBranch, /fullscreen-research-layout/);
  assert.match(fullscreenBranch, /fullscreen-insight-panel/);
  assert.match(styles, /grid-template-columns:\s*300px minmax\(0, 1fr\)/);
});

test("keeps the fullscreen workspace read-only while broker and US contracts are pending", () => {
  const fullscreenStart = app.indexOf("if (isFullscreenLayout)");
  const inlineStart = app.indexOf('className={`dashboard-shell', fullscreenStart);
  assert.notEqual(fullscreenStart, -1);
  assert.notEqual(inlineStart, -1);
  const fullscreenBranch = app.slice(fullscreenStart, inlineStart);

  assert.doesNotMatch(fullscreenBranch, /<OrderShell/);
  assert.doesNotMatch(fullscreenBranch, /fullscreen-execution-rail/);
  assert.match(fullscreenBranch, /fullscreen-broker-reserve/);
  assert.match(fullscreenBranch, /美股 dashboard contract 尚未接通/);
  assert.match(app, /台股／美股公司事件尚未加入這個 widget 的唯讀契約/);
});

test("restores backend-owned today daily weekly and monthly K-line navigation", () => {
  assert.match(app, /key: "today", label: "今日"/);
  assert.match(app, /key: "daily", label: "日 K"/);
  assert.match(app, /key: "weekly", label: "週 K"/);
  assert.match(app, /key: "monthly", label: "月 K"/);
  assert.match(app, /omi\.read_tw_stock_dashboard_detail/);
  assert.match(app, /\{ stock_id: stockId, timeframe, bars: DETAIL_BARS\[timeframe\] \}/);
  assert.match(app, /omi\.tw_stock_dashboard_detail\.v2/);
  assert.match(app, /const resultError = toolResultError\(response\)/);
});

test("uses the original chart engine for pan zoom crosshair and volume", () => {
  assert.match(packageJson, /"lightweight-charts": "5\.2\.0"/);
  assert.match(chart, /CandlestickSeries/);
  assert.match(chart, /HistogramSeries/);
  assert.match(chart, /CrosshairMode\.MagnetOHLC/);
  assert.match(chart, /pressedMouseMove: true/);
  assert.match(chart, /mouseWheel: true/);
  assert.match(chart, /tickMarkFormatter/);
  assert.match(chart, /pinch: true/);
  assert.match(chart, /title: "成交量"/);
  assert.match(chart, /setVisibleLogicalRange/);
});

test("keeps watchlist selection independent from expansion and scrolling", () => {
  const selectStart = app.indexOf("const selectWatchlistGroup");
  const toggleStart = app.indexOf("const toggleWatchlistGroup", selectStart);
  assert.notEqual(selectStart, -1);
  assert.notEqual(toggleStart, -1);
  const selectHandler = app.slice(selectStart, toggleStart);

  assert.match(app, /useState<Set<number>>\(new Set\(\)\)/);
  assert.match(selectHandler, /setSelectedWatchlistGroupId\(groupId\)/);
  assert.doesNotMatch(selectHandler, /setExpandedWatchlistGroupIds/);
  assert.doesNotMatch(app, /lastExpandedWatchlistGroupIdRef/);
  assert.doesNotMatch(app, /findWatchlistGroupPath/);
  assert.doesNotMatch(app, /tree\.scrollTop\s*[+-]=/);
});
