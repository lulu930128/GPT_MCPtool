import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import JSZip from "jszip";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { ARCHIVE_LIMITS, archiveCrc32, digest, inspectArchive, packageFolder, readArchiveEntry } from "../src/archives.js";
import { ArchiveTempStore, archiveOperation, fetchArchive, packageFolderResource, readArchiveResource } from "../src/archive-transfer.js";
import { fetchAsset } from "../src/file-transfer.js";
import { resolveWorkspacePath } from "../src/path-guard.js";
import { createWorkspaceMcpServer } from "../src/server.js";

async function fixture(t: TestContext, cap = 1024 * 1024, enabled = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-zip-test-"));
  const assets = path.join(root, "assets");
  await fs.mkdir(path.join(assets, "source"), { recursive: true });
  const config = await loadConfig({
    WORKSPACE_MCP_ROOTS: `projects=${root}`,
    WORKSPACE_MCP_ASSET_SCOPES: "media=projects:assets",
    WORKSPACE_MCP_FILE_RETURN_SCOPES: enabled ? "media" : "",
    WORKSPACE_MCP_ROOT_DENY_DIRS: "projects=private",
    WORKSPACE_MCP_MAX_FETCH_FILE_BYTES: String(cap),
  });
  const directory = path.join(root, "owned-temp");
  const store = new ArchiveTempStore({ directory });
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  const args = { scope: "media", path: "source" };
  const writeZip = async (zip: JSZip, name = "existing.zip", options: JSZip.JSZipGeneratorOptions<"nodebuffer"> = {}) => {
    const bytes = await zip.generateAsync({ ...options, type: "nodebuffer" });
    await fs.writeFile(path.join(assets, name), bytes);
    return { bytes, args: { scope: "media", path: name } };
  };
  const files = async (): Promise<string[]> => fs.readdir(directory).catch((e: NodeJS.ErrnoException) => e.code === "ENOENT" ? [] : Promise.reject(e));
  return { root, assets, config, directory, store, args, writeZip, files };
}

test("ZIP nested binary/text/empty-directory round-trip preserves source and metadata", async (t) => {
  const f = await fixture(t);
  const folder = path.join(f.assets, "source", "中文 😀 #");
  await fs.mkdir(path.join(folder, "empty"), { recursive: true });
  const binary = Buffer.from([0, 255, 128, 1, 13, 10]);
  const text = Buffer.from("\uFEFF第一行\r\nsecond\n", "utf8");
  await fs.writeFile(path.join(folder, "音訊.wav"), binary);
  await fs.writeFile(path.join(folder, "說明.txt"), text);
  const before = await fs.stat(path.join(folder, "說明.txt"));
  const linked = await packageFolderResource(f.config, f.args, f.store);
  assert.equal(linked.complete, true);
  assert.equal(linked.includedFiles, 2);
  assert.equal(linked.includedDirectories, 2);
  assert.equal(linked.filename, "source.zip");
  assert.equal(linked.sourceBytes, binary.length + text.length);
  assert.equal((await f.files()).length, 1, "link emission retains ZIP");
  const zipped = await f.store.consume(f.config, linked.resourceUri);
  assert.equal(zipped.length, linked.bytes);
  assert.equal(digest(zipped), linked.sha256);
  assert.deepEqual(await f.files(), []);
  const external = await JSZip.loadAsync(zipped, { checkCRC32: true });
  assert.deepEqual(await external.file("中文 😀 #/音訊.wav")!.async("nodebuffer"), binary);
  assert.deepEqual(await external.file("中文 😀 #/說明.txt")!.async("nodebuffer"), text);
  assert.equal(external.files["中文 😀 #/empty/"].dir, true);
  assert.deepEqual(await fs.readFile(path.join(folder, "說明.txt")), text);
  const after = await fs.stat(path.join(folder, "說明.txt"));
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.ino, before.ino);
  await fs.writeFile(path.join(f.assets, "round-trip.zip"), zipped);
  const args = { scope: "media", path: "round-trip.zip" };
  const listing = await inspectArchive(f.config, { ...args, limit: 1 });
  assert.equal(listing.entryCount, 4);
  assert.equal(listing.entries.length, 1);
  assert.equal(listing.nextOffset, 1);
  assert.equal(listing.integrity, "all_entries_crc32_verified");
  const read = await readArchiveEntry(f.config, { ...args, entry: "中文 😀 #\\音訊.wav", maxBytes: 2 });
  assert.deepEqual(Buffer.from(read.data, "base64"), binary.subarray(0, 2));
  assert.equal(read.nextOffset, 2);
  assert.equal(read.eof, false);
  assert.equal(read.sha256, digest(binary));
  const tail = await readArchiveEntry(f.config, { ...args, entry: "中文 😀 #/音訊.wav", offset: 2 });
  assert.deepEqual(Buffer.from(tail.data, "base64"), binary.subarray(2));
  assert.equal(tail.eof, true);
  const utf8 = await readArchiveEntry(f.config, { ...args, entry: "中文 😀 #/說明.txt", encoding: "utf8" });
  assert.equal(utf8.data, text.toString("utf8"));
});

