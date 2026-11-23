import { createRoot } from "react-dom/client";
import { DeskOrders } from "../src/DeskOrders";
import { fixtureCrossdayOrders } from "./desk-fixture";
import type { UnknownRecord } from "../src/state";
import styles from "../src/styles.css";

const style = document.createElement("style"); style.textContent = styles; document.head.append(style);
const f = fixtureCrossdayOrders(), calls: { name: string; args: UnknownRecord }[] = [], originalStages = JSON.stringify(f.stages);
let fillRace = false, cancelResolved = false, failOrders = false, generation = 0;
const bySymbol = (symbol: string) => { const item = f.orders.find(item => item.broker.symbol === symbol); check(item, symbol); return item; };
const setState = (symbol: string, state: string) => { const item = bySymbol(symbol), execution = item.review.execution as UnknownRecord;
  execution.state = state; item.broker.execution_state = state;
  if (state === "FILLED") { execution.filled_shares = execution.quantity; item.broker.known_filled_shares = execution.quantity; }
};
const bridge = { async callTool(name: string, args: UnknownRecord) {
  calls.push({ name, args: structuredClone(args) });
  let value: unknown;
  if (name === "omi_search_tw_symbols") value = { kind: "omi.tw_symbol_search", query: args.keyword, items: [] };
  else if (name === "omi_read_desk_staged") value = { result: f.stages };
  else if (name === "omi_read_desk_stage") value = f.stages.find(row => row.id === args.id);
  else if (name === "omi_read_desk_orders") { if (failOrders) throw Error("synthetic stale list"); value = f.data; }
  else if (name === "omi_read_desk_order") {
    const item = f.orders.find(item => item.review.execution_id === args.id);
    check(item && args.market === "TW", "single read uses exact Native identity and default TW market");
    if (item.broker.symbol === "crossday-active" && fillRace) setState("crossday-active", "FILLED");
    if (item.broker.symbol === "crossday-partial" && cancelResolved) setState("crossday-partial", "CANCELLED");
    const protection = item.broker.symbol === "crossday-today-filled" ? { entry_execution_id: args.id, strategy_id: "synthetic-protection", strategy_revision: 1,
      rules: { enabled: true, stop_loss: "90", take_profit: "110" }, protected_quantity: 1, audit: [] } : null;
    value = { market: "TW", execution: item.review.execution, command: (item.review.draft as UnknownRecord).command, protection };
  } else if (name === "omi_cancel_desk_order") {
    check(args.id === "synthetic-execution-crossday-partial" && args.market === "TW", "only precise partial order reaches fake cancel");
    throw Error("synthetic UNKNOWN cancellation timeout");
  } else throw Error(`Unexpected fixture tool ${name}`);
  return { structuredContent: structuredClone(value) };
} };
const root = createRoot(document.getElementById("root")!);
const render = () => root.render(<main className="tw-workspace desk-fixture" data-workspace-view="trade"><DeskOrders key={generation} bridge={bridge} active view="orders" refreshKey={0}/></main>);
const pause = () => new Promise(resolve => setTimeout(resolve, 40));
function check(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
const find = <T extends HTMLElement = HTMLElement>(selector: string) => { const node = document.querySelector<T>(selector); check(node, selector); return node; };
const card = (symbol: string) => find(`[aria-label="${symbol} 券商委託"]`);
const getButton = (node: Element, label: string) => [...node.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === label);
const button = (node: Element, label: string) => { const value = getButton(node, label); check(value, label); return value; };
const click = async (node: Element, label: string) => { const value = button(node, label); check(!value.disabled, `${label} enabled`); value.click(); await pause(); await pause(); };
const main = () => find('[aria-label="當日委託清單"]');
const cancelCount = () => calls.filter(call => call.name === "omi_cancel_desk_order").length;

async function run() {
  render(); await pause(); await pause();
  check(!calls.some(call => call.name === "omi_read_desk_order"), "initial render has no N+1 single-order reads");
  check([...document.querySelectorAll("details")].every(node => !node.open), "history/protection start collapsed");
  check(!/crossday-(filled|cancelled|rejected|unknown)/.test(find("main").textContent ?? ""), "all past records absent regardless of state");
  check(card("crossday-today-filled").innerText.includes("已成交"), "same-day filled remains visible");
  check(!main().textContent?.includes("crossday-undated") && find('[aria-label="委託日期待確認"]').textContent?.includes("crossday-undated"), "undated only outside today's list");
  check(!document.querySelector('[aria-label="crossday-active 本地掛單"]'), "exact source deduplicated into broker card");
  for (const symbol of ["crossday-active", "crossday-partial"]) {
    check(!("market" in (bySymbol(symbol).row.raw as UnknownRecord)), "fixture actually omits local raw.market");
    const cancel = button(card(symbol), "撤銷剩餘委託"), box = cancel.getBoundingClientRect();
    check(!cancel.disabled && box.width > 80 && box.left >= 0 && box.right <= innerWidth, "default-TW main card cancel is directly visible and fits");
  }
  for (const symbol of ["crossday-missing-id", "crossday-external", "crossday-untrusted"]) {
    check(!getButton(card(symbol), "撤銷剩餘委託"), `${symbol} has no false cancel action`);
    check(card(symbol).querySelectorAll(".workspace-ticket-note").length > 0, `${symbol} gives a reason`);
  }
  const preview = { html: document.querySelector("main")!.outerHTML, css: styles };
  failOrders = true; await click(document.body, "更新委託");
  check(!getButton(card("crossday-active"), "撤銷剩餘委託") && document.body.innerText.includes("過期"), "stale list has no cancel pin and gives reason");
  failOrders = false; await click(document.body, "更新委託");
  fillRace = true; await click(card("crossday-active"), "撤銷剩餘委託");
  check(cancelCount() === 0 && card("crossday-active").innerText.includes("已成交"), "pre-read catches FILLED race, no mutation, today's card remains");
  const before = calls.length, upper = button(card("crossday-partial"), "撤銷剩餘委託");
  upper.click(); upper.click(); await pause(); await pause();
  const effects = calls.slice(before).filter(call => /omi_(read|cancel)_desk_order$/.test(call.name));
  check(effects.map(call => call.name).join(",") === "omi_read_desk_order,omi_cancel_desk_order", "double click preserves read-before-cancel lock");
  check(effects.every(call => call.args.id === "synthetic-execution-crossday-partial" && call.args.market === "TW"), "omitted raw market still sends only exact TW identity");
  check(cancelCount() === 1 && button(card("crossday-partial"), "撤銷剩餘委託").disabled, "UNKNOWN locks the sole inline entry");
  const detail = [...card("crossday-partial").querySelectorAll("details")].find(node => node.querySelector("summary")?.textContent === "券商委託與停損停利")!;
  detail.open = true; await click(detail, "讀取此單");
  check(!getButton(detail, "撤銷券商委託"), "protection detail does not duplicate the inline cancel action");
  generation++; render(); await pause(); await pause();
  check(button(card("crossday-partial"), "撤銷剩餘委託").disabled, "refresh/remount cannot forget UNKNOWN");
  await click(card("crossday-partial"), "核對此單"); check(cancelCount() === 1 && button(card("crossday-partial"), "撤銷剩餘委託").disabled, "old partial exact read cannot unlock resend");
  cancelResolved = true; await click(card("crossday-partial"), "核對此單");
  check(card("crossday-partial").innerText.includes("已撤銷") && cancelCount() === 1, "terminal read keeps today's card without another effect");
  check(!document.querySelector('[aria-label="本地已結案與歷史紀錄"]') && !find("main").textContent?.includes("crossday-unknown"), "history stays outside this page");
  const protection = [...card("crossday-today-filled").querySelectorAll("details")].find(node => node.querySelector("summary")?.textContent === "券商委託與停損停利")!;
  protection.open = true; await click(protection, "讀取此單");
  check(protection.innerText.includes("停損觸發價") && !getButton(protection, "撤銷券商委託"), "same-day filled preserves usable protection entry without cancellation");
  const source = [...card("crossday-partial").querySelectorAll("details")].find(node => node.querySelector("summary")?.textContent === "本地來源與讀回")!;
  source.open = true; await click(source, "讀回本地來源");
  check(JSON.stringify(f.stages) === originalStages && cancelCount() === 1, "local frozen receipts and Candidate lifecycles are never rewritten");
  check(document.documentElement.scrollWidth <= innerWidth, "no horizontal overflow");
  find("#fixture-receipt").textContent = JSON.stringify({ calls, preview }, null, 2);
  document.body.dataset.testResult = `PASS crossday ${innerWidth}px: strict today/default-TW inline cancel, no N+1, dedupe/detail latch, fill race=0, UNKNOWN=1, protection/source retained`;
}
run().catch(error => { document.body.dataset.testResult = `FAIL ${error.message}`; });
