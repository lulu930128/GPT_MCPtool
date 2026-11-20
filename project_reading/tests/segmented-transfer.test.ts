import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import JSZip from "jszip";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { digest } from "../src/archives.js";
import { SegmentedTransferStore, type TransferOptions } from "../src/segmented-transfer.js";
import { registerSegmentedTransferTools } from "../src/segmented-transfer-server.js";
import { addBytes, identity, StreamingZip64, TRANSFER_LIMITS, writeAll, zip64End } from "../src/transfer-streams.js";

const MiB = 1024 * 1024;
async function fixture(t: TestContext, options: TransferOptions = {}) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "workspace-segments-"));
  const source = path.join(root, "source"), staging = path.join(root, "staging");
  await fs.mkdir(source);
  const config = await loadConfig({ WORKSPACE_MCP_ROOTS: `projects=${root}`, WORKSPACE_MCP_ASSET_SCOPES: "projects=projects:.",
    WORKSPACE_MCP_FILE_RETURN_SCOPES: "projects", WORKSPACE_MCP_ROOT_DENY_DIRS: "projects=private" });
  let store = new SegmentedTransferStore({ directory: staging, ...options });
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  const start = (kind: "folder" | "file" | "zip" = "folder", file = "source", chunkBytes = MiB) => store.start(config, { scope: "projects", path: file, kind, chunkBytes });
  const ready = async (id: string) => { await store.waitForIdle(); const result = await store.status(config, id); assert.equal(result.state, "ready", result.error ?? ""); return result; };
  const restart = async () => { await store.close(); store = new SegmentedTransferStore({ directory: staging, ...options }); await store.initialize(); return store; };
  return { root, source, staging, config, get store() { return store; }, start, ready, restart };
}
async function patternedFile(filename: string, size: number, random = false) {
  const handle = await fs.open(filename, "wx"); const hash = createHash("sha256");
  try {
    for (let at = 0; at < size;) {
      const bytes = random ? randomBytes(Math.min(MiB, size - at)) : Buffer.alloc(Math.min(MiB, size - at), 65);
      await handle.writeFile(bytes); hash.update(bytes); at += bytes.length;
    }
  } finally { await handle.close(); }
  return hash.digest("hex");
}

