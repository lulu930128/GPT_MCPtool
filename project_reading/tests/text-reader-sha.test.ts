import assert from "node:assert/strict";
import fs from "node:fs/promises";
import nativeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/config.js";
import { startWorkspaceHttpServer } from "../src/http-server.js";
import { readWorkspaceFile } from "../src/workspace.js";
import { readTextWindow, type TextWindowResult } from "../src/text-reader.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sha-reader-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = await loadConfig({ WORKSPACE_MCP_ROOTS: `fixture=${root}` });
  return { root, config };
}
const rawHash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const rows = Array.from({ length: 1200 }, (_, i) => `${String(i + 1).padStart(4, "0")}: ${"x".repeat(40)} 中文😀`);
const largeText = rows.join("\r\n") + "\r\n";

test("SHA snapshot: 1200 lines reproduce the real reader failure and paginate in two 600-line pages", async t => {
  const f = await fixture(t), bytes = Buffer.from(largeText);
  await fs.writeFile(path.join(f.root, "rows.txt"), bytes);
  for (const startLine of [1, 601, 1201]) {
    const args = { path: "rows.txt", startLine, maxLines: 600 };
    const ordinary = await readWorkspaceFile(f.config, args) as TextWindowResult;
    const { sha256, ...hashed } = await readWorkspaceFile(f.config, { ...args, includeSha256: true }) as TextWindowResult;
    assert.equal(sha256, rawHash(bytes));
    assert.deepEqual(hashed, ordinary);
    assert.equal(hashed.text, rows.slice(startLine - 1, startLine + 599).join("\n"));
    assert.equal(hashed.totalLines, 1200);
    assert.equal(hashed.nextStartLine, startLine === 1 ? 601 : null);
    assert.equal(hashed.completedLines, startLine === 1201 ? 0 : 600);
  }
});

test("snapshot and stream retain BOM, CR/LF framing, blank and trailing lines and Unicode", async t => {
  const f = await fixture(t), file = path.join(f.root, "framing.txt");
  const cases: [string, string[]][] = [
    ["", []], ["\n", [""]], ["\r\n", [""]], ["\r", [""]], ["\n\n", ["", ""]],
    ["a", ["a"]], ["a\n", ["a"]], ["a\r\n", ["a"]], ["a\r", ["a"]],
    ["a\r\nb\rc\nd\r\r\n", ["a", "b", "c", "d", ""]],
    ["\ufeffASCII\r\n繁體中文\r日本語\n😀𠮷\n", ["\ufeffASCII", "繁體中文", "日本語", "😀𠮷"]],
  ];
  for (const [text, expected] of cases) {
    const bytes = Buffer.from(text); await fs.writeFile(file, bytes);
    for (const startLine of [1, 2, expected.length + 2]) {
      const args = { startLine, maxLines: 600, maxSourceBytes: f.config.maxFileBytes, maxReturnedBytes: 262144 };
      const ordinary = await readTextWindow(file, bytes.length, args);
      const { sha256, ...hashed } = await readTextWindow(file, bytes.length, { ...args, includeSha256: true });
      assert.equal(sha256, rawHash(bytes)); assert.deepEqual(hashed, ordinary);
      assert.equal(hashed.totalLines, expected.length);
      assert.equal(hashed.text, expected.slice(startLine - 1).join("\n"));
    }
  }
});

test("SHA and ordinary byte truncation preserve partial code points and truthful continuation", async t => {
  const f = await fixture(t), file = path.join(f.root, "budget.txt");
  for (const text of ["😀中文\n尾端\n", "abc\n中文😀\nlast\n", "\ufeff😀\r\n\r\n日本語"]) {
    const bytes = Buffer.from(text); await fs.writeFile(file, bytes);
    for (const maxReturnedBytes of [0, 1, 3, 4, 5, 9, 10, 18, 262144]) {
      const args = { startLine: 1, maxLines: 600, maxSourceBytes: f.config.maxFileBytes, maxReturnedBytes };
      const ordinary = await readTextWindow(file, bytes.length, args);
      const { sha256, ...hashed } = await readTextWindow(file, bytes.length, { ...args, includeSha256: true });
      assert.deepEqual(hashed, ordinary); assert.equal(sha256, rawHash(bytes));
      assert.equal(hashed.returnedBytes, Buffer.byteLength(hashed.text));
      assert.ok(hashed.returnedBytes <= maxReturnedBytes); assert.ok(!hashed.text.includes("\ufffd"));
      if (hashed.partialLine) {
        assert.equal(hashed.completedLines, 0); assert.equal(hashed.nextStartLine, 1);
        assert.equal(hashed.eof, false); assert.equal(hashed.continuationRequiresMoreBytes, true);
      }
    }
  }
  await fs.writeFile(file, "alpha\r\n中文😀\r\n\r\nfour\r\n五\r\nlast\r\n");
  const collected: string[] = []; let next: number | null = 1;
  for (let i = 0; next !== null; i++) {
    assert.ok(i < 10);
    const result: TextWindowResult = await readTextWindow(file, (await fs.stat(file)).size,
      { startLine: next, maxLines: 3, maxSourceBytes: f.config.maxFileBytes, maxReturnedBytes: 18, includeSha256: true });
    assert.equal(result.partialLine, false); collected.push(...result.text.split("\n")); next = result.nextStartLine;
  }
  assert.deepEqual(collected, ["alpha", "中文😀", "", "four", "五", "last"]);
});

