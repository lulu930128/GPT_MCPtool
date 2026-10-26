import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { PathLike } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { createWorkspaceMcpServer } from "../src/server.js";
import { startWorkspaceHttpServer } from "../src/http-server.js";
import { readWorkspaceFile, getWorkspaceInfo } from "../src/workspace.js";
import { WorkspaceWriter, getWorkspaceWriter } from "../src/write-tools.js";
import { sha256 } from "../src/text-snapshot.js";
import { WRITE_TOOLS, componentDirectory } from "../src/write-policy.js";
import { inspectWritePath, inspectOperatorStatePath } from "../src/path-guard.js";

async function fixture(t: TestContext, customize?: (policy: Record<string, unknown>) => void) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-operate-"));
  t.after(async () => fs.rm(base, { recursive: true, force: true }));
  const first = path.join(base, "one");
  const second = path.join(base, "two");
  await fs.mkdir(path.join(first, "notes"), { recursive: true });
  await fs.mkdir(path.join(second, "notes"), { recursive: true });
  const policyPath = path.join(base, "write-policy.json");
  const state = path.join(base, "state");
  const policy: Record<string, unknown> = { version: 1, enabled: true, rules: [
    { root: "one", path: "notes/**", operations: [...WRITE_TOOLS], extensions: [".txt", ".md", ".json", ".jsonl", ".ts"] },
    { root: "two", path: "notes/**", operations: [...WRITE_TOOLS], extensions: [".md", ".json", ".txt"] },
  ], deny: [{ root: "one", path: "notes/private/**" }] };
  customize?.(policy);
  await fs.writeFile(policyPath, JSON.stringify(policy));
  const env = { WORKSPACE_MCP_ROOTS: `one=${first};two=${second}`, WORKSPACE_MCP_DEFAULT_ROOT: "one",
    WORKSPACE_MCP_WRITE_POLICY: policyPath, WORKSPACE_MCP_WRITE_STATE_DIR: state };
  const config = await loadConfig(env);
  return { base, first, second, state, policyPath, policy, env, config, writer: getWorkspaceWriter(config) };
}

function input(filename: string, extra: Record<string, unknown> = {}): Record<string, unknown> & { root: string; path: string; operation_id: string } {
  return { root: "one", path: filename, operation_id: randomUUID(), ...extra };
}

for (const initiallyExists of [true, false]) {
  test(`operator state binds a same-identity filesystem alias (${initiallyExists ? "existing" : "created on first use"})`, async (t) => {
    const f = await fixture(t);
    const logical = path.join(f.base, "logical-state");
    const physical = path.join(f.base, "physical-state");
    if (initiallyExists) await fs.mkdir(physical);
    const nativeStat = fs.lstat.bind(fs);
    const nativeRealpath = fs.realpath.bind(fs);
    const nativeMkdir = fs.mkdir.bind(fs);
    const remap = (value: PathLike): PathLike => typeof value === "string" &&
      (value === logical || value.startsWith(`${logical}${path.sep}`)) ? physical + value.slice(logical.length) : value;
    // Model a non-symlink filesystem virtualization layer. The canonical side
    // uses real files; mutation, lock, audit and receipt IO remain unmocked there.
    t.mock.method(fs, "lstat", (...[value, options]: Parameters<typeof fs.lstat>) => nativeStat(remap(value), options));
    t.mock.method(fs, "realpath", (...[value, options]: Parameters<typeof fs.realpath>) => nativeRealpath(remap(value), options));
    t.mock.method(fs, "mkdir", (...[value, options]: Parameters<typeof fs.mkdir>) => nativeMkdir(remap(value), options));
    const env = { ...f.env, WORKSPACE_MCP_WRITE_STATE_DIR: logical };
    const config = await loadConfig(env);
    assert.equal(config.writePolicy.enabled, true);
    assert.equal(config.writePolicy.stateDirectory, initiallyExists ? physical : logical);
    const writer = new WorkspaceWriter(config);
    const args = input("notes/alias-state.txt", { content: "once" });
    assert.equal((await writer.execute("append_text_file", args)).ok, true);
    assert.equal(config.writePolicy.stateDirectory, physical);
    assert.ok(config.writePolicy.protectedPaths.includes(physical));
    assert.equal((await writer.getOperation(args.operation_id)).ok, true);
    assert.equal((await new WorkspaceWriter(await loadConfig(env)).execute("append_text_file", args)).replayed, true);
    assert.equal(await fs.readFile(path.join(f.first, args.path), "utf8"), "once");
    assert.ok((await fs.readdir(path.join(physical, "operations"))).includes(`${args.operation_id}.json`));
    assert.equal((await fs.readFile(path.join(physical, "write-audit.jsonl"), "utf8")).trim().split("\n").length, 2);
    await assert.rejects(() => inspectWritePath(logical), (error: unknown) => (error as { code: string }).code === "SYMLINK_DENIED");
  });
}