test("segmented ZIP64 >48 MiB input and >12 MiB output, single large file, exact parts, Python independent CRC/bytes and source unchanged", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.source, "nested")); await fs.mkdir(path.join(f.source, "empty"));
  const expected = {
    "nested/large.wav": await patternedFile(path.join(f.source, "nested/large.wav"), 51 * MiB),
    "random.wav": await patternedFile(path.join(f.source, "random.wav"), 13 * MiB + 11, true),
  };
  const before = await fs.stat(path.join(f.source, "nested/large.wav"));
  const job = await f.start("folder", "source", 8 * MiB); assert.equal(job.state, "running");
  const ready = await f.ready(job.taskId);
  assert.equal(ready.sourceBytes, 64 * MiB + 11); assert.ok(ready.archiveBytes > 12 * MiB);
  assert.ok(ready.archiveBytes < ready.sourceBytes / 2); assert.equal(ready.chunkCount, 2); assert.equal(ready.complete, true);
  const downloads = path.join(f.root, "downloads"); await fs.mkdir(downloads);
  const manifestDir = path.join(f.root, "manifests"); await fs.mkdir(manifestDir);
  const pages: string[] = [];
  for (let index = 0; index < ready.chunkCount; index++) {
    const page = await f.store.page(f.config, job.taskId, "parts", index, 1);
    assert.equal(page.nextOffset, index + 1 === ready.chunkCount ? null : index + 1);
    const part = page.records[0]; const bytes = await f.store.read(f.config, part.resourceUri as string);
    assert.equal(digest(bytes), part.sha256); assert.equal(bytes.length, part.length); assert.ok(bytes.length <= 8 * MiB);
    await fs.writeFile(path.join(downloads, part.filename as string), bytes);
    const pageFile = path.join(manifestDir, `page-${index}.json`); await fs.writeFile(pageFile, JSON.stringify(page)); pages.push(pageFile);
  }
  const output = path.join(f.root, "restored.zip");
  const execution = promisify(execFile);
  const reconstructed = await execution("python", ["scripts/reassemble-transfer.py", "--parts", downloads, "--output", output, "--manifest-dir", manifestDir]);
  assert.equal(JSON.parse(reconstructed.stdout).sha256, ready.archiveSha256);
  const verified = await execution("python", ["-c", "import zipfile,hashlib,json,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; result={};\nfor i in z.infolist():\n if not i.is_dir():\n  h=hashlib.sha256()\n  with z.open(i) as f:\n   while b:=f.read(1048576): h.update(b)\n  result[i.filename]=h.hexdigest()\nprint(json.dumps(result))", output]);
  assert.deepEqual(JSON.parse(verified.stdout), expected);
  const scriptArgs = ["scripts/reassemble-transfer.py", "--parts", downloads, "--output", path.join(f.root, "copy.zip")];
  await execution("python", [...scriptArgs, ...pages]); // Explicit-file mode remains compatible.
  await fs.copyFile(pages[0], path.join(manifestDir, "duplicate.json"));
  await assert.rejects(execution("python", [...scriptArgs.slice(0, -1), path.join(f.root, "bad.zip"), "--manifest-dir", manifestDir]), /duplicate/);
  await fs.unlink(path.join(manifestDir, "duplicate.json"));
  const saved = await fs.readFile(pages[1]); await fs.unlink(pages[1]);
  await assert.rejects(execution("python", [...scriptArgs.slice(0, -1), path.join(f.root, "bad.zip"), "--manifest-dir", manifestDir]), /Missing/);
  const mixed = JSON.parse(saved.toString()); mixed.taskId = "another-task"; await fs.writeFile(pages[1], JSON.stringify(mixed));
  await assert.rejects(execution("python", [...scriptArgs.slice(0, -1), path.join(f.root, "bad.zip"), "--manifest-dir", manifestDir]), /Mixed/);
  await fs.writeFile(pages[1], saved);
  const tailHandle = await fs.open(output, "r");
  const tail = Buffer.alloc(98); await tailHandle.read(tail, 0, 98, ready.archiveBytes - 98); await tailHandle.close();
  assert.equal(tail.readUInt32LE(0), 0x06064b50); assert.equal(tail.readUInt32LE(56), 0x07064b50);
  const after = await fs.stat(path.join(f.source, "nested/large.wav"));
  assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.ino, before.ino); assert.equal(after.size, before.size);
  // Existing ZIP transfers original ZIP64 bytes and verifies every entry CRC by streaming.
  const existing = await f.start("zip", "restored.zip", 12 * MiB); const restored = await f.ready(existing.taskId);
  assert.equal(restored.archiveSha256, ready.archiveSha256); assert.equal(restored.expandedBytes, ready.sourceBytes);
});

