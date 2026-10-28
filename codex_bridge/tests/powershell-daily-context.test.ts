import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolvePowerShellHostContext } from "../src/installed-runtime.js";

test("daily transport context preserves its own root without inventing installed binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-normal-daily-"));
  const runtime = join(root, "codex_bridge", "Runtime"), release = join(runtime, "versions", "fixture-a");
  const codeRoot = join(release, "codex_bridge");
  await mkdir(codeRoot, { recursive: true });
  await writeFile(join(release, "daily-mode.json"), JSON.stringify({ contract: "mcpcc-daily-user-v1", trayOwner: "independent-cc" }));
  await writeFile(join(runtime, "current.json"), JSON.stringify({ contract: "mcpcc-daily-current-v1", version: "fixture-a" }));
  assert.deepEqual(await resolvePowerShellHostContext(undefined, codeRoot), { mode: "daily", codeRoot });
  assert.equal(await resolvePowerShellHostContext(undefined, root), undefined);
  await writeFile(join(runtime, "current.json"), JSON.stringify({ contract: "mcpcc-daily-current-v1", version: "fixture-b" }));
  await assert.rejects(resolvePowerShellHostContext(undefined, codeRoot), /NORMAL_DEPLOYMENT_SELECTION_CHANGED/);
  await writeFile(join(runtime, "current.json"), JSON.stringify({ contract: "mcpcc-daily-current-v1", version: "fixture-a" }));
  await writeFile(join(release, "daily-mode.json"), JSON.stringify({ contract: "mcpcc-daily-user-v1", trayOwner: "caller-forged-owner" }));
  await assert.rejects(resolvePowerShellHostContext(undefined, codeRoot), /NORMAL_DEPLOYMENT_SELECTION_CHANGED/);
  await writeFile(join(release, "daily-mode.json"), "invalid-json");
  await assert.rejects(resolvePowerShellHostContext(undefined, codeRoot), /NORMAL_DEPLOYMENT_INVALID/);
  await unlink(join(release, "daily-mode.json"));
  await assert.rejects(resolvePowerShellHostContext(undefined, codeRoot), /NORMAL_DEPLOYMENT_MISSING/);
});