test("ZIP packaging reports denied trees and files without claiming completeness", async (t) => {
  const f = await fixture(t);
  for (const name of ["dist", "build", "node_modules", ".git", "private"]) {
    await fs.mkdir(path.join(f.assets, "source", name));
    await fs.writeFile(path.join(f.assets, "source", name, "hidden.txt"), "not included");
  }
  for (const name of [".env", "auth.json", "data.db", "nested.zip", "weights.bin"]) await fs.writeFile(path.join(f.assets, "source", name), "not included");
  await fs.writeFile(path.join(f.assets, "source", "ok.txt"), "visible");
  const result = await packageFolderResource(f.config, f.args, f.store);
  assert.equal(result.complete, false);
  assert.equal(result.skippedEntries, 10);
  assert.ok(result.skipped.every((entry) => entry.reason.includes("denied")));
  assert.equal(result.includedFiles, 1);
  const bytes = await f.store.consume(f.config, result.resourceUri);
  assert.deepEqual(Object.keys((await JSZip.loadAsync(bytes)).files), ["ok.txt"]);
});

test("ZIP existing return stays immutable, repeatable, content-bound and separate from fetch_asset", async (t) => {
  const f = await fixture(t);
  const original = await f.writeZip(new JSZip().file("a.txt", "first"));
  const result = await fetchArchive(f.config, original.args);
  assert.equal(result.metadata.temporary, false);
  assert.deepEqual(await readArchiveResource(f.config, result.metadata.resourceUri), original.bytes);
  assert.deepEqual(await readArchiveResource(f.config, result.metadata.resourceUri), original.bytes);
  await assert.rejects(() => fetchAsset(f.config, original.args), /denied file extension/);
  await assert.rejects(() => resolveWorkspacePath(f.config, "assets/existing.zip", "file", "projects"), /denied file extension/);
  await f.writeZip(new JSZip().file("a.txt", "second"));
  await assert.rejects(() => readArchiveResource(f.config, result.metadata.resourceUri), /changed since/);
  assert.equal((await fs.stat(path.join(f.assets, "existing.zip"))).isFile(), true);
});

test("ZIP source/entry policies reject secrets, root/scope escapes and non-ZIP exceptions", async (t) => {
  const f = await fixture(t);
  for (const request of [
    { scope: "unknown", path: "source" }, { scope: "media", path: "../outside" },
    { scope: "media", path: "C:\\Windows" }, { scope: "media", path: "/tmp" },
    { scope: "media", path: "source/../../outside" }, { scope: "media", path: "source:stream" },
  ]) await assert.rejects(() => packageFolder(f.config, request));
  for (const name of [".env.zip", "other.7z", "private/payload.zip", "dist/payload.zip"]) {
    await fs.mkdir(path.dirname(path.join(f.assets, name)), { recursive: true });
    await fs.writeFile(path.join(f.assets, name), Buffer.alloc(0));
    await assert.rejects(() => inspectArchive(f.config, { scope: "media", path: name }));
  }
  const zip = new JSZip().file("ok.txt", "readable").file(".env", "denied").file("private/data.txt", "denied");
  const item = await f.writeZip(zip);
  const listing = await inspectArchive(f.config, item.args);
  assert.equal(listing.deniedEntries, 3);
  assert.ok(listing.entries.filter((e) => !e.allowed).every((e) => e.integrity === "not_read_denied" && !!e.reason));
  await assert.rejects(() => fetchArchive(f.config, item.args), /denied content/);
  await assert.rejects(() => readArchiveEntry(f.config, { ...item.args, entry: ".env" }), /denied/);
  assert.equal((await readArchiveEntry(f.config, { ...item.args, entry: "ok.txt", encoding: "utf8" })).data, "readable");
});

