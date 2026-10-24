import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server.js";
import { DOWNLOAD_UI_URI, downloadHtml } from "../src/download-app.js";
import { backend, health, question, send, wav } from "./fixtures.js";
test("six tools have truthful annotations and resources/read only fetches WAV", async () => {
  const calls: string[] = [];
  const fixture = await backend((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.url?.endsWith("/audio")) { res.writeHead(200, { "content-type": "audio/wav" }); res.end(wav()); }
    else send(res, req.url?.endsWith("/health") ? health : { ...question, audio: { state: "ready", bytes: wav().length } });
  });
  const client = new Client({ name: "test", version: "1" });
  const server = createMcpServer(fixture.config);
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const { tools } = await client.listTools(); assert.equal(tools.length, 7);
    assert.equal(tools.find(t => t.name === "listening_get_question")?.annotations?.readOnlyHint, true);
    assert.equal(tools.find(t => t.name === "listening_prepare_audio")?.annotations?.readOnlyHint, false);
    const result = await client.callTool({ name: "listening_get_question", arguments: { setId: "exam001", questionId: "Q001" } });
    assert.equal(result.isError, undefined);
    const audio = await client.readResource({ uri: "listening-audio://sets/exam001/Q001.wav" });
    assert.equal(audio.contents[0].mimeType, "audio/wav");
    assert.deepEqual(Buffer.from((audio.contents[0] as { blob: string }).blob, "base64"), wav());
    assert.ok(calls.every(c => c.startsWith("GET ")));
    const invalid = await client.callTool({ name: "listening_get_question", arguments: { setId: "exam001", questionId: "Q001", path: "C:/secret" } });
    assert.equal(invalid.isError, true);
    await assert.rejects(client.readResource({ uri: "listening-audio://sets/exam001/..%2fsecret.wav" }));
  } finally { await client.close(); await server.close(); await fixture.close(); }
});
test("download render is read-only, safe, and only links ready audio", async () => {
  for (const state of ["ready", "missing", "stale"]) {
    const calls: string[] = [];
    const fixture = await backend((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      send(res, { ...question, audio_script: "secret", correct_option: 1,
        audio: { state, bytes: state === "ready" ? 76 : 0, resourceUri: "file:///secret" } });
    });
    const client = new Client({ name: "test", version: "1" });
    const server = createMcpServer(fixture.config);
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a); await client.connect(b);
      const tool = (await client.listTools()).tools.find(t => t.name === "listening_render_question")!;
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal((tool._meta?.ui as { resourceUri: string }).resourceUri, DOWNLOAD_UI_URI);
      const ui = await client.readResource({ uri: DOWNLOAD_UI_URI });
      assert.equal(ui.contents[0].mimeType, "text/html;profile=mcp-app");
      assert.equal((ui.contents[0] as { text: string }).text, downloadHtml());
      const result = await client.callTool({ name: tool.name, arguments: { setId: "exam001", questionId: "Q001" } });
      const projected = result.structuredContent as { audio: Record<string, unknown> };
      assert.equal(result.isError, undefined);
      assert.equal(projected.audio.resourceUri, state === "ready" ? "listening-audio://sets/exam001/Q001.wav" : undefined);
      assert.equal(projected.audio.filename, state === "ready" ? "Q001.wav" : undefined);
      for (const forbidden of ["secret", "correct_option", "audio_script", "options"]) assert.ok(!JSON.stringify(result).includes(forbidden));
      assert.ok(calls.every(c => c.startsWith("GET ")));
      const rejected = await client.callTool({ name: tool.name, arguments: { setId: "exam001", questionId: "Q001", resourceUri: "file:///secret" } });
      assert.equal(rejected.isError, true);
    } finally { await client.close(); await server.close(); await fixture.close(); }
  }
});
