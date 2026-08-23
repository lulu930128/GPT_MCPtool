import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { EnglishStudyHubClient } from "../src/api-client.js";

test("search uses bounded English query fields and bearer auth", async () => {
  let receivedUrl = "";
  let receivedAuth = "";
  const server = createServer((req, res) => {
    receivedUrl = req.url ?? "";
    receivedAuth = String(req.headers.authorization ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, count: 0, total: 0, items: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new EnglishStudyHubClient({ hubBaseUrl: `http://127.0.0.1:${address.port}`, hubApiToken: "test-token", hubTimeoutMs: 2000 });
  try {
    await client.searchItems({ query: "look forward", kind: "phrase", cefrLevel: "B1", limit: 5, offset: 2 });
    assert.equal(receivedAuth, "Bearer test-token");
    assert.match(receivedUrl, /^\/api\/v1\/items\?/);
    assert.match(receivedUrl, /query=look\+forward/);
    assert.match(receivedUrl, /kind=phrase/);
    assert.match(receivedUrl, /cefr_level=B1/);
    assert.match(receivedUrl, /limit=5/);
    assert.match(receivedUrl, /offset=2/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
test("item and practice writes map camelCase without losing partial or void", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    requests.push({ url: req.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new EnglishStudyHubClient({ hubBaseUrl: `http://127.0.0.1:${address.port}`, hubTimeoutMs: 2000 });
  const draft = { kind: "vocab" as const, title: "bank", lemma: "bank", partOfSpeech: "noun", senseKey: "financial_institution", meaningTc: "銀行", cefrLevel: "A2" };
  const submission = {
    submissionId: "submission-001",
    session: { sessionId: "session-001", title: "Test", practiceType: "vocabulary", startedAt: "2026-08-13T10:00:00+08:00", completedAt: "2026-08-13T10:05:00+08:00" },
    questions: [
      { questionKey: "q1", position: 1, prompt: "bank", answerResult: "partial" as const, awardedPoints: 0.5, maxPoints: 1, submittedAt: "2026-08-13T10:04:00+08:00", targets: [{ targetKey: "bank", itemId: "vocab:123456789012345678901234", targetKind: "vocab" as const }] },
      { questionKey: "q2", position: 2, prompt: "void", answerResult: "void" as const, awardedPoints: 0, maxPoints: 1, submittedAt: "2026-08-13T10:04:30+08:00" },
    ],
  };
  try {
    await client.createItem({ operationId: "create-item-001", expectedFingerprint: "a".repeat(64), draft });
    await client.recordPractice({ expectedFingerprint: "b".repeat(64), submission });
    assert.equal(requests[0].body.operation_id, "create-item-001");
    assert.equal((requests[0].body.draft as Record<string, unknown>).part_of_speech, "noun");
    const questions = ((requests[1].body.submission as Record<string, unknown>).questions as Array<Record<string, unknown>>);
    assert.equal(questions[0].answer_result, "partial");
    assert.equal(questions[1].answer_result, "void");
    assert.equal(((questions[0].targets as Array<Record<string, unknown>>)[0]).target_kind, "vocab");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("reference search and enrichment map only bounded Hub routes", async () => {
  const requests: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    requests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new EnglishStudyHubClient({ hubBaseUrl: `http://127.0.0.1:${address.port}`, hubTimeoutMs: 2000 });
  try {
    await client.searchReferenceEntries({ query: "look forward", sourceId: "open-english-wordnet", partOfSpeech: "verb", limit: 5, offset: 2 });
    await client.getReferenceEntry("ref-entry:123456789012345678901234");
    await client.previewItemEnrichment({ itemId: "vocab:123456789012345678901234", referenceEntryIds: ["ref-entry:123456789012345678901234"] });
    assert.equal(requests[0].method, "GET");
    assert.match(requests[0].url, /^\/api\/v1\/reference\/entries\?/);
    assert.match(requests[0].url, /query=look\+forward/);
    assert.match(requests[0].url, /source_id=open-english-wordnet/);
    assert.match(requests[0].url, /part_of_speech=verb/);
    assert.equal(requests[1].url, "/api/v1/reference/entries/ref-entry%3A123456789012345678901234");
    assert.equal(requests[2].method, "POST");
    assert.deepEqual(requests[2].body, {
      item_id: "vocab:123456789012345678901234",
      reference_entry_ids: ["ref-entry:123456789012345678901234"],
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
