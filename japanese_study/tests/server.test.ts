import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startJapaneseStudyHttpServer } from "../src/http-server.js";

const expectedToolNames = [
  "study_add_study_list_items",
  "study_apply_item_lifecycle",
  "study_apply_item_revision",
  "study_apply_practice_target_overrides",
  "study_create_item",
  "study_create_study_list",
  "study_get_due_reviews",
  "study_get_diagnosis_catalog",
  "study_get_item",
  "study_get_learner_policy",
  "study_get_learning_context",
  "study_get_plan",
  "study_get_practice_session",
  "study_get_quality_inbox",
  "study_get_summary",
  "study_list_practice_sessions",
  "study_list_study_lists",
  "study_preview_item_creation",
  "study_preview_item_lifecycle",
  "study_preview_item_revision",
  "study_preview_practice_record",
  "study_preview_practice_target_resolution",
  "study_preview_question_candidates",
  "study_preview_target_resolution",
  "study_promote_question_candidate",
  "study_record_attempt",
  "study_record_practice",
  "study_record_practice_revision",
  "study_retire_question_candidate",
  "study_save_question_candidate",
  "study_search_items",
  "study_set_manual_labels",
  "study_set_learner_policy",
  "study_supersede_practice_session",
].sort();

test("published MCP contract exposes the complete learning-content v8.1 surface", async () => {
  const handle = await startJapaneseStudyHttpServer({
    hubBaseUrl: "http://127.0.0.1:1",
    hubTimeoutMs: 2_000,
    host: "127.0.0.1",
    port: 0,
  });
  const client = new Client({ name: "contract-test", version: "1.2.1" });
  const transport = new StreamableHTTPClientTransport(new URL(handle.url));

  try {
    const healthResponse = await fetch(new URL("/health", handle.url));
    assert.equal(healthResponse.status, 200);
    const health = (await healthResponse.json()) as Record<string, unknown>;
    assert.equal(health.service, "japanese-study-mcp");
    assert.equal(health.version, "1.2.1");
    assert.equal(health.contractVersion, "learning-content-v8.1");
    assert.equal(health.toolCount, 34);
    assert.match(String(health.buildId), /^[0-9a-f]{16}$/);

    await client.connect(transport);
    const response = await client.listTools();
    assert.deepEqual(
      response.tools.map((tool) => tool.name).sort(),
      expectedToolNames,
    );

    const preview = response.tools.find(
      (tool) => tool.name === "study_preview_practice_record",
    );
    assert.ok(preview);
    const inputSchema = preview.inputSchema as Record<string, any>;
    const selector =
      inputSchema.properties.questions.items.properties.targets.items.properties.selector;
    assert.equal(selector.anyOf.length, 4);
    assert.deepEqual(
      selector.anyOf
        .map((branch: Record<string, any>) => branch.properties.type.const)
        .sort(),
      ["grammar_identity", "item_id", "search", "vocab_identity"],
    );
    assert.ok(inputSchema.properties.practiceContractVersion);
    assert.ok(
      inputSchema.properties.questions.items.properties.targets.items.properties.assessment,
    );
    const responseDiagnosisEvents =
      inputSchema.properties.questions.items.properties.response.properties.diagnosisEvents;
    assert.equal(responseDiagnosisEvents.items.type, "object");
    assert.equal(responseDiagnosisEvents.items.properties.code.type, "string");
    assert.deepEqual(responseDiagnosisEvents.items.properties.sourceType.enum, [
      "ai_grading",
      "deterministic",
      "manual",
    ]);

    const retrySafeWrites = [
      "study_add_study_list_items",
      "study_apply_item_lifecycle",
      "study_apply_item_revision",
      "study_apply_practice_target_overrides",
      "study_create_item",
      "study_create_study_list",
      "study_promote_question_candidate",
      "study_record_attempt",
      "study_record_practice",
      "study_record_practice_revision",
      "study_retire_question_candidate",
      "study_save_question_candidate",
      "study_set_manual_labels",
      "study_set_learner_policy",
      "study_supersede_practice_session",
    ];
    for (const name of retrySafeWrites) {
      const tool = response.tools.find((entry) => entry.name === name);
      assert.equal(tool?.annotations?.idempotentHint, true, `${name} idempotentHint`);
    }

    const requiredOutputFields: Record<string, string[]> = {
      study_search_items: ["total", "offset", "limit", "has_more"],
      study_preview_item_creation: ["contract_version", "possible_duplicate_ids"],
      study_preview_item_revision: ["contract_version", "reason"],
      study_preview_item_lifecycle: [
        "contract_version",
        "expected_revision",
        "action",
        "reason",
        "replacement_item_id",
      ],
      study_get_quality_inbox: ["offset", "limit", "has_more"],
      study_add_study_list_items: ["items_changed"],
      study_preview_question_candidates: ["contract_version"],
      study_promote_question_candidate: ["question_item"],
      study_get_learner_policy: ["policy", "version", "persisted"],
      study_set_learner_policy: ["policy", "version", "operation_id"],
      study_get_learning_context: [
        "recommended_targets",
        "active_weaknesses",
        "recent_strengths",
        "recent_observations",
        "recent_diagnoses",
        "recent_practice",
        "level_scope",
        "limits",
      ],
      study_get_diagnosis_catalog: ["contract_version", "count", "limit", "items"],
      study_record_practice_revision: [
        "replacement_session_id",
        "affected_item_ids",
        "rebuilt_srs_count",
      ],
    };
    for (const [name, fields] of Object.entries(requiredOutputFields)) {
      const tool = response.tools.find((entry) => entry.name === name);
      assert.ok(tool, `${name} exists`);
      const properties = (tool.outputSchema as Record<string, any>).properties;
      for (const field of fields) {
        assert.ok(properties[field], `${name} declares ${field}`);
      }
    }
  } finally {
    await client.close().catch(() => undefined);
    await handle.close();
  }
});

