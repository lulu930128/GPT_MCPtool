import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HoldingsList, WorkspaceApp } from "./WorkspaceApp";
import { StatusBadge, WorkspaceStatusPanel, SourceDetails, LazyDetails, collectDiagnostics } from "./workspace-evidence";
import { GroupNavigation, SelectedGroupItems, hasContentBelow, observeGroupOverflow, revealGroup } from "./workspace-navigation";
import { holdingsArgs, parseHoldings, readHoldingsEnvelope } from "./workspace-holdings";
import { buildWatchlistTree, findWatchlistGroupPath, type UnknownRecord } from "./state";
import { PaneLoader } from "./workspace-state";
import type { McpAppsBridge } from "./bridge";

test("workspace source and tests retain strict UTF-8 Chinese text without replacement characters", () => {
  for (const name of ["WorkspaceApp.tsx", "workspace-navigation.tsx", "workspace-evidence.tsx", "workspace-ui.test.ts", "workspace-navigation-interaction.test.ts", "styles.css"]) {
    const raw = readFileSync(new URL(`./${name}`, import.meta.url));
    const source = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    assert.ok(!source.includes(String.fromCharCode(0xfffd)), name);
    assert.doesNotMatch(source, /\?{3,}/, name);
  }
  const source = readFileSync(new URL("./workspace-ui.test.ts", import.meta.url), "utf8");
  for (const original of ["\u53f0\u7a4d\u96fb", "\u806f\u96fb", "\u4e16\u754c", "\u529b\u7a4d\u96fb", "\u534a\u5c0e\u9ad4\u88fd\u9020\uff0f\u6676\u5713\u4ee3\u5de5"]) {
    assert.ok(source.includes(original), `Missing original UTF-8 text: ${original}`);
  }
});

const holding = { market: "TW", symbol: "2330", display_name: "台積電", quantity: 12345, cost_amount: 987654, price_as_of: "2026-10-07", price_resolved_status: "stale", source: "recorded", price_source: "cache" };
function envelope(rows: unknown = [holding], capability: UnknownRecord = {}): UnknownRecord {
  return { contract_version: "omi.decision.v4", ok: true, request_status: "completed", evidence: {
    manifest: { capabilities: [{ capability: "portfolio.holdings", status: "ready", payload_included: true, ...capability }] },
    data: { "portfolio.holdings": rows },
  } };
}

test("portfolio request is exactly the bounded read-only bridge request", () => {
  assert.deepEqual(holdingsArgs(), {
    question: "讀取已記錄的台股持股清單，只作前端顯示；不得同步或更新",
    target: { type: "portfolio" }, mode: "data_only", output: "evidence_only",
    selection: { include: ["portfolio.holdings"], limits: { "portfolio.holdings": 20 } },
    realtime_policy: "cache_only", refresh_policy: { mode: "off", before_answer: false, fallback_to_cached: true },
    tool_budget: { max_calls: 1, max_external_fetches: 0, max_total_seconds: 12 },
    payload_level: "compact", refresh_if_missing: false,
  });
  assert.notEqual(holdingsArgs(), holdingsArgs());
});

test("holdings parses v4 structured content and only projects TW identity and provenance", () => {
  const data = envelope([holding, { ...holding, market: "tw", symbol: "2317" }, { market: "US", symbol: "AAPL" }]);
  assert.equal(readHoldingsEnvelope({ structuredContent: data }), data);
  const view = parseHoldings(data);
  assert.deepEqual(view.items.map((row) => row.symbol), ["2330", "2317"]);
  assert.equal(view.items[0].name, "台積電");
  assert.equal(view.excludedCount, 1);
  assert.equal(view.state, "available");
  assert.doesNotMatch(JSON.stringify(view.items), /quantity|cost_amount|987654/);
});