test("ZIP readers need asset scopes; sending additionally needs the existing file-return scope", async (t) => {
  const f = await fixture(t, 1024, false);
  const item = await f.writeZip(new JSZip().file("a.txt", "hello"));
  assert.equal((await inspectArchive(f.config, item.args)).entryCount, 1);
  await assert.rejects(() => fetchArchive(f.config, item.args), /not enabled/);
  await assert.rejects(() => packageFolderResource(f.config, f.args, f.store), /not enabled/);
  assert.deepEqual(await f.files(), []);
});

test("ZIP junctions/symlinks cannot escape root, escape scope or redirect within scope", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "private.txt"), "outside");
  const type = process.platform === "win32" ? "junction" : "dir";
  await fs.symlink(outside, path.join(f.assets, "source", "escape"), type);
  await fs.symlink(path.join(f.assets, "source"), path.join(f.assets, "alias"), type);
  await assert.rejects(() => packageFolder(f.config, { scope: "media", path: "alias" }), /symlink|junction/);
  await assert.rejects(() => packageFolder(f.config, { scope: "media", path: "source/escape" }), /symlink|junction/);
  const result = await packageFolder(f.config, f.args);
  assert.equal(result.complete, false);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].subtree, true);
  const other = await fs.mkdtemp(path.join(os.tmpdir(), "zip-outside-root-"));
  t.after(() => fs.rm(other, { recursive: true, force: true }));
  await fs.writeFile(path.join(other, "outer.zip"), await new JSZip().file("a.txt", "outside").generateAsync({ type: "nodebuffer" }));
  await fs.symlink(other, path.join(f.assets, "escape-root"), type);
  await assert.rejects(() => fetchArchive(f.config, { scope: "media", path: "escape-root/outer.zip" }), /symlink|junction/);
});

test("ZIP hard links are rejected without reading their contents", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "outside.txt"), "outside");
  await fs.link(path.join(f.root, "outside.txt"), path.join(f.assets, "source", "linked.txt"));
  await assert.rejects(() => packageFolder(f.config, f.args), /hard-linked/);
});

test("ZIP expanded entry and compressed output limits fail without a partial resource", async (t) => {
  const f = await fixture(t, 128);
  await fs.writeFile(path.join(f.assets, "source", "large.txt"), Buffer.alloc(ARCHIVE_LIMITS.entryExpandedBytes + 1));
  await assert.rejects(() => packageFolderResource(f.config, f.args, f.store), /expanded size/);
  await fs.writeFile(path.join(f.assets, "source", "large.txt"), randomBytes(256));
  await assert.rejects(() => packageFolderResource(f.config, f.args, f.store), /including headers/);
  const item = await f.writeZip(new JSZip().file("a.txt", Buffer.alloc(200)));
  await assert.rejects(() => fetchArchive(f.config, item.args), /fetch limit/);
  assert.deepEqual(await f.files(), []);
});

test("ZIP DEFLATE compresses a source file above 12 MiB while retaining the exact 12 MiB output cap", async (t) => {
  const cap = 12 * 1024 * 1024;
  const f = await fixture(t, cap);
  const input = Buffer.alloc(13 * 1024 * 1024, 65);
  await fs.writeFile(path.join(f.assets, "source", "compressible.txt"), input);
  const linked = await packageFolderResource(f.config, f.args, f.store);
  assert.ok(linked.sourceBytes > cap);
  assert.ok(linked.bytes < cap);
  assert.equal(f.config.maxFetchFileBytes, cap);
  assert.equal(linked.complete, true);
  const compressed = await f.store.consume(f.config, linked.resourceUri);
  assert.equal(compressed.readUInt16LE(8), 8, "actual DEFLATE, not STORE");
  const zip = await JSZip.loadAsync(compressed, { checkCRC32: true });
  assert.deepEqual(await zip.file("compressible.txt")!.async("nodebuffer"), input);
  await fs.writeFile(path.join(f.assets, "large-expanded.zip"), compressed);
  const args = { scope: "media", path: "large-expanded.zip" };
  assert.equal((await fetchArchive(f.config, args)).metadata.bytes, linked.bytes);
  assert.equal((await inspectArchive(f.config, args)).expandedBytes, input.length);
  const window = await readArchiveEntry(f.config, { ...args, entry: "compressible.txt", offset: cap, maxBytes: 32 });
  assert.equal(window.bytes, input.length);
  assert.deepEqual(Buffer.from(window.data, "base64"), input.subarray(cap, cap + 32));
  assert.deepEqual(await fs.readFile(path.join(f.assets, "source", "compressible.txt")), input);
  assert.deepEqual(await f.files(), []);
});