test("practice tools enforce contract-version invariants before Hub I/O", async () => {
  const handle = await startJapaneseStudyHttpServer({
    hubBaseUrl: "http://127.0.0.1:1",
    hubTimeoutMs: 2_000,
    host: "127.0.0.1",
    port: 0,
  });
  const client = new Client({ name: "practice-contract-test", version: "1.2.1" });
  const transport = new StreamableHTTPClientTransport(new URL(handle.url));
  const invalidV2Submission = {
    submissionId: "submission-contract-0001",
    practiceContractVersion: 2,
    session: {
      sessionId: "session-contract-0001",
      title: "Contract validation",
      practiceType: "multiple_choice",
      startedAt: "2026-08-28T10:00:00+08:00",
      completedAt: "2026-08-28T10:01:00+08:00",
    },
    questions: [{
      questionKey: "question-1",
      position: 1,
      snapshot: { prompt: "test" },
      targets: [{ targetKey: "target-1", targetKind: "vocab", itemId: "vocab:test" }],
      response: {
        answer: { value: "test" },
        answerResult: "wrong",
        submittedAt: "2026-08-28T10:01:00+08:00",
      },
    }],
  };

  try {
    await client.connect(transport);
    for (const name of ["study_preview_practice_record", "study_record_practice"]) {
      const response = await client.callTool({
        name,
        arguments: invalidV2Submission,
      });
      assert.equal(response.isError, true, name);
      assert.equal(
        (response.structuredContent as Record<string, any>)?.error?.code,
        "INVALID_PRACTICE_CONTRACT",
        name,
      );
      assert.equal(
        (response.structuredContent as Record<string, any>)?.error?.status,
        400,
        name,
      );
    }
  } finally {
    await client.close().catch(() => undefined);
    await handle.close();
  }
});

test("learning-workbench projections satisfy their published output schemas", async () => {
  const hubServer = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/v1/quality/inbox?limit=3&offset=0") {
      res.end(JSON.stringify({
        ok: true,
        count: 1,
        total: 4,
        offset: 0,
        limit: 3,
        has_more: true,
        summary: { missing_translation: 4 },
        items: [{ item_id: "vocab:test", issue_type: "missing_translation" }],
      }));
      return;
    }
    if (req.url === "/api/v1/items/creation/preview" && req.method === "POST") {
      res.end(JSON.stringify({
        ok: true,
        contract_version: "learning-content-v8.0",
        candidate: { item_id: "vocab:test" },
        can_create: true,
        exact_duplicate_item_id: null,
        possible_duplicate_ids: [],
        possible_duplicates: [],
        warnings: [],
        fingerprint: "a".repeat(64),
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false }));
  });
  await new Promise<void>((resolve) => hubServer.listen(0, "127.0.0.1", resolve));
  const hubAddress = hubServer.address();
  assert.ok(hubAddress && typeof hubAddress === "object");

  const handle = await startJapaneseStudyHttpServer({
    hubBaseUrl: `http://127.0.0.1:${hubAddress.port}`,
    hubTimeoutMs: 2_000,
    host: "127.0.0.1",
    port: 0,
  });
  const client = new Client({ name: "projection-schema-test", version: "1.2.1" });
  const transport = new StreamableHTTPClientTransport(new URL(handle.url));

  try {
    await client.connect(transport);
    const quality = await client.callTool({
      name: "study_get_quality_inbox",
      arguments: { limit: 3, offset: 0 },
    });
    assert.notEqual(quality.isError, true);
    assert.equal((quality.structuredContent as Record<string, any>)?.has_more, true);

    const preview = await client.callTool({
      name: "study_preview_item_creation",
      arguments: { draft: { kind: "vocab", title: "test" } },
    });
    assert.notEqual(preview.isError, true);
    assert.deepEqual(
      (preview.structuredContent as Record<string, any>)?.possible_duplicate_ids,
      [],
    );
  } finally {
    await client.close().catch(() => undefined);
    await handle.close();
    await new Promise<void>((resolve, reject) =>
      hubServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("Hub domain errors remain typed across the MCP boundary", async () => {
  const hubServer = createServer((req, res) => {
    assert.equal(req.url, "/api/v1/practice/sessions/missing-session");
    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: {
          code: "PRACTICE_SESSION_NOT_FOUND",
          message: "Practice session not found.",
          retryable: false,
          details: { session_id: "missing-session" },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => hubServer.listen(0, "127.0.0.1", resolve));
  const hubAddress = hubServer.address();
  assert.ok(hubAddress && typeof hubAddress === "object");

  const handle = await startJapaneseStudyHttpServer({
    hubBaseUrl: `http://127.0.0.1:${hubAddress.port}`,
    hubTimeoutMs: 2_000,
    host: "127.0.0.1",
    port: 0,
  });
  const client = new Client({ name: "typed-error-test", version: "1.2.1" });
  const transport = new StreamableHTTPClientTransport(new URL(handle.url));

  try {
    await client.connect(transport);
    const response = await client.callTool({
      name: "study_get_practice_session",
      arguments: { sessionId: "missing-session" },
    });
    assert.equal(response.isError, true);
    assert.deepEqual(response.structuredContent, {
      ok: false,
      error: {
        code: "PRACTICE_SESSION_NOT_FOUND",
        message: "Practice session not found.",
        status: 404,
        retryable: false,
        details: { session_id: "missing-session" },
      },
    });
  } finally {
    await client.close().catch(() => undefined);
    await handle.close();
    await new Promise<void>((resolve, reject) =>
      hubServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