test("successful empty holdings differs from missing, malformed, denied and transport failure", () => {
  assert.equal(parseHoldings(envelope([])).state, "empty");
  for (const data of [envelope(null), envelope([], { status: "forbidden" }), envelope([], { status: "unknown" }), envelope([], { payload_included: false }), { ...envelope([]), ok: false }, { ...envelope([]), request_status: "rejected" }]) {
    assert.equal(parseHoldings(data).state, "unavailable");
    assert.equal(parseHoldings(data).items.length, 0);
  }
  assert.throws(() => readHoldingsEnvelope({ isError: true, structuredContent: envelope() }), /失敗或禁止/);
  assert.throws(() => readHoldingsEnvelope({ contract_version: "omi.decision.v3" }), /格式不符/);
});

test("partial, stale, malformed and truncated holdings cannot claim a complete empty list", () => {
  for (const data of [envelope([], { status: "partial" }), envelope([], { status: "stale" }), envelope([], { truncated: true }), envelope([null, { market: "TW" }]), envelope([], { canonical_available_count: 5 })]) {
    assert.equal(parseHoldings(data).state, "partial");
  }
  assert.equal(parseHoldings(envelope([null, { market: "TW" }])).invalidCount, 2);
  const atLimit = parseHoldings(envelope(Array.from({ length: 20 }, () => holding)));
  assert.equal(atLimit.atLimit, true);
  assert.equal(atLimit.state, "partial");
  assert.equal(atLimit.truncated, false);
});

test("holding rows preserve stock and critical price status; provenance stays in pane evidence", () => {
  const html = renderToStaticMarkup(createElement(HoldingsList, { data: envelope(), selected: "2330", select: () => {} }));
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /台積電/);
  assert.match(html, /資料過期/);
  assert.doesNotMatch(html, /stale/);
  assert.doesNotMatch(html, /2026-10-07|recorded|cache/);
  assert.doesNotMatch(html, /12345|987654|cost_amount|quantity/);
  const empty = renderToStaticMarkup(createElement(HoldingsList, { data: envelope([]), select: () => {} }));
  const missing = renderToStaticMarkup(createElement(HoldingsList, { data: envelope(null), select: () => {} }));
  assert.match(empty, /沒有已記錄台股持股/);
  assert.match(missing, /無法確認持股/);
  assert.doesNotMatch(missing, /沒有已記錄台股持股/);
});

test("rendered sidebar has one hierarchy owner after search and holdings", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { openai: {} } });
  try {
    const bridge = { getPresentationDiagnostic: () => ({ actualDisplayMode: "inline" }) } as unknown as McpAppsBridge;
    const html = renderToStaticMarkup(createElement(WorkspaceApp, { bridge }));
    assert.doesNotMatch(html, /當前自選群組股票|workspace-stock-scroll/);
    const positions = ["搜尋台股", "OMI 已記錄台股持股", "自選族群與個股"].map((name) => html.indexOf(`aria-label="${name}"`));
    assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])));
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("holdings retain provenance in their data projection but only show degraded status on rows", () => {
  const identity = { market: "TW", symbol: "2330", display_name: "台積電" };
  for (const fields of [{}, { source: " ", price_resolved_status: null, price_as_of: "", price_source: 123 }]) {
    const html = renderToStaticMarkup(createElement(HoldingsList, { data: envelope([{ ...identity, ...fields }]), selected: "2330", select: () => {} }));
    assert.match(html, /2330 台積電/);
    assert.match(html, /aria-pressed="true"/);
    assert.doesNotMatch(html, /記錄來源|價格資料|unknown|時間未提供|來源未提供/);
  }
  for (const [field, value, expected] of [
    ["source", "recorded", "記錄來源 recorded"],
    ["price_as_of", "2026-10-07", "價格資料 2026-10-07"],
    ["price_source", "cache", "價格資料 cache"],
    ["price_resolved_status", "stale", "價格：資料過期"],
    ["price_resolved_status", "unknown", "價格：狀態未確認"],
  ]) {
    const html = renderToStaticMarkup(createElement(HoldingsList, { data: envelope([{ ...identity, [field]: value }]), select: () => {} }));
    assert.equal(parseHoldings(envelope([{ ...identity, [field]: value }])).items.length, 1);
    if (field === "price_resolved_status") assert.ok(html.includes(expected));
    else assert.ok(!html.includes(expected));
    assert.doesNotMatch(html, /時間未提供|來源未提供| · <\/small>/);
  }
});