test("segmented raw file byte exact, retries/concurrent reads, persistent budget, completion and cleanup", async (t) => {
  const f = await fixture(t); const original = randomBytes(2 * MiB + 3);
  await fs.writeFile(path.join(f.source, "audio.wav"), original);
  const job = await f.start("file", "source/audio.wav"); await f.ready(job.taskId);
  const page = await f.store.page(f.config, job.taskId, "parts", 0, 100);
  const chunks: Buffer[] = [];
  for (const part of page.records) chunks.push(await f.store.read(f.config, part.resourceUri as string));
  assert.deepEqual(Buffer.concat(chunks), original);
  const uri = page.records[0].resourceUri as string;
  const reads = await Promise.all([f.store.read(f.config, uri), f.store.read(f.config, uri)]);
  assert.deepEqual(reads[0], reads[1]);
  await f.restart(); assert.deepEqual(await f.store.read(f.config, uri), chunks[0]);
  const state = await f.store.status(f.config, job.taskId); assert.equal(state.transmittedBytes, original.length + 3 * MiB);
  await assert.rejects(f.store.finish(f.config, job.taskId, "complete", "0".repeat(64)), /verified archive/);
  await f.store.finish(f.config, job.taskId, "complete", digest(original)); await f.store.waitForIdle();
  assert.equal((await f.store.status(f.config, job.taskId)).cleaned, true);
  await assert.rejects(f.store.read(f.config, uri), /not ready/);
  assert.deepEqual(await fs.readFile(path.join(f.source, "audio.wav")), original);
  assert.deepEqual((await fs.readdir(f.staging)).filter((name) => name.includes(".part-")), []);
  await f.store.sweep(); await assert.rejects(f.store.status(f.config, job.taskId), /Unknown transfer/);
});

test("100 GB decimal counters and restart-persisted re-download budget enforce exact boundary without huge allocations", async (t) => {
  assert.equal(addBytes(99_999_999_999, 1), 100_000_000_000);
  assert.throws(() => addBytes(100_000_000_000, 1), /budget/);
  for (const args of [[-1, 1], [0, NaN], [0, Infinity], [0, 1.5], [Number.MAX_SAFE_INTEGER, 1]]) assert.throws(() => addBytes(args[0], args[1]));
  const end = zip64End(70_000, 2 ** 32 + 10, 2 ** 33 + 20);
  assert.equal(end.readBigUInt64LE(32), 70000n); assert.equal(end.readBigUInt64LE(48), BigInt(2 ** 33 + 20));
  const f = await fixture(t); await fs.writeFile(path.join(f.source, "a.txt"), "ABC");
  const job = await f.start("file", "source/a.txt"); await f.ready(job.taskId);
  const uri = (await f.store.page(f.config, job.taskId, "parts")).records[0].resourceUri as string;
  await f.store.close();
  const statePath = path.join(f.staging, `${job.taskId}.state.json`);
  const data = JSON.parse(await fs.readFile(statePath, "utf8")); data.transmittedBytes = TRANSFER_LIMITS.bytes - 3;
  await fs.writeFile(statePath, JSON.stringify(data)); await f.restart();
  assert.equal((await f.store.read(f.config, uri)).toString(), "ABC");
  await f.restart(); await assert.rejects(f.store.read(f.config, uri), /budget/);
  assert.equal((await f.store.status(f.config, job.taskId)).transmittedBytes, TRANSFER_LIMITS.bytes);
});

test("policy exclusions declared, links skipped, direct denied sources and scope changes rejected", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, "ok.txt"), "allowed");
  for (const name of [".env", "data.db", "nested.zip"]) await fs.writeFile(path.join(f.source, name), "not read");
  for (const name of ["private", "node_modules", ".git"]) await fs.mkdir(path.join(f.source, name));
  await fs.link(path.join(f.source, "ok.txt"), path.join(f.source, "hard.txt"));
  const job = await f.start(); const state = await f.ready(job.taskId);
  assert.equal(state.complete, false); assert.equal(state.skippedEntries, 8);
  const page = await f.store.page(f.config, job.taskId, "entries", 0, 2); assert.equal(page.records.length, 2); assert.equal(page.nextOffset, 2);
  await assert.rejects(f.start("file", "source/.env"), /denied/); await assert.rejects(f.start("file", "source/ok.txt"), /hard-linked/);
  await assert.rejects(f.start("folder", "../outside"), /Unsafe/);
  const disabled = { ...f.config, fileReturnScopeIds: new Set<string>() };
  await assert.rejects(f.store.status(disabled, job.taskId), /scope/i);
  const changed = { ...f.config, denyExtensions: new Set([...f.config.denyExtensions, ".txt"]) };
  await assert.rejects(f.store.page(changed, job.taskId, "parts"), /policy changed/);
});