test("ZIP aggregate expanded input is capped independently of high compressibility", async (t) => {
  const f = await fixture(t, 12 * 1024 * 1024);
  const bytes = Buffer.alloc(13 * 1024 * 1024);
  for (let i = 0; i < 4; i++) await fs.writeFile(path.join(f.assets, "source", `${i}.txt`), bytes);
  await assert.rejects(() => packageFolderResource(f.config, f.args, f.store), /expanded size/);
  assert.deepEqual(await f.files(), []);
});

test("ZIP temporary reads are single-use and concurrent duplicate reads fail closed", async (t) => {
  const f = await fixture(t);
  const result = await packageFolderResource(f.config, f.args, f.store);
  const calls = await Promise.allSettled([f.store.consume(f.config, result.resourceUri), f.store.consume(f.config, result.resourceUri)]);
  assert.equal(calls.filter((c) => c.status === "fulfilled").length, 1);
  assert.equal(calls.filter((c) => c.status === "rejected").length, 1);
  await assert.rejects(() => f.store.consume(f.config, result.resourceUri), /expired, consumed/);
  await assert.rejects(() => f.store.consume(f.config, result.resourceUri + "&extra=1"), /unknown/);
  assert.deepEqual(await f.files(), []);
});

test("ZIP temporary read corruption, missing file and policy failure all clean up", async (t) => {
  const f = await fixture(t);
  for (const mode of ["corrupt", "missing", "scope", "entry-policy"] as const) {
    await fs.writeFile(path.join(f.assets, "source", "a.txt"), "hello");
    const result = await packageFolderResource(f.config, f.args, f.store);
    const absolute = path.join(f.directory, (await f.files())[0]);
    if (mode === "corrupt") await fs.writeFile(absolute, "corrupted");
    if (mode === "missing") await fs.unlink(absolute);
    if (mode === "scope") f.config.fileReturnScopeIds.clear();
    if (mode === "entry-policy") f.config.denyExtensions.add(".txt");
    await assert.rejects(() => f.store.consume(f.config, result.resourceUri));
    assert.deepEqual(await f.files(), [], mode);
    f.config.fileReturnScopeIds.add("media");
    f.config.denyExtensions.delete(".txt");
  }
});

test("ZIP automatic expiry removes unclaimed files; stale links stay invalid", async (t) => {
  const f = await fixture(t);
  let now = Date.now();
  const store = new ArchiveTempStore({ directory: f.directory, ttlMs: 100, sweepMs: 10, now: () => now });
  t.after(() => store.close());
  const result = await packageFolderResource(f.config, f.args, store);
  now += 101;
  for (let i = 0; i < 100 && (await f.files()).length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(await f.files(), []);
  await assert.rejects(() => store.consume(f.config, result.resourceUri), /expired/);
  await store.close();
});

test("ZIP crash recovery sweeps expired owned names only and never follows a temp junction", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.directory);
  const expired = `${Date.now() - 1000}-12345678-1234-1234-1234-123456789abc.zip`;
  await fs.writeFile(path.join(f.directory, expired), "orphan");
  await fs.writeFile(path.join(f.directory, "user.zip"), "keep");
  const future = `${Date.now() + 60_000}-12345678-1234-1234-1234-123456789abc.zip`;
  await fs.writeFile(path.join(f.directory, future), "keep");
  const result = await packageFolderResource(f.config, f.args, f.store);
  assert.equal((await f.files()).includes(expired), false);
  assert.equal(await fs.readFile(path.join(f.directory, "user.zip"), "utf8"), "keep");
  assert.equal(await fs.readFile(path.join(f.directory, future), "utf8"), "keep");
  await f.store.consume(f.config, result.resourceUri);
  const link = path.join(f.root, "unsafe-temp");
  await fs.symlink(f.assets, link, process.platform === "win32" ? "junction" : "dir");
  const unsafe = new ArchiveTempStore({ directory: link });
  t.after(() => unsafe.close());
  await assert.rejects(() => packageFolderResource(f.config, f.args, unsafe), /Symbolic link|junction/);
});

