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
  if (name === "omi_read_desk_staged") value = { result: f.stages };
  else if (name === "omi_read_desk_stage") value = f.stages.find(row => row.id === args.id);
  else if (name === "omi_read_desk_orders") { if (failOrders) throw Error("synthetic stale list"); value = f.data; }
  else if (name === "omi_read_desk_order") {
    const item = f.orders.find(item => item.review.execution_id === args.id);
    check(item && args.market === "TW", "single read uses exact Native identity and default TW market");
    if (item.broker.symbol === "crossday-active" && fillRace) setState("crossday-active", "FILLED");
    if (item.broker.symbol === "crossday-partial" && cancelResolved) setState("crossday-partial", "CANCELLED");
    const protection = item.broker.symbol === "crossday-filled" ? { entry_execution_id: args.id, strategy_id: "synthetic-protection", strategy_revision: 1,
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
const card = (symbol: string, local = true) => find(`[aria-label="${symbol} ${local ? "本地掛單" : "券商委託"}"]`);
const getButton = (node: Element, label: string) => [...node.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === label);
const button = (node: Element, label: string) => { const value = getButton(node, label); check(value, label); return value; };
const click = async (node: Element, label: string) => { const value = button(node, label); check(!value.disabled, `${label} enabled`); value.click(); await pause(); await pause(); };
const main = () => find('[aria-label="本地目前委託"]');
const cancelCount = () => calls.filter(call => call.name === "omi_cancel_desk_order").length;

async function run() {
  render(); await pause(); await pause();
  check(!calls.some(call => call.name === "omi_read_desk_order"), "initial render has no N+1 single-order reads");
  check([...document.querySelectorAll("details")].every(node => !node.open), "history/protection start collapsed");
  check(!/crossday-(filled|cancelled|rejected|unknown|today-filled)/.test(main().innerText), "terminal and past unresolved local rows leave the main list");
  check(main().innerText.includes("crossday-undated") && card("crossday-undated").innerText.includes("原委託日未確認"), "unknown date stays visible with reason");
  for (const symbol of ["crossday-active", "crossday-partial"]) {
    check(!("market" in (bySymbol(symbol).row.raw as UnknownRecord)), "fixture actually omits local raw.market");
    const cancel = button(card(symbol), "撤銷剩餘委託"), box = cancel.getBoundingClientRect();
    check(!cancel.disabled && box.width > 80 && box.left >= 0 && box.right <= innerWidth, "default-TW main card cancel is directly visible and fits");
  }
  for (const symbol of ["crossday-missing-id", "crossday-external", "crossday-untrusted", "crossday-undated"]) {
    check(!getButton(card(symbol), "撤銷剩餘委託"), `${symbol} has no false cancel action`);
    check(card(symbol).querySelectorAll(".workspace-ticket-note").length > 0, `${symbol} gives a reason`);
  }
  const preview = { html: document.querySelector("main")!.outerHTML, css: styles };
  failOrders = true; await click(document.body, "更新委託");
  check(!getButton(card("crossday-active"), "撤銷剩餘委託") && card("crossday-active").innerText.includes("過期"), "stale list removes upper cancel and gives reason");
  failOrders = false; await click(document.body, "更新委託");
  fillRace = true; await click(card("crossday-active"), "撤銷剩餘委託");
  check(cancelCount() === 0 && !main().innerText.includes("crossday-active"), "pre-read catches FILLED race, no mutation, upper card moves to history");
  const before = calls.length, upper = button(card("crossday-partial"), "撤銷剩餘委託"), lower = button(card("crossday-partial", false), "撤銷剩餘委託");
  upper.click(); upper.click(); lower.click(); await pause(); await pause();
  const effects = calls.slice(before).filter(call => /omi_(read|cancel)_desk_order$/.test(call.name));
  check(effects.map(call => call.name).join(",") === "omi_read_desk_order,omi_cancel_desk_order", "upper/lower double click share read-before-cancel lock");
  check(effects.every(call => call.args.id === "synthetic-execution-crossday-partial" && call.args.market === "TW"), "omitted raw market still sends only exact TW identity");
  check(cancelCount() === 1 && button(card("crossday-partial"), "撤銷剩餘委託").disabled && button(card("crossday-partial", false), "撤銷剩餘委託").disabled, "UNKNOWN locks both entries");
  const detail = [...card("crossday-partial").querySelectorAll("details")].find(node => node.querySelector("summary")?.textContent === "券商委託與停損停利")!;
  detail.open = true; await click(detail, "讀取此單");
  check(button(detail, "撤銷券商委託").disabled, "protection detail shares the same cancellation latch");
  generation++; render(); await pause(); await pause();
  check(button(card("crossday-partial"), "撤銷剩餘委託").disabled && button(card("crossday-partial", false), "撤銷剩餘委託").disabled, "refresh/remount cannot forget UNKNOWN");
  await click(card("crossday-partial"), "核對此單"); check(cancelCount() === 1 && button(card("crossday-partial"), "撤銷剩餘委託").disabled, "old partial exact read cannot unlock resend");
  cancelResolved = true; await click(card("crossday-partial"), "核對此單");
  check(!main().innerText.includes("crossday-partial") && cancelCount() === 1, "terminal read moves local card into history without another effect");
  const history = find<HTMLDetailsElement>('[aria-label="本地已結案與歷史紀錄"]'); history.open = true;
  for (const [symbol, label, date] of [["crossday-filled", "已成交", "2026-11-06"], ["crossday-cancelled", "已撤銷", "2026-11-09"], ["crossday-rejected", "遭拒絕", "2026-11-02"], ["crossday-unknown", "歷史待核對", "2026-11-02"]]) {
    check(card(symbol).innerText.includes(label) && card(symbol).innerText.includes(date) && !getButton(card(symbol), "撤銷剩餘委託"), "historical state/date exact and non-cancellable");
    check(!button(card(symbol), "讀回").disabled, "history retains original stage read");
  }
  const unknown = [...card("crossday-unknown").querySelectorAll("dl > div")].find(node => node.querySelector("dt")?.textContent === "已成交");
  check(unknown?.querySelector("dd")?.textContent === "未提供 股", "unknown fill is never coerced to zero");
  const protection = [...card("crossday-filled").querySelectorAll("details")].find(node => node.querySelector("summary")?.textContent === "券商委託與停損停利")!;
  protection.open = true; await click(protection, "讀取此單");
  check(protection.innerText.includes("停損觸發價") && !getButton(protection, "撤銷券商委託"), "filled history preserves usable protection entry without cancellation");
  await click(card("crossday-unknown"), "讀回");
  check(JSON.stringify(f.stages) === originalStages && cancelCount() === 1, "local frozen receipts and Candidate lifecycles are never rewritten");
  check(document.documentElement.scrollWidth <= innerWidth, "no horizontal overflow");
  find("#fixture-receipt").textContent = JSON.stringify({ calls, preview }, null, 2);
  document.body.dataset.testResult = `PASS crossday ${innerWidth}px: exact history/default-TW main cancel, no N+1, upper/lower/detail latch, fill race=0, UNKNOWN=1, protection/history retained`;
}
run().catch(error => { document.body.dataset.testResult = `FAIL ${error.message}`; });