test("source mutation fails closed and removes incomplete chunks; cancellation and expiry cleanup", async (t) => {
  let now = Date.now(); const f = await fixture(t, { now: () => now });
  await patternedFile(path.join(f.source, "a.wav"), 13 * MiB, true);
  const originalOpen = fs.open;
  let mutated = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === path.join(f.source, "a.wav") && args[1] === "r" && !mutated) {
      const read = handle.read.bind(handle);
      handle.read = (async (...parameters: any[]) => {
        const result = await (read as any)(...parameters);
        if (!mutated) { mutated = true; await fs.appendFile(path.join(f.source, "a.wav"), "mutation"); }
        return result;
      }) as typeof handle.read;
    }
    return handle;
  });
  const job = await f.start(); await f.store.waitForIdle();
  const failed = await f.store.status(f.config, job.taskId); assert.equal(failed.state, "failed"); assert.match(failed.error!, /SOURCE_CHANGED/); assert.equal(failed.cleaned, true);
  t.mock.restoreAll(); await f.store.sweep();
  const canceled = await f.start(); await f.store.finish(f.config, canceled.taskId, "cancel"); await f.store.waitForIdle();
  assert.equal((await f.store.status(f.config, canceled.taskId)).cleaned, true); await f.store.sweep();
  await fs.writeFile(path.join(f.source, "tiny.txt"), "x");
  const expired = await f.start("file", "source/tiny.txt"); await f.ready(expired.taskId);
  now += TRANSFER_LIMITS.ttlMs + 1; await f.store.sweep(); await f.store.waitForIdle();
  assert.equal((await f.store.status(f.config, expired.taskId)).state, "expired");
  assert.deepEqual((await fs.readdir(f.staging)).filter((name) => name.includes(".part-")), []);
});

test("restart discards interrupted capture; orphan/foreign staging cleanup is constrained", async (t) => {
  const f = await fixture(t); await fs.writeFile(path.join(f.source, "a.txt"), "hello");
  const job = await f.start(); await f.ready(job.taskId); await f.store.close();
  const statePath = path.join(f.staging, `${job.taskId}.state.json`);
  const data = JSON.parse(await fs.readFile(statePath, "utf8")); data.state = "running"; data.archiveSha256 = null; await fs.writeFile(statePath, JSON.stringify(data));
  await fs.writeFile(path.join(f.staging, "foreign.txt"), "preserve");
  await f.restart(); await f.store.waitForIdle();
  const state = await f.store.status(f.config, job.taskId); assert.equal(state.state, "failed"); assert.match(state.error!, /INTERRUPTED/); assert.equal(state.cleaned, true);
  assert.equal(await fs.readFile(path.join(f.staging, "foreign.txt"), "utf8"), "preserve");
  const competing = new SegmentedTransferStore({ directory: f.staging });
  await assert.rejects(competing.initialize(), /live process/);
});

test("existing ZIP denies hidden payload, malformed CRC and traversal; binary originals unchanged", async (t) => {
  const f = await fixture(t);
  for (const [name, zip] of [
    ["denied.zip", new JSZip().file(".env", "secret fixture")],
    ["traversal.zip", new JSZip().file("../bad.txt", "x")],
  ] as const) {
    await fs.writeFile(path.join(f.root, name), await zip.generateAsync({ type: "nodebuffer" }));
    const job = await f.start("zip", name); await f.store.waitForIdle();
    assert.equal((await f.store.status(f.config, job.taskId)).state, "failed"); await f.store.sweep();
  }
  const corrupt = await new JSZip().file("a.txt", "ABC").generateAsync({ type: "nodebuffer" }); corrupt[35] ^= 1;
  await fs.writeFile(path.join(f.root, "corrupt.zip"), corrupt);
  const bad = await f.start("zip", "corrupt.zip"); await f.store.waitForIdle(); assert.equal((await f.store.status(f.config, bad.taskId)).state, "failed");
  assert.deepEqual(await fs.readFile(path.join(f.root, "corrupt.zip")), corrupt);
});

