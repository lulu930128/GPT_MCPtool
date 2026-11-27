import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync, linkSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { RuntimeDiagnostics, diagnosticError } from "../src/runtime-diagnostics.js";
import { startBridgeHttpServer } from "../src/http-server.js";
import type { BridgeRuntime } from "../src/runtime.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const moduleUrl = new URL("../src/runtime-diagnostics.js", import.meta.url).href;
const secret = "PRIVATE_PROMPT_AND_TOKEN_do_not_store";
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "bridge-diagnostics-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { dataDir: root, projectRoot, buildId: "0123456789abcdef" };
}
function rows(path: string) { return readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line)); }

test("diagnostics persist bounded code locations, never messages, arbitrary codes or external paths", (t) => {
  const config = fixture(t);
  const logger = new RuntimeDiagnostics(config); t.after(() => logger.dispose());
  const error = Object.assign(new TypeError(secret), { code: secret, token: secret });
  const source = pathToFileURL(join(projectRoot, "dist", "src", "http-main.js")).href;
  error.stack = `TypeError: ${secret}\n    at ${secret} (${source}:12:34)\n    at ${secret} (file:///private/${secret}.js:1:2)`;
  assert.equal(logger.record("http_error", { error }), true);
  const text = readFileSync(logger.path, "utf8");
  assert.equal(text.includes(secret), false);
  const row = rows(logger.path).at(-1);
  assert.deepEqual(row.error, { name: "TypeError", frames: [{ file: "dist/src/http-main.js", line: 12, column: 34 }] });
  assert.equal(row.pid, process.pid); assert.equal(row.buildId, config.buildId);
  assert.ok(row.memory.rss > 0);
  const osError = Object.assign(new Error(secret), { code: "ENOSPC" });
  assert.equal(diagnosticError(osError, projectRoot).code, "ENOSPC");
  assert.equal(diagnosticError(new Error("COOPERATIVE_CHANNEL_UNAVAILABLE"), projectRoot).code, "COOPERATIVE_CHANNEL_UNAVAILABLE");
  assert.deepEqual(diagnosticError(secret, projectRoot), { name: "Unknown", frames: [] });
  const hostile = Object.defineProperty(new Error(), "name", { get() { throw new Error(secret); } });
  assert.doesNotThrow(() => logger.record("uncaught_exception", { error: hostile }));
});

test("caught HTTP errors reach diagnostics without persisting the request body", async (t) => {
  const logger = new RuntimeDiagnostics(fixture(t));
  const runtime = { close: async () => {} } as unknown as BridgeRuntime;
  const http = await startBridgeHttpServer(runtime, { host: "127.0.0.1", port: 0,
    onError: error => { logger.record("http_error", { error }); } });
  try {
    const response = await fetch(http.url, { method: "POST", body: secret });
    assert.equal(response.status, 500);
    assert.equal((await response.json() as { error: { code: number } }).error.code, -32603);
    const record = rows(logger.path).at(-1);
    assert.equal(record.event, "http_error");
    assert.equal(record.error.name, "SyntaxError");
    assert.equal(readFileSync(logger.path, "utf8").includes(secret), false);
  } finally { await http.close(); logger.dispose(); }
});

test("HTTP floods are capped and report dropped records without suppressing fatal events", (t) => {
  const logger = new RuntimeDiagnostics(fixture(t)); t.after(() => logger.dispose());
  for (let n = 0; n < 100; n++) logger.record("http_error", { error: new Error(secret) });
  logger.record("uncaught_exception", { error: new Error(secret) });
  const records = rows(logger.path);
  assert.equal(records.filter(row => row.event === "http_error").length, 60);
  assert.equal(records.at(-1).event, "uncaught_exception");
  assert.equal(records.at(-1).droppedHttpErrors, 40);
});

test("rotation keeps only four bounded fixed-name log files", (t) => {
  const logger = new RuntimeDiagnostics(fixture(t)); t.after(() => logger.dispose());
  for (let n = 0; n < 6; n++) {
    writeFileSync(logger.path, "x".repeat(1_048_576));
    assert.equal(logger.record("heartbeat"), true);
  }
  for (const suffix of ["", ".1", ".2", ".3"]) assert.ok(statSync(logger.path + suffix).size <= 1_048_576);
  assert.throws(() => statSync(logger.path + ".4"), { code: "ENOENT" });
  assert.equal(rows(logger.path).at(-1).event, "heartbeat");
});

test("linked files are refused and write failures never throw from the error observer", (t) => {
  const config = fixture(t);
  const logger = new RuntimeDiagnostics(config); t.after(() => logger.dispose());
  const protectedFile = join(config.dataDir, "preserve.txt");
  writeFileSync(protectedFile, secret);
  unlinkSync(logger.path); linkSync(protectedFile, logger.path);
  assert.equal(logger.record("uncaught_exception", { error: new Error(secret) }), false);
  assert.equal(readFileSync(protectedFile, "utf8"), secret);
  unlinkSync(logger.path); mkdirSync(logger.path);
  assert.equal(logger.record("runtime_exit", { exitCode: 1 }), false);
  assert.throws(() => new RuntimeDiagnostics(config), /RUNTIME_DIAGNOSTICS_UNAVAILABLE/);
});

for (const [mode, trigger, expected] of [
  ["uncaught", "setImmediate(() => { throw new TypeError('fixture secret'); });", "uncaught_exception"],
  ["rejection", "void Promise.reject(new Error('fixture secret'));", "unhandled_rejection"],
  ["normal", "logger.record('runtime_ready');", "runtime_ready"],
] as const) {
  test(`real ${mode} child preserves Node exit behavior and synchronously records exit`, (t) => {
    const config = fixture(t);
    const script = `import { RuntimeDiagnostics } from ${JSON.stringify(moduleUrl)};\nconst logger = new RuntimeDiagnostics(${JSON.stringify(config)});\n${trigger}`;
    const result = spawnSync(process.execPath, ["--unhandled-rejections=throw", "--input-type=module", "-e", script],
      { encoding: "utf8", timeout: 10_000, windowsHide: true });
    assert.equal(result.error, undefined);
    assert.equal(result.status, mode === "normal" ? 0 : 1);
    const path = join(config.dataDir, "diagnostics", "runtime.jsonl");
    const records = rows(path);
    assert.ok(records.some(row => row.event === expected));
    assert.equal(records.at(-1).event, "runtime_exit");
    assert.equal(records.at(-1).exitCode, result.status);
    assert.equal(readFileSync(path, "utf8").includes("fixture secret"), false);
  });
}

test("pipeline summaries aggregate tokens, persist failed-write counts, and preserve correlation without content",t=>{
  const config=fixture(t), log=new RuntimeDiagnostics(config);
  t.after(()=>log.dispose());
  const jobId="00000000-0000-4000-a000-000000000001";
  for(let i=0;i<48000;i++) log.observe("queue","received",{jobId,threadId:secret,elapsedMs:i%3});
  assert.equal(rows(log.path).length,1);
  const other=join(config.dataDir,"other");
  writeFileSync(other,secret); unlinkSync(log.path); linkSync(other,log.path);
  assert.equal(log.record("heartbeat"),false);
  unlinkSync(log.path);
  assert.equal(log.record("heartbeat"),true);
  const row=rows(log.path).at(-1);
  assert.equal(row.writeFailures,1);
  assert.equal(row.groups[0].count,48000);
  assert.equal(row.groups[0].maxMs,2);
  assert.ok(!readFileSync(log.path,"utf8").includes(secret));
  assert.equal(readFileSync(other,"utf8"),secret);
});
