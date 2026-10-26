import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketCards, sessionLabel, changeTone } from "./workspace-market";
import { SourceDetails } from "./workspace-evidence";
import { WorkspaceApp } from "./WorkspaceApp";
import type { McpAppsBridge } from "./bridge";
import type { UnknownRecord } from "./state";

const data = {
  session: { presentation_state: "previous_session", trade_date: "2026-10-08" },
  freshness: { status: "latest_completed_session" },
  resolved_indices: [
    { index_id: "TPEX", value: 426.71, change: -3.75, change_pct: -0.87116, status: "complete", authority: "derived_proxy" },
    { index_id: "TAIEX", value: 49313.44, change: -492.93, change_pct: -0.9897, status: "complete", authority: "official_exchange" },
  ],
  resolved_breadth: {
    TWSE: { status: "partial", advance: 417, decline: 523, unchanged: 104, unknown: 36, coverage: 1044, universe: 1080 },
    TPEX: { status: "partial", advance: 319, decline: 382, unchanged: 80, unknown: 106, coverage: 781, universe: 887 },
  },
};
const render = (value: UnknownRecord | null = data, overrides = {}) => renderToStaticMarkup(createElement(MarketCards, { pane: { data: value, dataKey: "header", loading: false, error: null, retry() {}, ...overrides } }));
const cards = (html: string) => html.match(/<section\b[\s\S]*?<\/section>/g) ?? [];

test("independent compact market cards pair index and breadth, with right aligned values", () => {
  const [taiex, tpex] = cards(render());
  assert.ok(taiex && tpex);
  assert.equal(cards(render()).length, 2);
  assert.match(taiex, /49,313\.44/); assert.match(taiex, /-492\.93 \/ -0\.99%/);
  assert.match(taiex, /TWSE 市場廣度/); assert.match(taiex, /<dt>漲<\/dt><dd>417/);
  assert.match(taiex, /覆蓋 1,044 \/ 1,080/);
  assert.match(tpex, /426\.71/); assert.match(tpex, /<dt>漲<\/dt><dd>319/);
  assert.match(tpex, /覆蓋 781 \/ 887/); assert.match(tpex, /代理指數/);
  assert.doesNotMatch(taiex, /代理指數|426\.71/);
  for (const card of [taiex, tpex]) {
    assert.match(card, /廣度：部分受限/); assert.match(card, /10\/08 前一交易日/);
    assert.match(card, /workspace-down/);
    assert.doesNotMatch(card, /complete|partial|previous_session|derived_proxy|official_exchange|<pre|<details/);
  }
});

test("missing values remain missing; explicit zero remains zero", () => {
  for (const value of [null, {}, { resolved_indices: [null, { index_id: "OTHER", value: 123 }], resolved_breadth: null }]) {
    for (const card of cards(render(value))) {
      assert.match(card, /指數：尚無資料/); assert.match(card, /廣度：尚無資料/);
      assert.match(card, /覆蓋 — \/ —/); assert.doesNotMatch(card, /123|NaN|undefined|ready|complete|—%/);
    }
  }
  const [taiex] = cards(render({ resolved_indices: [{ index_id: "TAIEX", value: NaN, change: 0, change_pct: 0, status: "unavailable" }], resolved_breadth: { TWSE: { status: "missing", advance: 0 } } }));
  assert.ok(taiex);
  assert.match(taiex, /<strong>—<\/strong>/); assert.match(taiex, /漲跌 0 \/ 0%/);
  assert.match(taiex, /<dt>漲<\/dt><dd>0/); assert.match(taiex, /部分受限/);
});

test("each market shows its own degradation; full sources and errors belong to shared details", () => {
  const value = { ...data, resolved_indices: [{ ...data.resolved_indices[1], freshness_status: "stale" }, data.resolved_indices[0]],
    resolved_breadth: { ...data.resolved_breadth, TPEX: { ...data.resolved_breadth.TPEX, status: "blocked" } },
    warnings: ["DETAIL_ONLY"], source: "HEADER_SOURCE", generated_at: "2026-10-09T10:00:00+08:00" };
  const [taiex, tpex] = cards(render(value));
  assert.ok(taiex && tpex);
  assert.match(taiex, /指數：資料過期/); assert.match(taiex, /廣度：部分受限/);
  assert.match(tpex, /廣度：存取受限/); assert.doesNotMatch(tpex, /資料過期/);
  const html = render(value, { error: "header timeout", loading: true });
  for (const card of cards(html)) {
    assert.match(card, /aria-busy="true"/); assert.match(card, /role="alert"[^>]*>讀取失敗 · 保留上次結果/);
    assert.doesNotMatch(card, /header timeout|DETAIL_ONLY|HEADER_SOURCE|2026-10-09|stale|blocked/);
  }
  const expanded = renderToStaticMarkup(createElement(SourceDetails, { source: { id: "header", name: "市場", pane: { data: value, key: "new", dataKey: "old", error: "header timeout", loading: false } } }));
  for (const text of ["header timeout", "DETAIL_ONLY", "HEADER_SOURCE", "2026-10-09", "stale", "blocked", "TAIEX", "TPEX", "derived_proxy", "official_exchange"]) assert.ok(expanded.includes(text), text);
  assert.doesNotMatch(expanded, /<pre/);
});

