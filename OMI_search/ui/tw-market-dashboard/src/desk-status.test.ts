import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { fixtureConnection } from "../scripts/desk-fixture";
import type { CandidateBridge } from "./candidate-state";

const output = await build({
  stdin: { contents: 'export { DeskStatus } from "./DeskOrders";', resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "tsx" },
  bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
  plugins: [{ name: "controlled-status", setup(builder) {
    builder.onResolve({ filter: /^react(?:\/jsx-runtime)?$/ }, args => ({ path: args.path, namespace: "controlled" }));
    builder.onLoad({ filter: /.*/, namespace: "controlled" }, args => ({ contents: args.path === "react"
      ? "export const {useState,useEffect,useRef}=globalThis.hooks;"
      : "export const jsx=(type,props)=>({type,props});export const jsxs=jsx;export const Fragment='fragment';" }));
  } }],
});

function harness(initialBridge: CandidateBridge) {
  let cursor = 0, dirty = false, tree: any, sequence = 0, bridge = initialBridge;
  const slots: any[] = [], timers = new Map<number, () => void>(), listeners = new Set<() => void>();
  let effects: (() => void)[] = [];
  const document = { hidden: false, addEventListener(name: string, fn: () => void) { assert.equal(name, "visibilitychange"); listeners.add(fn); },
    removeEventListener(_name: string, fn: () => void) { listeners.delete(fn); } };
  const hooks = {
    useState(value: unknown) { const i = cursor++; slots[i] ??= { value }; return [slots[i].value, (next: any) => { slots[i].value = next; dirty = true; }]; },
    useRef(value: unknown) { const i = cursor++; slots[i] ??= { current: value }; return slots[i]; },
    useEffect(fn: () => void, deps: unknown[]) { const i = cursor++; if (!slots[i] || deps.some((v, j) => v !== slots[i].deps[j])) effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); },
  };
  const module = { exports: {} as any };
  vm.runInNewContext(output.outputFiles[0].text, { module, exports: module.exports, hooks, document, AbortController,
    setTimeout: (fn: () => void, ms: number) => { assert.equal(ms, 15_000); timers.set(++sequence, fn); return sequence; },
    clearTimeout: (id: number) => timers.delete(id),
    fetch() { throw Error("Unexpected direct HTTP"); },
  });
  function render() { let rounds = 0; do { cursor = 0; dirty = false; effects = []; tree = module.exports.DeskStatus({ bridge }); effects.forEach(fn => fn()); assert.ok(++rounds < 10); } while (dirty); }
  const text = (node: any): string => typeof node === "string" || typeof node === "number" ? String(node) : node && typeof node === "object" ? [node.props?.children].flat(Infinity).map(text).join(" ") : "";
  render();
  return {
    text: () => text(tree), timers, listeners,
    tick() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); render(); },
    visible(value: boolean) { document.hidden = !value; listeners.forEach(fn => fn()); render(); },
    changeBridge(value: CandidateBridge) { bridge = value; render(); },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); },
    async settle() { await new Promise(resolve => setImmediate(resolve)); render(); },
  };
}

test("status polls only its read tool; binding/HTTP200 never imply online; busy/date/read quality stay separate", async () => {
  let value = fixtureConnection(), calls = 0;
  const h = harness({ async callTool(name, args) { assert.equal(name, "omi_read_desk_status"); assert.deepEqual({ ...args }, {}); calls++; return { structuredContent: value }; } });
  await h.settle(); assert.match(h.text(), /恢復中/); assert.doesNotMatch(h.text(), /台股連線：已連線/);
  assert.match(h.text(), /交易日就緒 否/); assert.match(h.text(), /尚無讀取證據/); assert.match(h.text(), /美股連線： 尚無連線資料/);
  value = fixtureConnection({ actual: "ONLINE", date_ready: true, ready: false, disconnect_observed: false,
    us: { market: "US", account_bound: true, connected: true, ready: false },
    busy: { operation: "query", started_at: "2026-11-05T01:00:00Z" },
    last_broker_read: { status: "PARTIAL", observed_at: "2026-11-05T00:55:00Z", session_generation: 1, sources: [], age_seconds: 300, stale: true } });
  h.tick(); await h.settle(); assert.equal(calls, 2);
  assert.match(h.text(), /台股連線：已連線/); assert.match(h.text(), /程序就緒 否/); assert.match(h.text(), /query/);
  assert.match(h.text(), /美股連線： 已連線/); assert.match(h.text(), /目前尚未就緒/);
  assert.match(h.text(), /PARTIAL.*300 秒.*過期：是/); assert.match(h.text(), /不代表委託可送出/);
  value = { broker_session: "CONNECTED", connection: {} };
  h.tick(); await h.settle(); assert.match(h.text(), /暫時無法確認/); assert.match(h.text(), /上次讀取/);
  assert.equal(h.timers.size, 1);
  h.unmount(); assert.equal(h.timers.size, 0); assert.equal(h.listeners.size, 0);
});

test("hidden tabs pause; visibility resumes single-flight with one timer and no late hidden overwrite", async () => {
  let calls = 0; const resolvers: ((value: unknown) => void)[] = [];
  const h = harness({ callTool() { calls++; return new Promise(resolve => resolvers.push(resolve)); } });
  h.visible(false); h.tick(); h.visible(true); h.visible(true); h.tick(); assert.equal(calls, 1);
  resolvers.shift()!({ structuredContent: fixtureConnection({ actual: "ONLINE" }) }); await h.settle();
  assert.doesNotMatch(h.text(), /台股連線：已連線/); assert.equal(h.timers.size, 1);
  h.visible(false); assert.equal(h.timers.size, 0); h.visible(true); assert.equal(calls, 2);
  resolvers.shift()!({ structuredContent: fixtureConnection({ actual: "OFFLINE", desired: "OFFLINE" }) }); await h.settle();
  assert.match(h.text(), /保持離線/); assert.equal(h.timers.size, 1); h.unmount();
});

test("bridge replacement/unmount discard late responses and never overlap unresolved requests", async () => {
  let resolve!: (value: unknown) => void, nextCalls = 0, signal: AbortSignal | undefined;
  const h = harness({ callTool(_name, _args, value) { signal = value; return new Promise(done => resolve = done); } });
  assert.equal(signal?.aborted, false);
  h.changeBridge({ async callTool() { nextCalls++; return { structuredContent: fixtureConnection({ actual: "BLOCKED" }) }; } });
  assert.equal(signal?.aborted, true);
  assert.equal(nextCalls, 0);
  resolve({ structuredContent: fixtureConnection({ actual: "ONLINE" }) }); await h.settle();
  assert.doesNotMatch(h.text(), /台股連線：已連線/);
  h.tick(); await h.settle(); assert.equal(nextCalls, 1); assert.match(h.text(), /受阻/);
  h.unmount(); assert.equal(h.timers.size, 0); assert.equal(h.listeners.size, 0);
});
