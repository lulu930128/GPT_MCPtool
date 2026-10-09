import assert from "node:assert/strict";
import test from "node:test";
import { CONVERSATION_DELIVERY, RecentConversationChanges } from "../src/conversation-delivery.js";
import type { ConversationProjectionPatch } from "../src/types.js";

function patch(revision: number): ConversationProjectionPatch {
  return { revision, at: "2026-09-12T00:00:00Z", turns: [] };
}

test("five thousand revisions require one snapshot; sustained producer cannot force unbounded replay", () => {
  const buffer = new RecentConversationChanges();
  for (let revision = 1; revision <= 5000; revision++) buffer.add("job", patch(revision));
  assert.equal(buffer.read("job", 1, 5000), undefined);
  let cursor = 4900;
  let server = 5000;
  for (let page = 0; page < 4; page++) {
    const changes = buffer.read("job", cursor, server);
    if (!changes) { cursor = server; break; }
    cursor = changes.at(-1)!.revision;
    for (let i = 0; i < 100; i++) buffer.add("job", patch(++server));
  }
  assert.equal(cursor, server, "Large lag switches to the latest snapshot cursor.");
  assert.ok(buffer.diagnostics("job").hotBufferEntries <= CONVERSATION_DELIVERY.hotEntries);
});

test("byte budget and discontinuities require a snapshot instead of oversized or incomplete deltas", () => {
  const buffer = new RecentConversationChanges();
  buffer.add("gap", patch(2));
  assert.equal(buffer.read("gap", 0, 2), undefined);
  buffer.add("large", { ...patch(1), threadId: "x".repeat(CONVERSATION_DELIVERY.maxDeltaBytes) });
  assert.equal(buffer.read("large", 0, 1), undefined);
  assert.equal(buffer.read("large", 2, 1), undefined);
  assert.deepEqual(buffer.read("large", 1, 1), []);
});