test("ZIP cleanup failure locks the resource and retries owned deletion", async (t) => {
  const f = await fixture(t);
  const result = await packageFolderResource(f.config, f.args, f.store);
  const original = fs.unlink;
  let failed = false;
  const mock = t.mock.method(fs, "unlink", async (target: Parameters<typeof fs.unlink>[0]) => {
    if (!failed && String(target).startsWith(f.directory)) { failed = true; throw Object.assign(new Error("fixture busy"), { code: "EBUSY" }); }
    return original(target);
  });
  await assert.rejects(() => f.store.consume(f.config, result.resourceUri), /fixture busy/);
  assert.equal((await f.files()).length, 1);
  await assert.rejects(() => f.store.consume(f.config, result.resourceUri), /in progress/);
  mock.mock.restore();
  await f.store.sweep();
  assert.deepEqual(await f.files(), []);
});

test("ZIP capacity and operation concurrency are bounded", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < ARCHIVE_LIMITS.pending; i++) await packageFolderResource(f.config, f.args, f.store);
  await assert.rejects(() => packageFolderResource(f.config, f.args, f.store), /capacity/);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const one = archiveOperation(() => hold), two = archiveOperation(() => hold);
  await assert.rejects(() => archiveOperation(async () => undefined), /ARCHIVE_BUSY/);
  release(); await Promise.all([one, two]);
});

test("ZIP malicious traversal, absolute, ADS, device and ambiguous entry names are rejected", async (t) => {
  const f = await fixture(t);
  for (const name of ["../escape.txt", "a/../../escape.txt", "/absolute.txt", "C:\\escape.txt", "\\\\server\\share\\a.txt", "a.txt:ads", "NUL.txt", "a./x.txt", "a /x.txt", "a//b.txt", "a\0.txt", "a/./b.txt", "a/".repeat(33) + "b.txt"]) {
    const item = await f.writeZip(new JSZip().file(name, "hostile", { createFolders: false }));
    await assert.rejects(() => inspectArchive(f.config, item.args), name);
  }
});

test("ZIP duplicate, case/Unicode-normalization and file/directory collisions are rejected", async (t) => {
  const f = await fixture(t);
  for (const names of [["a.txt", "A.txt"], ["é.txt", "e\u0301.txt"], ["parent", "parent/file.txt"]]) {
    const zip = new JSZip();
    for (const name of names) zip.file(name, "hello", { createFolders: false });
    const item = await f.writeZip(zip);
    await assert.rejects(() => inspectArchive(f.config, item.args), /Duplicate|collision/);
  }
});

test("ZIP encrypted/symlink/special entries and unsupported compression are rejected", async (t) => {
  const f = await fixture(t);
  for (const mode of [0o120777, 0o020600, 0o060600]) {
    const item = await f.writeZip(new JSZip().file("link", "outside", { unixPermissions: mode }), "existing.zip", { platform: "UNIX" });
    await assert.rejects(() => inspectArchive(f.config, item.args), /symlink|special/);
  }
  const item = await f.writeZip(new JSZip().file("a.txt", "abc"));
  for (const [field, value] of [["flags", 1], ["method", 99]] as const) {
    const data = Buffer.from(item.bytes);
    const central = data.indexOf(Buffer.from("504b0102", "hex"));
    data.writeUInt16LE(value, field === "flags" ? 6 : 8);
    data.writeUInt16LE(value, central + (field === "flags" ? 8 : 10));
    await fs.writeFile(path.join(f.assets, "existing.zip"), data);
    await assert.rejects(() => inspectArchive(f.config, item.args), /encrypt|unsupported|size mismatch/i);
  }
});

