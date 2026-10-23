// Direct close-chain regression only. This does NOT prove Windows signal delivery.
import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBridgeConfig } from "../dist/src/config.js";
import { createBridgeRuntime } from "../dist/src/runtime.js";
import { startBridgeHttpServer } from "../dist/src/http-server.js";
import { ApprovalStore } from "../dist/src/powershell-approval/store.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function fixture(t) {
  const base = join(projectRoot, ".tmp", "close-regression");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "run-"));
  const projectsFile = join(root, "projects.json");
  await writeFile(projectsFile, JSON.stringify({ projects: [{ id: "fixture", name: "Fixture", path: root }] }));
  const config = await loadBridgeConfig({ CODEX_BRIDGE_PROJECT_ROOT: projectRoot,
    CODEX_BRIDGE_PROJECTS_FILE: projectsFile, CODEX_BRIDGE_DATA_DIR: join(root, "data"),
    CODEX_BRIDGE_CODEX_COMMAND: process.execPath, CODEX_BRIDGE_CODEX_ARGS: '["app-server"]' });
  const runtime = await createBridgeRuntime(config);
  assert.ok(runtime.approvalStore);
  t.after(async () => { await runtime.approvalStore.close(); await rm(root, { recursive: true, force: true }); });
  return { runtime, directory: join(config.dataDir, "powershell-approval") };
}

test("HTTP listener closes before runtime; close awaits ApprovalStore and releases only its fixture lock", async (t) => {
  const { runtime, directory } = await fixture(t);
  const lock = join(directory, "approval.lock");
  await access(lock);
  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const closingStore = new Promise((resolve) => { entered = resolve; });
  const storeClose = runtime.approvalStore.close.bind(runtime.approvalStore);
  runtime.approvalStore.close = async () => {
    events.push("approval-close-enter"); entered(); await gate;
    await storeClose(); events.push("approval-close-complete");
  };
  const runtimeClose = runtime.close;
  runtime.close = async () => {
    events.push("runtime-close-enter");
    await assert.rejects(fetch(`http://127.0.0.1:${handle.port}/health`));
    events.push("listener-closed");
    await runtimeClose(); events.push("runtime-close-complete");
  };
  const handle = await startBridgeHttpServer(runtime, { host: "127.0.0.1", port: 0 });
  let settled = false;
  const closing = handle.close().then(() => { settled = true; events.push("http-close-complete"); });
  try {
    await closingStore;
    await access(lock);
    await assert.rejects(ApprovalStore.open(directory), (error) => error.code === "STORE_LOCKED");
    assert.equal(settled, false);
  } finally { release(); await closing; }
  await assert.rejects(access(lock), (error) => error.code === "ENOENT");
  assert.deepEqual(events, ["runtime-close-enter", "listener-closed", "approval-close-enter",
    "approval-close-complete", "runtime-close-complete", "http-close-complete"]);
  const reopened = await ApprovalStore.open(directory);
  await reopened.close();
});

test("runtime finally closes its ApprovalStore even if controller.close rejects", async (t) => {
  const { runtime, directory } = await fixture(t);
  const closeController = runtime.controller.close.bind(runtime.controller);
  runtime.controller.close = async () => { await closeController(); throw new Error("fixture controller close failed"); };
  await assert.rejects(runtime.close(), /fixture controller close failed/);
  await assert.rejects(access(join(directory, "approval.lock")), (error) => error.code === "ENOENT");
});
