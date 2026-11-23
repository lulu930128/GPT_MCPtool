import { createRoot } from "react-dom/client";
import { DeskOrders } from "../src/DeskOrders";
import { fixtureStagedDays, fixtureTodayOrders } from "./today-orders-fixture";
import type { UnknownRecord } from "../src/state";
import styles from "../src/styles.css";

const style = document.createElement("style");
style.textContent = styles + ".today-fixture{display:block;max-width:650px;margin:auto;padding:12px}.today-fixture .workspace-context{display:block;width:100%;min-width:0}";
document.head.append(style);
const noIO = () => { throw Error("No real IO permitted"); };
window.fetch = noIO; window.WebSocket = noIO as unknown as typeof WebSocket; Storage.prototype.setItem = noIO;
const f = fixtureTodayOrders(), original = JSON.stringify(f), calls: { name: string; args: UnknownRecord }[] = [];
let failRead = false, localRows = f.stages;
const bridge = { async callTool(name: string, args: UnknownRecord = {}) {
  calls.push({ name, args });
  let value: unknown;
  if (name === "omi_read_desk_staged") value = { result: localRows };
  else if (name === "omi_read_desk_orders") { if (failRead) throw Error("synthetic offline"); value = f.data; }
  else if (name === "omi_read_desk_stage") value = localRows.find(item => item.id === args.id);
  else if (name === "omi_search_tw_symbols") value = { kind: "omi.tw_symbol_search", query: args.keyword, items: [{ stock_id: args.keyword, stock_name: "測試名稱" }] };
  else if (name === "omi_read_desk_order") {
    const order = f.orders.find(item => item.review.execution_id === args.id); check(order && args.market === "TW", "read exact identity");
    value = { market: "TW", execution: order.review.execution, command: (order.review.draft as any).command, protection: null };
  } else throw Error(`Forbidden fixture operation: ${name}`);
  return { structuredContent: structuredClone(value) };
} };
const root = createRoot(document.getElementById("root")!);
let generation = 0, sample = 0;
const render = (view: "orders" | "staged" = "orders", focus = String(f.past[0].row.id)) => root.render(<main className="tw-workspace today-fixture" data-workspace-view="trade"><div className="workspace-context"><DeskOrders key={sample} bridge={bridge} active refreshKey={generation} view={view} focusStageId={focus}/></div></main>);
const pause = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms));
function check(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
const find = (selector: string) => { const node = document.querySelector<HTMLElement>(selector); check(node, selector); return node; };
const click = async (label: string, scope: Element = document.body) => {
  const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label);
  check(button && !button.disabled && button.getBoundingClientRect().height >= 44, `${label} reachable`); button.click(); await pause();
};
const cards = () => [...find('[aria-label="當日委託清單"]').querySelectorAll<HTMLElement>("article.workspace-order-card")];
const checkToday = () => {
  check(cards().length === 2, "exact same-day dedupe only");
  check(cards()[0].innerText.includes("83.1") && cards()[0].innerText.includes("10:09:44") && cards()[0].innerText.includes("已受理"), "new order first");
  check(cards()[1].innerText.includes("82.5") && cards()[1].innerText.includes("09:11:49") && cards()[1].innerText.includes("已撤銷"), "same-day cancelled remains second");
  check(cards()[0].innerText.includes("剩餘 1,000 股") && cards()[1].innerText.includes("剩餘 0 股"), "reported remainders preserved");
  const content = find('[aria-label="券商委託"]').textContent!;
  for (const symbol of ["1802", "2409", "2330", "8227"]) check(!content.includes(symbol), `past ${symbol} absent even in collapsed DOM`);
  check(!document.querySelector('[aria-label="歷史委託"], [aria-label="跨日待核對委託"], [aria-label="本地已結案與歷史紀錄"]'), "no historical sections");
  check(!find('[aria-label="當日委託清單"]').textContent!.includes("9999"), "unknown dates outside today");
  check(document.documentElement.scrollWidth <= innerWidth, "no horizontal overflow");
};
async function run() {
  render(); await pause(400); checkToday();
  check(!calls.some(call => call.name === "omi_read_desk_order"), "no automatic per-order reads");
  const cancel = [...cards()[0].querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "撤銷剩餘委託")!;
  check(cancel && !cancel.disabled && cancel.getBoundingClientRect().height >= 44, "original inline cancel remains usable, never clicked");
  check(!cards()[1].querySelector('.candidate-primary'), "cancelled has no active cancellation");
  const unknown = find('[aria-label="委託日期待確認"]') as HTMLDetailsElement;
  unknown.querySelector<HTMLElement>("summary")!.click(); await pause(); await click("讀回原紀錄", unknown); unknown.open = false;
  checkToday();
  const source = [...cards()[0].querySelectorAll<HTMLDetailsElement>("details")].find(node => node.querySelector("summary")?.textContent === "本地來源與讀回")!;
  source.querySelector<HTMLElement>("summary")!.click(); await pause(); await click("讀回本地來源", source); source.open = false;
  checkToday();
  failRead = true; await click("更新委託"); checkToday();
  check(find('[aria-label="券商委託"]').innerText.includes("可能已過期"), "failed refresh marks last trade date stale");
  failRead = false; await click("更新委託");
  const systemClock = Date.now;
  const clockAt = (instant: string) => {
    const offset = Date.parse(instant) - systemClock();
    Date.now = () => systemClock() + offset;
  };
  clockAt("2026-11-23T13:53:00+08:00"); localRows = fixtureStagedDays(); sample++;
  const snapshot = JSON.stringify(localRows), old = localRows.slice(3);
  const stageCards = () => [...find('[aria-label="本地待送單"]').querySelectorAll<HTMLElement>("article.workspace-order-card")];
  render("staged", String(old[1].id)); await pause(300);
  check(find('[aria-label="待送單範圍"] button').getAttribute("aria-pressed") === "true", "defaults to today despite historical focus");
  check(stageCards().length === 3 && stageCards().every(card => card.closest('[aria-label="當日已送委託"]') && card.innerText.includes("已成交")), "3 filled today after close");
  check(old.every(row => !document.getElementById(`stage-${row.id}`)) && !document.querySelector('[aria-label="跨日待核對"]'), "no old card or review group in today's DOM");
  const stagedPreview = document.querySelector("main")!.outerHTML;
  await click("歷史（32）");
  check(stageCards().length === 32 && old.every(row => document.getElementById(`stage-${row.id}`)), "history mounts exactly the 32 older IDs");
  const review = find('[aria-label="跨日待核對"]');
  check(["1802", "2409", "5000"].every(symbol => review.innerText.includes(symbol)) && review.innerText.includes("已受理"), "old unknown and accepted remain unresolved");
  const cancelled = find(`#stage-${old[0].id}`);
  check(cancelled.innerText.includes("00685L") && cancelled.innerText.includes("2026-11-19") && cancelled.innerText.includes("已取消"), "original local cancellation retained");
  check(stageCards().every(card => [...card.querySelectorAll("button")].every(button => button.textContent === "讀回")), "history permits reads only");
  await click("讀回", cancelled);
  check(calls.some(call => call.name === "omi_read_desk_stage" && call.args.id === old[0].id), "exact original ID read");
  await click("當日（3）"); check(stageCards().length === 3 && !cancelled.isConnected, "switch unmounts history");
  check(JSON.stringify(localRows) === snapshot, "source receipts remain intact");

  const undated = { ...old[0], id: "missing-creation", stage_validity: null };
  localRows = [...localRows, undated]; generation++; render("staged", undated.id); await pause(150);
  check(!document.getElementById("stage-missing-creation") && stageCards().length === 3, "focus does not reveal unknown date on today");
  await click("歷史（33）");
  const disclosure = find("#stage-missing-creation").closest("details");
  check(disclosure && !disclosure.open && disclosure.querySelector("summary")?.textContent?.includes("建立日期待核對（1）"), "unknown date is in closed history review");
  await click("當日（3）");

  // Resume just before midnight with unchanged Backend rows and no further poll.
  // The civil-day timer alone must move today's filled cards into history.
  clockAt("2026-11-23T23:59:59.500+08:00");
  document.dispatchEvent(new Event("visibilitychange")); await pause(150);
  const listReads = () => calls.filter(call => call.name === "omi_read_desk_staged").length;
  const beforeMidnight = listReads();
  check(stageCards().length === 3, "still today before Taipei midnight");
  await pause(550);
  check(stageCards().length === 0 && listReads() === beforeMidnight, "midnight changes rendering without a new list read");
  await click("歷史（36）"); check(stageCards().length === 36, "new day history includes previous three");
  Date.now = systemClock; localRows = f.stages; sample++;
  render(); await pause(300); checkToday();
  const preview = document.querySelector("main")!.outerHTML;
  f.data.trade_date = "2026-11-17"; generation++; render("orders", String(f.later.row.id)); await pause(250);
  check(cards().length === 0 && !document.body.innerText.includes("3702"), "focus cannot override changed Backend date");
  f.data.trade_date = "2026-11-16";
  check(JSON.stringify(f) === original, "no data, fills, inventory, raw, lifecycle or receipt mutation");
  check(calls.every(call => /^(omi_read_|omi_search_tw_symbols)/.test(call.name)), "zero send/cancel/amend/delete calls");
  root.unmount(); document.getElementById("root")!.innerHTML = stagedPreview;
  document.body.dataset.testResult = `PASS today ${innerWidth}px: 11/16 strict date, newest first, terminal kept, exact dedupe, 35 staged rows split 3/32, date-unknown and midnight, zero mutations`;
  document.getElementById("fixture-receipt")!.textContent = JSON.stringify({ result: document.body.dataset.testResult, calls, preview: { html: preview, css: style.textContent } });
}
void run().catch(error => { document.body.dataset.testResult = `FAIL ${String(error)}`; });
