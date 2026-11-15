// Offline MCP host. All market/candidate records below are synthetic fixtures;
// no Backend, provider, broker, persistence or real account is contacted.
import { createRoot } from "react-dom/client";
import { WorkspaceApp } from "../src/WorkspaceApp";
import { McpAppsBridge } from "../src/bridge";
import { holdingsArgs } from "../src/workspace-holdings";
import styles from "../src/styles.css";
import { fixtureReadback, fixtureStage } from "./desk-fixture";
import type { UnknownRecord } from "../src/state";

const style = document.createElement("style"); style.textContent = styles; document.head.append(style);
document.documentElement.dataset.omiWorkspace = "true";
declare global {
  interface Window {
    workspaceFixtureTool?: (params: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>;
    workspaceFeedback?: (phase: string) => Promise<void>;
    workspaceCandidateReads?: () => number;
  }
}
const feedback = async (phase: string) => { await window.parent.workspaceFeedback?.(phase); };
const calls: { name: string; arguments: Record<string, unknown> }[] = [];
const groups = Array.from({ length: 77 }, (_, i) => ({ group_id: i + 1,
  group_name: i === 0 ? "科技／電子" : i === 44 ? "半導體製造／晶圓代工" : `測試群組 ${i + 1}`,
  parent_id: i === 44 ? 1 : i >= 69 && i < 74 ? i : null, sort_order: i }));
const stocks = [["2330", "台積電"], ["2303", "聯電"], ["5347", "世界"], ["6770", "力積電"]].map(([stock_id, stock_name]) => ({ stock_id, stock_name, status: "ready", freshness_status: "current", price_semantics: "official_close" }));
const warnings = Array.from({ length: 1200 }, (_, i) => `fixture-warning-${i}`);
let listMode: "many" | "few" = "many";
let portfolioMode = "ready";
let reviews: UnknownRecord[] = [];
const stages: UnknownRecord[] = [];
const checkNoIO = () => { throw Error("Unexpected real IO"); };
window.fetch = checkNoIO; window.WebSocket = checkNoIO as unknown as typeof WebSocket;
Storage.prototype.setItem = checkNoIO;

function tool(name: string, args: Record<string, unknown>) {
  if (name === "omi_read_desk_status") return { broker_session: "CONNECTED", trade_date: "2026-10-31", session_date_matches: true };
  if (name === "omi_read_desk_orders" || name === "omi_read_desk_fills" || name === "omi_read_desk_inventory") return fixtureReadback(reviews);
  if (name === "omi_create_desk_draft") { const stage = fixtureStage(args); stages.push(stage); return stage; }
  if (name === "omi_read_desk_staged") return { result: stages };
  if (name === "omi_read_desk_stage") return stages.find(row => row.id === args.id);
  if (name === "omi_confirm_desk_staged") {
    const stage = stages.find(row => row.id === args.id)!;
    if (!stage || args.expected_revision !== stage.revision || args.expected_digest !== stage.digest) throw Error("Fixture stale stage confirmation");
    stage.revision = Number(stage.revision) + 1; stage.digest = "d".repeat(64); stage.lifecycle = "SUBMITTED";
    stage.manual_stage = { ...(stage.manual_stage as UnknownRecord), state: "SUBMITTED", submission: { pin: { revision: args.expected_revision, digest: args.expected_digest } } };
    return stage;
  }
  if (name === "omi_confirm_desk_review") {
    const review = reviews.find(row => row.review_id === args.id)!;
    if (!review || args.expected_revision !== review.review_revision || args.expected_digest !== (review.snapshot as UnknownRecord).digest) throw Error("Fixture stale confirm");
    review.state = "EXECUTION"; review.execution_id = "fixture-confirmed"; review.execution = { state: "SUBMITTED" }; return review;
  }
  if (name === "omi_list_candidates") return { result: [] };
  if (name === "omi_read_candidate_monitor_status") return { status: "unknown" };
  if (/omi_(create|revise|pause|resume|cancel)_/.test(name)) throw Error("Fixture must never mutate");
  if (name === "omi_ask") return { contract_version: "omi.decision.v4", ok: portfolioMode !== "denied", request_status: portfolioMode === "denied" ? "rejected" : "completed",
    evidence: { manifest: { capabilities: [{ capability: "portfolio.holdings", status: portfolioMode === "denied" ? "forbidden" : "ready", payload_included: portfolioMode !== "denied" }] },
      data: { "portfolio.holdings": portfolioMode === "empty" ? [] : [{ market: "TW", symbol: "2330", display_name: "測試台股", price_as_of: "2026-10-07" }] } } };
  const kind = name.replace(/^omi_read_/, "omi.");
  const base = { kind, version: `${kind}.v1`, status: "partial", freshness: { status: "stale" }, generated_at: "2026-10-08", ...args };
  if (name === "omi_read_tw_workspace_header") return { ...base, warnings,
    session: { presentation_state: "previous_session", trade_date: "2026-10-08" },
    resolved_indices: [{ index_id: "TAIEX", value: 49313.44, change: -492.93, change_pct: -0.9897, status: "complete", authority: "official_exchange" }, { index_id: "TPEX", value: 426.71, change: -3.75, change_pct: -0.87116, status: "complete", authority: "derived_proxy" }],
    resolved_breadth: { TWSE: { status: "partial", advance: 417, decline: 523, unchanged: 104, unknown: 36, coverage: 1044, universe: 1080 }, TPEX: { status: "partial", advance: 319, decline: 382, unchanged: 80, unknown: 106, coverage: 781, universe: 887 } } };
  if (name === "omi_read_tw_workspace_watchlist") return { ...base, groups: listMode === "few" ? groups.filter(g => g.group_id === 1 || g.group_id === 45) : groups,
    selection: { group_id: args.watchlist_group_id ?? 45, group_name: "當前測試群組", truncated: args.watchlist_group_id === 47 },
    items: args.watchlist_group_id === 47 ? [] : args.watchlist_group_id === 46 ? [{ stock_id: "2317", stock_name: "測試自選" }] : listMode === "few" ? stocks.slice(0, 1) : [...stocks, ...Array.from({ length: 24 }, (_, i) => ({ stock_id: `F${i}`, stock_name: `測試成員 ${i}` }))] };
  if (name === "omi_read_tw_workspace_hot_groups") return { ...base, hot_groups: [{ group_id: "fixture-hot", label: "測試熱門族群", median_change_pct: 1.2 }] };
  if (name === "omi_read_tw_stock_chart") return { ...base, chart: { stock_id: args.stock_id, timeframe: args.timeframe, volume_unit: "shares", trade_value_unit: "TWD",
    points: Array.from({ length: 8 }, (_, i) => ({ time: `2026-10-${String(i + 1).padStart(2, "0")}`, open: 100 + i, high: 105 + i, low: 98 + i, close: 103 + i, volume: 1000 + i, trade_value: 1000000 })) }, moving_averages: [{ time: "2026-10-08", ma5: 100, ma20: 95, ma60: 90 }] };
  if (name === "omi_read_tw_stock_research" && args.projection === "technical") {
    const completed = { time: "2026-10-08", close: 110, change_pct: 0, rsi: { rsi14: 61.5111 },
      macd: { macd: 40.703, signal: 30.5897, histogram: 10.1133 }, kd: { k9: 83.5116, d9: 85.1391 },
      atr: { atr14: 0 }, adx: { adx14: null, plus_di14: 20, minus_di14: 0 }, obv: -123456 };
    return { ...base, version: "omi.tw_stock_research.technical.v2", projection: "technical",
      technical_summary: { ...completed, basis: args.timeframe === "daily" ? "daily_indicator" : "indicator" },
      technical: { stock_id: args.stock_id, status: "partial", decision_usable: false,
        timeframes: { [String(args.timeframe)]: { completed, period: { status: "completed" }, decision_snapshot: "completed" } } } };
  }
  if (name === "omi_read_tw_stock_research") return { ...base, technical: { title: "離線技術研究", summary: "本頁為合成資料的版面驗證，不代表即時市場或券商狀態。", status: "partial", stock_id: args.stock_id, timeframe: args.timeframe,
    generated_at: "2026-10-09T10:00:00+08:00", data: { daily_indicator: { time: "2026-10-08", close: 110, change_pct: 0, rsi: { rsi14: 61.5111 }, macd: { macd: 40.703, signal: 30.5897, histogram: 10.1133 }, kd: { k9: 83.5116, d9: 85.1391 } }, decision_snapshot: "completed" } } };
  if (name === "omi_search_tw_symbols") return { ...base, kind: "omi.tw_symbol_search", version: "omi.tw_symbol_search.v1", items: stocks };
  return base;
}
window.workspaceFixtureTool = async (params) => {
  calls.push(params);
  const result = { structuredContent: tool(params.name, params.arguments) };
  if ((params.name === "omi_read_tw_workspace_watchlist" && params.arguments.watchlist_group_id === 46)
    || (params.name === "omi_read_tw_stock_chart" && params.arguments.stock_id === "2303")) await new Promise(resolve => setTimeout(resolve, 500));
  return result;
};
window.workspaceCandidateReads = () => calls.filter(call => /^omi_(list_candidates|read_candidate)/.test(call.name)).length;
window.addEventListener("message", (event) => {
  if (window.parent !== window || !event.data?.method || !event.data.id) return;
  const request = event.data;
  void (request.method === "tools/call" ? window.workspaceFixtureTool!(request.params) : Promise.resolve({})).then(result => {
    window.postMessage({ jsonrpc: "2.0", id: request.id, result }, "*");
  });
});
const mode = document.documentElement.dataset.fixtureMode;
window.openai = { toolInput: { watchlist_group_id: 45 }, displayMode: mode === "unknown" ? undefined : mode === "fullscreen" || mode === "pip" ? mode : "inline" };
createRoot(document.getElementById("root")!).render(<WorkspaceApp bridge={new McpAppsBridge()} />);

const pause = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
const find = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const node = document.querySelector<T>(selector); if (!node) throw Error(`Missing ${selector}`); return node;
};
let checks = 0;
const check = (value: unknown, name: string) => { if (!value) throw Error(name); checks++; };
const click = async (selector: string) => { find(selector).click(); await pause(); };
async function change(label: string, value: string) {
  const input = find<HTMLInputElement>(`[aria-label="${label}"]`);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true })); await pause();
}
async function workspace(view: string) { await click(`[aria-label="工作區"] [aria-controls="workspace-${view}-area"]`); }
async function run() {
  for (let i = 0; i < 40 && !document.querySelector(".workspace-group-items button"); i++) await pause();
  await workspace("stocks");
  const tree = find(".workspace-group-scroll"), members = find(".workspace-stock-scroll");
  check(!document.querySelector(".workspace-group-tree .workspace-stock"), "members never embed in tree");
  check(tree.scrollHeight > tree.clientHeight && tree.clientHeight > 0 && tree.clientHeight <= 320, `many groups have bounded scroll: scroll=${tree.scrollHeight}, client=${tree.clientHeight}, width=${window.innerWidth}, view=${find('main').dataset.workspaceView}`);
  check(members.scrollHeight > members.clientHeight && members.clientHeight <= 300, "many members have separate bounded scroll");
  const treeHeight = tree.getBoundingClientRect().height;
  const pageY = window.scrollY;
  await click('[data-group-id="46"]');
  check(!document.querySelector(".workspace-group-items .workspace-stock"), "selection guard hides old members immediately");
  await click('[data-group-id="47"]'); await pause(550);
  check(!document.querySelector(".workspace-group-items .workspace-stock"), "late response cannot replace current members");
  check(find(".workspace-group-items").textContent?.includes("清單已截斷"), "truncated empty list visible");
  check(tree.getBoundingClientRect().height === treeHeight, "member count does not resize long tree");
  check(window.scrollY === pageY, "group selection does not scroll page");
  await click('[data-group-id="45"]');
  listMode = "few"; await click(".workspace-group-heading button");
  check(tree.getBoundingClientRect().height < 180, "few groups shrink instead of reserving 320px");
  check(members.getBoundingClientRect().height < 120, "one member shrinks instead of reserving 300px");
  await feedback("few groups and members");
  listMode = "many"; await click(".workspace-group-heading button");
  await click('[data-group-id="74"]');
  const deep = find('[data-group-id="74"]');
  check(deep.getBoundingClientRect().width > 40, "deep group remains readable");
  check(tree.scrollWidth <= tree.clientWidth, "deep tree has no horizontal overflow");
  deep.focus(); check(document.activeElement === deep && getComputedStyle(deep).outlineStyle !== "none", "group keyboard focus visible");
  await click('[data-group-id="45"]');
  const before = tree.scrollTop;
  const beforeBounds = find('[data-group-id="45"]').getBoundingClientRect();
  const beforeFocus = document.activeElement?.getAttribute("data-group-id");
  await click('.workspace-group-items .workspace-stock');
  check(tree.scrollTop === before, `stock selection does not re-anchor tree: before=${before}, after=${tree.scrollTop}, groupTop=${beforeBounds.top}->${find('[data-group-id="45"]').getBoundingClientRect().top}, treeTop=${tree.getBoundingClientRect().top}, focus=${beforeFocus}->${document.activeElement?.getAttribute("data-group-id")}`);
  await workspace("chart"); await pause();
  const market = find(".workspace-market-cards").getBoundingClientRect(), chart = find(".workspace-chart-pane").getBoundingClientRect();
  check(Math.abs(market.left - chart.left) < 1 && Math.abs(market.right - chart.right) < 1, "market matches chart boundaries");
  check(find(".workspace-technical-pane").getBoundingClientRect().top >= chart.bottom, "technical research follows chart");
  check(!!document.querySelector(".workspace-technical-pane .workspace-technical-summary"), "numeric summary below chart");
  if (window.innerWidth >= 1248) {
    const left = find(".workspace-watchlist").getBoundingClientRect(), right = find(".workspace-context").getBoundingClientRect();
    check(Math.abs(left.top - market.top) < 1 && Math.abs(right.top - market.top) < 1, "three columns share top edge");
    check(chart.width >= 550, "desktop chart has usable width");
  }
  await feedback("chart and three-column geometry");
  await workspace("trade");
  check(find<HTMLInputElement>('[aria-label="委託股票代碼"]').value === "2330", "clean manual form follows stock");
  check(find<HTMLInputElement>('[aria-label="委託價格"]').value === "", "daily close never becomes order price");
  for (const [condition, side] of [["CASH_SELLING", "Sell"], ["MARGIN", "Buy"], ["SHORT_SELLING", "Sell"]]) {
    await click('[data-condition="CASH"]'); await click('[data-lot="Odd"]'); await change("委託數量", "1");
    await click(`[data-condition="${condition}"]`);
    check(find(`[data-side="${side}"]`).getAttribute("aria-pressed") === "true", "condition normalizes side");
    check(find<HTMLButtonElement>(`[data-side="${side === "Buy" ? "Sell" : "Buy"}"]`).disabled, "illegal side disabled");
    check(find<HTMLButtonElement>('[data-lot="Odd"]').disabled, "non-cash excludes Odd");
    check(find<HTMLInputElement>('[aria-label="委託數量"]').value === "", "unit change clears quantity");
  }
  await change("委託數量", "1"); check(find(".workspace-order-review").textContent?.includes("1 張 / 1,000 股"), "Common one lot is 1000 shares");
  await change("委託價格", "100");
  const price = find<HTMLInputElement>('[aria-label="委託價格"]');
  await click(".workspace-order-submit");
  check(calls.filter(call => call.name === "omi_create_desk_draft").length === 1 && typeof calls.find(call => call.name === "omi_create_desk_draft")?.arguments.client_intent_id === "string", "add stages one local manual_stage with stable intent");
  check(find(".workspace-desk-orders").textContent?.includes("EXTERNAL") && find(".workspace-desk-orders").textContent?.includes("MANAGED"), "broker orders include external and managed identities");
  await click('[aria-label="本地待送單"] .workspace-order-actions .candidate-primary');
  check(document.querySelectorAll("dialog[open]").length === 1 && find("dialog").textContent?.includes("USER_SPACE"), "exactly one confirmation modal with real snapshot space");
  await click("dialog .workspace-order-pair button:first-child");
  check(calls.filter(call => call.name === "omi_confirm_desk_staged").length === 0, "modal cancel has zero confirm effects");
  await click('[aria-label="本地待送單"] .workspace-order-actions .candidate-primary');
  const confirm = find<HTMLButtonElement>("dialog .workspace-order-pair button:last-child"); confirm.click(); confirm.click(); await pause();
  check(calls.filter(call => call.name === "omi_confirm_desk_staged").length === 1, "double confirmation produces exactly one pinned call");
  check(!document.querySelector("dialog[open]"), "no second confirmation dialog");
  await click('[aria-controls="workspace-broker-trade"]');
  await click('[aria-controls="workspace-candidate-content"]'); await pause();
  const panel = find(".candidate-panel");
  await click(".candidate-heading .candidate-primary");
  await click(".candidate-owner-details > summary");
  await change("候選股數", "2");
  const owner = find<HTMLInputElement>('[aria-label="候選 owner_id"]');
  for (const tab of ["orders", "fills", "inventory"]) {
    await click(`[aria-controls="workspace-broker-${tab}"]`);
    check(find(`#workspace-broker-${tab}`).textContent?.includes(tab === "orders" ? "EXTERNAL" : "PARTIAL"), "broker page preserves real contract quality and ownership");
    if (tab !== "orders") {
      const toolName = `omi_read_desk_${tab}`, count = calls.filter(call => call.name === toolName).length;
      await click(`#workspace-broker-${tab} .candidate-heading button`);
      check(calls.filter(call => call.name === toolName).length === count + 1, "manual broker refresh reads current kind once");
      if (tab === "inventory") check(find("#workspace-broker-inventory").textContent?.includes("UNKNOWN"), "credit inventory unknown is retained");
      else check(find("#workspace-broker-fills").textContent?.includes("KNOWN"), "known fill is distinct from submitted");
    }
    await click('[aria-controls="workspace-broker-trade"]');
    check(find(".candidate-panel") === panel && owner.value === "MCP" && find<HTMLInputElement>('[aria-label="候選股數"]').value === "2", "candidate session and dirty USER draft survive broker tabs");
  }
  await click('[aria-label="工作環境"] button:last-child');
  check(find(".candidate-panel").textContent?.includes("目前保留 USER_SPACE 草稿"), "legacy AGENT view cannot convert new USER draft");
  await click('[aria-label="工作環境"] button:first-child');
  check(find(".candidate-panel") === panel && owner.value === "MCP", "environment switch retains the same dirty USER session");
  await click('[aria-controls="workspace-manual-content"]');
  check(find<HTMLInputElement>('[aria-label="委託價格"]') === price && price.value === "100", "manual draft survives mode switch");
  await workspace("stocks"); await click('.workspace-group-items .workspace-stock:nth-of-type(2)'); await pause(550);
  await workspace("trade");
  check(find<HTMLInputElement>('[aria-label="委託股票代碼"]').value === "2330", "dirty manual form retains old symbol");
  check(!!document.querySelector(".workspace-ticket-retained"), "dirty selection mismatch is explicit");
  await click('[aria-controls="workspace-candidate-content"]');
  check(find(".candidate-panel") === panel && owner.value === "MCP", "dirty candidate survives workspace navigation");
  check(find(".candidate-switch-prompt").textContent?.includes("2303"), "candidate symbol protection remains");
  await click('[aria-controls="workspace-manual-content"]');
  const reads = window.workspaceCandidateReads!(); await pause(31_000);
  check(window.workspaceCandidateReads!() === reads, "inactive candidate polling stops");
  check(calls.filter(call => /omi_(create|revise|pause|resume|cancel)_/.test(call.name)).every(call => call.name === "omi_create_desk_draft"), "fixture mutations are restricted to the staged synthetic Native draft");
  check(JSON.stringify(calls.find(call => call.name === "omi_ask")?.arguments) === JSON.stringify(holdingsArgs()), "holdings read contract preserved");
  await workspace("stocks");
  const status = find<HTMLDetailsElement>(".workspace-status-panel > details"); status.open = true; await pause();
  check(find(".workspace-status-scroll").clientHeight <= 280, "source diagnostics remain bounded");
  status.open = false; await pause();
  await workspace("chart");
  check(document.documentElement.scrollWidth <= window.innerWidth, "no document horizontal overflow");
  await feedback("final state");
  document.body.dataset.testResult = `PASS ${checks} checks ${window.innerWidth}px`;
}
void run().catch(error => { document.body.dataset.testResult = `FAIL ${error.message}`; });
