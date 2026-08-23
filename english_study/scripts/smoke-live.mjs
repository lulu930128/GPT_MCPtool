import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.ESTUDY_MCP_URL || "http://127.0.0.1:18886/mcp";
const allowWrite = process.env.ESTUDY_ALLOW_TEST_WRITE === "1";
const client = new Client({ name: "english-study-live-smoke", version: "0.3.0" });
const transport = new StreamableHTTPClientTransport(new URL(url));
try {
  await client.connect(transport);
  const listed = await client.listTools();
  if (listed.tools.length !== 15) throw new Error(`Expected 15 tools, received ${listed.tools.length}.`);
  for (const required of ["english_search_reference_entries", "english_get_reference_entry", "english_preview_item_enrichment"]) {
    if (!listed.tools.some((tool) => tool.name === required)) throw new Error(`Missing Reference Catalog tool: ${required}`);
  }
  const summary = await client.callTool({ name: "english_get_summary", arguments: {} });
  if (summary.isError || summary.structuredContent?.ok !== true) throw new Error("Summary call failed.");
  const result = { ok: true, toolCount: listed.tools.length, summary: summary.structuredContent };
  if (allowWrite) {
    const suffix = randomUUID();
    const draft = { kind: "vocab", title: `smoke-${suffix}`, lemma: `smoke-${suffix}`, partOfSpeech: "noun", senseKey: "test_only", meaningTc: "測試", cefrLevel: "A1", sourceName: "smoke_test" };
    const preview = await client.callTool({ name: "english_preview_item_creation", arguments: { draft } });
    if (preview.isError) throw new Error("Creation preview failed.");
    const fingerprint = preview.structuredContent?.fingerprint;
    const created = await client.callTool({ name: "english_create_item", arguments: { operationId: `smoke-create-${suffix}`, expectedFingerprint: fingerprint, draft } });
    if (created.isError) throw new Error(`Creation failed: ${JSON.stringify(created.structuredContent)}`);
    result.createdItemId = created.structuredContent?.item?.item_id;
  }
  console.log(JSON.stringify(result));
} finally {
  await client.close().catch(() => undefined);
}