test("ZIP corrupted payload, truncated directory, mismatched local name and overlap fail integrity", async (t) => {
  const f = await fixture(t);
  const item = await f.writeZip(new JSZip().file("a.txt", "payload").file("b.txt", "second"));
  const central = item.bytes.indexOf(Buffer.from("504b0102", "hex"));
  const second = item.bytes.indexOf(Buffer.from("504b0102", "hex"), central + 1);
  const corrupt = Buffer.from(item.bytes); corrupt[35] ^= 0xff;
  const mismatch = Buffer.from(item.bytes); mismatch[30] = 98;
  const overlap = Buffer.from(item.bytes); overlap.writeUInt32LE(0, second + 42);
  for (const bytes of [corrupt, item.bytes.subarray(0, -1), mismatch, overlap, Buffer.from("not a zip")]) {
    await fs.writeFile(path.join(f.assets, "existing.zip"), bytes);
    await assert.rejects(() => inspectArchive(f.config, item.args));
    await assert.rejects(() => fetchArchive(f.config, item.args));
  }
});

test("ZIP bombs are bounded by per-entry expansion, actual inflated size, total expansion and count", async (t) => {
  const f = await fixture(t, 64 * 1024 * 1024);
  const bomb = await f.writeZip(new JSZip().file("zeros.txt", Buffer.alloc(ARCHIVE_LIMITS.entryExpandedBytes + 1)), "existing.zip", { compression: "DEFLATE" });
  await assert.rejects(() => inspectArchive(f.config, bomb.args), /entry expanded size/);
  const many = new JSZip();
  for (let i = 0; i <= ARCHIVE_LIMITS.entries; i++) many.file(`${i}.txt`, "");
  const count = await f.writeZip(many);
  await assert.rejects(() => inspectArchive(f.config, count.args), /entry count/);
  // A valid compressed archive exceeds the aggregate limit without exceeding any entry limit.
  const large = Buffer.alloc(13 * 1024 * 1024);
  const aggregate = new JSZip();
  for (let i = 0; i < 4; i++) aggregate.file(`${i}.txt`, large);
  const total = await f.writeZip(aggregate, "existing.zip", { compression: "DEFLATE" });
  await assert.rejects(() => inspectArchive(f.config, total.args), /total expanded size/);
  const valid = await f.writeZip(new JSZip().file("a.txt", large), "existing.zip", { compression: "DEFLATE" });
  const fake = Buffer.from(valid.bytes);
  const central = fake.indexOf(Buffer.from("504b0102", "hex"));
  fake.writeUInt32LE(1024, 22);
  fake.writeUInt32LE(1024, central + 24);
  await fs.writeFile(path.join(f.assets, "existing.zip"), fake);
  await assert.rejects(() => inspectArchive(f.config, valid.args), /size|byte/i);
});

test("ZIP valid DEFLATE, descriptor, UTF-8, CP437 and Windows separators are supported", async (t) => {
  const f = await fixture(t);
  const value = "A little text, with a second sentence.";
  const item = await f.writeZip(new JSZip().file("中文\\inner.txt", value, { createFolders: false }), "existing.zip", { compression: "DEFLATE", streamFiles: true });
  assert.equal((await readArchiveEntry(f.config, { ...item.args, entry: "中文/inner.txt", encoding: "utf8" })).data, value);
  // Legacy CP437 name: patch the ASCII name equally in local and central headers.
  const legacy = await f.writeZip(new JSZip().file("x.txt", "legacy"));
  const bytes = Buffer.from(legacy.bytes);
  bytes[30] = 0x82;
  bytes[bytes.indexOf(Buffer.from("504b0102", "hex")) + 46] = 0x82;
  await fs.writeFile(path.join(f.assets, "existing.zip"), bytes);
  assert.equal((await readArchiveEntry(f.config, { ...legacy.args, entry: "é.txt", encoding: "utf8" })).data, "legacy");
});

