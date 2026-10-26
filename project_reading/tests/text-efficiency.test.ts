import assert from "node:assert/strict";
import fs from "node:fs/promises";
import nativeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { createWorkspaceMcpServer } from "../src/server.js";
import { readWorkspaceFile, readWorkspaceFiles, searchText } from "../src/workspace.js";
import type { TextWindowResult } from "../src/text-reader.js";

interface FileResult extends TextWindowResult {
  path: string;
  appliedLimits: { maxLines: number; maxReturnedBytes: number };
}
interface BatchResult {
  totalReturnedLines: number;
  totalReturnedBytes: number;
  truncated: boolean;
  files: FileResult[];
}
interface SearchResult {
  engine: string;
  count: number;
  truncated: boolean;
  limitReason?: string;
  results: Array<{ path: string; line: number; matchText: string; contextId?: number | null; text?: string }>;
  contexts?: Array<{ id: number; path: string; startLine: number; endLine: number; text: string; truncated: boolean }>;
}

async function fixture(t: TestContext, env: NodeJS.ProcessEnv = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "text-efficiency-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = await loadConfig({ WORKSPACE_MCP_ROOTS: `fixture=${root}`, ...env });
  return { root, config, write: (name: string, text: string | Buffer) => fs.writeFile(path.join(root, name), text) };
}

test("four omitted maxLines succeed under the original 300/1000 limits; explicit overflow still fails", async (t) => {
  const f = await fixture(t, { WORKSPACE_MCP_MAX_READ_LINES: "300", WORKSPACE_MCP_MAX_BATCH_TOTAL_LINES: "1000" });
  const files = Array.from({ length: 4 }, (_, i) => ({ path: `${i}.txt` }));
  for (const file of files) await f.write(file.path, "first\nsecond");
  const result = await readWorkspaceFiles(f.config, { files }) as BatchResult;
  assert.deepEqual(result.files.map((file) => file.text), files.map(() => "first\nsecond"));
  assert.deepEqual(result.files.map((file) => file.appliedLimits.maxLines), [250, 250, 250, 250]);
  await assert.rejects(() => readWorkspaceFiles(f.config, {
    files: files.map((file) => ({ ...file, maxLines: 300 })),
  }), /Requested line budget 1200 exceeds 1000/);
});

test("default limits allow 600 single lines and 12 files within 2400 lines and 512 KiB", async (t) => {
  const f = await fixture(t);
  assert.deepEqual([f.config.maxReadLines, f.config.maxBatchFiles, f.config.maxBatchTotalLines,
    f.config.maxReturnedBytes, f.config.maxBatchTotalBytes, f.config.maxSearchResults, f.config.maxSearchReturnedBytes],
  [600, 12, 2400, 262144, 524288, 120, 524288]);
  const lines = Array.from({ length: 605 }, (_, i) => `${i + 1}:${"文".repeat(80)}`);
  const files = Array.from({ length: 12 }, (_, i) => ({ path: `${i}.txt` }));
  for (const file of files) await f.write(file.path, lines.join("\n"));
  const single = await readWorkspaceFile(f.config, files[0]) as FileResult;
  assert.equal(single.returnedLines, 600);
  assert.equal(single.nextStartLine, 601);
  assert.deepEqual(single.truncationReasons, ["max_lines"]);
  const batch = await readWorkspaceFiles(f.config, { files }) as BatchResult;
  assert.ok(batch.totalReturnedLines <= 2400);
  assert.ok(batch.totalReturnedBytes <= 524288);
  assert.equal(batch.totalReturnedBytes, batch.files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0));
  assert.ok(batch.files.every((file) => file.returnedLines > 0 && file.returnedBytes <= 262144));
  assert.ok(Math.max(...batch.files.map((file) => file.returnedBytes)) - Math.min(...batch.files.map((file) => file.returnedBytes)) < 250);
  for (const file of files) await f.write(file.path, Array.from({ length: 605 }, (_, i) => `${i + 1}`).join("\n"));
  const lineBatch = await readWorkspaceFiles(f.config, { files }) as BatchResult;
  assert.equal(lineBatch.totalReturnedLines, 2400);
  assert.ok(lineBatch.files.every((file) => file.nextStartLine === 201 && file.truncationReasons.includes("batch_total_lines")));
  await assert.rejects(() => readWorkspaceFiles(f.config, { files: [...files, files[0]] }), /1-12 files/);
  await assert.rejects(() => readWorkspaceFiles(f.config, { files: files.slice(0, 5).map((file) => ({ ...file, maxLines: 600 })) }), /line budget/);
});

