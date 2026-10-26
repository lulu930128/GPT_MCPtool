// Offline synthetic host: no backend/provider requests and no real portfolio data.
import { createRoot } from "react-dom/client";
import { WorkspaceApp } from "../src/WorkspaceApp";
import { McpAppsBridge } from "../src/bridge";
import { holdingsArgs } from "../src/workspace-holdings";
import styles from "../src/styles.css";

const style = document.createElement("style"); style.textContent = styles; document.head.append(style);
document.documentElement.dataset.omiWorkspace = "true";
declare global {
  interface Window {
    workspaceFixtureTool?: (params: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>;
    workspaceFeedback?: (phase: string) => Promise<void>;
  }
}
const feedback = async (phase: string) => { await window.parent.workspaceFeedback?.(phase); };
const calls: { name: string; arguments: Record<string, unknown> }[] = [];
const groups = Array.from({ length: 77 }, (_, i) => ({ group_id: i + 1, group_name: i === 0 ? "科技／電子" : i === 44 ? "半導體製造／晶圓代工" : `Fixture 群組 ${i + 1}`, parent_id: i === 44 ? 1 : null, sort_order: i }));
const stocks = [["2330", "台積電"], ["2303", "聯電"], ["5347", "世界"], ["6770", "力積電"]].map(([stock_id, stock_name]) => ({ stock_id, stock_name, status: "ready", freshness_status: "current", price_semantics: "official_close" }));
const warnings = Array.from({ length: 1200 }, (_, i) => `fixture-warning-${i}`);
let portfolioMode = "ready";
function tool(name: string, args: Record<string, unknown>) {
  if (name === "omi_ask") return { contract_version: "omi.decision.v4", ok: portfolioMode !== "denied", request_status: portfolioMode === "denied" ? "rejected" : "completed",
    evidence: { manifest: { capabilities: [{ capability: "portfolio.holdings", status: portfolioMode === "denied" ? "forbidden" : "ready", payload_included: portfolioMode !== "denied" }] },
      data: { "portfolio.holdings": portfolioMode === "empty" ? [] : [{ market: "TW", symbol: "2330", display_name: "測試台股", price_as_of: "2026-10-07" }] } } };
  const kind = name.replace(/^omi_read_/, "omi.");
  const base = { kind, version: `${kind}.v1`, status: "partial", freshness: { status: "stale" }, generated_at: "2026-10-08", ...args };
  if (name === "omi_read_tw_workspace_header") return { ...base, warnings,
    session: { presentation_state: "previous_session", trade_date: "2026-10-08" },
    resolved_indices: [{ index_id: "TAIEX", value: 49313.44, change: -492.93, change_pct: -0.9897, status: "complete", authority: "official_exchange" }, { index_id: "TPEX", value: 426.71, change: -3.75, change_pct: -0.87116, status: "complete", authority: "derived_proxy" }],
    resolved_breadth: { TWSE: { status: "partial", advance: 417, decline: 523, unchanged: 104, unknown: 36, coverage: 1044, universe: 1080 }, TPEX: { status: "partial", advance: 319, decline: 382, unchanged: 80, unknown: 106, coverage: 781, universe: 887 } },
  };
  if (name === "omi_read_tw_workspace_watchlist") return { ...base, groups, selection: { group_id: args.watchlist_group_id ?? 45, group_name: "當前 Fixture", truncated: args.watchlist_group_id === 47 }, items: args.watchlist_group_id === 47 ? [] : args.watchlist_group_id === 46 ? [{ stock_id: "2317", stock_name: "測試自選" }] : stocks };
  if (name === "omi_read_tw_stock_chart") return { ...base,
    chart: { stock_id: args.stock_id, timeframe: args.timeframe, volume_unit: "shares", trade_value_unit: "TWD",
      points: Array.from({ length: 8 }, (_, i) => ({ time: `2026-10-${String(i + 1).padStart(2, "0")}`, open: 100 + i, high: 105 + i, low: 98 + i, close: 103 + i, volume: 1000 + i, trade_value: 1000000 })) },
    moving_averages: [{ time: "2026-10-08", ma5: 100, ma20: 95, ma60: 90 }], warnings };
  if (name === "omi_read_tw_stock_research") return { ...base, technical: {
    title: "測試研究", status: "partial", stock_id: args.stock_id, timeframe: args.timeframe,
    generated_at: "2026-10-09T10:00:00+08:00", data: { daily_indicator: {
      time: "2026-10-08", close: 110, change_pct: 0, rsi: { rsi14: 61.5111 },
      macd: { macd: 40.703, signal: 30.5897, histogram: 10.1133 }, kd: { k9: 83.5116, d9: 85.1391 },
    }, decision_snapshot: "completed" },
  }, warnings };
  if (name === "omi_search_tw_symbols") return { ...base, kind: "omi.tw_symbol_search", version: "omi.tw_symbol_search.v1", items: stocks };
  return base;
}
window.workspaceFixtureTool = async (params) => {
  calls.push(params);
  const result = { structuredContent: tool(params.name, params.arguments) };
  if (params.name === "omi_read_tw_workspace_watchlist" && params.arguments.watchlist_group_id === 46) await new Promise((resolve) => setTimeout(resolve, 500));
  if (params.name === "omi_read_tw_stock_chart" && params.arguments.stock_id === "2303") await new Promise((resolve) => setTimeout(resolve, 500));
  return result;
};
window.addEventListener("message", (event) => {
  const request = event.data;
  if (!request?.method || !request.id) return;
  let result = {};
  if (request.method === "tools/call") {
    calls.push(request.params);
    result = { structuredContent: tool(request.params.name, request.params.arguments) };
  }
  const reply = () => window.postMessage({ jsonrpc: "2.0", id: request.id, result }, "*");
  if ((request.params?.name === "omi_read_tw_workspace_watchlist" && request.params.arguments.watchlist_group_id === 46)
    || (request.params?.name === "omi_read_tw_stock_chart" && request.params.arguments.stock_id === "2303")) setTimeout(reply, 500);
  else reply();
});
const mode = document.documentElement.dataset.fixtureMode;
window.openai = { toolInput: { watchlist_group_id: 45 }, displayMode: mode === "unknown" ? undefined : mode === "fullscreen" || mode === "pip" ? mode : "inline" };
createRoot(document.getElementById("root")!).render(<WorkspaceApp bridge={new McpAppsBridge()} />);

const pause = () => new Promise((resolve) => setTimeout(resolve, 80));
const find = <T extends Element = HTMLElement>(selector: string) => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
};
let checks = 0;
const check = (condition: unknown, name: string) => { if (!condition) throw new Error(name); checks++; };
async function run() {
  for (let i = 0; i < 25 && !document.querySelector(".workspace-holdings button"); i++) await pause();
  await feedback("initialization");
  const sidebar = find(".workspace-watchlist");
  check([...sidebar.children].map((node) => node.getAttribute("aria-label")).join("|") === "搜尋台股|OMI 已記錄台股持股|自選族群與個股|資料狀態／更新狀態", "single hierarchy owner and final status sibling");
  check(!document.querySelector(".workspace-diagnostics, .workspace-source-details pre"), "no closed diagnostics DOM");
  check([...document.querySelectorAll<HTMLDetailsElement>(".workspace-status-panel details")].every((node) => !node.open), "all source evidence initially closed");
  check(!find(".workspace-group-items").textContent?.match(/official_close|current/), "per-stock details initially closed");
  check(!find<HTMLElement>('#workspace-group-children-1').hidden, "selected ancestor opens");
  check([...document.querySelectorAll('[data-group-node="45"] > .workspace-group-items .workspace-stock strong')].map((row) => row.textContent).join("|") === stocks.map((row) => `${row.stock_id} ${row.stock_name}`).join("|"), "exact four stocks within node 45");
  const marketCards = document.querySelectorAll<HTMLElement>(".workspace-market-card");
  check(marketCards.length === 2 && !document.querySelector(".workspace-market"), "exactly two independent market cards");
  for (const card of marketCards) {
    check(!card.textContent?.match(/previous_session|derived_proxy|complete|partial|stale|fixture-warning/), "market diagnostics closed");
    check(card.textContent?.includes("部分受限"), "breadth degradation visible");
    check(getComputedStyle(card.querySelector(".workspace-index-value")!).textAlign === "right", "index aligned right");
    for (const value of card.querySelectorAll("dd")) check(getComputedStyle(value).textAlign === "right", "breadth aligned right");
  }
  const marketBounds = find(".workspace-market-cards").getBoundingClientRect();
  const sidebarBounds = sidebar.getBoundingClientRect();
  if (window.innerWidth > 650) {
    check(Math.abs(sidebarBounds.top - marketBounds.top) < 2, "sidebar shares market top edge");
    check(sidebarBounds.right <= marketBounds.left, "market does not span sidebar");
    check(Math.abs(sidebarBounds.height - 820) < 2, "sidebar height is host-independent");
  }
  if (window.innerWidth > 1150) check(Math.abs(find(".workspace-context").getBoundingClientRect().width - 360) < 2, "desktop preserves M2 360px context");
  else check(find(".workspace-context").getBoundingClientRect().top >= find(".workspace-chart-pane").getBoundingClientRect().bottom, "narrow context follows chart");
  check(Math.abs(marketCards[0]!.getBoundingClientRect().top - marketCards[1]!.getBoundingClientRect().top) < 2, "market cards stay side by side");
  check(!document.querySelector(".workspace-market-card details, .workspace-group-items details"), "no scattered evidence disclosures");
  const warningsDetails = find<HTMLDetailsElement>(".workspace-status-panel > details");
  const statusToggle = find<HTMLElement>(".workspace-status-panel > details > summary");
  statusToggle.focus();
  check(document.activeElement === statusToggle && getComputedStyle(statusToggle).outlineStyle !== "none", "status entry keyboard focus");
  check(!warningsDetails.open, "status initially closed");
  warningsDetails.open = true; await pause();
  const statusScroll = find<HTMLElement>(".workspace-status-scroll");
  check(statusScroll.clientHeight <= 280, "bounded independent status viewport");
  const sourceDetails = find<HTMLDetailsElement>(".workspace-status-scroll > details");
  sourceDetails.open = true; await pause();
  check(document.querySelectorAll(".workspace-diagnostics p").length === 1200, "all diagnostics accessible");
  find<HTMLDetailsElement>(".workspace-source-details details").open = true; await pause();
  check(find(".workspace-source-details pre").textContent?.includes("fixture-warning-1199"), "full raw evidence accessible");
  if (window.innerWidth > 650) check(Math.abs(sidebar.getBoundingClientRect().height - 820) < 2, "expanded evidence cannot grow sidebar");
  await feedback("expanded status evidence");
  warningsDetails.open = false; await pause();
  check(!document.querySelector(".workspace-diagnostics"), "closed diagnostics unmounted");
  const scroll = find<HTMLElement>(".workspace-group-scroll");
  const shell = find<HTMLElement>(".workspace-group-scroll-shell");
  check(scroll.clientHeight <= 820 && scroll.scrollHeight > scroll.clientHeight, "long tree has an independent bounded region");
  check(scroll.getBoundingClientRect().bottom <= sidebar.getBoundingClientRect().bottom + 1, "tree stays inside sidebar");
  for (const selector of ['[data-group-id="46"]', '.workspace-group-items .workspace-stock:not([aria-pressed="true"])']) {
    const style = getComputedStyle(find(selector));
    check(style.borderTopWidth === "0px" && style.backgroundColor === "rgba(0, 0, 0, 0)", "tree rows have no default box");
  }
  check(shell.dataset.moreBelow === "true", "fade at top");
  scroll.scrollTop = scroll.scrollHeight; scroll.dispatchEvent(new Event("scroll")); await pause();
  check(shell.dataset.moreBelow === "false", "no fade at bottom");
  check(Math.abs(find(".workspace-group-heading").getBoundingClientRect().top - scroll.getBoundingClientRect().top) < 6, "heading stays sticky");
  scroll.scrollTop -= 80; scroll.dispatchEvent(new Event("scroll")); await pause();
  check(shell.dataset.moreBelow === "true", "fade on reverse scroll");
  scroll.scrollTop = 0;
  const branch = find<HTMLButtonElement>('[data-group-node="1"] > .workspace-group-row .workspace-group-toggle');
  const before = scroll.scrollHeight;
  branch.click(); await pause();
  check(scroll.scrollHeight < before, "nested collapse");
  branch.click(); await pause();
  check(scroll.scrollHeight === before, "nested expand");
  await feedback("group expansion");
  scroll.style.maxHeight = "100px"; await pause();
  check(scroll.clientHeight === 100 && shell.dataset.moreBelow === "true", "resize observer");
  scroll.style.maxHeight = ""; await pause();
  scroll.focus();
  check(document.activeElement === scroll && getComputedStyle(scroll).outlineStyle !== "none", "keyboard focus ring");
  find<HTMLButtonElement>(".workspace-holdings button").click(); await pause();
  check(calls.some((call) => call.name === "omi_read_tw_stock_chart" && call.arguments.stock_id === "2330"), "holdings shared selection");
  const beforeStockScroll = scroll.scrollTop;
  find<HTMLButtonElement>('[data-group-node="45"] .workspace-stock:nth-of-type(2)').click(); await pause();
  check(find(".workspace-chart-pane .workspace-pending").textContent?.includes("待載入 2303") && find(".workspace-target > strong").textContent?.includes("2330"), "retained chart identity and pending target remain distinct");
  check(calls.some((call) => call.name === "omi_read_tw_stock_research" && call.arguments.stock_id === "2303"), "watchlist shared selection");
  check(scroll.scrollTop === beforeStockScroll, "stock selection does not re-anchor tree");
  check(find("#workspace-order-content").textContent?.includes("2303"), "M2 receives only shared symbol");
  await new Promise((resolve) => setTimeout(resolve, 550));
  await feedback("watchlist stock selection");
  const pageY = window.scrollY;
  find<HTMLButtonElement>('[data-group-id="46"]').click(); await pause();
  check(!document.querySelector(".workspace-group-items .workspace-stock"), "pending switch has no stale stocks");
  check(find('[data-group-node="46"] > .workspace-group-items').textContent?.includes("讀取此群組中"), "loading belongs to new node");
  find<HTMLButtonElement>('[data-group-id="47"]').click(); await pause();
  check(find('[data-group-node="47"] > .workspace-group-items').textContent?.includes("清單已截斷"), "truncated inline");
  check(find('[data-group-node="47"] > .workspace-group-items').textContent?.includes("本次回傳沒有直接標的"), "empty inline");
  await new Promise((resolve) => setTimeout(resolve, 550));
  check(!document.querySelector(".workspace-group-items .workspace-stock"), "late response never replaces selected group");
  check(window.scrollY === pageY, "selection never scrolls document");
  await feedback("group selection and late response");
  branch.click(); await pause();
  // Simulate an external selection arriving through the same group control.
  find<HTMLButtonElement>('[data-group-id="45"]').click(); await pause();
  check(branch.getAttribute("aria-expanded") === "true" && document.querySelectorAll('[data-group-node="45"] .workspace-stock').length === 4, "selection reopens ancestor path");
  const selectedBounds = find('[data-group-id="45"]').getBoundingClientRect();
  check(selectedBounds.top >= find(".workspace-group-heading").getBoundingClientRect().bottom && selectedBounds.bottom <= scroll.getBoundingClientRect().bottom, "selected node visible beneath heading");
  check(calls.filter((call) => call.name === "omi_read_tw_workspace_watchlist").every((call) => call.arguments.include_watchlist_children === false && call.arguments.watchlist_limit === 100), "single direct bounded watchlist request");
  check(JSON.stringify(calls.find((call) => call.name === "omi_ask")?.arguments) === JSON.stringify(holdingsArgs()), "safe bridge arguments");
  const retry = find<HTMLButtonElement>('[aria-label="OMI 已記錄台股持股"] .workspace-pane-heading button');
  portfolioMode = "empty"; retry.click(); await pause();
  check(find(".workspace-holdings").textContent?.includes("沒有已記錄台股持股"), "empty visible");
  portfolioMode = "denied"; retry.click(); await pause();
  check(find(".workspace-holdings").textContent?.includes("無法確認持股") && !document.querySelector(".workspace-holdings button"), "denied fails closed");
  portfolioMode = "ready"; retry.click(); await pause();
  const search = find<HTMLInputElement>("#workspace-search");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "2330");
  search.dispatchEvent(new Event("input", { bubbles: true })); await pause();
  find<HTMLFormElement>(".workspace-watchlist form").requestSubmit(); await pause();
  find<HTMLButtonElement>('[aria-label="搜尋台股"] .workspace-stock').click(); await pause();
  check(!!document.querySelector('[aria-label="圖表技術摘要"]'), "technical summary above chart");
  const summary = find<HTMLElement>('[aria-label="圖表技術摘要"]');
  check(summary.textContent?.includes("61.51") && summary.textContent?.includes("83.51") && summary.textContent?.includes("85.14"), "structured RSI and KD rendered");
  check(summary.textContent?.includes("MACD 線") && summary.textContent?.includes("MACD Signal") && summary.textContent?.includes("MACD Histogram"), "MACD components labelled separately");
  check(summary.scrollWidth <= summary.clientWidth, "technical summary fits its panel");
  for (const field of summary.querySelectorAll("dl > div")) {
    const bounds = field.getBoundingClientRect();
    const panel = summary.getBoundingClientRect();
    check(bounds.left >= panel.left - 1 && bounds.right <= panel.right + 1, "summary fields wrap within panel");
    const value = field.querySelector("dd")!;
    check(getComputedStyle(value).textAlign === "right" && value.scrollWidth <= value.clientWidth, "numeric value right aligned and not clipped");
  }
  check(getComputedStyle(find(".workspace-metrics-grid")).display === "grid", "responsive metrics grid");
  check(!summary.textContent?.match(/報告產生|研究資料時間|completed|fixture-warning/), "research clocks and raw diagnostics closed");
  warningsDetails.open = true; await pause();
  const chartDetails = [...document.querySelectorAll<HTMLDetailsElement>(".workspace-status-scroll > details")].find((node) => node.querySelector("summary")?.textContent?.includes("圖表／研究對應"))!;
  chartDetails.open = true; await pause();
  check(chartDetails.textContent?.includes("K 棒原始時間") && chartDetails.textContent?.includes("2026-10-09T10:00:00+08:00"), "separate chart and research clocks accessible");
  warningsDetails.open = false; await pause();
  await feedback("search selection");
  find<HTMLButtonElement>(".workspace-chart-pane .workspace-pane-heading button").click(); await pause();
  await feedback("chart refresh");
  check(document.documentElement.scrollWidth <= window.innerWidth, "no horizontal overflow");
  check(!document.querySelector(".workspace-diagnostics, .workspace-source-details pre"), "default density retained after selection");
  check(document.querySelectorAll("*").length < 800, "bounded default DOM with 3600 diagnostics");
  document.body.dataset.testResult = `PASS ${checks} checks ${window.innerWidth}px`;
}
void run().catch((error) => { document.body.dataset.testResult = `FAIL ${error.message}`; });