test("chunk range/page validation, empty original, corruption and fetch cap", async (t) => {
  const f = await fixture(t); await fs.writeFile(path.join(f.source, "empty.txt"), "");
  for (const size of [0, MiB - 1, 12 * MiB + 1]) await assert.rejects(f.start("file", "source/empty.txt", size), /chunkBytes/);
  const job = await f.start("file", "source/empty.txt"); const state = await f.ready(job.taskId);
  assert.equal(state.archiveSha256, digest(Buffer.alloc(0))); assert.equal(state.chunkCount, 1);
  const uri = (await f.store.page(f.config, job.taskId, "parts")).records[0].resourceUri as string;
  assert.equal((await f.store.read(f.config, uri)).length, 0);
  assert.equal((await f.store.page(f.config, job.taskId, "parts", 1)).records.length, 0);
  await assert.rejects(f.store.page(f.config, job.taskId, "parts", 2), /offset/);
  await assert.rejects(f.store.page(f.config, job.taskId, "parts", 0, 101), /page/);
  await fs.writeFile(path.join(f.staging, `${job.taskId}.part-000000`), "corrupt");
  await assert.rejects(f.store.read(f.config, uri), /size mismatch/);
});

test("MCP strict schemas, paged resource_links, retry after SDK failure and explicit cleanup", async (t) => {
  const f = await fixture(t); await fs.writeFile(path.join(f.source, "a.txt"), "hello");
  const server = new McpServer({ name: "transfer-test", version: "1" }); registerSegmentedTransferTools(server, f.config, f.store);
  const client = new Client({ name: "test", version: "1" }); const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); }); await server.connect(st); await client.connect(ct);
  for (const tool of (await client.listTools()).tools) { assert.ok(tool.outputSchema); assert.equal(tool.inputSchema.additionalProperties, false); }
  assert.equal((await client.callTool({ name: "start_segmented_transfer", arguments: { scope: "projects", path: "source", kind: "folder", outputPath: "outside" } })).isError, true);
  const started = await client.callTool({ name: "start_segmented_transfer", arguments: { scope: "projects", path: "source", kind: "folder" } });
  assert.notEqual(started.isError, true); const id = (started.structuredContent as Record<string, unknown>).taskId as string; await f.ready(id);
  const page = await client.callTool({ name: "list_segmented_transfer", arguments: { taskId: id } }); assert.notEqual(page.isError, true);
  const uri = (page.content as any[]).find((item) => item.type === "resource_link").uri;
  const send = st.send.bind(st); st.send = async (message, options) => { if ("result" in message && "contents" in message.result) throw new Error("SDK fixture failure"); return send(message, options); };
  await assert.rejects(client.readResource({ uri }, { timeout: 500 }), /timed out/); st.send = send;
  const response = await client.readResource({ uri }); assert.ok((response.contents[0] as any).blob);
  const status = await client.callTool({ name: "get_segmented_transfer", arguments: { taskId: id } });
  const metadata = status.structuredContent as Record<string, unknown>;
  assert.equal(metadata.transmittedBytes, Number(metadata.archiveBytes) * 2);
  const finished = await client.callTool({ name: "finish_segmented_transfer", arguments: { taskId: id, action: "complete", archiveSha256: metadata.archiveSha256 } });
  assert.notEqual(finished.isError, true); await f.store.waitForIdle();
});

test("more than four ready workspace captures recover with their original IDs and bytes",async t=>{
  const f=await fixture(t);
  const jobs=[];
  for(let i=0;i<6;i++) {
    const name="source/"+i+".txt", file=path.join(f.root,name);
    await fs.writeFile(file,String(i));
    jobs.push(await f.store.start(f.config,{scope:"projects",path:name,kind:"file"},identity(await fs.stat(file))));
  }
  await f.store.waitForIdle();
  await f.restart();
  for (const [index,job] of jobs.entries()) {
    const page=await f.store.page(f.config,job.taskId,"parts");
    assert.equal((await f.store.read(f.config,String(page.records[0].resourceUri))).toString(),String(index));
  }
});

