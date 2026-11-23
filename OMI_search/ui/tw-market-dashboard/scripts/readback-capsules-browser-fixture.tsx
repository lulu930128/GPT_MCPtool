import { createRoot } from "react-dom/client";
import { WorkspaceContext } from "../src/WorkspaceContext";
import { fixtureConnection, fixtureReadback, fixtureStage, fixtureSubmittedOrder } from "./desk-fixture";
import { fixtureResearch, fixtureResearchList } from "./research-fixture";
import { fixtureReadbackCapsules } from "./readback-capsules-fixture";
import type { UnknownRecord } from "../src/state";
import styles from "../src/styles.css";

document.head.append(Object.assign(document.createElement("style"), { textContent: styles +
  ".capsules-fixture{display:block;max-width:650px;margin:auto;padding:12px}.capsules-fixture .workspace-context{width:100%;min-width:0}" }));
const blocked = () => { throw Error("External IO forbidden in offline fixture"); };
window.fetch = blocked; window.WebSocket = blocked as unknown as typeof WebSocket;
window.EventSource = blocked as unknown as typeof EventSource;
Storage.prototype.setItem = blocked; navigator.sendBeacon = blocked;
const initial = fixtureReadbackCapsules();
let data: UnknownRecord = structuredClone(initial), failed = false;
const calls: string[] = [];
const submitted = fixtureSubmittedOrder("capsule-order", "ACCEPTED", "2026-11-18", { symbol: "3702", price: "83.1", quantity_shares: 1000 });
const stage = fixtureStage({ symbol: "3702", client_intent_id: "capsule-local-stage", price: "83.1" });
const orders = { ...fixtureReadback([submitted.review]), trade_date: "2026-11-18", broker_orders: [submitted.broker] };
const names: Record<string, string> = { "3702": "大聯大", "2330": "台積電", "8227": "巨有科技", "2637": "慧洋-KY", "3481": "群創" };
const bridge = { async callTool(name: string, args: UnknownRecord = {}) {
  calls.push(name);
  let result: unknown;
  if (name === "omi_search_tw_symbols") result = { kind: "omi.tw_symbol_search", query: args.keyword, items: [{ stock_id: args.keyword, stock_name: names[String(args.keyword)] ?? "測試股票" }] };
  else if (name === "omi_read_desk_status") result = fixtureConnection();
  else if (name === "omi_read_desk_staged") result = { result: [stage] };
  else if (name === "omi_read_desk_orders") result = orders;
  else if (name === "omi_list_research_proposals") result = fixtureResearchList([fixtureResearch()]);
  else if (name === "omi_read_desk_fills" || name === "omi_read_desk_inventory") {
    if (failed) throw Error("Fixture read failed");
    result = data;
  } else throw Error(`Unexpected tool or mutation: ${name}`);
  return { structuredContent: structuredClone(result) };
} };
Object.assign(window, { capsulesFixture: { calls, reset() { data = structuredClone(initial); failed = false; },
  setInventory(inventory: UnknownRecord) { data = { ...data, inventory }; },
  setFills(fills: UnknownRecord[]) { data = { ...data, fills }; }, fail(value: boolean) { failed = value; }, initial,
} });
createRoot(document.getElementById("root")!).render(<main className="tw-workspace capsules-fixture" data-workspace-view="trade"><WorkspaceContext bridge={bridge} symbol="3702"/></main>);
