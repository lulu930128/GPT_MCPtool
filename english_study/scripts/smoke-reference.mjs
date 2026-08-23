import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.ESTUDY_MCP_URL || "http://127.0.0.1:18886/mcp";
const client = new Client({ name: "english-study-reference-smoke", version: "0.3.0" });
const transport = new StreamableHTTPClientTransport(new URL(url));

try {
  await client.connect(transport);
  const listed = await client.listTools();
  for (const required of ["english_search_reference_entries", "english_get_reference_entry", "english_preview_item_enrichment"]) {
    if (!listed.tools.some((tool) => tool.name === required)) {
      throw new Error(`Missing Reference Catalog tool: ${required}`);
    }
  }
  const search = await client.callTool({
    name: "english_search_reference_entries",
    arguments: { query: "bank", limit: 5 },
  });
  if (search.isError || search.structuredContent?.ok !== true) {
    throw new Error(`Reference search failed: ${JSON.stringify(search.structuredContent)}`);
  }
  const items = search.structuredContent?.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Reference search returned no bank entries.");
  }
  const entryId = items[0]?.entry_id;
  if (typeof entryId !== "string") throw new Error("Reference search result has no entry_id.");
  const detail = await client.callTool({
    name: "english_get_reference_entry",
    arguments: { entryId },
  });
  if (detail.isError || detail.structuredContent?.ok !== true) {
    throw new Error(`Reference detail failed: ${JSON.stringify(detail.structuredContent)}`);
  }
  const entry = detail.structuredContent?.entry;
  if (!entry || typeof entry !== "object" || typeof entry.source_id !== "string") {
    throw new Error("Reference detail did not preserve source identity.");
  }
  console.log(JSON.stringify({
    ok: true,
    toolCount: listed.tools.length,
    searchTotal: search.structuredContent?.total,
    selectedSource: entry.source_id,
    selectedSourceVersion: entry.source_version,
    selectedLicense: entry.source_license,
  }));
} finally {
  await client.close().catch(() => undefined);
}
