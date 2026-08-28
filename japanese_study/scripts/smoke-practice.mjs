import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

assert.equal(
  process.env.JSTUDY_ALLOW_TEST_WRITE,
  "1",
  "Set JSTUDY_ALLOW_TEST_WRITE=1 only for a disposable Hub database.",
);

const url = new URL(process.env.JSTUDY_MCP_URL || "http://127.0.0.1:18790/mcp");
assert.ok(
  url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1",
  "smoke:practice only connects to a loopback MCP endpoint",
);

const unique = `${Date.now()}-${process.pid}`;
const sessionId = `smoke-session-${unique}`;
const submissionId = `smoke-submission-${unique}`;
const submission = {
  submissionId,
  session: {
    sessionId,
    title: "Disposable MCP practice smoke",
    practiceType: "grammar",
    requestedLevel: "N3",
    status: "completed",
    startedAt: "2026-07-27T10:00:00+08:00",
    completedAt: "2026-07-27T10:05:00+08:00",
    timezoneName: "Asia/Taipei",
    source: "mcp_disposable_smoke",
    metadata: { disposable: true },
  },
  questions: [
    {
      questionKey: "q1",
      position: 1,
      snapshot: {
        question_type: "single_choice",
        stem: "このコートは三割引の商品（　）、着心地がいい。",
        choices: [
          { choice_id: "a", text: "にしては" },
          { choice_id: "b", text: "に限らず" },
        ],
        correct_choice_ids: ["a"],
      },
      validity: "valid",
      maxPoints: 1,
      targets: [
        {
          targetKey: "grammar-main",
          targetKind: "grammar",
          pattern: "～にしては",
          senseKey: "unexpected_relative_to_standard",
          role: "primary",
          weight: 1,
        },
      ],
      response: {
        answer: { selected_choice_ids: ["a"] },
        answerResult: "correct",
        awardedPoints: 1,
        submittedAt: "2026-07-27T10:03:00+08:00",
        grading: { rationale: "Disposable contract smoke." },
      },
    },
  ],
};

const client = new Client({ name: "japanese-study-practice-smoke", version: "1.2.1" });
const transport = new StreamableHTTPClientTransport(url);

try {
  await client.connect(transport);

  const preview = await client.callTool({
    name: "study_preview_practice_record",
    arguments: submission,
  });
  assert.notEqual(preview.isError, true, JSON.stringify(preview.content));
  assert.equal(preview.structuredContent?.ok, true);
  assert.equal(preview.structuredContent?.preview?.resolved_target_count, 1);
  assert.equal(preview.structuredContent?.preview?.unresolved_target_count, 0);

  const first = await client.callTool({
    name: "study_record_practice",
    arguments: submission,
  });
  assert.notEqual(first.isError, true, JSON.stringify(first.content));
  assert.equal(first.structuredContent?.ok, true);
  assert.equal(first.structuredContent?.duplicate, false);
  assert.equal(first.structuredContent?.stored?.evidence_created, 1);

  const retry = await client.callTool({
    name: "study_record_practice",
    arguments: submission,
  });
  assert.notEqual(retry.isError, true, JSON.stringify(retry.content));
  assert.equal(retry.structuredContent?.duplicate, true);

  const changed = structuredClone(submission);
  changed.questions[0].response.answerResult = "wrong";
  changed.questions[0].response.awardedPoints = 0;
  const conflict = await client.callTool({
    name: "study_record_practice",
    arguments: changed,
  });
  assert.equal(conflict.isError, true);
  assert.equal(conflict.structuredContent?.error?.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(conflict.structuredContent?.error?.status, 409);
  assert.equal(conflict.structuredContent?.error?.retryable, false);

  const stored = await client.callTool({
    name: "study_get_practice_session",
    arguments: { sessionId },
  });
  assert.notEqual(stored.isError, true, JSON.stringify(stored.content));
  assert.equal(stored.structuredContent?.ok, true);
  assert.equal(stored.structuredContent?.session?.session_id, sessionId);
  assert.equal(stored.structuredContent?.summary?.question_count, 1);
  assert.equal(stored.structuredContent?.summary?.evidence, 1);

  console.log(
    JSON.stringify(
      {
        ok: true,
        url: url.toString(),
        session_id: sessionId,
        preview_resolved_targets:
          preview.structuredContent.preview.resolved_target_count,
        duplicate_retry: retry.structuredContent.duplicate,
        conflict_code: conflict.structuredContent.error.code,
        stored_summary: stored.structuredContent.summary,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close().catch(() => undefined);
}
