import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

assert.ok(
  process.env.CODEX_BRIDGE_LIVE_CODEX_CONFIRM === "1" || process.argv.includes("--confirm-live-codex"),
  "Set CODEX_BRIDGE_LIVE_CODEX_CONFIRM=1 or pass --confirm-live-codex to run one real read-only Codex turn.",
);
const url = new URL(process.env.CODEX_BRIDGE_SMOKE_URL?.trim() || "http://127.0.0.1:8828/mcp");
const projectId = process.env.CODEX_BRIDGE_SMOKE_PROJECT_ID?.trim() || "mcp_tools";
const client = new Client({ name: "codex-bridge-codex-smoke", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(url);
let jobId;

try {
  await client.connect(transport);
  const preview = await client.callTool({
    name: "codex_job_preview",
    arguments: {
      projectId,
      title: "Codex Bridge read-only smoke",
      objective: "Read the repository README title and report it. Do not modify files, run shell commands, or use network access.",
      executionMode: "plan",
      dataClassification: "personal",
    },
  });
  assert.match(preview.structuredContent?.previewDigest, /^[0-9a-f]{64}$/);
  const dispatched = await client.callTool({
    name: "codex_job_dispatch",
    arguments: {
      ...preview.structuredContent.workPackage,
      previewDigest: preview.structuredContent.previewDigest,
      idempotencyKey: `live-smoke:${randomUUID()}`,
    },
  });
  if (dispatched.isError) throw new Error(dispatched.content?.[0]?.text || "Dispatch failed.");
  jobId = dispatched.structuredContent?.job?.id;
  assert.match(jobId, /^[0-9a-f-]{36}$/i);

  const deadline = Date.now() + 120_000;
  let snapshot = dispatched.structuredContent.job;
  while (!new Set(["completed", "failed", "interrupted", "cancelled", "awaiting_approval"]).has(snapshot.status)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for real Codex job ${jobId}.`);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const response = await client.callTool({ name: "codex_job_get", arguments: { jobId, afterSeq: 0, maxEvents: 100 } });
    snapshot = response.structuredContent;
  }
  console.log(JSON.stringify({ ok: snapshot.status === "completed", jobId, status: snapshot.status, controllerEvents: snapshot.events, result: snapshot.result }, null, 2));
  if (snapshot.status !== "completed") throw new Error(`Real Codex smoke ended in ${snapshot.status}.`);
  assert.ok(snapshot.result?.output?.trim(), "Real Codex smoke did not persist the final agent output.");
} catch (error) {
  if (jobId) {
    await client.callTool({ name: "codex_job_cancel", arguments: { jobId } }).catch(() => undefined);
  }
  throw error;
} finally {
  await client.close().catch(() => undefined);
}
