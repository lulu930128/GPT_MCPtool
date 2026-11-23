// Offline UI verification: synthetic orders only; no Backend/Native connection.
import { createRoot } from "react-dom/client";
import { WorkspaceContext } from "../src/WorkspaceContext";
import { StockName } from "../src/StockName";
import { fixtureSubmittedOrder, fixtureStage, fixtureReadback } from "./desk-fixture";
import type { UnknownRecord } from "../src/state";
import styles from "../src/styles.css";

const style = document.createElement("style");
style.textContent = styles + ".ux-fixture {display:block;max-width:650px;margin:auto;padding:12px}.ux-fixture .workspace-context{width:100%;min-width:0}";
document.head.append(style);
const noIO = () => { throw Error("No real IO permitted"); };
window.fetch = noIO; window.WebSocket = noIO as unknown as typeof WebSocket; Storage.prototype.setItem = noIO;
const sent = fixtureSubmittedOrder("3702", "ACCEPTED", "2026-11-11", { price: "82.5", lot: "Odd", quantity_shares: 800 });
const staged = fixtureStage({ symbol: "3702", price: "83.1", client_intent_id: "synthetic-other-3702", quantity_shares: 1000 });
const second = fixtureStage({ symbol: "2330", price: "100.25", action: "Sell", client_intent_id: "synthetic-2330" });
const data = { ...fixtureReadback([sent.review]), trade_date: "2026-11-11", broker_orders: [sent.broker] };
const calls: { name: string; args: UnknownRecord }[] = [];
let stages = [sent.row, staged, second];
const bridge = { async callTool(name: string, args: UnknownRecord = {}) {
  calls.push({ name, args });
  let value: unknown;
  if (name === "omi_search_tw_symbols") value = { kind: "omi.tw_symbol_search", query: args.keyword, items: [{ stock_id: args.keyword, stock_name: args.keyword === "3702" ? "大聯大" : "台積電" }] };
  else if (name === "omi_read_desk_staged") value = { result: stages };
  else if (name === "omi_read_desk_orders" || name === "omi_read_desk_fills" || name === "omi_read_desk_inventory") value = data;
  else if (name === "omi_read_desk_status") throw Error("synthetic offline status");
  else if (name === "omi_revise_candidate") {
    const row = stages.find(item => item.id === args.id)!;
    check(row && row.revision === args.expected_revision, "exact revision");
    value = { ...row, event: "REVISE", revision: Number(row.revision) + 1, digest: "e".repeat(64), raw: args.raw };
    stages = stages.map(item => item.id === args.id ? value as UnknownRecord : item);
  } else throw Error(`Unexpected fixture tool: ${name}`);
  return { structuredContent: structuredClone(value) };
} };
function check(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
const pause = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms));
const root = createRoot(document.getElementById("root")!);
const find = (selector: string) => { const node = document.querySelector<HTMLElement>(selector); check(node, selector); return node; };
const button = (label: string, scope: Element = document.body) => { const node = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label); check(node, label); return node; };
const click = async (label: string, scope?: Element) => { const node = button(label, scope); check(!node.disabled && node.getBoundingClientRect().height >= 44, `${label} enabled and touchable`); node.click(); await pause(); };
const overflow = () => check(document.documentElement.scrollWidth <= innerWidth + 1, "no horizontal overflow");
const sideColors = {
  Buy: { solid: "rgb(169, 67, 82)", accent: "rgb(225, 129, 138)", label: "買進" },
  Sell: { solid: "rgb(36, 121, 95)", accent: "rgb(89, 184, 154)", label: "賣出" },
};