test("operator state rejects a canonical path identifying a different object", async (t) => {
  const f = await fixture(t);
  const logical = path.join(f.base, "logical-state");
  const other = path.join(f.base, "different-object");
  await fs.mkdir(logical); await fs.mkdir(other);
  const nativeRealpath = fs.realpath.bind(fs);
  t.mock.method(fs, "realpath", (...[value, options]: Parameters<typeof fs.realpath>) => nativeRealpath(value === logical ? other : value, options));
  await assert.rejects(() => inspectOperatorStatePath(logical), (error: unknown) => (error as { code: string }).code === "PATH_CHANGED");
});

test("operator state rejects physical workspace overlap and real junctions", async (t) => {
  const f = await fixture(t);
  const logical = path.join(f.base, "logical-state");
  const physical = path.join(f.first, "readable-state");
  await fs.mkdir(physical);
  const nativeStat = fs.lstat.bind(fs);
  const nativeRealpath = fs.realpath.bind(fs);
  t.mock.method(fs, "lstat", (...[value, options]: Parameters<typeof fs.lstat>) => nativeStat(value === logical ? physical : value, options));
  t.mock.method(fs, "realpath", (...[value, options]: Parameters<typeof fs.realpath>) => nativeRealpath(value === logical ? physical : value, options));
  const config = await loadConfig({ ...f.env, WORKSPACE_MCP_WRITE_STATE_DIR: logical });
  assert.equal(config.writePolicy.enabled, false);
  assert.deepEqual(await fs.readdir(physical), []);
  const junction = path.join(f.base, "state-junction");
  await fs.symlink(physical, junction, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => inspectOperatorStatePath(junction), (error: unknown) => (error as { code: string }).code === "SYMLINK_DENIED");
});

test("operator read-write defaults cover configured roots and new roots while preserving deny and field restrictions", async (t) => {
  const f = await fixture(t, (policy) => {
    policy.defaultRootAccess = "read-write";
    policy.rules = [{ root: "one", path: "settings.json", operations: ["update_json_value"], extensions: [".json"],
      jsonFields: { "/count": { type: "integer", minimum: 1, maximum: 10 } } }];
  });
  assert.equal(f.config.writePolicy.enabled, true);
  for (const root of ["one", "two"]) {
    assert.equal((await f.writer.execute("create_text_file", input("README", { root, content: "plain text" }))).ok, true);
    assert.equal((await f.writer.execute("create_text_file", input("example.py", { root, content: "value = 1\n" }))).ok, true);
    assert.equal((await f.writer.execute("make_directory", input("new/sub", { root }))).ok, true);
  }
  assert.equal((await f.writer.execute("make_directory", input("notes/private"))).code, "WRITE_POLICY_DENIED");
  for (const filename of [".env", "example.db", "AGENTS.md", "secrets/key.txt"]) {
    assert.equal((await f.writer.execute("create_text_file", input(filename, { content: "denied" }))).ok, false);
  }
  await fs.writeFile(path.join(f.first, "settings.json"), '{"count":2}');
  assert.equal((await f.writer.execute("patch_text_file", input("settings.json", {
    expected_sha256: sha256('{"count":2}'), operations: [{ find: "2", replace: "20" }],
  }))).code, "WRITE_POLICY_DENIED");
  assert.equal((await f.writer.execute("update_json_value", input("settings.json", {
    expected_sha256: sha256('{"count":2}'), json_pointer: "/count", value: 20,
  }))).code, "VALIDATION_FAILED");
  const third = path.join(f.base, "third");
  await fs.mkdir(third);
  const config = await loadConfig({ ...f.env, WORKSPACE_MCP_ROOTS: `${f.env.WORKSPACE_MCP_ROOTS};three=${third};self=${componentDirectory}` });
  const writer = new WorkspaceWriter(config);
  assert.equal((await writer.execute("create_text_file", input("new.txt", { root: "three", content: "new root" }))).ok, true);
  assert.equal((await writer.execute("create_text_file", input("should-not-exist.txt", { root: "self", content: "denied" }))).code, "PATH_DENIED");
  const volume = await inspectWritePath(path.parse(f.base).root);
  assert.ok(volume.stat?.isDirectory());
  assert.equal(volume.ancestors.length, 1);
});

