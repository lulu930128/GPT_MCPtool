import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { JapaneseStudyHubClient } from "../src/api-client.js";


test("Hub client sends bounded query and bearer auth", async () => {
  let receivedUrl = "";
  let receivedAuth = "";
  const server = createServer((req, res) => {
    receivedUrl = req.url || "";
    receivedAuth = String(req.headers.authorization || "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, count: 0, items: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new JapaneseStudyHubClient({
    hubBaseUrl: `http://127.0.0.1:${address.port}`,
    hubApiToken: "test-token",
    hubTimeoutMs: 2_000,
  });

  try {
    const response = await client.searchItems({ query: "遂に", kind: "vocab", limit: 5 });
    assert.deepEqual(response, { ok: true, count: 0, items: [] });
    assert.equal(receivedAuth, "Bearer test-token");
    assert.match(receivedUrl, /^\/api\/v1\/items\?/);
    assert.match(receivedUrl, /query=%E9%81%82%E3%81%AB/);
    assert.match(receivedUrl, /kind=vocab/);
    assert.match(receivedUrl, /limit=5/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("attempt payload maps camelCase to the Hub contract", async () => {
  let body = "";
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    body = Buffer.concat(chunks).toString("utf8");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, result: { inserted: true } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new JapaneseStudyHubClient({
    hubBaseUrl: `http://127.0.0.1:${address.port}`,
    hubTimeoutMs: 2_000,
  });

  try {
    await client.recordAttempt({
      eventId: "event-0001",
      itemId: "vocab:test",
      result: "wrong",
      sessionId: "session-1",
    });
    assert.deepEqual(JSON.parse(body), {
      event_id: "event-0001",
      item_id: "vocab:test",
      result: "wrong",
      session_id: "session-1",
      source: "chatgpt_mcp",
      metadata: {},
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("practice payload maps only contract fields and preserves snapshots", async () => {
  let receivedUrl = "";
  let body = "";
  const server = createServer(async (req, res) => {
    receivedUrl = req.url || "";
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    body = Buffer.concat(chunks).toString("utf8");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, preview: { unresolved_targets: [] } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new JapaneseStudyHubClient({
    hubBaseUrl: `http://127.0.0.1:${address.port}`,
    hubTimeoutMs: 2_000,
  });

  try {
    await client.previewPractice({
      submissionId: "submission-0001",
      session: {
        sessionId: "session-0001",
        title: "N3 文法練習",
        practiceType: "multiple_choice",
        startedAt: "2026-07-27T10:00:00+08:00",
        completedAt: "2026-07-27T10:05:00+08:00",
      },
      questions: [
        {
          questionKey: "q1",
          position: 1,
          snapshot: {
            promptText: "彼は新人____、仕事が速い。",
            choices: [{ key: "a", text: "にしては" }],
          },
          targets: [
            {
              targetKey: "grammar-main",
              targetKind: "grammar",
              pattern: "にしては",
              senseKey: "unexpected_degree",
            },
          ],
          response: {
            answer: { selectedKey: "a" },
            answerResult: "correct",
            awardedPoints: 1,
            submittedAt: "2026-07-27T10:01:00+08:00",
            gradingOverrideReason: "Manual rubric exception.",
          },
        },
      ],
    });

    assert.equal(receivedUrl, "/api/v1/practice/submissions/preview");
    const parsed = JSON.parse(body);
    assert.equal(parsed.submission_id, "submission-0001");
    assert.equal(parsed.session.session_id, "session-0001");
    assert.equal(parsed.session.practice_type, "multiple_choice");
    assert.deepEqual(parsed.questions[0].snapshot, {
      promptText: "彼は新人____、仕事が速い。",
      choices: [{ key: "a", text: "にしては" }],
    });
    assert.deepEqual(parsed.questions[0].response.answer, { selectedKey: "a" });
    assert.equal(
      parsed.questions[0].response.grading_override_reason,
      "Manual rubric exception.",
    );
    assert.equal(parsed.questions[0].targets[0].pattern, "にしては");
    assert.equal(parsed.questions[0].targets[0].sense_key, "unexpected_degree");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("selector preview maps discriminated selectors without internal canonical keys", async () => {
  let receivedUrl = "";
  let body = "";
  const server = createServer(async (req, res) => {
    receivedUrl = req.url || "";
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    body = Buffer.concat(chunks).toString("utf8");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, targets: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new JapaneseStudyHubClient({
    hubBaseUrl: `http://127.0.0.1:${address.port}`,
    hubTimeoutMs: 2_000,
  });

  try {
    await client.previewTargetSelectors([
      {
        targetKey: "grammar-main",
        targetKind: "grammar",
        selector: {
          type: "grammar_identity",
          pattern: "~にしては",
          senseKey: "unexpected_standard",
        },
      },
    ]);
    assert.equal(receivedUrl, "/api/v1/practice/targets/preview");
    assert.deepEqual(JSON.parse(body).targets[0].selector, {
      type: "grammar_identity",
      pattern: "~にしては",
      sense_key: "unexpected_standard",
    });
    assert.equal(JSON.parse(body).targets[0].canonical_key, undefined);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("practice resolution apply maps only explicit item ids and fingerprint", async () => {
  let receivedUrl = "";
  let body = "";
  const server = createServer(async (req, res) => {
    receivedUrl = req.url || "";
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    body = Buffer.concat(chunks).toString("utf8");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, applied: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new JapaneseStudyHubClient({
    hubBaseUrl: `http://127.0.0.1:${address.port}`,
    hubTimeoutMs: 2_000,
  });

  try {
    await client.applyPracticeTargetOverrides({
      sessionId: "session-0001",
      operationId: "operation-0001",
      expectedFingerprint: "a".repeat(64),
      overrides: [
        {
          questionKey: "q05",
          targetKey: "grammar-main",
          itemId: "grammar:item-1",
        },
      ],
    });
    assert.equal(
      receivedUrl,
      "/api/v1/practice/sessions/session-0001/target-resolution/apply",
    );
    assert.deepEqual(JSON.parse(body), {
      operation_id: "operation-0001",
      expected_fingerprint: "a".repeat(64),
      overrides: [
        {
          question_key: "q05",
          target_key: "grammar-main",
          item_id: "grammar:item-1",
        },
      ],
      actor: "chatgpt_mcp",
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
