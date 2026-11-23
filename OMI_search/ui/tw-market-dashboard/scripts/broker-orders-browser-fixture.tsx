import { createRoot } from "react-dom/client";
import { DeskOrders } from "../src/DeskOrders";
import { fixtureBrokerOrders, fixtureDeskOrder } from "./desk-fixture";
import type { UnknownRecord } from "../src/state";
import styles from "../src/styles.css";

const style = document.createElement("style"); style.textContent = styles; document.head.append(style);
const data = fixtureBrokerOrders(), calls: { name: string; args: UnknownRecord }[] = [];
const rows = () => data.broker_orders as UnknownRecord[];
let activeFilled = false, partialCancelled = false, cancelCalls = 0;
const cancelCount = () => cancelCalls;
const bridge = { async callTool(name: string, args: UnknownRecord) {
  calls.push({ name, args: structuredClone(args) });
  let value: unknown;
  if (name === "omi_search_tw_symbols") value = { kind: "omi.tw_symbol_search", query: args.keyword, items: [] };
  else if (name === "omi_read_desk_staged") value = { result: [] };
  else if (name === "omi_read_desk_orders") value = structuredClone(data);
  else if (name === "omi_read_desk_order") {
    const row = rows().find(row => row.execution_id === args.id);
    check(row && args.market === "TW", "exact fixture execution and market");
    if (row.symbol === "fixture-active" && activeFilled) { row.execution_state = "FILLED"; row.known_filled_shares = 1000; }
    if (row.symbol === "fixture-partial" && partialCancelled) row.execution_state = "CANCELLED";
    value = fixtureDeskOrder(row, { reconcile_required: row.symbol === "fixture-partial" });
  } else if (name === "omi_cancel_desk_order") {
    check(args.id === "execution-fixture-partial" && args.market === "TW", "only partial fixture can reach cancel");
    cancelCalls++;
    if (cancelCalls === 1) return { structuredContent: fixtureDeskOrder(rows().find(row => row.execution_id === args.id)!,
      { cancel_stage: "NOT_SENT", cancel_error: "ORDER_NOT_IN_SDK_SESSION" }) };
    throw Error("synthetic cancel timeout UNKNOWN");
  } else throw Error(`Unexpected fixture tool ${name}`);
  return { structuredContent: value };
} };
const root = createRoot(document.getElementById("root")!);
let generation = 0;
const render = () => root.render(<main className="tw-workspace desk-fixture" data-workspace-view="trade"><DeskOrders key={generation} bridge={bridge} active view="orders" refreshKey={0}/></main>);
const pause = () => new Promise(resolve => setTimeout(resolve, 40));
function check(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
const find = <T extends HTMLElement = HTMLElement>(selector: string) => { const node = document.querySelector<T>(selector); check(node, selector); return node; };
const card = (symbol: string) => find(`[aria-label="${symbol} 券商委託"]`);
const button = (node: Element, label: string) => { const value = [...node.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === label); check(value, label); return value; };
const click = async (node: Element, label: string) => { const value = button(node, label); check(!value.disabled, `${label} enabled`); value.click(); await pause(); await pause(); };
const current = () => find('[aria-label="當日委託清單"]');

async function run() {
  render(); await pause(); await pause();
  check(!document.querySelector('[aria-label="歷史委託"]'), "no history section on today's page");
  check(!/fixture-old-/.test(find("main").textContent ?? ""), "past records absent even from collapsed content");
  check(current().innerText.includes("fixture-filled") && current().innerText.includes("fixture-rejected"), "same-day terminal orders remain visible");
  check(current().innerText.includes("fixture-active") && current().innerText.includes("fixture-partial"), "current active/partial visible");
  check(card("fixture-today-unknown").innerText.includes("待核對") && card("fixture-untrusted").innerText.includes("待核對"), "unknown and bad quality explicitly check-needed");
  check(!current().textContent?.includes("fixture-undated"), "undated outside today's list");
  for (const symbol of ["fixture-external", "fixture-missing-id", "fixture-today-unknown", "fixture-untrusted"]) {
    check(![...card(symbol).querySelectorAll("button")].some(node => node.textContent === "撤銷剩餘委託"), `${symbol} read-only`);
  }
  check(!button(card("fixture-active"), "撤銷剩餘委託").disabled && !button(card("fixture-partial"), "撤銷剩餘委託").disabled, "direct cancel visible without expanding details");
  for (const node of [...document.querySelectorAll<HTMLButtonElement>("button")].filter(node => node.textContent === "撤銷剩餘委託")) {
    const box = node.getBoundingClientRect(); check(box.width > 80 && box.left >= 0 && box.right <= innerWidth, "cancel button visible and fits viewport");
  }
  // A fill racing the click must be read before any cancellation effect.
  activeFilled = true;
  await click(card("fixture-active"), "撤銷剩餘委託");
  check(cancelCount() === 0 && card("fixture-active").innerText.includes("已成交"), "pre-read catches FILLED without cancel; today card remains");
  await click(card("fixture-partial"), "撤銷剩餘委託");
  check(cancelCount() === 1, "NOT_SENT never retries automatically");
  check(!button(card("fixture-partial"), "撤銷剩餘委託").disabled && card("fixture-partial").innerText.includes("未送交券商"),
    "exact pre-effect rejection is visible and permits another explicit click");
  const before = calls.length;
  const cancel = button(card("fixture-partial"), "撤銷剩餘委託"); cancel.click(); cancel.click(); await pause(); await pause();
  check(cancelCalls === 2, "explicit retry double click dispatches once");
  const effects = calls.slice(before).filter(call => /omi_(read|cancel)_desk_order$/.test(call.name));
  check(effects.map(call => call.name).join(",") === "omi_read_desk_order,omi_cancel_desk_order", "precise read precedes existing cancel route even when reconcile_required=true");
  check(effects.every(call => call.args.id === "execution-fixture-partial" && call.args.market === "TW"), "no guessed identity or replacement ID");
  check(button(card("fixture-partial"), "撤銷剩餘委託").disabled && card("fixture-partial").innerText.includes("不會重複撤單"), "UNKNOWN cancel stays locked after list refresh");
  generation++; render(); await pause(); await pause();
  check(button(card("fixture-partial"), "撤銷剩餘委託").disabled, "remount retains shared cancellation latch");
  await click(card("fixture-partial"), "核對此單");
  check(button(card("fixture-partial"), "撤銷剩餘委託").disabled && cancelCalls === 2, "old ACCEPTED/partial read does not unlock ambiguous cancel");
  partialCancelled = true; await click(card("fixture-partial"), "核對此單");
  check(card("fixture-partial").innerText.includes("已撤銷") && cancelCalls === 2, "exact terminal read keeps today card without resending");
  check(!document.querySelector('[aria-label="跨日待核對委託"]') && !find("main").textContent?.includes("fixture-old-unknown"), "past unknown never returns");
  check(document.documentElement.scrollWidth <= innerWidth, "no horizontal overflow");
  check(calls.every(call => ["omi_search_tw_symbols", "omi_read_desk_staged", "omi_read_desk_orders", "omi_read_desk_order", "omi_cancel_desk_order"].includes(call.name)), "fixture-only existing tools, no lifecycle/submit/DB/provider path");
  find("#fixture-receipt").textContent = JSON.stringify(calls, null, 2);
  document.body.dataset.testResult = `PASS broker ${innerWidth}px: today includes terminal, exact read-before-cancel, NOT_SENT explicit retry, partial remaining, terminal race, UNKNOWN lock/remount, read refresh`;
}
run().catch(error => { document.body.dataset.testResult = `FAIL ${error.message}`; });
