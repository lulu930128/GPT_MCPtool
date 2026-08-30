import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { AppServerStatus, AppServerTransport } from "../src/app-server-client.js";
import { ThreadHistoryError, ThreadHistoryReader } from "../src/thread-history-reader.js";

class PaginatedTransport extends EventEmitter implements AppServerTransport {
  status: AppServerStatus = "ready";
  requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  async ensureStarted(): Promise<void> {}
  async close(): Promise<void> {}
  async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.requests.push({ method, params });
    if (method === "thread/read") {
      return { thread: { id: params?.threadId, historyMode: "paginated", updatedAt: 20, turns: [] } } as T;
    }
    if (method === "thread/turns/list" && params?.sortDirection === "desc") {
      return { data: [{ id: "turn-2", items: [] }], nextCursor: null } as T;
    }
    if (method === "thread/turns/list" && !params?.cursor) {
      return { data: [{ id: "turn-1", items: [{ id: "agent-1", type: "agentMessage", text: "One" }] }], nextCursor: "page-2" } as T;
    }
    if (method === "thread/turns/list" && params?.cursor === "page-2") {
      return { data: [{ id: "turn-2", items: [{ id: "agent-2", type: "agentMessage", text: "Two" }] }], nextCursor: null } as T;
    }
    throw new Error(`Unexpected method ${method}`);
  }
  notify(): void {}
  respond(): void {}
}

test("paginated reader requests every page with full items in ascending order", async () => {
  const transport = new PaginatedTransport();
  const reader = new ThreadHistoryReader(transport);
  const metadata = await reader.readMetadata("thread-1");
  const fingerprint = await reader.freshnessFingerprint(metadata);
  const history = await reader.read("thread-1", metadata);

  assert.equal(fingerprint.length, 24);
  assert.equal(history.pageCount, 2);
  assert.deepEqual(
    ((history.response.thread as Record<string, unknown>).turns as Array<Record<string, unknown>>).map((turn) => turn.id),
    ["turn-1", "turn-2"],
  );
  const pageRequests = transport.requests.filter((request) => request.method === "thread/turns/list" && request.params?.sortDirection === "asc");
  assert.equal(pageRequests.length, 2);
  assert.equal(pageRequests.every((request) => request.params?.itemsView === "full"), true);
});

test("paginated reader fails with HistoryLimitExceeded without sending a zero limit", async () => {
  const transport = new PaginatedTransport();
  transport.request = async function request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.requests.push({ method, params });
    if (method === "thread/read") return { thread: { id: params?.threadId, historyMode: "paginated", updatedAt: 20, turns: [] } } as T;
    if (method === "thread/turns/list" && params?.sortDirection === "desc") return { data: [{ id: "turn-2", items: [] }], nextCursor: null } as T;
    if (method === "thread/turns/list") {
      return { data: [{ id: "turn-1", items: [] }, { id: "turn-2", items: [] }], nextCursor: "page-2" } as T;
    }
    throw new Error(`Unexpected method ${method}`);
  };
  const reader = new ThreadHistoryReader(transport, { maxPages: 10, maxTurns: 2, pageSize: 2 });

  await assert.rejects(
    () => reader.read("thread-1"),
    (error: unknown) => error instanceof ThreadHistoryError && error.code === "HistoryLimitExceeded",
  );
  const limits = transport.requests
    .filter((request) => request.method === "thread/turns/list")
    .map((request) => request.params?.limit);
  assert.equal(limits.includes(0), false);
});

test("paginated reader detects a concurrent append and retries one consistent snapshot", async () => {
  const transport = new PaginatedTransport();
  let headGeneration = 0;
  transport.request = async function request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.requests.push({ method, params });
    if (method === "thread/read") return { thread: { id: params?.threadId, historyMode: "paginated", updatedAt: 20, turns: [] } } as T;
    if (method === "thread/turns/list" && params?.sortDirection === "desc") {
      headGeneration += 1;
      return { data: [{ id: headGeneration === 1 ? "turn-2" : "turn-3", items: [] }], nextCursor: null } as T;
    }
    const changed = headGeneration > 1;
    if (!params?.cursor) {
      return { data: [{ id: "turn-1", items: [] }], nextCursor: "page-2" } as T;
    }
    if (params.cursor === "page-2") {
      return { data: changed ? [{ id: "turn-2", items: [] }, { id: "turn-3", items: [] }] : [{ id: "turn-2", items: [] }], nextCursor: null } as T;
    }
    throw new Error(`Unexpected method ${method}`);
  };
  const reader = new ThreadHistoryReader(transport);

  const history = await reader.read("thread-1");
  const turns = (history.response.thread as Record<string, unknown>).turns as Array<Record<string, unknown>>;
  assert.deepEqual(turns.map((turn) => turn.id), ["turn-1", "turn-2", "turn-3"]);
  assert.equal(transport.requests.filter((request) => request.method === "thread/turns/list" && request.params?.sortDirection === "asc").length, 4);
});
