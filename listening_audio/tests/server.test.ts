import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server.js";
import { backend, health, question, send, wav } from "./fixtures.js";
test("five tools have truthful annotations and resources/read only fetches WAV", async () => {
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
    const { tools } = await client.listTools(); assert.equal(tools.length, 5);
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
