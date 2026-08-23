import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startEnglishStudyHttpServer } from "../src/http-server.js";

const expectedTools = [
  "english_create_item", "english_get_due_reviews", "english_get_item", "english_get_plan",
  "english_get_practice_session", "english_get_summary", "english_preview_item_creation",
  "english_preview_practice_record", "english_record_attempt", "english_record_practice",
  "english_search_items", "english_set_manual_labels", "english_search_reference_entries",
  "english_get_reference_entry", "english_preview_item_enrichment",
].sort();

test("MCP publishes the independent strict 15-tool contract", async () => {
  const handle = await startEnglishStudyHttpServer({ hubBaseUrl: "http://127.0.0.1:1", hubTimeoutMs: 2000, host: "127.0.0.1", port: 0 });
  const client = new Client({ name: "contract-test", version: "0.3.0" });
  const transport = new StreamableHTTPClientTransport(new URL(handle.url));
  try {
    const healthResponse = await fetch(new URL("/health", handle.url));
    const health = await healthResponse.json() as Record<string, unknown>;
    assert.equal(health.service, "english-study-mcp");
    assert.equal(health.version, "0.3.0");
    assert.equal(health.contractVersion, "english-learning-v1");
    assert.equal(health.toolCount, 15);
    assert.match(String(health.buildId), /^[0-9a-f]{16}$/);
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), expectedTools);
    for (const name of ["english_create_item", "english_set_manual_labels", "english_record_attempt", "english_record_practice"]) {
      assert.equal(tools.tools.find((tool) => tool.name === name)?.annotations?.idempotentHint, true);
    }
    const draftSchema = tools.tools.find((tool) => tool.name === "english_preview_item_creation")?.inputSchema as Record<string, any>;
    assert.deepEqual(draftSchema.properties.draft.properties.kind.enum, ["vocab", "phrase", "grammar", "question"]);
    assert.ok(draftSchema.properties.draft.properties.senseKey);
  } finally {
    await client.close().catch(() => undefined);
    await handle.close();
  }
});

test("representative output validates and Hub errors stay typed", async () => {
  const hub = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/v1/summary") return res.end(JSON.stringify({ ok: true, summary: { items: 0 } }));
    if (req.url?.startsWith("/api/v1/reference/entries?")) return res.end(JSON.stringify({ ok: true, count: 1, total: 1, offset: 0, limit: 20, has_more: false, items: [{ entry_id: "ref-entry:sample" }] }));
    if (req.url === "/api/v1/practice/sessions/missing-session") {
      res.writeHead(404);
      return res.end(JSON.stringify({ ok: false, error: { code: "PRACTICE_SESSION_NOT_FOUND", message: "Practice session not found.", retryable: false, details: { session_id: "missing-session" } } }));
    }
    res.writeHead(404); res.end(JSON.stringify({ ok: false }));
  });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve));
  const address = hub.address(); assert.ok(address && typeof address === "object");
  const handle = await startEnglishStudyHttpServer({ hubBaseUrl: `http://127.0.0.1:${address.port}`, hubTimeoutMs: 2000, host: "127.0.0.1", port: 0 });
  const client = new Client({ name: "projection-test", version: "0.3.0" });
  const transport = new StreamableHTTPClientTransport(new URL(handle.url));
  try {
    await client.connect(transport);
    const summary = await client.callTool({ name: "english_get_summary", arguments: {} });
    assert.notEqual(summary.isError, true);
    assert.equal((summary.structuredContent as Record<string, any>).summary.items, 0);
    const references = await client.callTool({ name: "english_search_reference_entries", arguments: { query: "bank" } });
    assert.notEqual(references.isError, true);
    assert.equal((references.structuredContent as Record<string, any>).total, 1);
    const missing = await client.callTool({ name: "english_get_practice_session", arguments: { sessionId: "missing-session" } });
    assert.equal(missing.isError, true);
    assert.equal((missing.structuredContent as Record<string, any>).error.code, "PRACTICE_SESSION_NOT_FOUND");
  } finally {
    await client.close().catch(() => undefined);
    await handle.close();
    await new Promise<void>((resolve, reject) => hub.close((error) => error ? reject(error) : resolve()));
  }
});
