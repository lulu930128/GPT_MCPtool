import assert from "node:assert/strict";
import { loadConfig } from "../dist/src/config.js";
import { resolveWorkspacePath } from "../dist/src/path-guard.js";
import { listDirectory } from "../dist/src/workspace.js";

const configuredRoots = process.env.WORKSPACE_MCP_ROOTS?.trim();
if (!configuredRoots) {
  throw new Error(
    "WORKSPACE_MCP_ROOTS is required for smoke:roots. Use only roots you explicitly approved.",
  );
}

const config = await loadConfig({
  ...process.env,
  WORKSPACE_MCP_ROOTS: configuredRoots,
});
const expectedRootIds = Array.from(config.roots.keys());

assert.ok(expectedRootIds.length > 0);
assert.ok(config.roots.has(config.defaultRootId));

const summaries = [];
for (const root of expectedRootIds) {
  const listing = await listDirectory(config, {
    root,
    path: ".",
    depth: 0,
    maxEntries: 200,
  });
  summaries.push({
    root,
    count: listing.count,
    skipped: listing.skipped,
    truncated: listing.truncated,
  });
}

const deniedChecks = [];
const approvedChecks = [];

if (config.roots.has("mcp_tools")) {
  await assert.rejects(
    () => resolveWorkspacePath(config, "project_reading/.secrets", "directory", "mcp_tools"),
    /denied directory/,
  );
  deniedChecks.push("mcp_tools:project_reading/.secrets");
}

await assert.rejects(
  () => resolveWorkspacePath(config, "../outside", "directory", config.defaultRootId),
  /outside the configured workspace root/,
);
deniedChecks.push(`${config.defaultRootId}:../outside`);

const deniedRoot = process.env.WORKSPACE_MCP_SMOKE_DENIED_ROOT?.trim();
const deniedPath = process.env.WORKSPACE_MCP_SMOKE_DENIED_PATH?.trim();
if (deniedRoot || deniedPath) {
  assert.ok(deniedRoot && deniedPath, "Both denied smoke root and path are required.");
  await assert.rejects(
    () => resolveWorkspacePath(config, deniedPath, undefined, deniedRoot),
    /denied directory|denied file/,
  );
  deniedChecks.push(`${deniedRoot}:${deniedPath}`);
}

const allowedRoot = process.env.WORKSPACE_MCP_SMOKE_ALLOWED_ROOT?.trim();
const allowedPath = process.env.WORKSPACE_MCP_SMOKE_ALLOWED_PATH?.trim();
if (allowedRoot || allowedPath) {
  assert.ok(allowedRoot && allowedPath, "Both allowed smoke root and path are required.");
  const allowed = await resolveWorkspacePath(config, allowedPath, undefined, allowedRoot);
  assert.equal(allowed.rootId, allowedRoot);
  approvedChecks.push(`${allowedRoot}:${allowedPath}`);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      defaultRoot: config.defaultRootId,
      roots: summaries,
      deniedChecks,
      approvedChecks,
    },
    null,
    2,
  ),
);
