// In-memory BrokerReadback integration: no provider, storage or trading calls.
import { createRoot } from "react-dom/client";
import { BrokerReadback } from "../src/DeskOrders";
import styles from "../src/styles.css";
const style = document.createElement("style"); style.textContent = styles; document.head.append(style);
const noIO = () => { throw Error("Real IO forbidden"); };
window.fetch = noIO; window.WebSocket = noIO as unknown as typeof WebSocket;
Storage.prototype.setItem = noIO;
const base = { quality: "PARTIAL", complete: false, source_as_of: null, queried_at: "2026-11-16T03:18:14Z", empty_confirmed: null };
const data = { contract: "omi.execution-desk.v1", trade_date: "2026-11-16", quality: "PARTIAL", inventory: {
  cash: { ...base, items: [{ symbol: "3702", reported_total_shares: 0, odd_shares: 0, closeable_shares: 0, orderable_shares: 0, odd_closeable_shares: 0 }] },
  margin: { ...base, items: [{ symbol: "2337", reported_total_shares: 1000, closeable_shares: 800, orderable_shares: 600 }] },
  short_selling: { ...base, items: [{ symbol: "1802", reported_total_shares: 2000, closeable_shares: 2000, orderable_shares: 2000 }] },
} };
let calls = 0;
const bridge = { async callTool(name: string) {
  if (name !== "omi_read_desk_inventory") throw Error("unexpected tool");
  calls++; return { structuredContent: structuredClone(data) };
} };
const root = createRoot(document.getElementById("root")!);
const render = (key: number) => root.render(<main className="tw-workspace"><BrokerReadback key={key} bridge={bridge} kind="inventory" active/></main>);
const wait = () => new Promise(resolve => setTimeout(resolve, 80));
function check(value: unknown, message: string) { if (!value) throw Error(message); }
async function run() {
  render(0); await wait(); await wait();
  const zeros = document.querySelector<HTMLDetailsElement>('.workspace-zero-inventory details');
  if (zeros) { zeros.open = true; await wait(); await wait(); }
  const cash = document.querySelector('[aria-label="現股券商庫存"]')!;
  check(document.querySelector('[aria-label="3702 券商庫存"]')?.textContent?.includes("今日餘額0 股"), "cash zero retained");
  check(cash.textContent?.includes("零值不代表已確認空手"), "zero not empty");
  check(document.querySelector('[aria-label="2337 券商庫存"]')?.textContent?.includes("1000 股"), "margin despite zero cash");
  check(document.querySelector('[aria-label="1802 券商庫存"]')?.textContent?.includes("待回補"), "short liability separate");
  check(document.documentElement.scrollWidth <= innerWidth, "no horizontal overflow");
  // Empty frame and unknown are distinct, neither is confirmed empty.
  data.inventory.margin.items = [];
  Object.assign(data.inventory.short_selling, { items: null, quality: "UNKNOWN" });
  render(1); await wait(); await wait();
  check(document.body.textContent?.includes("本次未回傳庫存列，尚不能確認空手"), "empty frame semantics");
  check(document.body.textContent?.includes("庫存未知，不視為零"), "unknown semantics");
  check(calls === 2, "one read per mount and no effects");
  document.querySelector("#fixture-receipt")!.textContent = JSON.stringify({ calls, cash_zero: true, margin_nonzero: true, short_liability: true, no_effects: true });
  document.body.dataset.testResult = `PASS inventory ${innerWidth}px`;
}
run().catch(error => { document.body.dataset.testResult = `FAIL ${error.message}`; });
