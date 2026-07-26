import assert from "node:assert/strict";

const mcpUrl = process.env.WORKSPACE_MCP_SMOKE_URL?.trim() || "http://127.0.0.1:8787/mcp";
let nextId = 1;
let sessionId;

async function rpc(method, params) {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json; charset=utf-8",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method,
      params,
    }),
  });
  assert.equal(response.status, 200, `${method} returned HTTP ${response.status}`);
  sessionId ||= response.headers.get("mcp-session-id") || undefined;
  const payload = parseResponseBody(await response.text());
  if (payload.error) {
    throw new Error(`${method} failed: ${JSON.stringify(payload.error)}`);
  }
  return payload.result;
}

function parseResponseBody(body) {
  const dataLines = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));
  return JSON.parse(dataLines.at(-1) || body);
}

async function callTool(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.equal(typeof text, "string", `${name} did not return text content`);
  return JSON.parse(text);
}

const initialized = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "multi-root-live-smoke", version: "1.0" },
});
assert.equal(initialized.serverInfo.version, "0.3.0");

const listedTools = await rpc("tools/list", {});
const tools = listedTools.tools;
assert.equal(tools.length, 7);
assert.equal(
  tools.filter((tool) => tool.inputSchema?.properties?.root).length,
  6,
);

const workspaceInfo = await callTool("workspace_info", {});
const rootIds = workspaceInfo.roots.map((root) => root.id);
assert.ok(rootIds.length > 0);
assert.ok(rootIds.includes(workspaceInfo.defaultRoot));

const rootCounts = {};
for (const root of rootIds) {
  const listing = await callTool("list_dir", {
    root,
    path: ".",
    depth: 0,
    maxEntries: 20,
  });
  assert.equal(listing.root, root);
  rootCounts[root] = listing.count;
}

const approvedChecks = [];
const deniedChecks = [];

if (rootIds.includes("mcp_tools")) {
  const deniedSecret = await callTool("list_dir", {
    root: "mcp_tools",
    path: "project_reading/.secrets",
    depth: 0,
    maxEntries: 5,
  });
  assert.equal(deniedSecret.ok, false);
  assert.match(deniedSecret.error, /denied directory/);
  deniedChecks.push("mcp_tools:project_reading/.secrets");
}

const deniedRoot = process.env.WORKSPACE_MCP_SMOKE_DENIED_ROOT?.trim();
const deniedPath = process.env.WORKSPACE_MCP_SMOKE_DENIED_PATH?.trim();
if (deniedRoot || deniedPath) {
  assert.ok(deniedRoot && deniedPath, "Both denied smoke root and path are required.");
  const denied = await callTool("list_dir", {
    root: deniedRoot,
    path: deniedPath,
    depth: 0,
    maxEntries: 5,
  });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /denied directory|denied file/);
  deniedChecks.push(`${deniedRoot}:${deniedPath}`);
}

const allowedRoot = process.env.WORKSPACE_MCP_SMOKE_ALLOWED_ROOT?.trim();
const allowedPath = process.env.WORKSPACE_MCP_SMOKE_ALLOWED_PATH?.trim();
if (allowedRoot || allowedPath) {
  assert.ok(allowedRoot && allowedPath, "Both allowed smoke root and path are required.");
  const allowed = await callTool("list_dir", {
    root: allowedRoot,
    path: allowedPath,
    depth: 0,
    maxEntries: 5,
  });
  assert.equal(allowed.root, allowedRoot);
  approvedChecks.push(`${allowedRoot}:${allowedPath}`);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      serverVersion: initialized.serverInfo.version,
      toolCount: tools.length,
      toolsWithRoot: tools.filter((tool) => tool.inputSchema?.properties?.root).length,
      defaultRoot: workspaceInfo.defaultRoot,
      roots: rootIds,
      rootCounts,
      approvedChecks,
      deniedChecks,
    },
    null,
    2,
  ),
);
