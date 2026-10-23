// Default mode reads only canonical build inputs. Explicit startup-preflight
// mode also validates launch config, without opening runtime state or stores.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";

try {
  const preflight = process.argv.length === 3 && process.argv[2] === "--startup-preflight";
  if (process.argv.length !== 2 && !preflight) throw new Error("Unexpected arguments");
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { computeRuntimeBuildId, loadBridgeConfig } = await import("../dist/src/config.js");
  if (preflight) {
    // Load the same config and module graph, never http-main (which starts the
    // runtime), createBridgeRuntime, a store, a socket, or a Codex subprocess.
    const manifest = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
    if (manifest.type !== "module") throw new Error("Invalid package manifest");
    const syntax = spawnSync(process.execPath, ["--check", resolve(projectRoot, "dist/src/http-main.js")],
      { timeout: 3000, windowsHide: true, stdio: "ignore", env: { SystemRoot: process.env.SystemRoot } });
    if (syntax.status !== 0 || syntax.error) throw new Error("Invalid HTTP entry");
    await import("../dist/src/http-server.js");
    await import("../dist/src/runtime.js");
    const config = await loadBridgeConfig();
    if (config.projectRoot !== projectRoot) throw new Error("Unexpected config root");
    for (const path of [config.widgetPath, resolve(projectRoot, "web/self-reload.html")]) {
      await readFile(path, "utf8");
    }
    // A PATH-only Codex command cannot be attested here. Refuse instead of
    // testing it by execution or silently accepting a missing executable.
    if (!isAbsolute(config.codexCommand) || !(await stat(config.codexCommand)).isFile()) {
      throw new Error("Unverified Codex executable");
    }
  }
  process.stdout.write(`${await computeRuntimeBuildId(projectRoot)}\n`);
} catch {
  // Never forward loader errors, paths, environment values, or file contents.
  process.stderr.write("BUILD_ID_COMPUTE_FAILED\n");
  process.exitCode = 1;
}