const groups = [
  { group_id: 1, group_name: "科技／電子" },
  { group_id: 45, group_name: "半導體製造／晶圓代工", parent_id: 1 },
  { group_id: 46, group_name: "其他", parent_id: 1 },
];
const stockItems = [
  ["2330", "台積電"], ["2303", "聯電"], ["5347", "世界"], ["6770", "力積電"],
].map(([stock_id, stock_name]) => ({ stock_id, stock_name, status: "ready", freshness_status: "current", price_semantics: "official_close" }));
const watchlistData = { groups, selection: { group_id: 45 }, items: stockItems };
const readyPane = { data: watchlistData, key: "45", dataKey: "45", loading: false, error: null, retry() {} };
const stockSelection = { selectedStock: "2330", selectStock() {} };

test("selected group 45 opens its ancestor path and owns all four stocks before its sibling", () => {
  assert.deepEqual(findWatchlistGroupPath(buildWatchlistTree(groups), 45), [1, 45]);
  const html = renderToStaticMarkup(createElement(GroupNavigation, { pane: readyPane, selected: 45, select() {}, ...stockSelection }));
  assert.match(html, /aria-expanded="true" aria-controls="workspace-group-children-1"/);
  assert.match(html, /<div id="workspace-group-children-1">/);
  assert.equal((html.match(/class="workspace-group-toggle"/g) ?? []).length, 1);
  assert.equal((html.match(/>科技／電子<\/button>/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<summary>.*科技／電子/);
  assert.match(html, /aria-label="收合 科技／電子 子群組"/);
  assert.match(html, /<span class="workspace-group-spacer" aria-hidden="true"><\/span><button type="button" data-group-id="45"/);
  const selected = html.indexOf('data-group-node="45"');
  const sibling = html.indexOf('data-group-node="46"');
  for (const item of stockItems) {
    const at = html.indexOf(`${item.stock_id} ${item.stock_name}`);
    assert.ok(at > selected && at < sibling);
  }
  assert.equal((html.match(/class="workspace-group-items"/g) ?? []).length, 1);
  assert.equal((html.match(/class="workspace-group-scroll"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /workspace-stock-scroll/);
  assert.doesNotMatch(html, /official_close|current|ready/);
  let symbol = "";
  const rows = SelectedGroupItems({ pane: readyPane, selected: 45, selectStock(value) { symbol = value; } }).props.children[4];
  rows[1].props.onClick();
  assert.equal(symbol, "2303");
});

test("selection guard hides retained rows before effects, on mismatch, pending and failed switching", () => {
  for (const pane of [
    { ...readyPane, key: "46" },
    { ...readyPane, key: "46", loading: true },
    { ...readyPane, key: "46", error: "exact backend error at 2026-10-09" },
    { ...readyPane, dataKey: "46", key: "46" },
  ]) {
    const html = renderToStaticMarkup(createElement(SelectedGroupItems, { pane, selected: 46, ...stockSelection }));
    assert.doesNotMatch(html, /台積電|聯電|世界|力積電|<button/);
    if (pane.error) {
      assert.match(html, /role="alert"[^>]*>讀取失敗/);
      assert.doesNotMatch(html, /exact backend error/);
      assert.match(renderToStaticMarkup(createElement(SourceDetails, { source: { id: "watchlist", name: "自選", pane } })), /exact backend error at 2026-10-09/);
    }
    else assert.match(html, /讀取此群組中/);
  }
});

test("late group results and errors cannot displace the active node; empty and truncated stay inline", async () => {
  const loader = new PaneLoader(() => {});
  await loader.load("45", async () => watchlistData);
  let resolve!: (data: UnknownRecord) => void;
  const late = loader.load("46", () => new Promise((done) => { resolve = done; }));
  const empty = { groups, selection: { group_id: 45, truncated: true }, items: [], status: "partial" };
  await loader.load("45", async () => empty);
  resolve({ selection: { group_id: 46 }, items: [{ stock_id: "WRONG" }] }); await late;
  let reject!: (error: Error) => void;
  const failed = loader.load("46", () => new Promise((_, fail) => { reject = fail; }));
  await loader.load("45", async () => empty);
  reject(new Error("late group error")); await failed;
  const html = renderToStaticMarkup(createElement(GroupNavigation, { pane: { ...loader.state, key: "45", retry() {} }, selected: 45, select() {}, ...stockSelection }));
  assert.doesNotMatch(html, /WRONG|late group error/);
  assert.match(html, /清單已截斷/);
  assert.match(html, /本次回傳沒有直接標的/);
  assert.ok(html.indexOf("清單已截斷") > html.indexOf('data-group-node="45"'));
  assert.equal(loader.state.error, null);
});

test("same-group polling failure retains accurately labelled rows and retry", () => {
  const html = renderToStaticMarkup(createElement(GroupNavigation, { pane: { ...readyPane, error: "timeout" }, selected: 45, select() {}, ...stockSelection }));
  assert.match(html, /讀取失敗 · 保留此群組上次結果/);
  assert.doesNotMatch(html, /timeout/);
  assert.match(html, /重試/);
  assert.match(html, /2330 台積電/);
});

test("77 groups share one bounded viewport, sticky heading and accessible controls", () => {
  const groups = Array.from({ length: 77 }, (_, i) => ({ group_id: i + 1, group_name: `Group ${i + 1}`, sort_order: i }));
  const pane = { ...readyPane, data: { ...watchlistData, groups } };
  const html = renderToStaticMarkup(createElement(GroupNavigation, { pane, selected: 45, select() {}, ...stockSelection }));
  assert.equal((html.match(/data-group-id=/g) ?? []).length, 77);
  assert.equal((html.match(/class="workspace-group-scroll"/g) ?? []).length, 1);
  assert.match(html, /tabindex="0"/);
  const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.workspace-group-scroll \{[^}]*height: 400px;[^}]*overflow-y: auto/);
  assert.match(styles, /\.workspace-group-heading \{[^}]*position: sticky/);
  assert.match(styles, /data-more-below="true"[^}]*opacity: 1/);
  assert.match(styles, /:focus-visible \{ outline: 2px/);
  assert.doesNotMatch(styles, /scroll-snap|parallax/);
});

test("selection visibility adjusts only inner scroll and does nothing for visible rows", () => {
  const viewport = { scrollTop: 200, getBoundingClientRect: () => ({ top: 100, bottom: 500 }) } as HTMLElement;
  const row = (top: number, bottom: number) => ({ getBoundingClientRect: () => ({ top, bottom }) }) as HTMLElement;
  revealGroup(viewport, row(200, 240), 50); assert.equal(viewport.scrollTop, 200);
  revealGroup(viewport, row(120, 150), 50); assert.equal(viewport.scrollTop, 166);
  revealGroup(viewport, row(500, 530), 50); assert.equal(viewport.scrollTop, 212);
});

test("fade is absent for short/hidden lists and bottom, and returns on reverse scroll", () => {
  assert.equal(hasContentBelow({ scrollHeight: 100, clientHeight: 280, scrollTop: 0 }), false);
  assert.equal(hasContentBelow({ scrollHeight: 1000, clientHeight: 0, scrollTop: 0 }), false);
  assert.equal(hasContentBelow({ scrollHeight: 1000, clientHeight: 280, scrollTop: 0 }), true);
  assert.equal(hasContentBelow({ scrollHeight: 1000, clientHeight: 280, scrollTop: 719.5 }), false);
  assert.equal(hasContentBelow({ scrollHeight: 1000, clientHeight: 280, scrollTop: 700 }), true);
});

test("overflow observer tracks resize and nested toggles and cleans up listeners", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  let resize!: () => void;
  let disconnected = false;
  const observed: unknown[] = [];
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class {
    constructor(callback: () => void) { resize = callback; }
    observe(value: unknown) { observed.push(value); }
    disconnect() { disconnected = true; }
  } });
  try {
    const viewport = Object.assign(new EventTarget(), { scrollHeight: 1000, clientHeight: 280, scrollTop: 0 });
    const content = {} as HTMLElement;
    const updates: boolean[] = [];
    const cleanup = observeGroupOverflow(viewport as unknown as HTMLElement, content, (value) => updates.push(value));
    assert.deepEqual(observed, [viewport, content]);
    viewport.scrollTop = 720; viewport.dispatchEvent(new Event("scroll"));
    viewport.scrollTop = 0; viewport.dispatchEvent(new Event("scroll"));
    viewport.scrollHeight = 200; viewport.dispatchEvent(new Event("toggle"));
    viewport.clientHeight = 100; resize();
    assert.deepEqual(updates, [true, false, true, false, true]);
    cleanup();
    viewport.dispatchEvent(new Event("scroll"));
    assert.equal(updates.length, 5);
    assert.equal(disconnected, true);
  } finally {
    if (original) Object.defineProperty(globalThis, "ResizeObserver", original);
    else Reflect.deleteProperty(globalThis, "ResizeObserver");
  }
});

