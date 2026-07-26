import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { JapaneseStudyHubClient } from "../src/api-client.js";


test("Hub client sends bounded query and bearer auth", async () => {
  let receivedUrl = "";
  let receivedAuth = "";
  const server = createServer((req, res) => {
    receivedUrl = req.url || "";
    receivedAuth = String(req.headers.authorization || "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, count: 0, items: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new JapaneseStudyHubClient({
    hubBaseUrl: `http://127.0.0.1:${address.port}`,
    hubApiToken: "test-token",
    hubTimeoutMs: 2_000,
  });

  try {
    const response = await client.searchItems({ query: "遂に", kind: "vocab", limit: 5 });
    assert.deepEqual(response, { ok: true, count: 0, items: [] });
    assert.equal(receivedAuth, "Bearer test-token");
    assert.match(receivedUrl, /^\/api\/v1\/items\?/);
    assert.match(receivedUrl, /query=%E9%81%82%E3%81%AB/);
    assert.match(receivedUrl, /kind=vocab/);
    assert.match(receivedUrl, /limit=5/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("attempt payload maps camelCase to the Hub contract", async () => {
  let body = "";
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    body = Buffer.concat(chunks).toString("utf8");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, result: { inserted: true } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new JapaneseStudyHubClient({
    hubBaseUrl: `http://127.0.0.1:${address.port}`,
    hubTimeoutMs: 2_000,
  });

  try {
    await client.recordAttempt({
      eventId: "event-0001",
      itemId: "vocab:test",
      result: "wrong",
      sessionId: "session-1",
    });
    assert.deepEqual(JSON.parse(body), {
      event_id: "event-0001",
      item_id: "vocab:test",
      result: "wrong",
      session_id: "session-1",
      source: "chatgpt_mcp",
      metadata: {},
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