test("operate is opt-in and malformed policy leaves all 36 read tools available", async (t) => {
  const f = await fixture(t);
  for (const policy of [undefined, { version: 1, enabled: false, rules: [] },
    { version: 2, enabled: true, rules: [] }, { ...f.policy, unknownPermission: true },
    { ...f.policy, rules: [{ root: "unknown", path: "notes/**", operations: ["create_text_file"], extensions: [".txt"] }] },
    { ...f.policy, rules: [{ root: "one", path: "../**", operations: ["make_directory"] }] }]) {
    if (policy) await fs.writeFile(f.policyPath, JSON.stringify(policy));
    const config = await loadConfig({ ...f.env, WORKSPACE_MCP_WRITE_POLICY: policy ? f.policyPath : undefined });
    assert.equal(config.writePolicy.enabled, false);
    const server = createWorkspaceMcpServer(config);
    const client = new Client({ name: "readonly-test", version: "1.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st); await client.connect(ct);
    try {
      const tools = (await client.listTools()).tools;
      assert.equal(tools.length, 37);
      assert.ok(tools.filter((tool) => tool.name !== "mcp_component_restart").every((tool) => tool.annotations?.readOnlyHint === true));
      assert.equal((await getWorkspaceInfo(config) as { mode: string }).mode, "read-only");
      assert.equal((await new WorkspaceWriter(config).execute("create_text_file", input("notes/no.txt", { content: "x" }))).code, "WRITE_DISABLED");
    } finally { await client.close(); await server.close(); }
  }
  assert.equal(await fs.stat(f.state).catch(() => undefined), undefined);
});

test("generic multi-root create, append, patch, JSON update and mkdir preserve bounded content", async (t) => {
  const f = await fixture(t);
  assert.equal(f.config.writePolicy.enabled, true);
  const directory = await f.writer.execute("make_directory", input("notes/中文 子目錄/nested"));
  assert.equal(directory.ok, true, JSON.stringify(directory)); assert.equal(directory.directories_created, 2);
  const filename = "notes/中文 子目錄/nested/report.md";
  const original = "\uFEFF第一行\r\nsecond\r\n";
  const created = await f.writer.execute("create_text_file", input(filename, { content: original }));
  assert.equal(created.ok, true); assert.equal(created.sha256, sha256(original));
  const read = await readWorkspaceFile(f.config, { root: "one", path: filename, includeSha256: true, maxLines: 1 }) as Record<string, unknown>;
  assert.equal(read.sha256, sha256(original)); assert.equal(read.truncated, true);
  assert.equal(read.text, "\uFEFF第一行");
  const patch = await f.writer.execute("patch_text_file", input(filename, {
    expected_sha256: read.sha256, operations: [{ find: "second", replace: "updated" }],
  }));
  assert.equal(patch.ok, true); assert.ok(patch.diff);
  const appended = await f.writer.execute("append_text_file", input(filename, { content: "尾端\r\n" }));
  assert.equal(appended.ok, true);
  assert.equal(await fs.readFile(path.join(f.first, filename), "utf8"), "\uFEFF第一行\r\nupdated\r\n尾端\r\n");
  const second = await f.writer.execute("create_text_file", input("notes/other.md", { root: "two", content: "other root" }));
  assert.equal(second.ok, true);
  assert.equal(await fs.readFile(path.join(f.second, "notes/other.md"), "utf8"), "other root");
  const source = await f.writer.execute("create_text_file", input("notes/example.ts", { content: "export const value = 1;\n" }));
  assert.equal(source.ok, true); // Explicitly granted source extension, not a hardcoded project use case.
});

test("create cannot overwrite, missing parents need permission, and all created ancestors are authorized", async (t) => {
  const f = await fixture(t);
  const args = input("notes/file.txt", { content: "original" });
  assert.equal((await f.writer.execute("create_text_file", args)).ok, true);
  assert.equal((await f.writer.execute("create_text_file", { ...args, operation_id: randomUUID(), content: "replace" })).code, "FILE_EXISTS");
  assert.equal((await f.writer.execute("create_text_file", { ...args, operation_id: randomUUID(), overwrite: true })).code, "VALIDATION_FAILED");
  assert.equal(await fs.readFile(path.join(f.first, args.path), "utf8"), "original");
  assert.equal((await f.writer.execute("create_text_file", input("notes/missing/file.txt", { content: "x" }))).code, "PARENT_NOT_FOUND");
  assert.equal((await f.writer.execute("make_directory", input("notes/missing/child", { parents: false }))).code, "PARENT_NOT_FOUND");
  const config = await loadConfig(f.env);
  config.writePolicy.document!.rules = [{ root: "one", path: "narrow/child/**", operations: ["make_directory"], extensions: [] }];
  assert.equal((await new WorkspaceWriter(config).execute("make_directory", input("narrow/child/deeper"))).code, "WRITE_POLICY_DENIED");
  assert.equal(await fs.stat(path.join(f.first, "narrow")).catch(() => undefined), undefined);
});

test("Windows aliases, protected names, denied scopes, unknown roots and extensions are rejected", async (t) => {
  const f = await fixture(t);
  const denied = ["../escape.txt", "C:\\Windows\\file.txt", "\\\\server\\share\\file.txt", "notes/file.txt:stream",
    "notes/NUL.txt", "notes/COM1.txt", "notes/lpt¹.txt", "notes/trailing. /x.txt", "notes/../x.txt", "notes/x.txt.",
    "notes/.env", "notes/.git/config", "notes/.codex/config.toml", "notes/AGENTS.md", "notes/SKILL.md",
    "notes/credentials/key.txt", "notes/secrets/key.txt", "notes/private/file.txt", "notes/archive.db", "notes/model.safetensors",
    "notes/file.exe", "notes/credentials.json", "notes/a//b.txt", "notes/write-policy.json"];
  for (const filename of denied) {
    const result = await f.writer.execute("create_text_file", input(filename, { content: "blocked" }));
    assert.equal(result.ok, false, filename);
    assert.equal(result.applied, false, filename);
  }
  assert.equal((await f.writer.execute("create_text_file", input("notes/test.txt", { root: "missing", content: "x" }))).code, "PATH_DENIED");
  assert.deepEqual(await fs.readdir(path.join(f.first, "notes")), []);
  const audit = await fs.readFile(path.join(f.state, "write-audit.jsonl"), "utf8");
  assert.match(audit, /"result":"rejected"/);
  assert.ok(!audit.includes('"content"'));
});

test("junction escape and hardlink aliases cannot mutate outside files", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.base, "outside");
  await fs.mkdir(outside);
  const original = path.join(outside, "target.txt");
  await fs.writeFile(original, "outside");
  await fs.symlink(outside, path.join(f.first, "notes/escape"), process.platform === "win32" ? "junction" : "dir");
  assert.equal((await f.writer.execute("create_text_file", input("notes/escape/new.txt", { content: "bad" }))).code, "SYMLINK_DENIED");
  await fs.link(original, path.join(f.first, "notes/alias.txt"));
  assert.equal((await f.writer.execute("append_text_file", input("notes/alias.txt", { content: "bad" }))).code, "HARDLINK_DENIED");
  assert.equal(await fs.readFile(original, "utf8"), "outside");
  assert.deepEqual(await fs.readdir(outside), ["target.txt"]);
});

