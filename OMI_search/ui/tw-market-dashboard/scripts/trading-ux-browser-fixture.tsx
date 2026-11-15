// Real React DOM, controlled latency, no Backend/SDK/storage access.
import { createRoot } from "react-dom/client";
import { WorkspaceContext } from "../src/WorkspaceContext";
import { ResearchPanel } from "../src/ResearchPanel";
import { fixtureStage, fixtureConnection } from "./desk-fixture";
import { fixtureResearch, fixtureResearchList } from "./research-fixture";
import type { UnknownRecord } from "../src/state";
import styles from "../src/styles.css";

document.head.append(Object.assign(document.createElement("style"), { textContent: styles + ".ux-fixture{max-width:720px;margin:0 auto;padding:16px}.ux-fixture .workspace-context{display:grid}" }));
const noIO = () => { throw Error("Real IO forbidden"); };
window.fetch = noIO; window.WebSocket = noIO as unknown as typeof WebSocket; Storage.prototype.setItem = noIO;
const root = createRoot(document.getElementById("root")!);
const pause = (ms = 30) => new Promise<void>(resolve => setTimeout(resolve, ms));
function check(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
const button = (label: string) => { const node = [...document.querySelectorAll("button")].find(node => node.textContent === label && node.getBoundingClientRect().height > 0); check(node, label); return node; };
const click = async (label: string) => { const node = button(label); check(!node.disabled, `${label} enabled`); node.click(); await pause(); };
const chooseMarket = async (market: string) => {
  const input = document.querySelector<HTMLSelectElement>('.workspace-research select')!;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(input, market);
  input.dispatchEvent(new Event("change", { bubbles: true })); await pause();
};
const receipt: UnknownRecord = { latency: [], calls: [] };

async function delayedDrafts() {
  for (const delay of [1000, 5000, 20000]) {
    let row = fixtureStage({ client_intent_id: `slow-${delay}`, symbol: "3481", lot: "Odd", quantity_shares: 1 });
    let mutations = 0, nativeReads = 0;
    const bridge = { async callTool(name: string, args: UnknownRecord) {
      (receipt.calls as string[]).push(name);
      if (name === "omi_read_desk_status") return { structuredContent: fixtureConnection() };
      if (name === "omi_read_desk_staged") return { structuredContent: { result: [row] } };
      if (name === "omi_read_desk_orders") { nativeReads++; throw Error("Broker must not block local drafts"); }
      if (name === "omi_cancel_candidate") {
        mutations++; check(args.id === row.id && args.expected_revision === row.revision, "cancel pin");
        await pause(delay);
        row = { ...row, revision: Number(row.revision) + 1, event: "CANCEL", state: "CANCELLED", lifecycle: "CANCELLED" };
        return { structuredContent: row };
      }
      throw Error(`unexpected ${name}`);
    } };
    root.render(<main className="tw-workspace ux-fixture" data-workspace-view="trade"><WorkspaceContext key={delay} bridge={bridge} symbol="3481"/></main>);
    await pause(); await click("待送單");
    const started = performance.now(), remove = button("刪除"); remove.click(); remove.click(); await pause();
    const feedbackMs = performance.now() - started;
    check(remove.disabled && document.body.innerText.includes("處理中"), "immediate mutation feedback");
    check(feedbackMs <= 100, "feedback within 100ms in controlled fixture");
    await click("新增委託");
    const input = document.querySelector<HTMLInputElement>('[aria-label="委託價格"]')!;
    check(!input.disabled && input.getBoundingClientRect().height > 0, "unrelated form remains usable during mutation");
    await pause(delay); await click("待送單");
    check(!document.querySelector('[aria-label="3481 本地掛單"]'), "cancelled draft absent after returning to tab");
    check(mutations === 1 && nativeReads === 0, "one local mutation, no Native orders dependency");
    await click("更新清單"); check(!document.querySelector('[aria-label="3481 本地掛單"]'), "cancelled draft does not resurrect");
    (receipt.latency as unknown[]).push({ simulatedBackendMs: delay, feedbackMs, localMutations: mutations, nativeReads });
  }
}

async function lateMarketAndDelete() {
  let releaseTw!: (value: unknown) => void;
  let initialTw = true, deleted = false, malformed = false, deletes = 0, reads = 0;
  const bridge = { async callTool(name: string, args: UnknownRecord) {
    if (name === "omi_list_research_proposals") {
      reads++;
      if (malformed) return { structuredContent: { items: [] } };
      if (args.market === "TW" && initialTw) { initialTw = false; return new Promise(resolve => { releaseTw = resolve; }); }
      return { structuredContent: fixtureResearchList(deleted ? [] : [fixtureResearch(String(args.market))]) };
    }
    if (name === "omi_delete_research_proposal") {
      check(args.id === "research-US" && args.expected_revision_id === "revision-1", "summary mutation identity");
      deletes++; deleted = true; throw Error("timeout after local terminal append");
    }
    if (name === "omi_read_research_proposal") {
      check(args.id === "research-US", "recovery reads original identity");
      return { isError: true, structuredContent: { error: "OMI API HTTP 410: deleted", http_status: 410,
        tool: name, backend_error: { error: { code: "PROPOSAL_DELETED" } } } };
    }
    throw Error(`unexpected ${name}`);
  } };
  root.render(<main className="tw-workspace ux-fixture"><ResearchPanel bridge={bridge} active onStaged={noIO}/></main>);
  await pause(); check(document.body.innerText.includes("正在讀取") && !document.body.innerText.includes("目前沒有符合"), "loading differs from empty");
  await chooseMarket("US"); check(document.body.innerText.includes("NVDA"), "new market renders while old read waits");
  releaseTw({ structuredContent: fixtureResearchList([fixtureResearch("TW")]) }); await pause();
  check(document.body.innerText.includes("NVDA") && !document.querySelector('[aria-label="3481 研究預選"]'), "late TW response cannot overwrite US");
  await click("刪除"); const confirm = button("確認刪除研究"); confirm.click(); confirm.click(); await pause(); await pause();
  check(deletes === 1 && document.body.innerText.includes("仍待確認"), "ambiguous delete retained even after item vanishes from list");
  await click("讀回此筆研究"); check(!document.body.innerText.includes("仍待確認") && deletes === 1, "exact terminal read resolves without resending");
  receipt.research = { deletes, reads, lateReplyDiscarded: true, terminalRecovery: true };
  // End on populated research, so the captured screenshot is also reviewable.
  deleted = false; await chooseMarket("TW");
  malformed = true; await click("重新讀取");
  check(button("修改").disabled && button("刪除").disabled, "malformed reload preserves prior row but blocks mutations");
  malformed = false; await click("重新讀取"); check(!button("修改").disabled, "valid reload restores actions");
  check(document.documentElement.scrollWidth <= innerWidth, "no horizontal overflow");
}

async function run() {
  await delayedDrafts(); await lateMarketAndDelete();
  document.querySelector("#fixture-receipt")!.textContent = JSON.stringify(receipt);
  document.body.dataset.testResult = `PASS ux ${innerWidth}px: 1/5/20s local latency, navigation, no Native dependency, late market, unknown delete readback`;
}
run().catch(error => { document.body.dataset.testResult = `FAIL ${error.message}`; });