test("mixed explicit/default budgets and exhausted implicit shares never exceed the aggregate", async (t) => {
  const f = await fixture(t, { WORKSPACE_MCP_MAX_READ_LINES: "6", WORKSPACE_MCP_MAX_BATCH_TOTAL_LINES: "8" });
  await f.write("rows.txt", "1\n2\n3\n4\n5\n6\n7");
  const files = [{ path: "rows.txt", maxLines: 6 }, { path: "rows.txt" }, { path: "rows.txt" }];
  const result = await readWorkspaceFiles(f.config, { files }) as BatchResult;
  assert.deepEqual(result.files.map((file) => file.returnedLines), [6, 1, 1]);
  f.config.maxBatchTotalLines = 6;
  const exhausted = await readWorkspaceFiles(f.config, { files }) as BatchResult;
  assert.equal(exhausted.totalReturnedLines, 6);
  assert.ok(exhausted.files.slice(1).every((file) => file.nextStartLine === 1 && !file.eof && file.truncated && file.returnedBytes === 0));
  for (const maxLines of [0, -1, 7, NaN, Infinity, 1.5]) {
    await assert.rejects(() => readWorkspaceFiles(f.config, { files: [{ path: "rows.txt", maxLines }] }), /maxLines/);
  }
});

test("byte allocation reserves later files and releases unused earlier shares", async (t) => {
  const f = await fixture(t, { WORKSPACE_MCP_MAX_RETURNED_BYTES: "100", WORKSPACE_MCP_MAX_BATCH_TOTAL_BYTES: "100" });
  await f.write("big.txt", "x".repeat(100));
  await f.write("small.txt", "1234");
  const fair = await readWorkspaceFiles(f.config, { files: [{ path: "big.txt" }, { path: "big.txt" }] }) as BatchResult;
  assert.deepEqual(fair.files.map((file) => file.returnedBytes), [50, 50]);
  assert.ok(fair.files.every((file) => file.nextStartLine === 1 && file.partialLine && file.truncationReasons.includes("batch_total_bytes")));
  for (const files of [[{ path: "big.txt" }, { path: "small.txt" }], [{ path: "small.txt" }, { path: "big.txt" }]]) {
    const result = await readWorkspaceFiles(f.config, { files }) as BatchResult;
    assert.equal(result.files.find((file) => file.path === "big.txt")?.returnedBytes, 96);
    assert.equal(result.totalReturnedBytes, 100);
  }
  await f.write("early.txt", "tiny\n" + "x".repeat(100));
  const released = await readWorkspaceFiles(f.config, { files: [{ path: "early.txt", maxLines: 1 }, { path: "big.txt" }] }) as BatchResult;
  assert.deepEqual(released.files.map((file) => file.returnedBytes), [4, 96]);
});

test("single and batch pagination reproduce every complete UTF-8 line exactly once", async (t) => {
  const f = await fixture(t, { WORKSPACE_MCP_MAX_RETURNED_BYTES: "18", WORKSPACE_MCP_MAX_BATCH_TOTAL_BYTES: "36" });
  const lines = ["alpha", "中文😀", "", "four", "五", "last"];
  await f.write("rows.txt", lines.join("\r\n") + "\r\n");
  for (const batch of [false, true]) {
    const collected: string[] = [];
    let next: number | null = 1;
    for (let iteration = 0; next !== null; iteration++) {
      assert.ok(iteration < 10);
      const args = { path: "rows.txt", startLine: next, maxLines: 3 };
      const result: FileResult = batch
        ? (await readWorkspaceFiles(f.config, { files: [args, args] }) as BatchResult).files[0]
        : await readWorkspaceFile(f.config, args) as FileResult;
      assert.equal(result.partialLine, false);
      assert.equal(result.completedLines, result.returnedLines);
      assert.ok(!result.text.includes("\ufffd"));
      collected.push(...result.text.split("\n"));
      assert.ok(result.nextStartLine === null || result.nextStartLine > next);
      next = result.nextStartLine;
    }
    assert.deepEqual(collected, lines);
  }
});