test("legacy eight MiB parts retain their URI and reassemble through same-task tunnel ranges",async t=>{
  const f = await fixture(t);
  const expected = await patternedFile(path.join(f.source,"legacy.dat"),8*MiB);
  const started = await f.start("file","source/legacy.dat",8*MiB);
  await f.ready(started.taskId);
  await f.restart();
  const server = new McpServer({name:"range",version:"1"});
  registerSegmentedTransferTools(server,f.config,f.store);
  const client = new Client({name:"range-client",version:"1"});
  const [ct,st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async()=>{await client.close();await server.close();});
  const page = await client.callTool({name:"list_segmented_transfer",arguments:{taskId:started.taskId}});
  const links = (page.content as {type:string;uri:string}[]).filter(x=>x.type==="resource_link");
  assert.equal(links.length,2);
  const hash = createHash("sha256");
  for(const {uri} of links) {
    const part = await client.readResource({uri});
    assert.ok(Buffer.byteLength(JSON.stringify({jsonrpc:"2.0",id:10,result:part})) < 10*MiB);
    const content = part.contents[0];
    assert.ok("blob" in content);
    hash.update(Buffer.from(content.blob,"base64"));
  }
  assert.equal(hash.digest("hex"),expected);
  assert.equal((await f.store.status(f.config,started.taskId)).transmittedBytes,8*MiB);
});

test("one directory with 4097 audio files has no unrelated fanout cap", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 4097; index++) await fs.writeFile(path.join(f.source, `${index}.wav`), "");
  const job = await f.start(); const ready = await f.ready(job.taskId);
  assert.equal(ready.entryCount, 4097); assert.equal(ready.complete, true);
  const tail = await f.store.page(f.config, job.taskId, "entries", 4096, 100);
  assert.equal(tail.records.length, 1); assert.equal(tail.nextOffset, null);
});

