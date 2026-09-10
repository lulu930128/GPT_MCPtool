import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { createInput, questionInput, answerInput } from "../src/schemas.js";
import { set } from "./fixtures.js";
test("config rejects remote, URL credentials, redirects bases and invalid limits", () => {
  for (const url of ["https://127.0.0.1", "http://example.com", "http://localhost", "http://u:p@127.0.0.1", "http://127.0.0.1/api", "http://127.0.0.1?x=1"]) {
    assert.throws(() => loadConfig({ LISTENING_TRAINER_BASE_URL: url }));
  }
  for (const v of ["0", "65536", "NaN", "1.1"]) assert.throws(() => loadConfig({ LISTENING_MCP_PORT: v }));
  assert.throws(() => loadConfig({ LISTENING_MCP_HOST: "0.0.0.0" }));
  assert.throws(() => loadConfig({ LISTENING_MCP_HTTP_TOKEN: "<replace-in-local-environment>" }));
});
test("strict envelopes reject arbitrary parameters and unsafe IDs", () => {
  assert.equal(questionInput.safeParse({ setId: "exam001", questionId: "../x" }).success, false);
  assert.equal(questionInput.safeParse({ setId: "exam001", questionId: "Q001", url: "http://evil" }).success, false);
  assert.equal(answerInput.safeParse({ setId: "exam001", attemptId: "a", submissionId: "s", answers: {} }).success, false);
  assert.equal(answerInput.safeParse({ setId: "exam001", attemptId: "a", submissionId: "s", answers: { Q001: true } }).success, false);
});
test("bounded schema delegates domain validation but enforces lengths, counts and language", () => {
  const schema = createInput(loadConfig({}));
  assert.equal(schema.safeParse({ set }).success, true);
  assert.equal(schema.safeParse({ set, language: "en" }).success, false);
  assert.equal(schema.safeParse({ set, generateAudio: true }).success, false);
  assert.equal(schema.safeParse({ set: { ...set, question_count: 2 } }).success, false);
  assert.equal(schema.safeParse({ set: { ...set, question_count: 2, questions: [...set.questions, ...set.questions] } }).success, false);
  assert.equal(schema.safeParse({ set: { ...set, questions: [{ id: "Q001", audio_script: [{ text: "a".repeat(5001) }] }] } }).success, false);
});
