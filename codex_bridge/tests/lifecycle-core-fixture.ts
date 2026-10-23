// Isolated real runtime. stdin EOF is test ownership cleanup, never production control.
import { join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { loadBridgeConfig } from "../src/config.js";
import { createBridgeRuntime } from "../src/runtime.js";
import { startRuntimeHttp } from "../src/http-main.js";
import { startCooperativeShutdown } from "../src/cooperative-shutdown.js";
import { currentProcessIdentity } from "../src/process-identity.js";
const root = resolve(process.argv[2]!);
await mkdir(join(root, "state"), { recursive: true });
await writeFile(join(root, "projects.json"), JSON.stringify({ projects: [{ id: "fixture", name: "Fixture", path: root }] }));
const config = await loadBridgeConfig({ CODEX_BRIDGE_PROJECT_ROOT: root, CODEX_BRIDGE_PROJECTS_FILE: join(root, "projects.json"),
  CODEX_BRIDGE_DATA_DIR: join(root, "state"), CODEX_HOME: join(root, "codex-home"),
  CODEX_BRIDGE_CODEX_COMMAND: process.execPath, CODEX_BRIDGE_CODEX_ARGS: '["app-server"]' });
await currentProcessIdentity();
const runtime = await createBridgeRuntime(config);
const http = await startRuntimeHttp(runtime, { host: "127.0.0.1", port: 0 });
const ipc = startCooperativeShutdown(runtime, http);
const close = async () => { try { await http.close(); } finally { await ipc.close(); } };
process.stdin.resume(); process.stdin.once("end", () => void close());
// Stop holding stdin open after the real controller has closed the runtime.
const original = runtime.close;
runtime.close = async () => { await original(); process.stdin.pause(); process.stdin.unref(); };
console.log(JSON.stringify({ port: http.port, buildId: config.buildId, proof: await currentProcessIdentity() }));