test("same hash concurrent patches cannot lose an earlier MCP update", async (t) => {
  const f = await fixture(t);
  const filename = "notes/concurrent.txt";
  await fs.writeFile(path.join(f.first, filename), "old");
  const [a, b] = await Promise.all(["one", "two"].map((replacement) => f.writer.execute("patch_text_file", input(filename,
    { expected_sha256: sha256("old"), operations: [{ find: "old", replace: replacement }] }))));
  assert.equal(a.ok, true); assert.equal(b.code, "HASH_MISMATCH");
  assert.equal(await fs.readFile(path.join(f.first, filename), "utf8"), "one");
});

test("durable idempotency survives writer recreation and rejects operation ID reuse with new arguments", async (t) => {
  const f = await fixture(t);
  const args = input("notes/events.jsonl", { content: '{"message":"hello"}\n' });
  const first = await f.writer.execute("append_text_file", args);
  assert.equal(first.ok, true);
  const nextWriter = new WorkspaceWriter(await loadConfig(f.env));
  const replay = await nextWriter.execute("append_text_file", args);
  assert.equal(replay.ok, true); assert.equal(replay.replayed, true);
  assert.equal(await fs.readFile(path.join(f.first, args.path), "utf8"), args.content);
  const conflict = await nextWriter.execute("append_text_file", { ...args, content: '{"different":true}\n' });
  assert.equal(conflict.code, "OPERATION_ID_CONFLICT");
  assert.equal((await nextWriter.getOperation(args.operation_id)).ok, true);
});