test("partial first line cannot claim EOF or skip bytes, including a non-fitting code point", async (t) => {
  const f = await fixture(t, { WORKSPACE_MCP_MAX_RETURNED_BYTES: "3" });
  const source = "😀中文";
  await f.write("long.txt", source);
  for (const includeSha256 of [false, true]) {
    const result = await readWorkspaceFile(f.config, { path: "long.txt", includeSha256 }) as FileResult;
    assert.equal(result.text, "");
    assert.equal(result.partialLine, true);
    assert.equal(result.completedLines, 0);
    assert.equal(result.nextStartLine, 1);
    assert.equal(result.eof, false);
    assert.equal(result.continuationRequiresMoreBytes, true);
    assert.equal(result.requiredBytesForNextLine, Buffer.byteLength(source));
    assert.deepEqual(result.truncationReasons, ["max_returned_bytes", "partial_line"]);
    if (includeSha256) assert.equal(result.sha256, createHash("sha256").update(source).digest("hex"));
  }
  f.config.maxReturnedBytes = 10;
  const full = await readWorkspaceFile(f.config, { path: "long.txt", startLine: 1 }) as FileResult;
  assert.equal(full.text, source);
  assert.equal(full.eof, true);
  assert.equal(full.nextStartLine, null);
  assert.equal(full.truncated, false);
});

test("empty files, exact byte limits, empty lines and beyond EOF have truthful continuation", async (t) => {
  const f = await fixture(t, { WORKSPACE_MCP_MAX_RETURNED_BYTES: "3", WORKSPACE_MCP_MAX_BATCH_TOTAL_BYTES: "3" });
  await f.write("empty.txt", "");
  await f.write("exact.txt", "abc");
  await f.write("blank.txt", "\n");
  for (const args of [{ path: "empty.txt" }, { path: "exact.txt" }, { path: "blank.txt" }, { path: "exact.txt", startLine: 5 }]) {
    const result = await readWorkspaceFile(f.config, args) as FileResult;
    assert.equal(result.eof, true);
    assert.equal(result.nextStartLine, null);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.truncationReasons, []);
  }
  const exact = await readWorkspaceFiles(f.config, { files: [{ path: "exact.txt" }] }) as BatchResult;
  assert.equal(exact.totalReturnedBytes, 3);
  assert.equal(exact.truncated, false);
  f.config.maxBatchTotalBytes = 1;
  const zeroShares = await readWorkspaceFiles(f.config, { files: [{ path: "exact.txt" }, { path: "exact.txt" }] }) as BatchResult;
  assert.equal(zeroShares.totalReturnedBytes, 1);
  assert.equal(zeroShares.files[0].nextStartLine, 1);
  assert.equal(zeroShares.files[0].returnedLines, 0);
});

test("the default single-file byte cap preserves UTF-8 and signals an oversized first line", async (t) => {
  const f = await fixture(t);
  const source = "😀".repeat(70_000);
  await f.write("wide.txt", source);
  const partial = await readWorkspaceFile(f.config, { path: "wide.txt" }) as FileResult;
  assert.equal(partial.returnedBytes, 262144);
  assert.equal(Buffer.byteLength(partial.text), 262144);
  assert.ok(source.startsWith(partial.text));
  assert.equal(partial.nextStartLine, 1);
  assert.equal(partial.requiredBytesForNextLine, 280000);
  assert.equal(partial.continuationRequiresMoreBytes, true);
  assert.equal(partial.eof, false);
});

test("read_files preserves all-or-nothing path and text-source preflight before streaming", async (t) => {
  const f = await fixture(t);
  await f.write("ok.txt", "allowed");
  await f.write(".env", "synthetic-denied");
  await f.write("binary.txt", Buffer.from([0, 1, 2]));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "text-efficiency-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, "outside.txt"), "outside");
  await fs.symlink(outside, path.join(f.root, "escape"), process.platform === "win32" ? "junction" : "dir");
  let streams = 0;
  const native = nativeFs.createReadStream;
  t.mock.method(nativeFs, "createReadStream", (...args: Parameters<typeof native>) => { streams++; return native(...args); });
  for (const bad of [".env", "missing.txt", "../outside.txt", "escape/outside.txt", "binary.txt", path.join(f.root, "ok.txt")]) {
    await assert.rejects(() => readWorkspaceFiles(f.config, { files: [{ path: "ok.txt" }, { path: bad }] }));
    assert.equal(streams, 0, bad);
  }
});

