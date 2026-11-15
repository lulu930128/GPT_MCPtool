import React from "react";
import { createRoot } from "react-dom/client";
import { ResearchPanel } from "../src/ResearchPanel";
import { LiveOrderControls } from "../src/OrderProtection";
import { fixtureStage } from "./desk-fixture";
import { fixtureResearch, fixtureResearchList, fixtureResearchDetail } from "./research-fixture";
import type { UnknownRecord } from "../src/state";
import css from "../src/styles.css";

document.head.appendChild(Object.assign(document.createElement("style"), { textContent: css }));
let origin = "OMI_SCREEN", market = "TW", revision = 1, deleted = false, staged = 0;
const calls: { name: string; args: UnknownRecord }[] = [];
let strategy = { direction: 1, entry_price: 100, stop_price: 95, shares: 10, thesis: "研究條件", targets: [{ price: 110, fraction: 0.5 }, { price: 120, fraction: 0.5 }] };
let rules: UnknownRecord = { enabled: true, direction: 1, stop_loss: "95", exit_limit_price: "95", stop_limit_price: "95", take_profit: "120", targets: [{ price: "110", limit_price: "110", fraction: "0.5" }, { price: "120", limit_price: "120", fraction: "0.5" }] };
let protectionRevision = 3;
const protectionAudit: UnknownRecord[] = [];
const bridge = { async callTool(name: string, args: UnknownRecord = {}) {
  calls.push({ name, args: structuredClone(args) });
  let value: unknown;
  const summary = () => fixtureResearch(market, revision, origin);
  const detail = () => fixtureResearchDetail(summary(), strategy);
  if (name === "omi_list_research_proposals") { market = String(args.market); value = fixtureResearchList(deleted ? [] : [summary()], Number(args.offset)); }
  else if (name === "omi_read_research_proposal") { check(args.id === summary().creation_id, "exact detail identity"); value = detail(); }
  else if (["omi_move_research_proposal", "omi_revise_research_proposal", "omi_delete_research_proposal", "omi_stage_research_order"].includes(name)) {
    check(args.id === summary().creation_id, "exact research identity");
    check((args.expected_revision_id ?? (args.data as UnknownRecord)?.expected_revision_id) === summary().revision_id, "exact research revision");
    if (name === "omi_move_research_proposal") { origin = String(args.origin); revision++; value = detail(); }
    else if (name === "omi_revise_research_proposal") { strategy = (args.data as UnknownRecord).strategy as typeof strategy; revision++; value = detail(); }
    else if (name === "omi_delete_research_proposal") { deleted = true; revision++; value = { creation_id: summary().creation_id, revision_id: summary().revision_id, status: "deleted", deleted_at: "2026-11-06T00:00:00Z" }; }
    else { check(origin === "AI_NOMINATION", "only nomination staged"); value = fixtureStage({ client_intent_id: String((args.data as UnknownRecord).client_intent_id), market, symbol: summary().symbol,
      lot: market === "US" ? "Shares" : "Odd", research_proposal: { creation_id: summary().creation_id, revision_id: summary().revision_id, workflow_origin: origin, market } }); }
  }
  else if (name === "omi_read_desk_order" || name === "omi_revise_order_protection" || name === "omi_cancel_desk_order") {
    check(args.id === "execution-1" && args.market === "US", "exact order identity and market");
    if (name === "omi_revise_order_protection") { check(args.expected_revision === protectionRevision, "revision pin"); rules = args.rules as UnknownRecord; protectionRevision++;
      protectionAudit.push({ kind: "STRATEGY_REVISED", payload: { request_id: args.request_id, strategy_id: "strategy-1", strategy_revision: protectionRevision } }); }
    value = { market: "US", command: { account_id: "fixture-account", trade_date: "2026-11-11" }, execution: { execution_id: "execution-1", broker_order_id: "fixture-broker-1", trade_date: "2026-11-11", quantity: 10, reconcile_required: false, cancel_stage: null, state: name === "omi_cancel_desk_order" ? "CANCEL_PENDING" : "ACCEPTED", filled_shares: 0 }, protection: { entry_execution_id: "execution-1", strategy_id: "strategy-1", strategy_revision: protectionRevision, rules, audit: protectionAudit } };
  } else throw Error(`Unexpected tool ${name}`);
  return { structuredContent: value };
} };
const root = createRoot(document.getElementById("root")!);
root.render(<main className="tw-workspace"><ResearchPanel bridge={bridge} active onStaged={() => staged++}/><LiveOrderControls bridge={bridge} market="US" id="execution-1"/></main>);
const pause = () => new Promise(resolve => setTimeout(resolve, 40));
function check(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
const has = (label: string) => [...document.querySelectorAll("button")].some(node => node.textContent === label);
async function click(label: string) { const node = [...document.querySelectorAll("button")].find(node => node.textContent === label); check(node && !node.disabled, label); node.click(); await pause(); }
async function input(label: string, value: string) { const node = [...document.querySelectorAll("label")].find(node => node.textContent?.startsWith(label))?.querySelector("input,select") as HTMLInputElement | HTMLSelectElement; check(node, label); Object.getOwnPropertyDescriptor(node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(node, value); node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); await pause(); }
async function run() {
  await pause(); await pause();
  check(!has("加入待送單"), "post-close has no staging action");
  await input("市場", "US"); check(document.body.textContent?.includes("NVDA"), "US selected");
  await click("移至 AI 提名"); check(has("加入待送單"), "moved candidate can stage");
  await click("修改"); await input("停損價", "94"); await input("修改原因", "修訂研究"); await click("儲存研究"); check(strategy.stop_price === 94, "edited stop persisted");
  await click("加入待送單"); check(staged === 1, "stage callback");
  check(!calls.some(call => /confirm|submit/.test(call.name)), "research never sends");
  await click("刪除"); check(calls.filter(call => call.name === "omi_delete_research_proposal").length === 0, "delete waits for explicit selection confirmation");
  await click("確認刪除研究"); check(document.body.textContent?.includes("目前沒有符合條件"), "deleted candidate removed");
  deleted = false; await input("市場", "TW");
  await click("刪除"); await click("確認刪除研究");
  check(calls.filter(call => call.name === "omi_delete_research_proposal").length === 2 && deleted, "TW and US both delete with exact summary identity");
  ([...document.querySelectorAll("details")].find(node => node.querySelector("summary")?.textContent === "券商委託與停損停利") as HTMLDetailsElement).open = true;
  await click("讀取此單"); await input("停損觸發價", "93"); await click("套用此單停損停利");
  check(rules.stop_loss === "93", "per-order protection edited");
  check(calls.filter(call => call.name === "omi_revise_order_protection").length === 1, "one protection update");
  await click("撤銷券商委託"); check(calls.filter(call => call.name === "omi_cancel_desk_order").length === 1, "one exact cancel");
  check(document.documentElement.scrollWidth <= innerWidth, "no horizontal overflow");
  document.body.dataset.testResult = `PASS research ${innerWidth}px: TW/US delete, US move/edit/stage, per-order protection and cancel`;
}
run().catch(error => { document.body.dataset.testResult = `FAIL ${error.message}`; });
