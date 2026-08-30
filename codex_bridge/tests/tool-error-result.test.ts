import assert from "node:assert/strict";
import test from "node:test";
import { ConversationPersistenceError } from "../src/job-store.js";
import { ThreadHistoryError } from "../src/thread-history-reader.js";
import { toolErrorResult } from "../src/tool-error-result.js";

test("tool errors preserve stable ThreadHistoryError codes in structured content", () => {
  const result = toolErrorResult(new ThreadHistoryError("HistoryChangedDuringRead", "History changed."));

  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: { code: "HistoryChangedDuringRead", message: "History changed." },
  });
  assert.equal(result.content[0]?.text, "History changed.");
});

test("tool errors preserve stable conversation persistence codes", () => {
  const diagnostic = {
    code: "conversation_journal_gap" as const,
    message: "The conversation revision journal is not contiguous.",
    at: "2026-08-29T00:00:00.000Z",
    checkpointRevision: 5,
    journalRevision: 7,
  };
  const result = toolErrorResult(new ConversationPersistenceError(
    diagnostic.code,
    diagnostic.message,
    [diagnostic],
  ));

  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: { code: "conversation_journal_gap", message: diagnostic.message },
  });
});