test("SHA snapshot handles dense lines and the configured source limit without relaxing either cap", async t => {
  const f = await fixture(t), file = path.join(f.root, "limit.txt");
  for (const text of ["x\n".repeat(40_000), "x".repeat(f.config.maxFileBytes - 1) + "\n"]) {
    const bytes = Buffer.from(text); await fs.writeFile(file, bytes);
    const args = { path: "limit.txt", maxLines: 600 };
    const ordinary = await readWorkspaceFile(f.config, args) as TextWindowResult;
    const { sha256, ...hashed } = await readWorkspaceFile(f.config, { ...args, includeSha256: true }) as TextWindowResult;
    assert.deepEqual(hashed, ordinary); assert.equal(sha256, rawHash(bytes));
    assert.ok(hashed.returnedBytes <= f.config.maxReturnedBytes);
  }
  await fs.appendFile(file, "x");
  for (const includeSha256 of [false, true]) await assert.rejects(readWorkspaceFile(f.config, { path: "limit.txt", includeSha256 }));
});

test("SHA text and hash stay on the same snapshot when the path changes after its handle closes", async t => {
  const f = await fixture(t), file = path.join(f.root, "same-snapshot.txt");
  const original = Buffer.from("\ufeff原始😀\r\nsecond\r\n"); await fs.writeFile(file, original);
  const nativeOpen = fs.open; let opens = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof nativeOpen>) => {
    const handle = await nativeOpen(...args);
    if (args[0] === file) {
      opens++; const close = handle.close.bind(handle);
      t.mock.method(handle, "close", async () => { await close(); await fs.writeFile(file, "different later bytes"); });
    }
    return handle;
  });
  t.mock.method(nativeFs, "createReadStream", () => { assert.fail("snapshot text must not reopen the path"); });
  const result = await readWorkspaceFile(f.config, { path: "same-snapshot.txt", includeSha256: true }) as TextWindowResult;
  assert.equal(opens, 1); assert.equal(result.sha256, rawHash(original));
  assert.equal(result.text, "\ufeff原始😀\nsecond"); assert.equal(result.bytes, original.length);
  assert.equal(await fs.readFile(file, "utf8"), "different later bytes");
});

test("SHA reader retains path deny and valid UTF-8/NUL gates", async t => {
  const f = await fixture(t);
  for (const [name, bytes] of [[".env", Buffer.from("synthetic denied")], ["nul.txt", Buffer.from([65, 0, 66])],
    ["invalid.txt", Buffer.from([0xc3, 0x28])]] as const) {
    await fs.writeFile(path.join(f.root, name), bytes);
    await assert.rejects(readWorkspaceFile(f.config, { path: name, includeSha256: true }));
  }
  await assert.rejects(readWorkspaceFile(f.config, { path: "../outside.txt", includeSha256: true }));
});

test("real local HTTP MCP read_file with SHA returns both pages and rejects over-limit caller input", async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, "rows.txt"), largeText);
  const handle = await startWorkspaceHttpServer(f.config, { host: "127.0.0.1", port: 0, bearerToken: "isolated-sha-test" });
  const client = new Client({ name: "sha-reader-test", version: "1" });
  t.after(async () => { await client.close(); await handle.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(handle.url), { requestInit: { headers: { Authorization: "Bearer isolated-sha-test" } } }));
  for (const startLine of [1, 601]) {
    const result = await client.callTool({ name: "read_file", arguments: { path: "rows.txt", includeSha256: true, maxLines: 600, startLine } });
    assert.notEqual(result.isError, true);
    const content = result.content as Array<{ type: string; text: string }>;
    const body = result.structuredContent as Record<string, unknown>;
    assert.deepEqual(JSON.parse(content[0].text), body);
    assert.equal(body.sha256, rawHash(Buffer.from(largeText)));
    assert.equal(body.returnedLines, 600);
    assert.equal(body.nextStartLine, startLine === 1 ? 601 : null);
  }
  const invalid = await client.callTool({ name: "read_file", arguments: { path: "rows.txt", includeSha256: true, maxLines: 601 } });
  assert.equal(invalid.isError, true);
});