test("merged context reduces 35 overlapping hits from 245 rows to 65 without losing identities", async (t) => {
  const f = await fixture(t);
  const hitLines = new Set([...Array.from({ length: 30 }, (_, i) => 4 + i * 2), 5, 7, 9, 11, 13]);
  const lines = Array.from({ length: 65 }, (_, i) => `${i + 1}: ${hitLines.has(i + 1) ? "parsePositiveInt" : "context"}  `);
  await f.write("sample.ts", lines.join("\n"));
  await f.write(".env", "parsePositiveInt(secret)");
  const args = { query: "parsePositiveInt", beforeLines: 3, afterLines: 3 };
  const run = async () => {
    const legacy = await searchText(f.config, args) as SearchResult;
    const explicit = await searchText(f.config, { ...args, contextMode: "per_match" }) as SearchResult;
    assert.deepEqual(legacy.results, explicit.results);
    assert.equal(legacy.contexts, undefined);
    assert.equal(legacy.count, 35);
    assert.equal(legacy.results.reduce((sum, match) => sum + match.text!.split("\n").length, 0), 245);
    const merged = await searchText(f.config, { ...args, contextMode: "merged" }) as SearchResult;
    assert.equal(merged.count, 35);
    assert.equal(merged.contexts?.length, 1);
    assert.equal(merged.contexts[0].text, lines.join("\n"));
    assert.deepEqual([merged.contexts[0].startLine, merged.contexts[0].endLine], [1, 65]);
    assert.equal(merged.truncated, false);
    assert.deepEqual(merged.results.map(({ path, line, matchText }) => ({ path, line, matchText })),
      legacy.results.map(({ path, line, matchText }) => ({ path, line, matchText })));
    assert.ok(merged.results.every((hit) => hit.contextId === merged.contexts![0].id && hit.path === "sample.ts"));
    return merged;
  };
  assert.equal(f.config.searchRuntime.active, "ripgrep", "test requires the existing bundled/PATH ripgrep");
  const rg = await run();
  assert.equal(rg.engine, "ripgrep");
  f.config.searchRuntime = { preferred: "ripgrep", active: "javascript", command: null, version: null, source: "fallback" };
  const js = await run();
  assert.equal(js.engine, "javascript");
  assert.deepEqual(js.results, rg.results);
  assert.deepEqual(js.contexts, rg.contexts);
});

test("merged contexts join adjacent windows, keep gaps/files separate and clip EOF", async (t) => {
  const f = await fixture(t);
  await f.write("a.txt", "before\nhit\nnext\nbefore\nhit\nafter\ngap\ngap\nhit");
  await f.write("b.txt", "hit");
  const result = await searchText(f.config, { query: "hit", beforeLines: 1, afterLines: 1, contextMode: "merged" }) as SearchResult;
  assert.equal(result.count, 4);
  assert.equal(result.contexts?.length, 3);
  assert.deepEqual(result.contexts.filter((context) => context.path === "a.txt").map((context) => [context.startLine, context.endLine]), [[1, 6], [8, 9]]);
  for (const hit of result.results) {
    const context: NonNullable<SearchResult["contexts"]>[number] = result.contexts.find((item) => item.id === hit.contextId)!;
    assert.equal(context.path, hit.path);
    assert.ok(context.startLine <= hit.line && hit.line <= context.endLine);
  }
});

test("merged output bounds escaped UTF-8 JSON and preserves hits when context runs out", async (t) => {
  const f = await fixture(t, { WORKSPACE_MCP_MAX_SEARCH_RETURNED_BYTES: "900" });
  await f.write("quoted.txt", `${'"\\\t😀'.repeat(300)}\nhit one\nhit two\n${'"'.repeat(600)}`);
  const result = await searchText(f.config, { query: "hit", beforeLines: 1, afterLines: 1, contextMode: "merged" }) as SearchResult;
  assert.equal(result.count, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.limitReason, "output");
  assert.ok(Buffer.byteLength(JSON.stringify({ results: result.results, contexts: result.contexts })) <= 900);
  assert.ok(!JSON.stringify(result).includes("\ufffd"));
  assert.deepEqual(result.results.map((hit) => hit.line), [2, 3]);
  f.config.maxSearchReturnedBytes = 170;
  const tight = await searchText(f.config, { query: "hit", beforeLines: 1, contextMode: "merged" }) as SearchResult;
  assert.equal(tight.count, 2);
  assert.ok(tight.results.every((hit) => hit.contextId === null));
  assert.deepEqual(tight.contexts, []);
  f.config.maxSearchReturnedBytes = 80;
  const capped = await searchText(f.config, { query: "hit", contextMode: "merged" }) as SearchResult;
  assert.equal(capped.truncated, true);
  assert.ok(capped.count < 2);
});