test("ZIP64 count beyond 65535 is accepted by independent Python reader with bounded disk-spooled directory", async (t) => {
  const f = await fixture(t), output = path.join(f.root, "many.zip");
  const destination = await fs.open(output, "wx"), central = await fs.open(path.join(f.root, "central.tmp"), "wx+");
  const zip = new StreamingZip64(central, (bytes) => writeAll(destination, bytes));
  const signal = new AbortController().signal;
  try {
    for (let index = 0; index < 65536; index++) await zip.entry(`${index}/`, (async function* () {})(), signal, true);
    await zip.finish();
  } finally { await central.close(); await destination.close(); }
  const result = await promisify(execFile)("python", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert len(z.infolist())==65536; assert z.testzip() is None; print(len(z.infolist()))", output]);
  assert.equal(result.stdout.trim(), "65536");
  const job = await f.start("zip", "many.zip"); const ready = await f.ready(job.taskId);
  assert.equal(ready.complete, true); assert.equal(ready.expandedBytes, 0);
  assert.equal(ready.archiveBytes, (await fs.stat(output)).size);
  const externalHash = await promisify(execFile)("python", ["-c", "import hashlib,sys; h=hashlib.sha256();\nwith open(sys.argv[1],'rb') as f:\n while b:=f.read(1048576): h.update(b)\nprint(h.hexdigest())", output]);
  assert.equal(ready.archiveSha256, externalHash.stdout.trim());
});

test("configurable practical deadline fails separately from byte budget and cleans owned data", async (t) => {
  let clock = Date.now(); const f = await fixture(t, { now: () => clock++, workMs: 1 });
  await fs.writeFile(path.join(f.source, "a.txt"), "x");
  const job = await f.start(); await f.store.waitForIdle();
  const state = await f.store.status(f.config, job.taskId);
  assert.equal(state.state, "failed"); assert.match(state.error!, /TRANSFER_TIMEOUT/); assert.equal(state.cleaned, true);
});

test("corrupt recovery state never resets read budget or serves payload; expired orphan cleans only owned files", async (t) => {
  let clock = Date.now(); const f = await fixture(t, { now: () => clock, log: () => {} });
  await fs.writeFile(path.join(f.source, "a.txt"), "x"); const job = await f.start(); await f.ready(job.taskId);
  const uri = (await f.store.page(f.config, job.taskId, "parts")).records[0].resourceUri as string;
  await f.store.close(); await fs.writeFile(path.join(f.staging, `${job.taskId}.state.json`), "broken");
  await f.restart(); await assert.rejects(f.store.read(f.config, uri), /Unknown transfer/);
  clock += TRANSFER_LIMITS.ttlMs + 1; await f.store.sweep();
  assert.deepEqual((await fs.readdir(f.staging)).filter((name) => name.startsWith(job.taskId)), []);
});

test("transient owner-lock initialization rejection can recover on the same store without process restart", async (t) => {
  const f = await fixture(t); await f.store.initialize();
  const contender = new SegmentedTransferStore({ directory: f.staging });
  t.after(() => contender.close());
  await assert.rejects(contender.initialize(), /live process/);
  await assert.rejects(contender.initialize(), /live process/);
  await f.store.close();
  await contender.initialize();
  await fs.writeFile(path.join(f.source, "ok.txt"), "ready after owner leaves");
  const job = await contender.start(f.config, { scope: "projects", path: "source/ok.txt", kind: "file" });
  await contender.waitForIdle();
  assert.equal((await contender.status(f.config, job.taskId)).state, "ready");
  await contender.close();
});

test("durable read budget survives an older JSON snapshot and a torn unused ledger slot", async (t) => {
  const f = await fixture(t); await fs.writeFile(path.join(f.source, "a.txt"), "ABC");
  const job = await f.start("file", "source/a.txt"); await f.ready(job.taskId);
  const statePath = path.join(f.staging, `${job.taskId}.state.json`);
  const beforeRead = await fs.readFile(statePath);
  const uri = (await f.store.page(f.config, job.taskId, "parts")).records[0].resourceUri as string;
  await f.store.read(f.config, uri); await f.store.close();
  await fs.writeFile(statePath, beforeRead); // Simulate loss of the advisory rename, not the synced ledger.
  const ledger = await fs.open(path.join(f.staging, `${job.taskId}.budget`), "r+");
  await ledger.write(Buffer.alloc(7, 255), 0, 7, 0); await ledger.close();
  await f.restart();
  assert.equal((await f.store.status(f.config, job.taskId)).transmittedBytes, 3);
  await f.store.read(f.config, uri); assert.equal((await f.store.status(f.config, job.taskId)).transmittedBytes, 6);
});

test("cleanup rejects a replaced hardlinked part and retries without deleting external source", async (t) => {
  const f = await fixture(t, { log: () => {} }); await fs.writeFile(path.join(f.source, "a.txt"), "ABC");
  const job = await f.start("file", "source/a.txt"); await f.ready(job.taskId);
  const part = path.join(f.staging, `${job.taskId}.part-000000`);
  await fs.unlink(part); await fs.link(path.join(f.source, "a.txt"), part);
  await f.store.finish(f.config, job.taskId, "cleanup"); await f.store.waitForIdle();
  assert.equal((await f.store.status(f.config, job.taskId)).cleaned, false);
  assert.equal(await fs.readFile(path.join(f.source, "a.txt"), "utf8"), "ABC");
  await fs.unlink(part); await f.store.sweep(); await f.store.waitForIdle();
  assert.equal((await f.store.status(f.config, job.taskId)).cleaned, true);
});
