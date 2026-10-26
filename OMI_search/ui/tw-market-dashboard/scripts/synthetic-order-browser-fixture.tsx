// Offline component fixture. CSP and tripwires forbid transport and persistence.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceContext } from "../src/WorkspaceContext";
import styles from "../src/styles.css";

const style = document.createElement("style"); style.textContent = styles; document.head.append(style);
const forbidden = () => { throw new Error("Unexpected IO in SYNTHETIC panel"); };
window.fetch = forbidden;
window.XMLHttpRequest = forbidden as unknown as typeof XMLHttpRequest;
window.WebSocket = forbidden as unknown as typeof WebSocket;
window.postMessage = forbidden;
Storage.prototype.setItem = forbidden;
function Fixture() {
  const [symbol, select] = useState("2330");
  return <main className="tw-workspace" style={{ maxWidth: 390, margin: "auto" }}>
    <button id="fixture-select" onClick={() => select(symbol === "2330" ? "0050" : "2330")}>切換 fixture 標的</button>
    <WorkspaceContext symbol={symbol}><p>獨立研究 fixture</p></WorkspaceContext>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
const pause = () => new Promise((resolve) => setTimeout(resolve, 40));
function find<T extends HTMLElement = HTMLElement>(selector: string) {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node;
}
let checks = 0;
const check = (condition: unknown, name: string) => { if (!condition) throw new Error(name); checks++; };
async function click(selector: string) { find(selector).click(); await pause(); }
async function change(label: string, value: string) {
  const node = find<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`);
  const prototype = node.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
  node.dispatchEvent(new Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  await pause();
}
async function fill() {
  await change("模擬方向", "BUY"); await change("模擬委託類型", "LIMIT");
  await change("模擬交易單位", "BOARD"); await change("模擬股數", "1000"); await change("模擬限價", "100");
}
async function run() {
  await pause();
  await click('[aria-controls="workspace-order-content"]');
  check(!find("#workspace-order-content").hidden, "order tab opens");
  check(find<HTMLInputElement>('[aria-label="模擬限價"]').value === "", "no default price");
  await click('.synthetic-ticket button[type="submit"]');
  check(!!document.querySelector('[role="alert"]'), "empty validation");
  await fill(); await click('.synthetic-ticket button[type="submit"]');
  check(find(".synthetic-ticket").dataset.phase === "preview", "preview created");
  check(find<HTMLButtonElement>(".synthetic-preview button").disabled, "confirmation requires acknowledgement");
  await click('.synthetic-ack input');
  await change("模擬限價", "99");
  check(!document.querySelector(".synthetic-preview"), "edit clears preview and intent");
  await click('.synthetic-ticket button[type="submit"]'); await click('.synthetic-ack input');
  const confirm = find<HTMLButtonElement>(".synthetic-preview button"); confirm.click(); confirm.click(); await pause();
  check(find(".synthetic-receipt").textContent?.includes("SIMULATED_PENDING"), "confirm only creates pending");
  check(find(".synthetic-receipt").textContent?.includes("模擬次數 1"), "duplicate confirm once");
  await click(".synthetic-receipt button"); await click(".synthetic-receipt button");
  check(find(".synthetic-receipt > strong").textContent === "SIMULATED_PARTIALLY_FILLED", "partial report");
  await click(".synthetic-ticket > button");
  check(find(".synthetic-receipt > strong").textContent === "CANCEL_PENDING", "cancel is intent");
  await click(".synthetic-receipt button");
  check(find(".synthetic-receipt > strong").textContent === "SIMULATED_CANCELLED", "explicit cancel report");
  check(find(".synthetic-receipt").textContent?.includes("累積模擬成交 500 股"), "fills preserved");
  await click('[aria-controls="workspace-research-content"]');
  check(find("#workspace-order-content").hidden, "research tab hides simulation");
  await click("#fixture-select"); await click('[aria-controls="workspace-order-content"]');
  check(find(".synthetic-symbol").textContent?.includes("0050"), "new symbol");
  check(find<HTMLInputElement>('[aria-label="模擬方向"]').value === "", "selection clears fields");
  check(!document.querySelector(".synthetic-receipt"), "selection clears receipt even while hidden");
  await fill(); await click('.synthetic-ticket button[type="submit"]'); await click('.synthetic-ack input');
  window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("pageshow")); await pause();
  check(!document.querySelector(".synthetic-preview"), "page lifecycle clears intent");
  const details = find<HTMLDetailsElement>(".workspace-context-disclosure");
  details.open = false; await pause();
  check(find(".synthetic-ticket").getBoundingClientRect().height === 0, "native mobile collapse");
  details.open = true; await fill(); await click('.synthetic-ticket button[type="submit"]');
  check(document.documentElement.scrollWidth <= window.innerWidth, "no horizontal overflow");
  const ack = find<HTMLInputElement>(".synthetic-ack input"); ack.focus();
  check(document.activeElement === ack && getComputedStyle(ack).outlineStyle !== "none", "keyboard focus");
  document.body.dataset.testResult = `PASS ${checks} offline synthetic UI checks`;
}
run().catch((error) => { document.body.dataset.testResult = `FAIL ${String(error)}`; });
