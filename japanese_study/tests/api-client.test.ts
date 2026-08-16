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

test("item creation and revision preserve preview fingerprints and map bounded fields", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    requests.push({
      url: req.url || "",
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new JapaneseStudyHubClient({
    hubBaseUrl: `http://127.0.0.1:${address.port}`,
    hubTimeoutMs: 2_000,
  });

  try {
    const draft = {
      kind: "vocab" as const,
      title: "見落とす",
      reading: "みおとす",
      meaningTc: "漏看",
      jlptLevel: "N3",
      partOfSpeech: "動詞",
      tags: ["易混淆"],
      provenance: "chatgpt_proposed" as const,
    };
    await client.previewItemCreation(draft);
    await client.createItem({
      operationId: "create-item-001",
      expectedFingerprint: "a".repeat(64),
      draft,
    });
    await client.applyItemRevision({
      itemId: "vocab:test/id",
      operationId: "revise-item-001",
      expectedFingerprint: "b".repeat(64),
      changes: { meaningTc: "沒有注意到", tags: ["動詞"] },
      reason: "補充語義",
    });

    assert.equal(requests[0].url, "/api/v1/items/creation/preview");
    assert.deepEqual((requests[0].body.draft as Record<string, unknown>).tags, ["易混淆"]);
    assert.equal((requests[1].body.draft as Record<string, unknown>).meaning_tc, "漏看");
    assert.equal(requests[1].body.operation_id, "create-item-001");
    assert.equal(requests[1].body.actor, "chatgpt_mcp");
    assert.equal(requests[2].url, "/api/v1/items/vocab%3Atest%2Fid/revision/apply");
    assert.deepEqual(requests[2].body.changes, {
      meaning_tc: "沒有注意到",
      tags: ["動詞"],
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("learner policy, learning context, and atomic revision map bounded contracts", async () => {
  const requests: Array<{
    url: string;
    method: string;
    body?: Record<string, unknown>;
  }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    requests.push({
      url: req.url || "",
      method: req.method || "GET",
      body: raw ? JSON.parse(raw) : undefined,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new JapaneseStudyHubClient({
    hubBaseUrl: `http://127.0.0.1:${address.port}`,
    hubTimeoutMs: 2_000,
  });
  const policy = {
    schemaVersion: 1 as const,
    practice: {
      autoRecordCompletedPractice: true,
      preservePartial: true as const,
      preserveVoid: true as const,
      preserveUnscored: true as const,
    },
    answerNotation: {
      chineseParentheses: "production_gap" as const,
      emptyAnswer: "skipped" as const,
    },
    questionGeneration: {
      generator: "ai" as const,
      useLearningContext: true,
      preferWeakTargets: true,
      avoidFullCatalogDump: true as const,
    },
  };
  const submission = {
    submissionId: "submission-revision-0001",
    session: {
      sessionId: "session-revision-0001",
      title: "修正版練習",
      practiceType: "grammar",
      startedAt: "2026-08-12T10:00:00+08:00",
      completedAt: "2026-08-12T10:05:00+08:00",
    },
    questions: [
      {
        questionKey: "q01",
        position: 1,
        snapshot: { question_type: "translation", prompt: "test" },
        response: {
          answer: { text: "回答" },
          answerResult: "partial" as const,
          awardedPoints: 0.5,
          submittedAt: "2026-08-12T10:04:00+08:00",
        },
      },
    ],
  };

  try {
    await client.getLearnerPolicy();
    await client.setLearnerPolicy({ operationId: "policy-operation-0001", policy });
    await client.learningContext({
      practiceType: "grammar",
      requestedLevel: "N3",
      kind: "grammar",
      targetLimit: 12,
      recentSessionLimit: 3,
      diagnosisLimit: 7,
    });
    await client.recordPracticeRevision({
      originalSessionId: "session-original-0001",
      revisionId: "practice-revision-0001",
      reason: "補充括號代表的 production gap。",
      changedQuestionKeys: ["q01"],
      submission,
    });

    assert.deepEqual(
      requests.map((request) => [request.method, request.url]),
      [
        ["GET", "/api/v1/learner-policy"],
        ["PUT", "/api/v1/learner-policy"],
        [
          "GET",
          "/api/v1/learning-context?practice_type=grammar&requested_level=N3&kind=grammar&target_limit=12&recent_session_limit=3&diagnosis_limit=7",
        ],
        ["POST", "/api/v1/practice/sessions/session-original-0001/revisions"],
      ],
    );
    assert.deepEqual(requests[1].body, {
      operation_id: "policy-operation-0001",
      policy: {
        schema_version: 1,
        practice: {
          auto_record_completed_practice: true,
          preserve_partial: true,
          preserve_void: true,
          preserve_unscored: true,
        },
        answer_notation: {
          chinese_parentheses: "production_gap",
          empty_answer: "skipped",
        },
        question_generation: {
          generator: "ai",
          use_learning_context: true,
          prefer_weak_targets: true,
          avoid_full_catalog_dump: true,
        },
      },
      actor: "chatgpt_mcp",
    });
    assert.equal(requests[3].body?.revision_id, "practice-revision-0001");
    assert.equal(
      (requests[3].body?.submission as Record<string, any>).session.session_id,
      "session-revision-0001",
    );
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
