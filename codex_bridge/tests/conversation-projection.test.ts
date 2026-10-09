import assert from "node:assert/strict";
import test from "node:test";
import {
  createConversationProjection,
  hydrateConversationProjection,
  mergeConversationMessages,
  mergeConversationProjectionMetadata,
  reduceConversationNotification,
} from "../src/conversation-projection.js";

test("historical timestamp lineage is independent of hydration clock and repairs legacy checkpoints", () => {
  const startedAt = "2026-10-08T01:00:00.000Z";
  const completedAt = "2026-10-08T01:05:00.000Z";
  const nativeAt = "2026-10-08T01:01:00.000Z";
  const response = { thread: { id: "thread-time", createdAt: startedAt, updatedAt: completedAt, turns: [
    { id: "turn-time", startedAt, completedAt, status: "completed", items: [
      { id: "u", type: "userMessage", clientId: "client-time", content: [{ type: "text", text: "native" }] },
      { id: "a", type: "agentMessage", text: "fallback" },
      { id: "a-native", type: "agentMessage", timestamp: nativeAt, text: "precise" },
      { id: "cmd", type: "commandExecution", command: "fixture" },
    ] },
    { id: "unknown", items: [{ id: "unknown-a", type: "agentMessage", text: "unknown", createdAt: "invalid", updatedAt: 1e30 }] },
    { id: "started-only", startedAt, items: [{ id: "start-a", type: "agentMessage", text: "start only" }] },
    { id: "completed-only", completedAt, items: [{ id: "unknown-user", type: "userMessage", content: [] }] },
  ] } };
  const first = hydrateConversationProjection(createConversationProjection(), response, "2026-10-09T02:00:00.000Z");
  const second = hydrateConversationProjection(first, response, "2026-10-10T03:00:00.000Z");
  assert.deepEqual(JSON.parse(JSON.stringify(second.turns)), JSON.parse(JSON.stringify(first.turns)));
  assert.equal(second.updatedAt, completedAt);
  assert.equal(second.createdAt, startedAt);
  assert.deepEqual(first.turns[0]!.items.map((item) => item.createdAt), [startedAt, completedAt, nativeAt, startedAt]);
  assert.equal(first.turns[0]!.durationMs, 300000);
  assert.equal(first.turns[1]!.items[0]!.createdAt, undefined);
  assert.equal(first.turns[1]!.items[0]!.updatedAt, undefined);
  assert.equal(first.turns[2]!.items[0]!.createdAt, startedAt);
  assert.equal(first.turns[3]!.items[0]!.createdAt, undefined, "A user message cannot borrow the later completion time.");
  const legacy = structuredClone(first);
  for (const turn of legacy.turns) for (const item of turn.items) {
    delete item.timestampSource;
    item.createdAt = item.updatedAt = "2026-10-09T02:00:00.000Z";
  }
  assert.deepEqual(JSON.parse(JSON.stringify(hydrateConversationProjection(legacy, response).turns)), JSON.parse(JSON.stringify(first.turns)));
});

test("exact durable user time supplements native content, not native item time or deleted text", () => {
  const native = hydrateConversationProjection(createConversationProjection(), { thread: { id: "t", turns: [{ id: "turn", startedAt: 1700000000, items: [
    { id: "u", type: "userMessage", clientId: "exact", content: [] },
    { id: "u-native", type: "userMessage", clientId: "native", createdAt: 1700000001, content: [] },
  ] }] } });
  const at = "2023-11-14T22:13:25.000Z";
  const merged = mergeConversationMessages(native, [
    { id: "b", role: "user", clientMessageId: "exact", at, content: "deleted source text" },
    { id: "n", role: "user", clientMessageId: "native", at, content: "stale" },
    { id: "missing", role: "user", clientMessageId: "other", at, content: "must not append" },
  ], true);
  assert.equal(merged.turns[0]!.items[0]!.createdAt, at);
  assert.equal(merged.turns[0]!.items[0]!.timestampSource, "bridge");
  assert.equal(merged.turns[0]!.items[0]!.text, "");
  assert.equal(merged.turns[0]!.items[1]!.createdAt, "2023-11-14T22:13:21.000Z");
  assert.equal(merged.turns[0]!.items.length, 2);
});

test("streaming and registry hydration preserve proven createdAt while updatedAt advances", () => {
  const createdAt = "2026-10-08T01:00:00.000Z";
  const updatedAt = "2026-10-08T01:01:00.000Z";
  let observed = reduceConversationNotification(createConversationProjection("thread"), {
    method: "item/started", params: { turnId: "turn", item: { id: "a", type: "agentMessage", text: "" } },
  }, createdAt);
  observed = reduceConversationNotification(observed, {
    method: "item/agentMessage/delta", params: { turnId: "turn", itemId: "a", delta: "hello" },
  }, updatedAt);
  assert.equal(observed.turns[0]!.items[0]!.createdAt, createdAt);
  assert.equal(observed.turns[0]!.items[0]!.updatedAt, updatedAt);
  const response = { thread: { id: "thread", turns: [{ id: "turn", completedAt: updatedAt, items: [{ id: "a", type: "agentMessage", text: "native final" }] }] } };
  const hydrated = hydrateConversationProjection(observed, response);
  const registry = mergeConversationProjectionMetadata(hydrateConversationProjection(createConversationProjection(), response), observed);
  for (const projection of [hydrated, registry]) {
    assert.equal(projection.turns[0]!.items[0]!.createdAt, createdAt);
    assert.equal(projection.turns[0]!.items[0]!.updatedAt, updatedAt);
    assert.equal(projection.turns[0]!.items[0]!.text, "native final");
  }
});

