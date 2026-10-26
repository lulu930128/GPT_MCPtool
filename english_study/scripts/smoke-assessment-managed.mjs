// Read-only verification of installed source, version and existing history.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startEnglishStudyHttpServer } from "../dist/src/http-server.js";
const url = new URL(process.env.ESTUDY_MCP_URL || "http://127.0.0.1:18886/mcp");
assert.equal(url.hostname, "127.0.0.1");
const client = new Client({name: "assessment-adoption-check", version: "2"});
const local = await startEnglishStudyHttpServer({hubBaseUrl: "http://127.0.0.1:1", hubTimeoutMs: 1000, host: "127.0.0.1", port: 0});
try {
  const actual = await (await fetch(new URL("/health", url))).json();
  const expected = await (await fetch(new URL("/health", local.url))).json();
  assert.equal(actual.buildId, expected.buildId);
  assert.equal(actual.toolCount, 17);
  await client.connect(new StreamableHTTPClientTransport(url));
  const call = async (name, args={}) => {
    const result = await client.callTool({name, arguments: args});
    assert.notEqual(result.isError, true); assert.equal(result.structuredContent.ok, true);
    return result.structuredContent;
  };
  const summary = await call("english_get_summary");
  const seen = new Set(); let offset = 0, count = 0, assessmentCount = 0;
  for (;;) {
    const page = await call("english_list_practice_sessions", {limit: 2, offset});
    assert.equal(page.total, summary.summary.practice_sessions);
    for (const item of page.items) {
      assert.ok(!seen.has(item.session_id)); seen.add(item.session_id);
      const detail = await call("english_get_practice_session", {sessionId: item.session_id});
      assert.equal(detail.session.session_id, item.session_id);
      count += detail.session.questions.length;
      assessmentCount += detail.session.assessments.length;
    }
    if (!page.has_more) break;
    assert.ok(page.count > 0); offset += page.count;
  }
  assert.equal(seen.size, summary.summary.practice_sessions);
  const progress = await call("english_get_ielts_progress");
  const evidence = {ok: true, checkedAt: new Date().toISOString(), buildId: actual.buildId,
    version: actual.version, toolCount: actual.toolCount, sessionsRead: seen.size,
    questionSnapshotsRead: count, assessmentsRead: assessmentCount, progressStatus: progress.status, domainWrites: false};
  await writeFile(new URL("../.tmp/assessment-managed.json", import.meta.url), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {await client.close(); await local.close();}
