import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.JSTUDY_MCP_URL || "http://127.0.0.1:8790/mcp");
assert.ok(
  url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1",
  "smoke:live only connects to a loopback MCP endpoint",
);

const client = new Client({ name: "japanese-study-live-smoke", version: "0.3.0" });
const transport = new StreamableHTTPClientTransport(url);

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "study_get_item",
    "study_apply_practice_target_overrides",
    "study_get_plan",
    "study_get_practice_session",
    "study_get_summary",
    "study_list_practice_sessions",
    "study_preview_practice_record",
    "study_preview_practice_target_resolution",
    "study_preview_target_resolution",
    "study_record_attempt",
    "study_record_practice",
    "study_search_items",
    "study_set_manual_labels",
    "study_supersede_practice_session",
  ].sort());

  const summary = await client.callTool({ name: "study_get_summary", arguments: {} });
  assert.notEqual(summary.isError, true, JSON.stringify(summary.content));
  assert.equal(summary.structuredContent?.ok, true);
  assert.ok(Number(summary.structuredContent?.summary?.items?.total) > 0);

  const sessions = await client.callTool({
    name: "study_list_practice_sessions",
    arguments: { limit: 5 },
  });
  assert.notEqual(sessions.isError, true, JSON.stringify(sessions.content));
  assert.equal(sessions.structuredContent?.ok, true);

  const targetPreview = await client.callTool({
    name: "study_preview_target_resolution",
    arguments: {
      targets: [
        {
          targetKey: "live-search-preview",
          targetKind: "grammar",
          selector: { type: "search", query: "にしては" },
        },
      ],
    },
  });
  assert.notEqual(targetPreview.isError, true, JSON.stringify(targetPreview.content));
  assert.equal(targetPreview.structuredContent?.ok, true);
  assert.equal(targetPreview.structuredContent?.targets?.[0]?.status, "unresolved");
  assert.equal(
    targetPreview.structuredContent?.targets?.[0]?.resolution_reason,
    "search_requires_explicit_item_id",
  );
  assert.ok(Number(targetPreview.structuredContent?.targets?.[0]?.candidate_count) > 0);

  const preview = await client.callTool({
    name: "study_preview_practice_record",
    arguments: {
      submissionId: "live-preview-submission",
      session: {
        sessionId: "live-preview-session",
        title: "Read-only live contract preview",
        practiceType: "grammar",
        requestedLevel: "N3",
        status: "completed",
        startedAt: "2026-07-27T10:00:00+08:00",
        completedAt: "2026-07-27T10:05:00+08:00",
        timezoneName: "Asia/Taipei",
        source: "mcp_live_preview",
      },
      questions: [
        {
          questionKey: "q1",
          position: 1,
          snapshot: {
            schemaVersion: 1,
            questionType: "single_choice",
            language: "ja",
            prompt: "このコートは三割引の商品（　）、着心地がいい。",
            choices: [
              { key: "a", text: "にしては" },
              { key: "b", text: "に限らず" },
            ],
            answerKey: ["a"],
          },
          validity: "valid",
          maxPoints: 1,
          targets: [
            {
              targetKey: "grammar-main",
              targetKind: "grammar",
              selector: {
                type: "grammar_identity",
                pattern: "～にしては",
                senseKey: "unexpected_relative_to_standard",
              },
              role: "primary",
              weight: 1,
            },
          ],
          response: {
            answer: { selectedKeys: ["a"] },
            answerResult: "correct",
            awardedPoints: 1,
            submittedAt: "2026-07-27T10:03:00+08:00",
          },
        },
      ],
    },
  });
  assert.notEqual(preview.isError, true, JSON.stringify(preview.content));
  assert.equal(preview.structuredContent?.ok, true);
  assert.equal(preview.structuredContent?.preview?.resolved_target_count, 1);
  assert.equal(preview.structuredContent?.preview?.unresolved_target_count, 0);
  assert.deepEqual(preview.structuredContent?.preview?.warnings, []);

  const missingSession = await client.callTool({
    name: "study_get_practice_session",
    arguments: { sessionId: "live-smoke-missing-session" },
  });
  assert.equal(missingSession.isError, true);
  assert.equal(
    missingSession.structuredContent?.error?.code,
    "PRACTICE_SESSION_NOT_FOUND",
  );
  assert.equal(missingSession.structuredContent?.error?.status, 404);
  assert.equal(missingSession.structuredContent?.error?.retryable, false);

  console.log(JSON.stringify({
    ok: true,
    url: url.toString(),
    tools: names,
    items: summary.structuredContent.summary.items.total,
    practice_sessions: sessions.structuredContent.count,
    target_preview_candidates:
      targetPreview.structuredContent.targets[0].candidate_count,
    preview_resolved_targets: preview.structuredContent.preview.resolved_target_count,
    missing_session_error: missingSession.structuredContent.error.code,
  }, null, 2));
} finally {
  await client.close().catch(() => undefined);
}