function luminance(color: string) {
  const channels = color.match(/\d+/g)?.map(channel => Number(channel) / 255);
  check(channels?.length === 3, `opaque RGB: ${color}`);
  const [r, g, b] = channels.map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function checkContrast(foreground: string, background: string, label: string) {
  const values = [luminance(foreground), luminance(background)];
  check((Math.max(...values) + 0.05) / (Math.min(...values) + 0.05) >= 4.5, `${label} text contrast`);
}

function checkAction(action: HTMLButtonElement, side: keyof typeof sideColors) {
  const css = getComputedStyle(action);
  check(action.dataset.side === side && css.backgroundColor === sideColors[side].solid, `${side} action fill`);
  checkContrast(css.color, css.backgroundColor, `${side} action`);
  check(getComputedStyle(action, "::before").display !== "none", `${side} action direction icon`);
}

function checkSummary(summary: HTMLElement, side: keyof typeof sideColors) {
  const label = summary.querySelector(".workspace-order-direction");
  check(label?.textContent?.includes(sideColors[side].label), `${side} summary explicitly names side`);
  const css = getComputedStyle(label!);
  check(css.color === sideColors[side].accent, `${side} summary accent`);
  checkContrast(css.color, getComputedStyle(summary).backgroundColor, `${side} summary`);
}

async function run() {
  root.render(<main className="tw-workspace ux-fixture" data-workspace-view="trade"><WorkspaceContext bridge={bridge} symbol="3702"/></main>);
  await pause(400);
  check(find(".workspace-ticket-identity").textContent?.includes("3702 大聯大"), "manual exact name");
  check(find(".workspace-trade-heading").textContent?.includes("3702 大聯大"), "header exact name");
  check(calls.filter(call => call.name === "omi_search_tw_symbols" && call.args.keyword === "3702").length === 1, "shared name request");
  const form = find(".workspace-order-form"), buy = button("買進", form), sell = button("賣出", form);
  const submit = button("加入掛單", form);
  check(buy.getAttribute("aria-pressed") === "true", "Buy initially selected");
  checkAction(buy, "Buy"); checkAction(submit, "Buy"); checkSummary(find(".workspace-order-review"), "Buy");
  check(getComputedStyle(buy, "::before").transform !== getComputedStyle(sell, "::before").transform, "opposite icons distinguish directions");
  sell.focus();
  check(getComputedStyle(sell).outlineColor === sideColors.Sell.accent, "Sell keyboard focus accent");
  await click("賣出", form);
  check(sell.getAttribute("aria-pressed") === "true" && buy.getAttribute("aria-pressed") === "false", "Sell selection updates");
  checkAction(sell, "Sell"); checkAction(submit, "Sell"); checkSummary(find(".workspace-order-review"), "Sell");
  await click("現先賣", form);
  const disabled = getComputedStyle(buy);
  check(buy.disabled && disabled.borderStyle === "dashed" && disabled.color === sideColors.Buy.accent, "ineligible Buy stays visibly disabled");
  checkContrast(disabled.color, disabled.backgroundColor, "disabled Buy");
  await click("現股", form);
  overflow();
  await click("待送單"); await pause(250);
  const card = find(`[id="stage-${staged.id}"]`), other = find(`[id="stage-${second.id}"]`);
  check(card.innerText.includes("3702 大聯大") && other.innerText.includes("2330 台積電"), "multiple exact names");
  const css = getComputedStyle(card), a = card.getBoundingClientRect(), b = other.getBoundingClientRect();
  check(css.backgroundColor !== "rgba(0, 0, 0, 0)" && parseFloat(css.borderRadius) > 0 && b.top - a.bottom >= 12, "separate order surfaces and spacing");
  check([...card.querySelectorAll("details")].every(item => !item.open), "secondary info collapsed");
  check(button("送單", card).getBoundingClientRect().height >= 44, "primary action touch size");
  button("送單", card).focus(); check(document.activeElement === button("送單", card), "focus accessible");
  for (const [side, order] of [["Buy", card], ["Sell", other]] as const) {
    checkAction(button("送單", order), side);
    check(getComputedStyle(order.querySelector(".workspace-order-facts .workspace-order-tint")!).color === sideColors[side].accent, `${side} staged amount accent`);
    await click("送單", order);
    const dialog = find("dialog[open]");
    checkSummary(find("dialog .workspace-order-confirm-facts"), side);
    checkAction(button(`確認送單 · ${sideColors[side].label}`, dialog), side);
    check(document.activeElement === button("取消", dialog), "modal defaults to cancel focus");
    await click("取消", dialog); check(!document.querySelector("dialog"), "cancel leaves zero send");
  }
  const secondary = card.querySelector<HTMLDetailsElement>(".workspace-secondary-actions")!;
  secondary.querySelector<HTMLElement>("summary")!.click(); await pause(); await click("修改", card);
  check(find('[aria-label="修改本地待送單"]'), "inline edit");
  await click("儲存修改", card); check(calls.filter(call => call.name === "omi_revise_candidate").length === 1, "one fake local revision");
  check(!card.querySelector('[aria-label="修改本地待送單"]') && !button("送單", card).disabled, "saved revision leaves edit and preserves send");
  secondary.open = false;
  overflow();
  const stagedPreview = document.querySelector("main")!.outerHTML;
  await click("券商委託"); await pause();
  const live = find(`[id="stage-${sent.row.id}"]`), related = [...live.querySelectorAll("details")].find(item => item.querySelector("summary")?.textContent === "本地來源與讀回")!;
  check(related && !related.open && live.querySelectorAll(".workspace-order-card").length === 1, "same execution has one broker card with collapsed local source");
  check(!button("撤銷剩餘委託", live).disabled && button("撤銷剩餘委託", live).getBoundingClientRect().height >= 44, "inline cancel retained but never clicked");
  related.querySelector<HTMLElement>("summary")!.click(); await pause();
  check(related.innerText.includes("讀回本地來源"), "related source expand"); related.open = false;
  overflow();
  await click("成交"); overflow(); await click("庫存"); overflow();
  // A delayed response from a previous symbol cannot repaint the current name.
  let resolveOld!: (value: unknown) => void;
  const lateBridge = { async callTool(_name: string, args: UnknownRecord) {
    if (args.keyword === "3702") return await new Promise(resolve => { resolveOld = resolve; });
    return { structuredContent: { kind: "omi.tw_symbol_search", query: "2330", items: [{ stock_id: "2330", stock_name: "台積電" }] } };
  } };
  root.render(<StockName bridge={lateBridge} symbol="3702"/>); await pause(250);
  root.render(<StockName bridge={lateBridge} symbol="2330"/>); await pause(250);
  resolveOld({ structuredContent: { kind: "omi.tw_symbol_search", query: "3702", items: [{ stock_id: "3702", stock_name: "大聯大" }] } }); await pause();
  check(document.body.innerText.includes("台積電") && !document.body.innerText.includes("大聯大"), "late symbol response ignored");
  root.render(<StockName bridge={lateBridge} symbol="3702" market="US"/>); await pause();
  check(!document.body.innerText.includes("大聯大"), "US does not inherit TW name");
  check(!calls.some(call => /omi_(confirm|cancel|revise_order)_desk|omi_revise_order_protection/.test(call.name)), "no broker mutation");
  root.unmount(); document.getElementById("root")!.innerHTML = stagedPreview;
  document.body.dataset.testResult = `PASS ux ${innerWidth}px: Buy/Sell controls, contrast, focus, disabled, summaries, modal cancel, no overflow, no broker mutation`;
  document.getElementById("fixture-receipt")!.textContent = JSON.stringify({ result: document.body.dataset.testResult, calls, preview: { html: stagedPreview, css: style.textContent } });
}
void run().catch(error => { document.body.dataset.testResult = `FAIL ${String(error)}`; });