test("search modes retain deny/containment and backend match limits", async (t) => {
  const f = await fixture(t);
  await f.write("allowed.txt", Array.from({ length: 121 }, () => "needle").join("\n"));
  await f.write(".env", "needle denied");
  await fs.mkdir(path.join(f.root, "blocked"));
  await fs.writeFile(path.join(f.root, "blocked", "secret.txt"), "needle private");
  f.config.roots.get(f.config.defaultRootId)!.denyDirs.add("blocked");
  await fs.symlink(path.join(f.root, "blocked"), path.join(f.root, "alias"), process.platform === "win32" ? "junction" : "dir");
  for (const backend of ["ripgrep", "javascript"] as const) {
    f.config.searchRuntime.active = backend;
    for (const contextMode of ["per_match", "merged"] as const) {
      const result = await searchText(f.config, { query: "needle", contextMode }) as SearchResult;
      assert.equal(result.engine, backend);
      assert.equal(result.count, 120);
      assert.equal(result.truncated, true);
      assert.equal(result.limitReason, "results");
      assert.ok(result.results.every((match) => match.path === "allowed.txt"));
      await assert.rejects(() => searchText(f.config, { path: "alias", query: "needle", contextMode }), /denied directory/);
      await assert.rejects(() => searchText(f.config, { path: "..", query: "needle", contextMode }), /outside/);
    }
  }
});

test("MCP schemas derive caps from config and preserve duplicated text/structured results", async (t) => {
  const f = await fixture(t, { WORKSPACE_MCP_MAX_READ_LINES: "7", WORKSPACE_MCP_MAX_BATCH_FILES: "4",
    WORKSPACE_MCP_MAX_BATCH_TOTAL_LINES: "10", WORKSPACE_MCP_MAX_BATCH_TOTAL_BYTES: "1234", WORKSPACE_MCP_MAX_SEARCH_RESULTS: "9" });
  await f.write("small.txt", "needle\nsecond");
  const server = createWorkspaceMcpServer(f.config);
  const client = new Client({ name: "text-efficiency", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(st);
  await client.connect(ct);
  const { tools } = await client.listTools();
  const read = tools.find((tool) => tool.name === "read_file")!;
  const batch = tools.find((tool) => tool.name === "read_files")!;
  const search = tools.find((tool) => tool.name === "search_text")!;
  assert.equal((read.inputSchema.properties!.maxLines as { maximum: number }).maximum, 7);
  assert.equal((batch.inputSchema.properties!.files as { maxItems: number }).maxItems, 4);
  assert.equal((search.inputSchema.properties!.maxResults as { maximum: number }).maximum, 9);
  assert.match(batch.description!, /4 text files, 10 total lines and 1234 total text bytes/);
  assert.deepEqual((search.inputSchema.properties!.contextMode as { enum: string[] }).enum, ["per_match", "merged"]);
  for (const [name, args] of [
    ["read_file", { path: "small.txt" }],
    ["read_files", { files: Array.from({ length: 4 }, () => ({ path: "small.txt" })) }],
    ["search_text", { query: "needle" }],
    ["search_text", { query: "needle", contextMode: "merged" }],
  ] as const) {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true);
    const content = result.content as Array<{ type: string; text: string }>;
    assert.equal(content[0].type, "text");
    assert.deepEqual(JSON.parse(content[0].text), JSON.parse(JSON.stringify(result.structuredContent)));
  }
  assert.equal((await client.callTool({ name: "search_text", arguments: { query: "needle", contextMode: "unknown" } })).isError, true);
  assert.equal((await client.callTool({ name: "read_file", arguments: { path: "small.txt", maxLines: 8 } })).isError, true);
  assert.equal((await client.callTool({ name: "read_files", arguments: { files: [{ path: "small.txt", maxLines: 7 }, { path: "small.txt", maxLines: 7 }] } })).isError, true);
});
