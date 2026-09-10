import test from "node:test";
import assert from "node:assert/strict";
import { TrainerClient, validateWav } from "../src/trainer-client.js";
import { backend, send, question, wav } from "./fixtures.js";
test("projection strips raw answers, paths and metadata before returning a question", async () => {
  const fixture = await backend((_req, res) => send(res, { ...question, audio_script: "secret", correct_option: 3, saved_to: "private",
    options: question.options.map(o => ({ ...o, text_zh_tw: "secret", answer: true })) }));
  try {
    const result = await new TrainerClient(fixture.config).question("exam001", "Q001");
    assert.deepEqual(result, question);
  } finally { await fixture.close(); }
});
test("non-2xx sanitizes traceback and preserves allowlisted domain code", async () => {
  const fixture = await backend((_req, res) => send(res, { error: { code: "SET_CONFLICT" }, traceback: "SECRET" }, 409));
  try { await assert.rejects(new TrainerClient(fixture.config).create({}), { code: "SET_CONFLICT", status: 409 }); }
  finally { await fixture.close(); }
});
test("invalid JSON, shape, MIME and redirects fail closed", async () => {
  for (const mode of ["json", "shape", "mime", "redirect"]) {
    const fixture = await backend((_req, res) => {
      if (mode === "redirect") { res.writeHead(302, { location: "http://example.com" }); res.end(); }
      else if (mode === "shape") send(res, { ok: true });
      else { res.writeHead(200, { "content-type": mode === "mime" ? "text/html" : "application/json" }); res.end("bad"); }
    });
    try { await assert.rejects(new TrainerClient(fixture.config).health()); }
    finally { await fixture.close(); }
  }
});
test("timeout covers body streaming and unknown upstream errors remain sanitized", async () => {
  const fixture = await backend((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write("{"); });
  try { await assert.rejects(new TrainerClient(fixture.config).request("/health", "GET", undefined, false, 30), { code: "TIMEOUT" }); }
  finally { await fixture.close(); }
});
test("response limit enforced without Content-Length", async () => {
  const fixture = await backend((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("x".repeat(600000)); });
  try { await assert.rejects(new TrainerClient(fixture.config).health(), { code: "RESPONSE_TOO_LARGE" }); }
  finally { await fixture.close(); }
});
test("WAV parser rejects HTML, empty audio and truncated chunks", () => {
  validateWav(wav());
  assert.throws(() => validateWav(Buffer.from("<html>bad</html>")));
  assert.throws(() => validateWav(wav().subarray(0, 50)));
  const bad = wav(); bad.writeUInt32LE(1000, 40); assert.throws(() => validateWav(bad));
});
test("answer scope mismatch is rejected even when response shape is valid", async () => {
  const fixture = await backend((_req, res) => send(res, { ok: true, setId: "exam001", attemptId: "a", submissionId: "s",
    score: 0, answeredCount: 1, questionCount: 2, details: [{ questionId: "Q002", chosen: 1, correct: false, correctOption: 2,
      transcript: "secret", explanation: { summary: "", evidence: "", translation: "" } }] }));
  try { await assert.rejects(new TrainerClient(fixture.config).answer({ setId: "exam001", attemptId: "a", submissionId: "s", answers: { Q001: 1 } }), { code: "TRAINER_INVALID_RESPONSE" }); }
  finally { await fixture.close(); }
});
