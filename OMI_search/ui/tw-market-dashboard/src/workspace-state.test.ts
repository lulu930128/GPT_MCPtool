import assert from "node:assert/strict";
import test from "node:test";
import { PaneLoader, initialSelection, readToolData } from "./workspace-state";
import type { UnknownRecord } from "./state";

function deferred() {
  let resolve!: (data: UnknownRecord) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<UnknownRecord>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("shell accepts empty or minimal selection without a dashboard", () => {
  assert.deepEqual(initialSelection({}), {});
  assert.deepEqual(initialSelection({ structuredContent: { stock_id: "2330", timeframe: "today", watchlist_group_id: 5 } }), { stock_id: "2330", timeframe: "today", watchlist_group_id: 5 });
});

test("selection retains old chart, aborts previous work, and rejects late data/errors", async () => {
  const loader = new PaneLoader(() => {});
  await loader.load("A", async () => ({ stock_id: "A" }));
  const b = deferred();
  let bSignal!: AbortSignal;
  const pendingB = loader.load("B", (signal) => { bSignal = signal; return b.promise; });
  assert.equal(loader.state.data?.stock_id, "A");
  assert.equal(loader.state.loading, true);
  await loader.load("C", async () => ({ stock_id: "C" }));
  assert.equal(bSignal.aborted, true);
  b.resolve({ stock_id: "B" });
  await pendingB;
  assert.equal(loader.state.data?.stock_id, "C");
  const old = deferred();
  const pendingOld = loader.load("D", () => old.promise);
  await loader.load("E", async () => ({ stock_id: "E" }));
  old.reject(new Error("late error"));
  await pendingOld;
  assert.equal(loader.state.dataKey, "E");
  assert.equal(loader.state.error, null);
});

test("slow research/hot groups never gate header, watchlist, chart; errors retry independently", async () => {
  const panes = Array.from({ length: 5 }, () => new PaneLoader(() => {}));
  const research = deferred();
  const hot = deferred();
  const slowResearch = panes[3].load("2330", () => research.promise);
  const slowHot = panes[4].load("hot", () => hot.promise);
  await Promise.all(panes.slice(0, 3).map((pane, index) => pane.load(String(index), async () => ({ ready: true }))));
  assert.ok(panes.slice(0, 3).every((pane) => pane.state.data?.ready));
  assert.ok(panes.slice(3).every((pane) => pane.state.loading));
  research.reject(new Error("research unavailable"));
  await slowResearch;
  assert.equal(panes[3].state.error, "research unavailable");
  await panes[3].load("2330", async () => ({ ready: true }));
  assert.equal(panes[3].state.error, null);
  hot.resolve({ ready: true });
  await slowHot;
});

test("unmount cancellation prevents updates and preserves backend warnings", async () => {
  const result = deferred();
  let writes = 0;
  const loader = new PaneLoader(() => { writes++; });
  const pending = loader.load("A", () => result.promise);
  loader.cancel();
  result.resolve({ ignored: true });
  await pending;
  assert.equal(writes, 1);
  const data = { kind: "omi.tw_stock_chart", version: "omi.tw_stock_chart.v1", warnings: ["stale"], status: "partial" };
  assert.equal(readToolData({ structuredContent: data }, data.kind), data);
  assert.throws(() => readToolData({ isError: true, content: [{ type: "text", text: "unavailable" }] }, data.kind), /unavailable/);
  assert.throws(() => readToolData({ kind: data.kind }, data.kind), /格式不符/);
});
