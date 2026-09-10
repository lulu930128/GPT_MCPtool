import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildId } from "../dist/src/http-server.js";

// Read-only adoption probe: does not create exams, generate audio or submit answers.
const client = new Client({ name: "listening-managed-smoke", version: "1" });
try {
  const response = await fetch("http://127.0.0.1:18810/health", { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.buildId, buildId(), "Running MCP must match the current compiled artifact");
  assert.equal(health.tunnelConfigured, true);
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:18810/mcp")));
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), ["listening_health", "listening_create_exam", "listening_get_question", "listening_prepare_audio", "listening_submit_answer"].sort());
  const result = await client.callTool({ name: "listening_health", arguments: {} });
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent.contractVersion, "listening-trainer-v1");
  assert.deepEqual(result.structuredContent.languages, ["ja"]);
  assert.equal((await client.listResourceTemplates()).resourceTemplates.length, 1);
  const ready = await fetch("http://127.0.0.1:18812/readyz", { signal: AbortSignal.timeout(5000) });
  assert.equal(ready.status, 200);
  assert.ok(["ready", "ok"].includes((await ready.text()).trim()));
  const evidence = { checkedAt: new Date().toISOString(), ok: true, buildId: health.buildId,
    tools: tools.map(tool => tool.name), trainerContract: result.structuredContent.contractVersion,
    languages: result.structuredContent.languages, tunnelReady: true, domainWrites: false,
    remoteChatGptVerified: false };
  await writeFile(new URL("../.tmp/managed-smoke.json", import.meta.url), JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence, null, 2));
} finally { await client.close(); }
