import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../dist/src/config.js";
import { startJapaneseStudyHttpServer } from "../dist/src/http-server.js";

if (process.env.JSTUDY_MCP_SMOKE_ALLOW_WRITES !== "1") {
  throw new Error("Set JSTUDY_MCP_SMOKE_ALLOW_WRITES=1 before running the write smoke.");
}

const config = loadConfig({
  ...process.env,
  JSTUDY_MCP_HOST: "127.0.0.1",
  JSTUDY_MCP_PORT: "0",
  JSTUDY_MCP_HTTP_TOKEN: "",
});
const handle = await startJapaneseStudyHttpServer(config);
const client = new Client({ name: "japanese-study-hub-write-smoke", version: "1.1.0" });
const transport = new StreamableHTTPClientTransport(new URL(handle.url));

try {
  await client.connect(transport);
  const plan = await client.callTool({
    name: "study_get_plan",
    arguments: { kind: "vocab", limit: 1 },
  });
  assert.notEqual(plan.isError, true, JSON.stringify(plan.content));
  const planData = plan.structuredContent;
  assert.ok(planData && Array.isArray(planData.items) && planData.items.length === 1);
  const itemId = planData.items[0]?.item_id;
  assert.equal(typeof itemId, "string");

  const labels = await client.callTool({
    name: "study_set_manual_labels",
    arguments: {
      labels: [{ itemId, label: "uncertain", note: "mcp integration smoke" }],
    },
  });
  assert.notEqual(labels.isError, true, JSON.stringify(labels.content));

  const eventId = `mcp-integration-smoke:${itemId}`;
  const attemptArguments = { eventId, itemId, result: "seen", metadata: { purpose: "retry-safety-check" } };
  const firstAttempt = await client.callTool({
    name: "study_record_attempt",
    arguments: attemptArguments,
  });
  const repeatedAttempt = await client.callTool({
    name: "study_record_attempt",
    arguments: attemptArguments,
  });
  assert.notEqual(firstAttempt.isError, true, JSON.stringify(firstAttempt.content));
  assert.notEqual(repeatedAttempt.isError, true, JSON.stringify(repeatedAttempt.content));
  assert.equal(repeatedAttempt.structuredContent?.result?.duplicate, true);

  console.log(
    JSON.stringify(
      {
        ok: true,
        hub: config.hubBaseUrl,
        itemId,
        labels: labels.structuredContent,
        firstAttempt: firstAttempt.structuredContent,
        repeatedAttempt: repeatedAttempt.structuredContent,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close().catch(() => undefined);
  await handle.close();
}
