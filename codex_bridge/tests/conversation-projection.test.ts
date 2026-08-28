import assert from "node:assert/strict";
import test from "node:test";
import {
  createConversationProjection,
  hydrateConversationProjection,
  reduceConversationNotification,
} from "../src/conversation-projection.js";

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
  assert.equal(projection.turns[0]?.items[0]?.text, "Hello");
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
