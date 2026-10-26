import assert from "node:assert/strict";
import test from "node:test";
import { McpAppsBridge } from "./bridge";

async function harness(run: (context: {
  bridge: McpAppsBridge;
  calls: string[];
  reply: (value: { result?: unknown; error?: unknown }) => void;
  expire: () => void;
}) => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const events = new EventTarget();
  const timers = new Map<number, () => void>();
  const calls: string[] = [];
  let nextTimer = 0;
  let toolId = 0;
  const deliver = (id: number, value: object) => {
    const event = new Event("message");
    Object.assign(event, { source: parent, data: { jsonrpc: "2.0", id, ...value } });
    events.dispatchEvent(event);
  };
  const parent = {
    postMessage(message: { id: number; method: string; params: unknown }) {
      if (message.method === "ui/initialize") queueMicrotask(() => deliver(message.id, { result: {} }));
      if (message.method === "tools/call") {
        calls.push("bridge");
        toolId = message.id;
        assert.deepEqual(message.params, { name: "omi_read_tw_stock_research", arguments: { stock_id: "2330", timeframe: "monthly" } });
      }
    },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    parent, innerWidth: 1000, innerHeight: 700,
    openai: { async callTool(name: string, args: unknown) {
      calls.push("legacy");
      assert.equal(name, "omi_read_tw_stock_research");
      assert.deepEqual(args, { stock_id: "2330", timeframe: "monthly" });
      return { structuredContent: { synthetic: true } };
    } },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    setTimeout(callback: () => void, milliseconds: number) {
      assert.equal(milliseconds, 20_000, "legacy timeout must stay unchanged");
      timers.set(++nextTimer, callback); return nextTimer;
    },
    clearTimeout(id: number) { timers.delete(id); },
  } });
  const bridge = new McpAppsBridge();
  try {
    bridge.start();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await run({ bridge, calls, reply: value => deliver(toolId, value), expire: () => {
      for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
    } });
  } finally {
    bridge.stop();
    assert.equal(timers.size, 0);
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

const args = { stock_id: "2330", timeframe: "monthly" };
const tick = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

test("bridge preserves internal/validation errors without a duplicate legacy request", async () => {
  for (const code of [-32603, -32602]) await harness(async ({ bridge, calls, reply }) => {
    const error = { code, message: "synthetic host rejection" };
    const pending = bridge.callTool("omi_read_tw_stock_research", args);
    const rejected = assert.rejects(pending, value => value === error);
    await tick(); reply({ error }); await rejected;
    assert.deepEqual(calls, ["bridge"]);
  });
});

test("bridge timeout is indeterminate and never resubmits the heavy read", async () => {
  await harness(async ({ bridge, calls, expire, reply }) => {
    const pending = bridge.callTool("omi_read_tw_stock_research", args);
    const rejected = assert.rejects(pending, /tools\/call timed out/);
    await tick(); expire(); await rejected;
    reply({ result: { late: true } }); await tick();
    assert.deepEqual(calls, ["bridge"]);
  });
});

test("unsupported tools/call retains one compatibility fallback", async () => {
  await harness(async ({ bridge, calls, reply }) => {
    const pending = bridge.callTool("omi_read_tw_stock_research", args);
    await tick(); reply({ error: { code: -32601, message: "Method not found" } });
    assert.deepEqual(await pending, { structuredContent: { synthetic: true } });
    assert.deepEqual(calls, ["bridge", "legacy"]);
  });
});

test("abort and stopped bridge never dispatch a legacy request", async () => {
  for (const stop of [false, true]) await harness(async ({ bridge, calls }) => {
    const controller = new AbortController();
    const pending = bridge.callTool("omi_read_tw_stock_research", args, controller.signal);
    const rejected = assert.rejects(pending, stop ? /Widget bridge stopped/ : { name: "AbortError" });
    await tick();
    if (stop) bridge.stop(); else controller.abort();
    await rejected;
    assert.deepEqual(calls, ["bridge"]);
  });
});

test("successful large and business-rejected responses are returned unchanged", async () => {
  for (const isError of [false, true]) await harness(async ({ bridge, calls, reply }) => {
    const result = { isError, structuredContent: { warnings: ["界".repeat(3_500_000)], freshness: { status: "stale" }, source: "synthetic", quality: "partial" } };
    assert.ok(Buffer.byteLength(JSON.stringify(result)) >= 10_000_000);
    const pending = bridge.callTool("omi_read_tw_stock_research", args);
    await tick(); reply({ result });
    assert.equal(await pending, result);
    assert.deepEqual(calls, ["bridge"]);
  });
});