test("append concurrency preserves every distinct event once", async (t) => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, (_, n) => f.writer.execute("append_text_file",
    input("notes/events.jsonl", { content: `${JSON.stringify({ n })}\n` }))));
  assert.ok(results.every((result) => result.ok));
  const events = (await fs.readFile(path.join(f.first, "notes/events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line).n);
  assert.deepEqual(events, [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("patch validation, stale hashes, invalid UTF-8 and malformed JSON leave originals intact", async (t) => {
  const f = await fixture(t);
  const filename = "notes/file.txt";
  await fs.writeFile(path.join(f.first, filename), "a a b");
  for (const operations of [[{ find: "a", replace: "x" }], [{ find: "b", replace: "x" }, { find: "missing", replace: "y" }]]) {
    assert.equal((await f.writer.execute("patch_text_file", input(filename, { expected_sha256: sha256("a a b"), operations }))).ok, false);
    assert.equal(await fs.readFile(path.join(f.first, filename), "utf8"), "a a b");
  }
  assert.equal((await f.writer.execute("patch_text_file", input(filename, { operations: [{ find: "b", replace: "x" }] }))).code, "VALIDATION_FAILED");
  await fs.writeFile(path.join(f.first, "notes/invalid.txt"), Buffer.from([0xff, 0xfe, 0x41]));
  assert.equal((await f.writer.execute("append_text_file", input("notes/invalid.txt", { content: "x" }))).code, "UNSUPPORTED_FILE_TYPE");
  assert.equal((await f.writer.execute("create_text_file", input("notes/invalid.json", { content: "{" }))).code, "PARSE_ERROR");
  assert.equal((await f.writer.execute("append_text_file", input("notes/invalid.jsonl", { content: '{"x":1}' }))).code, "VALIDATION_FAILED");
  assert.equal(await fs.stat(path.join(f.first, "notes/invalid.jsonl")).catch(() => undefined), undefined);
});

test("JSON update preserves conventions, requires existing pointers, validates values and cannot bypass field policy", async (t) => {
  const f = await fixture(t, (policy) => {
    (policy.rules as Array<unknown>).push({ root: "one", path: "notes/settings.json", operations: ["update_json_value"],
      extensions: [".json"], jsonFields: { "/count": { type: "integer", minimum: 1, maximum: 10 } } });
  });
  const filename = "notes/settings.json";
  const original = '\uFEFF{\r\n  "count": 2,\r\n  "locked": true\r\n}\r\n';
  await fs.writeFile(path.join(f.first, filename), original);
  const args = input(filename, { expected_sha256: sha256(original), json_pointer: "/count", value: 3 });
  assert.equal((await f.writer.execute("update_json_value", { ...args, value: 100 })).code, "VALIDATION_FAILED");
  assert.equal((await f.writer.execute("update_json_value", { ...args, operation_id: randomUUID(), json_pointer: "/locked", value: false })).code, "WRITE_POLICY_DENIED");
  assert.equal((await f.writer.execute("patch_text_file", input(filename, { expected_sha256: sha256(original), operations: [{ find: "true", replace: "false" }] }))).code, "WRITE_POLICY_DENIED");
  assert.equal((await f.writer.execute("append_text_file", input(filename, { content: " " }))).code, "WRITE_POLICY_DENIED");
  const success = await f.writer.execute("update_json_value", { ...args, operation_id: randomUUID() });
  assert.equal(success.ok, true); assert.equal(success.old_value, 2); assert.equal(success.new_value, 3);
  assert.equal(await fs.readFile(path.join(f.first, filename), "utf8"), original.replace('"count": 2', '"count": 3'));
  const noChange = await f.writer.execute("update_json_value", { ...args, operation_id: randomUUID(), expected_sha256: success.new_sha256 });
  assert.equal(noChange.changed, false); assert.equal(noChange.new_sha256, success.new_sha256);
});

test("JSON Pointer escaping and array updates work while unsafe reserialization is rejected", async (t) => {
  const f = await fixture(t);
  const filename = "notes/document.json";
  const original = '{"a/b":{"~key":[1,2]},"nested":{"flag":false}}';
  await fs.writeFile(path.join(f.first, filename), original);
  assert.equal((await f.writer.execute("update_json_value", input(filename, {
    expected_sha256: sha256(original), json_pointer: "/a~1b/~0key/1", value: 3,
  }))).ok, true);
  for (const source of ['{"x":1,"x":2}', '{"x":9007199254740993}', '{"x":1e-400}', '{"x":0.10000000000000001}', '{"x":']) {
    await fs.writeFile(path.join(f.first, filename), source);
    const result = await f.writer.execute("update_json_value", input(filename, { expected_sha256: sha256(source), json_pointer: "/x", value: 5 }));
    assert.equal(result.ok, false); assert.equal(await fs.readFile(path.join(f.first, filename), "utf8"), source);
  }
  await fs.writeFile(path.join(f.first, filename), original);
  for (const pointer of ["", "/__proto__/polluted", "/constructor", "/a~2b", "/missing", "/a~1b/~0key/length"]) {
    assert.equal((await f.writer.execute("update_json_value", input(filename, { expected_sha256: sha256(original), json_pointer: pointer, value: true }))).ok, false);
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("a changed external file immediately before publication is rejected without clobbering", async (t) => {
  const f = await fixture(t);
  const filename = "notes/race.txt";
  await fs.writeFile(path.join(f.first, filename), "before");
  const writer = new WorkspaceWriter(f.config, { beforePublish: async () => fs.writeFile(path.join(f.first, filename), "external edit") });
  const result = await writer.execute("patch_text_file", input(filename, { expected_sha256: sha256("before"), operations: [{ find: "before", replace: "after" }] }));
  assert.equal(result.code, "HASH_MISMATCH"); assert.equal(result.applied, false);
  assert.equal(await fs.readFile(path.join(f.first, filename), "utf8"), "external edit");
  assert.deepEqual(await fs.readdir(path.join(f.first, "notes")), ["race.txt"]);
});

test("failure before atomic publication preserves the original and removes its temporary file", async (t) => {
  const f = await fixture(t);
  const filename = "notes/failure.txt";
  await fs.writeFile(path.join(f.first, filename), "before");
  const writer = new WorkspaceWriter(f.config, { beforePublish: async () => { throw new Error("injected failure"); } });
  const result = await writer.execute("patch_text_file", input(filename, { expected_sha256: sha256("before"), operations: [{ find: "before", replace: "after" }] }));
  assert.equal(result.ok, false); assert.equal(result.applied, false);
  assert.equal(await fs.readFile(path.join(f.first, filename), "utf8"), "before");
  assert.deepEqual(await fs.readdir(path.join(f.first, "notes")), ["failure.txt"]);
});

test("post-publication failure returns unknown and never repeats an append, even after reload", async (t) => {
  const f = await fixture(t);
  const args = input("notes/once.txt", { content: "once" });
  const writer = new WorkspaceWriter(f.config, { afterCommit: async () => { throw new Error("lost response"); } });
  const result = await writer.execute("append_text_file", args);
  assert.equal(result.code, "OPERATION_OUTCOME_UNKNOWN");
  assert.equal(await fs.readFile(path.join(f.first, args.path), "utf8"), "once");
  const reloaded = new WorkspaceWriter(await loadConfig(f.env));
  assert.equal((await reloaded.execute("append_text_file", args)).code, "OPERATION_OUTCOME_UNKNOWN");
  assert.equal((await reloaded.getOperation(args.operation_id)).code, "OPERATION_OUTCOME_UNKNOWN");
  assert.equal(await fs.readFile(path.join(f.first, args.path), "utf8"), "once");
});

test("independent writers share an exclusive lock and stale locks are not stolen", async (t) => {
  const f = await fixture(t);
  let unblock!: () => void;
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const firstWriter = new WorkspaceWriter(f.config, { beforeCommit: async () => { entered(); await blocked; } });
  const first = firstWriter.execute("create_text_file", input("notes/first.txt", { content: "first" }));
  await inside;
  const secondWriter = new WorkspaceWriter(await loadConfig(f.env));
  const args = input("notes/second.txt", { content: "second" });
  try { assert.equal((await secondWriter.execute("create_text_file", args)).code, "WRITE_BUSY"); }
  finally { unblock(); }
  assert.equal((await first).ok, true);
  assert.equal((await secondWriter.execute("create_text_file", args)).ok, true);
  await fs.writeFile(path.join(f.state, "writer.lock"), '{"pid":0}');
  assert.equal((await secondWriter.execute("create_text_file", input("notes/third.txt", { content: "third" }))).code, "WRITE_BUSY");
  assert.equal(await fs.readFile(path.join(f.state, "writer.lock"), "utf8"), '{"pid":0}');
});

test("audit failure after publication remains uncertain and blocks repeat execution", async (t) => {
  const f = await fixture(t);
  const args = input("notes/audit-failure.txt", { content: "once" });
  const writer = new WorkspaceWriter(f.config, { afterCommit: async () => fs.appendFile(path.join(f.state, "write-audit.jsonl"), "broken") });
  const result = await writer.execute("append_text_file", args);
  assert.equal(result.code, "OPERATION_OUTCOME_UNKNOWN"); assert.equal(result.auditComplete, false);
  assert.equal((await new WorkspaceWriter(f.config).execute("append_text_file", args)).code, "OPERATION_OUTCOME_UNKNOWN");
  assert.equal(await fs.readFile(path.join(f.first, args.path), "utf8"), "once");
});

test("the component itself stays protected even through a separately granted root", async (t) => {
  const f = await fixture(t);
  (f.policy.rules as Array<unknown>).push({ root: "self", path: "src/**", operations: ["create_text_file"], extensions: [".ts"] });
  await fs.writeFile(f.policyPath, JSON.stringify(f.policy));
  const config = await loadConfig({ ...f.env, WORKSPACE_MCP_ROOTS: `${f.env.WORKSPACE_MCP_ROOTS};self=${componentDirectory}` });
  assert.equal(config.writePolicy.enabled, true);
  const result = await new WorkspaceWriter(config).execute("create_text_file", input("src/should-never-exist.ts", { root: "self", content: "denied" }));
  assert.equal(result.code, "PATH_DENIED");
});

test("policy changes revoke writes and state directories cannot overlap any readable root", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.policyPath, JSON.stringify({ ...f.policy, enabled: false }));
  assert.equal((await f.writer.execute("create_text_file", input("notes/revoked.txt", { content: "x" }))).code, "WRITE_DISABLED");
  assert.equal((await getWorkspaceInfo(f.config) as { mode: string }).mode, "read-only");
  await fs.writeFile(f.policyPath, JSON.stringify(f.policy));
  const invalid = await loadConfig({ ...f.env, WORKSPACE_MCP_WRITE_STATE_DIR: path.join(f.first, "state") });
  assert.equal(invalid.writePolicy.enabled, false);
  const aliasRoot = await loadConfig({ ...f.env, WORKSPACE_MCP_ROOTS: `${f.env.WORKSPACE_MCP_ROOTS};operator=${f.base}` });
  assert.equal(aliasRoot.writePolicy.enabled, false);
});

test("overlapping root aliases cannot bypass a physical file's deny or JSON field restriction", async (t) => {
  const f = await fixture(t, (policy) => {
    (policy.rules as Array<unknown>).push({ root: "one", path: "notes/settings.json", operations: ["update_json_value"],
      extensions: [".json"], jsonFields: { "/count": { type: "integer", minimum: 1, maximum: 10 } } });
  });
  (f.policy.rules as Array<unknown>).push(
    { root: "alias", path: "settings.json", operations: ["patch_text_file"], extensions: [".json"] },
    { root: "alias", path: "private/**", operations: ["make_directory", "create_text_file"], extensions: [".txt"] });
  await fs.writeFile(f.policyPath, JSON.stringify(f.policy));
  const config = await loadConfig({ ...f.env, WORKSPACE_MCP_ROOTS: `${f.env.WORKSPACE_MCP_ROOTS};alias=${path.join(f.first, "notes")}` });
  assert.equal(config.writePolicy.enabled, true);
  const writer = new WorkspaceWriter(config);
  await fs.writeFile(path.join(f.first, "notes/settings.json"), '{"count":2}');
  const result = await writer.execute("patch_text_file", input("settings.json", {
    root: "alias", expected_sha256: sha256('{"count":2}'), operations: [{ find: "2", replace: "100" }],
  }));
  assert.equal(result.code, "WRITE_POLICY_DENIED");
  assert.equal((await writer.execute("make_directory", input("private", { root: "alias" }))).code, "WRITE_POLICY_DENIED");
  assert.equal(await fs.readFile(path.join(f.first, "notes/settings.json"), "utf8"), '{"count":2}');
});

test("payload, file and journal quotas fail closed and audit corruption prevents mutation", async (t) => {
  const f = await fixture(t, (policy) => { policy.limits = { maxFileBytes: 16, maxPayloadBytes: 1024, maxOperations: 3 }; });
  assert.equal((await f.writer.execute("create_text_file", input("notes/large.txt", { content: "x".repeat(1025) }))).code, "PAYLOAD_TOO_LARGE");
  assert.equal((await f.writer.execute("create_text_file", input("notes/filelarge.txt", { content: "x".repeat(17) }))).code, "PAYLOAD_TOO_LARGE");
  assert.equal((await f.writer.execute("create_text_file", input("notes/ok.txt", { content: "ok" }))).ok, true);
  assert.equal((await f.writer.execute("append_text_file", input("notes/ok.txt", { content: "!" }))).ok, true);
  assert.equal((await f.writer.execute("append_text_file", input("notes/ok.txt", { content: "!" }))).code, "WRITE_QUOTA_EXCEEDED");
  const other = await fixture(t);
  assert.equal((await other.writer.execute("create_text_file", input("notes/a.txt", { content: "a" }))).ok, true);
  await fs.appendFile(path.join(other.state, "write-audit.jsonl"), "incomplete");
  const failed = await other.writer.execute("append_text_file", input("notes/a.txt", { content: "b" }));
  assert.equal(failed.code, "AUDIT_UNAVAILABLE"); assert.equal(failed.auditComplete, false);
  assert.equal(await fs.readFile(path.join(other.first, "notes/a.txt"), "utf8"), "a");
});

test("authenticated isolated HTTP MCP advertises actual permissions and round-trips a write", async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => startWorkspaceHttpServer(f.config, { host: "127.0.0.1", port: 0 }), /explicit WORKSPACE_MCP_HTTP_TOKEN/);
  const token = "isolated-test-token-not-a-credential-123456789";
  await assert.rejects(() => startWorkspaceHttpServer(f.config, { host: "0.0.0.0", port: 0, bearerToken: token }), /loopback/);
  const handle = await startWorkspaceHttpServer(f.config, { host: "127.0.0.1", port: 0, bearerToken: token });
  t.after(async () => handle.close());
  const unauthorized = await fetch(handle.url, { method: "POST" });
  assert.equal(unauthorized.status, 401);
  const origin = await fetch(handle.url, { method: "POST", headers: { authorization: `Bearer ${token}`, origin: "https://example.invalid" } });
  assert.equal(origin.status, 403);
  const health = await (await fetch(`http://${handle.host}:${handle.port}/health`)).json() as Record<string, unknown>;
  assert.equal(health.mode, "operate"); assert.equal(health.writeEnabled, true);
  assert.ok(!JSON.stringify(health).includes(f.base));
  const client = new Client({ name: "operate-http-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(handle.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  try {
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 43);
    for (const name of WRITE_TOOLS) assert.equal(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint, false);
    assert.equal(tools.find((tool) => tool.name === "get_write_operation")?.annotations?.readOnlyHint, true);
    const args = input("notes/http.txt", { content: "via HTTP MCP" });
    const result = await client.callTool({ name: "create_text_file", arguments: args });
    assert.equal(result.isError, false); assert.equal((result.structuredContent as Record<string, unknown>)?.ok, true);
    const read = await client.callTool({ name: "read_file", arguments: { root: "one", path: args.path, includeSha256: true } });
    assert.equal((read.structuredContent as Record<string, unknown>)?.sha256, sha256("via HTTP MCP"));
    const patch = await client.callTool({ name: "patch_text_file", arguments: input(args.path, {
      expected_sha256: sha256("via HTTP MCP"), operations: [{ find: "HTTP", replace: "transport" }],
    }) });
    assert.equal(patch.isError, false);
    const append = await client.callTool({ name: "append_text_file", arguments: input(args.path, { content: "!" }) });
    assert.equal(append.isError, false);
    const mkdir = await client.callTool({ name: "make_directory", arguments: input("notes/http-dir/sub") });
    assert.equal(mkdir.isError, false);
    const jsonCreate = await client.callTool({ name: "create_text_file", arguments: input("notes/http.json", { content: '{"x":1}' }) });
    assert.equal(jsonCreate.isError, false);
    const jsonUpdate = await client.callTool({ name: "update_json_value", arguments: input("notes/http.json", {
      expected_sha256: sha256('{"x":1}'), json_pointer: "/x", value: 2,
    }) });
    assert.equal(jsonUpdate.isError, false);
    assert.equal(await fs.readFile(path.join(f.first, args.path), "utf8"), "via transport MCP!");
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.first, "notes/http.json"), "utf8")), { x: 2 });
    const replay = await client.callTool({ name: "get_write_operation", arguments: { operation_id: args.operation_id } });
    assert.equal((replay.structuredContent as Record<string, unknown>)?.ok, true);
    const denied = await client.callTool({ name: "create_text_file", arguments: input("other.txt", { content: "denied" }) });
    assert.equal(denied.isError, true); assert.equal((denied.structuredContent as Record<string, unknown>)?.code, "WRITE_POLICY_DENIED");
  } finally { await client.close(); }
});
