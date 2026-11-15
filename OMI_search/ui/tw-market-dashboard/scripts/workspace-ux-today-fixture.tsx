// Isolated real WorkspaceApp. Receipt bytes originate in OMI's actual local
// persistence test; only unique fixture identity pins change per simulated call.
import { createRoot } from "react-dom/client";
import { WorkspaceApp } from "../src/WorkspaceApp";
import { McpAppsBridge } from "../src/bridge";
import { fixtureConnection, fixtureReadback, fixtureBrokerOrders, fixtureDeskOrder } from "./desk-fixture";
import { fixtureResearch, fixtureResearchList } from "./research-fixture";
import receipts from "./fixtures/backend-stage-receipts.json";
import marketFixtures from "./fixtures/backend-chart-cases.json";
import styles from "../src/styles.css";
import type { UnknownRecord } from "../src/state";

document.head.append(Object.assign(document.createElement("style"), { textContent: styles }));
document.documentElement.dataset.omiWorkspace = "true";
window.openai = { toolInput: { stock_id: "1802", timeframe: "today" } };
const blocked = () => { throw Error("External IO forbidden"); };
window.fetch = blocked; window.WebSocket = blocked as unknown as typeof WebSocket; Storage.prototype.setItem = blocked;
const calls: { name: string; args: UnknownRecord }[] = [], rows: UnknownRecord[] = [];
let mode = "success", withheld = false, chartMode = "today_missing", brokerDelay = 0;
const broker = fixtureBrokerOrders();
const source = receipts.find(item => item.request.client_intent_id === "ux-ui")!;
const makeStage = (args: UnknownRecord) => {
  const selected = args.condition && args.condition !== "CASH" ? receipts.find(item => item.request.condition === args.condition && item.request.action === args.action)! : source;
  const row = structuredClone(selected.receipt) as UnknownRecord;
  row.id = `offline-stage-${rows.length + 1}`;
  row.raw = { ...(row.raw as UnknownRecord), client_intent_id: args.client_intent_id };
  row.manual_stage = { ...(row.manual_stage as UnknownRecord), client_intent_id: args.client_intent_id };
  rows.push(row); return row;
};
const api = {
  calls, rows, brokerCompleted: 0,
  setMode(value: string) { mode = value; },
  setChart(value: string) { chartMode = value; },
  setBrokerDelay(value: number) { brokerDelay = value; },
  linkToBroker() {
    const row = rows.at(-1)!;
    const target = (broker.broker_orders as UnknownRecord[])[0];
    row.revision = Number(row.revision) + 1; row.lifecycle = "SUBMITTED";
    row.manual_stage = { ...(row.manual_stage as UnknownRecord), state: "SUBMITTED", submission: { receipt: { execution: { execution_id: target.execution_id } } } };
  },
  recover(lifecycle: string) {
    withheld = false;
    const row = rows.at(-1)!;
    row.lifecycle = lifecycle;
    if (lifecycle === "CANCELLED") row.state = "CANCELLED";
    else if (lifecycle !== "STAGED") row.manual_stage = { ...(row.manual_stage as UnknownRecord), state: lifecycle, submission: { phase: "CONFIRM" } };
  },
};
Object.assign(window, { uxFixture: api });
const bridge = {
  getPresentationDiagnostic: () => ({ actualDisplayMode: "inline" }),
  subscribe: () => () => {}, subscribePresentation: () => () => {}, start() {}, stop() {}, requestFullscreen: async () => {},
  async callTool(name: string, args: UnknownRecord = {}) {
    calls.push({ name, args });
    let result: unknown;
    if (name === "omi_read_desk_status") result = fixtureConnection();
    else if (name === "omi_read_desk_staged") result = { result: withheld ? rows.slice(0, -1) : rows };
    else if (name === "omi_read_desk_orders") { if (brokerDelay) await new Promise(resolve => setTimeout(resolve, brokerDelay)); api.brokerCompleted++; result = broker; }
    else if (name === "omi_read_desk_order") { const row = (broker.broker_orders as UnknownRecord[]).find(row => row.execution_id === args.id); if (!row) throw Error("exact execution missing"); result = fixtureDeskOrder(row); }
    else if (name === "omi_read_desk_stage") result = rows.find(row => row.id === args.id);
    else if (name === "omi_revise_candidate" || name === "omi_cancel_candidate") {
      const row = rows.find(row => row.id === args.id)!;
      if (!row || row.revision !== args.expected_revision) throw Error("stale local revision");
      row.revision = Number(row.revision) + 1; row.digest = "d".repeat(64); row.event = args.raw ? "REVISE" : "CANCEL";
      if (args.raw) row.raw = args.raw; else { row.lifecycle = "CANCELLED"; row.state = "CANCELLED"; }
      result = row;
    }
    else if (name === "omi_read_desk_fills") result = { ...fixtureReadback(), trade_date: "2026-11-12", fills: [
      { symbol: "當日成交fixture", action: "Buy", condition: "CASH", lot: "Common", quantity_shares: 1000, price: "80", fill_id: "today", broker_key: { trade_date: "2026-11-12" } },
      { symbol: "歷史成交fixture", action: "Sell", condition: "MARGIN", lot: "Common", quantity_shares: 1000, price: "81", fill_id: "old", broker_key: { trade_date: "2026-11-11" } },
    ] };
    else if (name === "omi_read_desk_inventory") result = fixtureReadback();
    else if (name === "omi_create_desk_draft") {
      result = makeStage(args);
      if (mode.startsWith("timeout")) { withheld = mode === "timeout-held"; throw Error("timeout after persistence"); }
    } else if (name === "omi_list_research_proposals") result = fixtureResearchList([{ ...fixtureResearch(), symbol: "1802" }]);
    else if (name === "omi_stage_research_order") {
      const data = args.data as UnknownRecord;
      const row = makeStage({ client_intent_id: data.client_intent_id });
      row.raw = { ...(row.raw as UnknownRecord), research_proposal: { creation_id: args.id, revision_id: data.expected_revision_id, market: "TW", workflow_origin: "AI_NOMINATION" } };
      result = row;
    } else if (name === "omi_read_tw_stock_chart") { const value = structuredClone(args.timeframe === "today" ? marketFixtures[chartMode as "today_missing"] : chartMode === "final" ? marketFixtures.final : chartMode === "stale_quote" ? marketFixtures.stale_quote : marketFixtures.daily); result = { ...value, stock_id: args.stock_id, stock_name: "離線測試", chart: { ...value.chart, stock_id: args.stock_id } }; }
    else if (name === "omi_read_tw_stock_research") { const value = structuredClone(args.timeframe === "today" ? marketFixtures.research_today : marketFixtures.research_daily); result = { ...value, stock_id: args.stock_id, technical: { ...value.technical, stock_id: args.stock_id } }; }
    else if (name === "omi_read_tw_workspace_header") result = marketFixtures.header;
    else if (name === "omi_read_tw_workspace_watchlist") result = { kind: "omi.tw_workspace_watchlist", version: "omi.tw_workspace_watchlist.v1", groups: [], selection: { group_id: null }, items: [] };
    else if (name === "omi_read_tw_workspace_hot_groups") result = { kind: "omi.tw_workspace_hot_groups", version: "omi.tw_workspace_hot_groups.v1", hot_groups: [] };
    else if (name === "omi_list_candidates") result = { result: [] };
    else throw Error(`Unexpected tool ${name}`);
    return { structuredContent: structuredClone(result) };
  },
} as unknown as McpAppsBridge;
createRoot(document.getElementById("root")!).render(<WorkspaceApp bridge={bridge}/>);