test("legacy checkpoint clocks are not displayed as proven time when native history is unavailable", () => {
  const legacy = createConversationProjection("thread");
  legacy.turns = [{ turnId: "turn", status: "completed", items: [{ id: "old", turnId: "turn", type: "agentMessage", text: "kept", status: "completed", isStreaming: false,
    createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z" }] }];
  assert.equal(mergeConversationMessages(legacy, []).turns[0]!.items[0]!.createdAt, undefined);
  legacy.turns[0]!.completedAt = "2026-10-08T00:00:00.000Z";
  const recovered = mergeConversationMessages(legacy, []);
  assert.equal(recovered.turns[0]!.items[0]!.createdAt, "2026-10-08T00:00:00.000Z");
  assert.equal(recovered.turns[0]!.items[0]!.timestampSource, "turn");
});

test("Bridge message metadata joins by exact client id without overwriting App Server text", () => {
  const native = hydrateConversationProjection(createConversationProjection("thread-1"), {
    thread: {
      id: "thread-1",
      turns: [
        { id: "turn-a", items: [{ id: "user-a", type: "userMessage", clientId: "client-a", content: [{ type: "text", text: "Native A" }] }] },
        { id: "turn-b", items: [{ id: "user-b", type: "userMessage", clientId: "client-b", content: [{ type: "text", text: "Native B" }] }] },
      ],
    },
  }, "2026-08-29T00:00:00.000Z", {
    historyMode: "legacy",
    synchronized: true,
    sourceAvailability: "available",
    lastMetadataCheckedAt: "2026-08-29T00:00:00.000Z",
  });
  const merged = mergeConversationMessages(native, [
    { id: "message-b", clientMessageId: "client-b", role: "user", content: "Stale B", context: "Context B", at: "2026-08-29T00:00:02.000Z" },
    { id: "message-a", clientMessageId: "client-a", role: "user", content: "Stale A", context: "Context A", at: "2026-08-29T00:00:01.000Z" },
    { id: "message-missing", role: "user", content: "Must not be positionally appended", at: "2026-08-29T00:00:03.000Z" },
  ]);

  const users = merged.turns.flatMap((turn) => turn.items).filter((item) => item.type === "userMessage");
  assert.deepEqual(users.map((item) => item.text), ["Native A", "Native B"]);
  assert.deepEqual(users.map((item) => item.context), ["Context A", "Context B"]);
});

test("thread/read hydrates ordered multi-turn history without raw reasoning", () => {
  const hydrated = hydrateConversationProjection(createConversationProjection(), {
    thread: {
      id: "thread-1",
      status: { type: "notLoaded" },
      turns: [1, 2, 3].map((number) => ({
        id: `turn-${number}`,
        status: "completed",
        startedAt: 1_700_000_000 + number,
        completedAt: 1_700_000_100 + number,
        items: [
          { id: `user-${number}`, type: "userMessage", clientId: null, content: [{ type: "text", text: `User ${number}` }] },
          { id: `reason-${number}`, type: "reasoning", summary: [`Summary ${number}`], content: [`hidden thought ${number}`] },
          { id: `agent-${number}`, type: "agentMessage", text: `Assistant ${number}` },
        ],
      })),
    },
  }, "2026-08-26T00:00:00.000Z");

  assert.equal(hydrated.threadId, "thread-1");
  assert.deepEqual(hydrated.turns.map((turn) => turn.turnId), ["turn-1", "turn-2", "turn-3"]);
  assert.deepEqual(hydrated.turns[0]?.items.map((item) => item.type), ["userMessage", "reasoningSummary", "agentMessage"]);
  assert.equal(hydrated.turns[0]?.items[1]?.text, "Summary 1");
  assert.doesNotMatch(JSON.stringify(hydrated), /hidden thought/);
});

test("large native histories keep item identity while bounding UI projection text", () => {
  const output = "x".repeat(3_000);
  const hydrated = hydrateConversationProjection(createConversationProjection("thread-large"), {
    thread: {
      id: "thread-large",
      turns: [{
        id: "turn-large",
        items: [
          { id: "user-old", type: "userMessage", content: [{ type: "text", text: "Old narrative remains visible." }] },
          ...Array.from({ length: 1_050 }, (_, index) => ({
            id: `command-${index}`,
            type: "commandExecution",
            command: `command ${index}`,
            aggregatedOutput: output,
            status: "completed",
          })),
          { id: "agent-new", type: "agentMessage", text: "New narrative remains visible." },
        ],
      }],
    },
  }, "2026-08-31T00:00:00.000Z", {
    historyMode: "paginated",
    synchronized: true,
    sourceAvailability: "available",
    lastMetadataCheckedAt: "2026-08-31T00:00:00.000Z",
  });

  const items = hydrated.turns[0]?.items ?? [];
  const projectedTextChars = items.reduce((total, item) => total
    + (item.command?.length ?? 0)
    + (item.output?.length ?? 0), 0);
  const commands = items.filter((item) => item.type === "commandExecution");
  assert.equal(items.length, 1_052);
  assert.equal(commands.every((item) => item.outputTruncated === true), true);
  assert.equal(items.find((item) => item.id === "user-old")?.text, "Old narrative remains visible.");
  assert.equal(items.find((item) => item.id === "agent-new")?.text, "New narrative remains visible.");
  assert.equal(projectedTextChars <= 2_050_000, true);
  assert.equal(hydrated.freshness?.projectionLimited, true);
  assert.equal((hydrated.freshness?.projectionTruncatedItemCount ?? 0) >= commands.length, true);
});

test("authoritative hydration removes turns and items deleted at the source", () => {
  const initial = hydrateConversationProjection(createConversationProjection("thread-1"), {
    thread: {
      id: "thread-1",
      turns: [
        { id: "turn-1", status: "completed", items: [
          { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Keep" }] },
          { id: "agent-1", type: "agentMessage", text: "Remove" },
        ] },
        { id: "turn-2", status: "completed", items: [] },
      ],
    },
  });
  const refreshed = hydrateConversationProjection(initial, {
    thread: {
      id: "thread-1",
      turns: [{ id: "turn-1", status: "completed", items: [
        { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Keep" }] },
      ] }],
    },
  });

  assert.deepEqual(refreshed.turns.map((turn) => turn.turnId), ["turn-1"]);
  assert.deepEqual(refreshed.turns[0]?.items.map((item) => item.id), ["user-1"]);
});

test("agent deltas reconcile to one authoritative completed message", () => {
  let projection = createConversationProjection("thread-1");
  projection = reduceConversationNotification(projection, {
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress", items: [] } },
  });
  projection = reduceConversationNotification(projection, {
    method: "item/started",
    params: { threadId: "thread-1", turnId: "turn-1", item: { id: "agent-1", type: "agentMessage", text: "" } },
  });
  for (const delta of ["Hel", "lo", "lo"]) {
    projection = reduceConversationNotification(projection, {
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "agent-1", delta },
    });
  }
  assert.equal(projection.turns[0]?.items[0]?.text, "Hellolo", "Equal adjacent text is not a duplicate event id.");
  assert.equal(projection.turns[0]?.items[0]?.isStreaming, true);

  projection = reduceConversationNotification(projection, {
    method: "item/completed",
    params: { threadId: "thread-1", turnId: "turn-1", item: { id: "agent-1", type: "agentMessage", text: "Hello, final." } },
  });
  projection = reduceConversationNotification(projection, {
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
  });

  assert.equal(projection.turns[0]?.items.filter((item) => item.id === "agent-1").length, 1);
  assert.equal(projection.turns[0]?.items[0]?.text, "Hello, final.");
  assert.equal(projection.turns[0]?.items[0]?.isStreaming, false);
});

test("work items update in place and interrupted turns retain partial text", () => {
  let projection = createConversationProjection("thread-1");
  projection = reduceConversationNotification(projection, {
    method: "item/started",
    params: { threadId: "thread-1", turnId: "turn-1", item: { id: "cmd-1", type: "commandExecution", command: "npm test", cwd: "C:\\repo", status: "inProgress" } },
  });
  projection = reduceConversationNotification(projection, {
    method: "item/commandExecution/outputDelta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1", delta: "running\n" },
  });
  projection = reduceConversationNotification(projection, {
    method: "item/completed",
    params: { threadId: "thread-1", turnId: "turn-1", item: { id: "cmd-1", type: "commandExecution", command: "npm test", cwd: "C:\\repo", status: "completed", aggregatedOutput: "running\npassed\n", exitCode: 0, durationMs: 398 } },
  });
  projection = reduceConversationNotification(projection, {
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "agent-1", delta: "Partial answer" },
  });
  projection = reduceConversationNotification(projection, {
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", items: [] } },
  });

  const command = projection.turns[0]?.items.find((item) => item.id === "cmd-1");
  const agent = projection.turns[0]?.items.find((item) => item.id === "agent-1");
  assert.equal(command?.status, "completed");
  assert.equal(command?.exitCode, 0);
  assert.equal(command?.durationMs, 398);
  assert.equal(command?.output, "running\npassed\n");
  assert.equal(agent?.text, "Partial answer");
  assert.equal(agent?.status, "interrupted");
  assert.equal(agent?.isStreaming, false);
});