test("1200 diagnostics stay lazy inside one closed evidence disclosure with critical indicators", () => {
  const data = { status: "partial", freshness: { status: "stale" }, warnings: Array.from({ length: 1200 }, (_, i) => `diagnostic-${i}`), nested: { missing: ["missing-field"], reason_code: "STALE" } };
  const notices = collectDiagnostics(data);
  assert.equal(notices.length, 1202);
  assert.equal(notices[1199].value, "diagnostic-1199");
  assert.equal(notices[1200].path, "nested.missing");
  const html = renderToStaticMarkup(createElement(WorkspaceStatusPanel, { sources: [{ id: "header", name: "市場", pane: { data, key: "header", dataKey: "header", loading: false, error: null } }] }));
  assert.match(html, /部分受限 1/);
  assert.equal((html.match(/<details/g) ?? []).length, 1);
  const badge = renderToStaticMarkup(createElement(StatusBadge, { data }));
  assert.match(badge, /部分受限/);
  assert.match(badge, /資料過期/);
  assert.doesNotMatch(badge, /partial|stale|1202 項/);
  assert.doesNotMatch(html, /diagnostic-0|<pre|資料時間 |freshness | open=/);
  assert.ok(html.length < 1500);
});

test("closed evidence does not evaluate expensive content or serialize raw payload", () => {
  const html = renderToStaticMarkup(createElement(LazyDetails, { summary: "raw", children: () => { throw new Error("closed child evaluated"); } }));
  assert.equal(html, "<details><summary>raw</summary></details>");
  const data = { status: "partial", toJSON: () => { throw new Error("raw serialization"); } };
  assert.doesNotThrow(() => renderToStaticMarkup(createElement(WorkspaceStatusPanel, { sources: [{ id: "header", name: "市場", pane: { data, key: "header", dataKey: "header", loading: false, error: null } }] })));
});

test("every explicit degraded nested status remains visible while timestamps/source/raw stay closed", () => {
  for (const status of ["partial", "stale", "missing", "blocked", "error", "unavailable", "forbidden", "unknown"]) {
    const data = { status: "ready", generated_at: "2026-10-09", nested: { freshness_status: status, source: "private-source-detail" } };
    const html = renderToStaticMarkup(createElement(StatusBadge, { data }));
    assert.doesNotMatch(html, new RegExp(status));
    assert.match(html, /部分受限|資料過期|存取受限|讀取失敗|狀態未確認/);
    const expanded = renderToStaticMarkup(createElement(SourceDetails, { source: { id: "test", name: "測試", pane: { data, key: "test", dataKey: "test", error: null, loading: false } } }));
    assert.ok(expanded.includes(status));
    assert.match(html, /role="status"/);
    assert.doesNotMatch(html, /2026-10-09|private-source-detail|<pre|open=/);
  }
  const ready = renderToStaticMarkup(createElement(StatusBadge, { data: { status: "ready", freshness: { status: "fresh" } } }));
  assert.doesNotMatch(ready, /role="status"|ready|fresh/);
});
