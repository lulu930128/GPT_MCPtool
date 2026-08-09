import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startJapaneseStudyHttpServer } from "../src/http-server.js";

const expectedToolNames = [
  "study_apply_practice_target_overrides",
  "study_get_item",
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
].sort();

test("published MCP contract exposes the complete practice-resolution v4.1 surface", async () => {
  const handle = await startJapaneseStudyHttpServer({
    hubBaseUrl: "http://127.0.0.1:1",
    hubTimeoutMs: 2_000,
    host: "127.0.0.1",
    port: 0,
  });
  const client = new Client({ name: "contract-test", version: "0.3.1" });
  const transport = new StreamableHTTPClientTransport(new URL(handle.url));

  try {
    const healthResponse = await fetch(new URL("/health", handle.url));
    assert.equal(healthResponse.status, 200);
    const health = (await healthResponse.json()) as Record<string, unknown>;
    assert.equal(health.service, "japanese-study-mcp");
    assert.equal(health.version, "0.3.1");
    assert.equal(health.contractVersion, "practice-resolution-v4.1");
    assert.equal(health.toolCount, 14);
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

    const retrySafeWrites = [
      "study_apply_practice_target_overrides",
      "study_record_attempt",
      "study_record_practice",
      "study_set_manual_labels",
      "study_supersede_practice_session",
    ];
    for (const name of retrySafeWrites) {
      const tool = response.tools.find((entry) => entry.name === name);
      assert.equal(tool?.annotations?.idempotentHint, true, `${name} idempotentHint`);
    }
  } finally {
    await client.close().catch(() => undefined);
    await handle.close();
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
  const client = new Client({ name: "typed-error-test", version: "0.3.0" });
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