test("ZIP invalid UTF-8 filename and nonaligned text windows are explicit errors", async (t) => {
  const f = await fixture(t);
  const item = await f.writeZip(new JSZip().file("x.txt", "中文字"));
  const bytes = Buffer.from(item.bytes);
  const central = bytes.indexOf(Buffer.from("504b0102", "hex"));
  bytes.writeUInt16LE(0x800, 6); bytes.writeUInt16LE(0x800, central + 8);
  bytes[30] = 0xff; bytes[central + 46] = 0xff;
  await fs.writeFile(path.join(f.assets, "existing.zip"), bytes);
  await assert.rejects(() => inspectArchive(f.config, item.args), /UTF-8|Unsafe/);
  await fs.writeFile(path.join(f.assets, "existing.zip"), item.bytes);
  await assert.rejects(() => readArchiveEntry(f.config, { ...item.args, entry: "x.txt", encoding: "utf8", maxBytes: 1 }), /not valid UTF-8/);
  await assert.rejects(() => readArchiveEntry(f.config, { ...item.args, entry: "x.txt", offset: 1000 }), /offset/);
  await assert.rejects(() => readArchiveEntry(f.config, { ...item.args, entry: "x.txt", maxBytes: 1000000 }), /range/);
});

test("ZIP published snapshot survives ordinary source edits; cancellation publishes nothing", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.assets, "source", "a.txt"), "first");
  const result = await packageFolderResource(f.config, f.args, f.store);
  await fs.writeFile(path.join(f.assets, "source", "a.txt"), "second");
  const zip = await JSZip.loadAsync(await f.store.consume(f.config, result.resourceUri));
  assert.equal(await zip.file("a.txt")!.async("string"), "first");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => packageFolderResource(f.config, f.args, f.store, controller.signal));
  assert.deepEqual(await f.files(), []);
  assert.equal(archiveCrc32(Buffer.from("123456789")), 0xcbf43926);
});

test("ZIP MCP schemas, resource_link delivery and failed SDK send use the existing protocol", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.assets, "source", "a.txt"), "hello");
  const item = await f.writeZip(new JSZip().file("hello.txt", "hello"));
  const server = createWorkspaceMcpServer(f.config);
  const client = new Client({ name: "zip-contract-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(st); await client.connect(ct);
  const tools = (await client.listTools()).tools;
  for (const name of ["package_folder_zip", "fetch_zip", "inspect_zip", "list_zip_entries", "read_zip_entry"]) {
    const tool = tools.find((tool) => tool.name === name)!;
    assert.ok(tool, name); assert.ok(tool.outputSchema, name);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.annotations?.readOnlyHint, name !== "package_folder_zip");
  }
  const denied = await client.callTool({ name: "package_folder_zip", arguments: { ...f.args, outputPath: "outside.zip" } });
  assert.equal(denied.isError, true);
  for (const name of ["inspect_zip", "list_zip_entries", "read_zip_entry", "fetch_zip"]) {
    const result = await client.callTool({ name, arguments: { ...item.args, ...(name === "read_zip_entry" ? { entry: "hello.txt" } : {}) } });
    assert.notEqual(result.isError, true, JSON.stringify(result));
  }
  for (const failSend of [false, true]) {
    const result = await client.callTool({ name: "package_folder_zip", arguments: f.args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const content = result.content as Array<{ type: string; uri: string }>;
    assert.deepEqual(content.map((c) => c.type), ["text", "resource_link"]);
    const uri = content[1].uri;
    const temporary = path.join(await fs.realpath(os.tmpdir()), "project-workspace-zip-v1", new URL(uri).pathname.slice(1));
    assert.equal((await fs.stat(temporary)).isFile(), true);
    const send = st.send.bind(st);
    if (failSend) st.send = async (message, options) => {
      if ("result" in message && "contents" in message.result) throw new Error("fixture SDK send failure");
      return send(message, options);
    };
    if (failSend) await assert.rejects(() => client.readResource({ uri }, { timeout: 1000 }), /timed out/);
    else {
      const response = await client.readResource({ uri });
      const blob = (response.contents[0] as { blob: string }).blob;
      const zip = await JSZip.loadAsync(Buffer.from(blob, "base64"), { checkCRC32: true });
      assert.equal(await zip.file("a.txt")!.async("string"), "hello");
    }
    st.send = send;
    await assert.rejects(() => fs.stat(temporary), { code: "ENOENT" });
    await assert.rejects(() => client.readResource({ uri }), /expired, consumed/);
  }
});
