import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readAudioAsset } from "../src/audio.js";
import { loadConfig } from "../src/config.js";
import { createWorkspaceMcpServer } from "../src/server.js";

// Valid mono PCM WAV: 80 silent samples at 8 kHz.
function wav(): Buffer {
  const bytes = Buffer.alloc(204);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(196, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(160, 40);
  return bytes;
}

async function fixture(t: TestContext, enabled = true, limit = 1024) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-audio-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const assets = path.join(root, "assets");
  await fs.mkdir(assets);
  const source = wav();
  await fs.writeFile(path.join(assets, "sample.WAV"), source);
  const config = await loadConfig({
    WORKSPACE_MCP_ROOTS: `projects=${root}`,
    WORKSPACE_MCP_ASSET_SCOPES: "media=projects:assets",
    WORKSPACE_MCP_FILE_RETURN_SCOPES: enabled ? "media" : "",
    WORKSPACE_MCP_MAX_FETCH_FILE_BYTES: String(limit),
  });
  return { root, assets, source, config };
}

test("readAudioAsset preserves WAV bytes and identity", async (t) => {
  const f = await fixture(t);
  const result = await readAudioAsset(f.config, { scope: "media", path: "sample.WAV" });
  assert.deepEqual(Buffer.from(result.data, "base64"), f.source);
  assert.deepEqual(result.metadata, {
    ok: true, scope: "media", path: "sample.WAV", filename: "sample.WAV",
    bytes: f.source.length, mimeType: "audio/wav",
    sha256: createHash("sha256").update(f.source).digest("hex"), transport: "audio_content",
  });
});

test("readAudioAsset preserves authorization and size limits", async (t) => {
  const disabled = await fixture(t, false);
  await assert.rejects(() => readAudioAsset(disabled.config, { scope: "media", path: "sample.WAV" }), /Original file return is not enabled/);
  const small = await fixture(t, true, 4);
  await assert.rejects(() => readAudioAsset(small.config, { scope: "media", path: "sample.WAV" }), /fetch limit of 4 bytes/);
});

test("readAudioAsset rejects unsupported, escaping and denied paths", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "outside.wav"), f.source);
  await fs.mkdir(path.join(f.assets, ".secrets"));
  await fs.writeFile(path.join(f.assets, ".secrets", "sample.wav"), f.source);
  for (const [scope, file, message] of [
    ["media", "note.txt", /supports WAV/],
    ["media", "../outside.wav", /escapes the configured asset scope/],
    ["media", "C:\\Windows\\sample.wav", /relative path/],
    ["media", ".secrets/sample.wav", /denied directory/],
    ["media", ".env.wav", /denied file name/],
    ["codex", "sample.wav", /Unknown asset scope/],
  ] as const) {
    await assert.rejects(() => readAudioAsset(f.config, { scope, path: file }), message);
  }
  await fs.symlink(f.root, path.join(f.assets, "escape"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => readAudioAsset(f.config, { scope: "media", path: "escape/outside.wav" }), /escapes the configured asset scope/);
});

test("read_audio MCP contract returns only audio and preserves download behavior", async (t) => {
  const f = await fixture(t);
  const server = createWorkspaceMcpServer(f.config);
  const client = new Client({ name: "audio-contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  const audioTool = listed.tools.find((tool) => tool.name === "read_audio");
  assert.ok(audioTool);
  assert.equal(audioTool.annotations?.readOnlyHint, true);
  assert.match(JSON.stringify(audioTool.inputSchema), /media/);
  const args = { scope: "media", path: "sample.WAV" };
  const result = await client.callTool({ name: "read_audio", arguments: args });
  assert.deepEqual(result.content, [{ type: "audio", data: f.source.toString("base64"), mimeType: "audio/wav" }]);
  assert.equal(result._meta, undefined);
  assert.equal(audioTool._meta, undefined);
  const metadata = result.structuredContent as Record<string, unknown>;
  assert.equal(metadata.transport, "audio_content");
  assert.equal("data" in metadata, false);
  const error = await client.callTool({ name: "read_audio", arguments: { ...args, scope: "codex" } });
  assert.equal(error.isError, true);
  const download = await client.callTool({ name: "fetch_asset", arguments: args });
  assert.deepEqual((download.content as Array<{ type: string }>).map((item) => item.type), ["text", "resource_link"]);
});