test("session text maps only explicit backend fields, including unknown phases", () => {
  assert.equal(sessionLabel({ trade_date: "2026-10-08", phase: "market_closed" }), "10/08 收盤");
  assert.equal(sessionLabel({ trade_date: "2026-10-08", phase: "unrecognized" }), "10/08 時段未確認");
  assert.equal(sessionLabel({}), "交易日未提供 時段未確認");
});

test("each explicit index risk stays short and local without changing sign or missing values", () => {
  for (const [status, notice] of [["stale", "資料過期"], ["partial", "部分受限"], ["missing", "部分受限"], ["unavailable", "部分受限"], ["error", "讀取失敗"], ["unknown", "狀態未確認"], ["decision_unusable", "不可供決策"]]) {
    const [taiex, tpex] = cards(render({ ...data, resolved_indices: [{ ...data.resolved_indices[1], status }, data.resolved_indices[0]] }));
    assert.ok(taiex && tpex);
    assert.ok(taiex.includes(`指數：${notice}`));
    assert.doesNotMatch(tpex, /指數：/);
    assert.ok(!taiex.includes(status!));
  }
  assert.equal(changeTone(1), "workspace-up");
  assert.equal(changeTone(-1), "workspace-down");
  for (const value of [0, null, undefined, NaN, Infinity, "1"]) assert.equal(changeTone(value), "");
});

test("workspace grid owns sidebar, exactly two cards, chart and synthetic context", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { openai: {} } });
  try {
    const bridge = { getPresentationDiagnostic: () => ({ actualDisplayMode: "inline" }) } as unknown as McpAppsBridge;
    const html = renderToStaticMarkup(createElement(WorkspaceApp, { bridge }));
    assert.match(html, /class="workspace-columns"><aside class="workspace-watchlist"/);
    assert.match(html, /<\/aside><div class="workspace-market-cards"/);
    assert.equal((html.match(/class="workspace-pane workspace-market-card"/g) ?? []).length, 2);
    assert.doesNotMatch(html, /aria-label="市場概況"|class="workspace-market"/);
    assert.match(html, /workspace-chart-pane/);
    assert.match(html, /委託 · SYNTHETIC/);
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("CSS declares shared top edge, bounded flexible sidebar and responsive fallbacks", () => {
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  assert.match(css, /grid-template-areas: "sidebar market market" "sidebar chart context"/);
  assert.match(css, /\.workspace-columns \{[^}]*grid-template-columns: clamp\(210px, 18vw, 260px\) minmax\(0, 1fr\) 360px;/);
  assert.match(css, /\.workspace-market-cards \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(min-width: 651px\)/);
  assert.match(css, /\.workspace-watchlist \{ height: 820px;/);
  assert.match(css, /workspace-group-navigation \{ flex: 1 1 0; min-height: 0/);
  assert.match(css, /workspace-group-scroll \{ flex: 1; min-height: 0; max-height: none/);
  assert.match(css, /max-width: 1150px[\s\S]*?"sidebar market" "sidebar chart" "sidebar context"/);
  assert.match(css, /max-width: 650px[\s\S]*?"market" "sidebar" "chart" "context"/);
  assert.match(css, /\.workspace-watchlist \{ position: static; height: auto/);
  assert.match(css, /\.workspace-chart-pane \.interactive-chart-shell \{ height: 420px/);
});

test("text tree overrides generic button boxes, with neutral selection and visible focus", () => {
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  for (const selector of [".tw-workspace .workspace-stock", ".tw-workspace .workspace-group-row > button"]) {
    const rule = css.slice(css.indexOf(`${selector} {`)).split("}")[0];
    assert.match(rule, /border: 0; border-radius: 0; background: transparent/);
  }
  assert.match(css, /workspace-group-tree \.workspace-group-tree \{[^}]*border-left: 1px/);
  assert.match(css, /workspace-stock\[aria-pressed="true"\] \{ background: #142234; box-shadow: inset 2px 0 var\(--blue\)/);
  assert.match(css, /:focus-visible \{ outline: 2px solid var\(--blue\); outline-offset: 2px/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /padding: 4px 4px 16px; scroll-padding-block: 72px 20px/);
  assert.doesNotMatch(css, /scroll-snap/);
});

test("market source retains strict UTF-8 and all reads retain their existing cadence and boundary", () => {
  for (const name of ["workspace-market.tsx", "workspace-market.test.ts"]) {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(new URL(`./${name}`, import.meta.url)));
    assert.ok(!source.includes(String.fromCharCode(0xfffd)));
  }
  const source = readFileSync(new URL("./WorkspaceApp.tsx", import.meta.url), "utf8");
  assert.match(source, /omi_read_tw_workspace_header", \{\}, 30_000/);
  assert.match(source, /include_watchlist_children: false, watchlist_limit: 100/);
  assert.match(source, /30_000, "omi.tw_workspace_watchlist"/);
  assert.match(source, /30_000, "omi.tw_stock_chart"/);
  assert.match(source, /120_000, "omi.tw_stock_research"/);
  const market = readFileSync(new URL("./workspace-market.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(market, /fetch\(|callTool\(|Date\(|place_order|broker/);
});
