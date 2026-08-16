import assert from "node:assert/strict";

const mcpUrl = process.env.WORKSPACE_MCP_SMOKE_URL?.trim() || "http://127.0.0.1:18787/mcp";
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
  const parsed = JSON.parse(text);
  assert.equal(typeof result.structuredContent, "object", `${name} did not return structured content`);
  assert.deepEqual(JSON.parse(JSON.stringify(result.structuredContent)), parsed);
  assert.equal(result.isError === true, parsed.ok === false);
  return parsed;
}

const initialized = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "multi-root-live-smoke", version: "1.5.0" },
});
assert.equal(initialized.serverInfo.version, "1.5.0");

const resourceTemplates = await rpc("resources/templates/list", {});
assert.ok(
  resourceTemplates.resourceTemplates.some(
    (template) => template.uriTemplate === "workspace-asset:///{scope}/{+path}",
  ),
);

const listedTools = await rpc("tools/list", {});
const tools = listedTools.tools;
assert.equal(tools.length, 24);
const projectMapTool = tools.find((tool) => tool.name === "project_map");
assert.ok(projectMapTool, "project_map is missing from tools/list");
assert.match(projectMapTool.inputSchema.properties.maxFiles.description, /Defaults to 30/);
assert.match(projectMapTool.inputSchema.properties.maxTotalSymbols.description, /Defaults to 300/);
assert.match(projectMapTool.inputSchema.properties.maxSymbolsPerFile.description, /Defaults to 50/);
assert.match(projectMapTool.inputSchema.properties.maxResults.description, /Deprecated alias/);
const readImageDescription =
  "Read an allowed JPEG, PNG, WebP, or GIF image. Animated GIF files are decoded and returned as a static PNG frame; animation metadata such as frame count is included, but animation is discarded.";
assert.equal(
  tools.find((tool) => tool.name === "read_image")?.description,
  readImageDescription,
);
assert.equal(
  tools.filter((tool) => tool.inputSchema?.properties?.root).length,
  14,
);
assert.deepEqual(
  tools
    .filter((tool) => tool.inputSchema?.properties?.scope)
    .map((tool) => tool.name)
    .sort(),
  [
    "fetch_asset",
    "inspect_asset",
    "inspect_pdf",
    "read_document",
    "read_image",
    "read_pdf_page",
    "read_pdf_text",
    "read_presentation",
    "read_spreadsheet",
  ],
);

const workspaceInfo = await callTool("workspace_info", {});
const rootIds = workspaceInfo.roots.map((root) => root.id);
assert.ok(rootIds.length > 0);
assert.ok(rootIds.includes(workspaceInfo.defaultRoot));
assert.equal(workspaceInfo.applicationVersion, "1.5.0");
assert.equal(workspaceInfo.toolContractVersion, "2026-08-14.3");
assert.equal(workspaceInfo.limits.fetch.maxFileBytes, 12_582_912);
assert.ok(workspaceInfo.limits.fetch.enabledScopes.includes("projects"));
assert.equal(typeof workspaceInfo.buildId, "string");
assert.equal(typeof workspaceInfo.runtimeStartedAt, "string");
assert.equal(workspaceInfo.search.active, "ripgrep");
assert.equal(workspaceInfo.search.source, "bundled");

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
  const found = await callTool("find_files", {
    root: "mcp_tools",
    path: "project_reading",
    pattern: "package.json",
    maxResults: 5,
  });
  assert.deepEqual(found.results, ["package.json"]);

  const search = await callTool("search_text", {
    root: "mcp_tools",
    path: "project_reading/src",
    query: "createWorkspaceMcpServer",
    glob: "**/*.ts",
    beforeLines: 1,
    afterLines: 1,
    maxResults: 5,
  });
  assert.ok(search.count >= 1);
  assert.ok(search.results[0].startLine <= search.results[0].line);
  assert.ok(search.results[0].endLine >= search.results[0].line);

  const symbol = await callTool("find_symbol", {
    root: "mcp_tools",
    path: "project_reading/src",
    symbol: "createWorkspaceMcpServer",
    maxResults: 5,
  });
  assert.equal(symbol.semantic, false);
  assert.ok(symbol.definitions.some((definition) => definition.path === "server.ts"));

  const projectMap = await callTool("project_map", {
    root: "mcp_tools",
    path: "project_reading/src",
    maxFiles: 5,
    maxTotalSymbols: 12,
    maxSymbolsPerFile: 3,
  });
  assert.deepEqual(projectMap.appliedLimits, {
    maxFiles: 5,
    maxTotalSymbols: 12,
    maxSymbolsPerFile: 3,
  });
  assert.ok(projectMap.fileCount <= 5);
  assert.ok(projectMap.symbolCount <= 12);
  assert.ok(projectMap.files.every((file) => file.symbolCount <= 3));
  assert.ok(projectMap.truncationReasons.includes("maxFiles"));

  const legacyProjectMap = await callTool("project_map", {
    root: "mcp_tools",
    path: "project_reading/src",
    maxResults: 30,
  });
  assert.deepEqual(legacyProjectMap.appliedLimits, {
    maxFiles: 30,
    maxTotalSymbols: 300,
    maxSymbolsPerFile: 50,
  });
  assert.deepEqual(legacyProjectMap.deprecatedInputs, ["maxResults"]);
  assert.ok(legacyProjectMap.symbolCount <= 300);
  assert.ok(legacyProjectMap.files.every((file) => file.symbolCount <= 50));

  const conflictingProjectMap = await callTool("project_map", {
    root: "mcp_tools",
    path: "project_reading/src",
    maxFiles: 5,
    maxResults: 4,
  });
  assert.equal(conflictingProjectMap.ok, false);
  assert.match(conflictingProjectMap.error, /deprecated alias for maxFiles/);

  const git = await callTool("git_status_summary", {
    root: "mcp_tools",
    project: "project_reading",
  });
  assert.equal(git.git.relation, "parent");
  assert.ok(git.changedFiles.every((file) => !file.includes("../")));

  const deniedSecret = await callTool("list_dir", {
    root: "mcp_tools",
    path: "project_reading/.secrets",
    depth: 0,
    maxEntries: 5,
  });
  assert.equal(deniedSecret.ok, false);
  assert.match(deniedSecret.error, /denied directory/);
  deniedChecks.push("mcp_tools:project_reading/.secrets");

  const deniedAbsolute = await callTool("read_file", {
    root: "mcp_tools",
    path: "C:\\GPT_MCPtool\\project_reading\\README.md",
  });
  assert.equal(deniedAbsolute.ok, false);
  assert.match(deniedAbsolute.error, /relative to/);
  deniedChecks.push("mcp_tools:absolute-path");
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
  applicationVersion: workspaceInfo.applicationVersion,
  toolContractVersion: workspaceInfo.toolContractVersion,
  buildId: workspaceInfo.buildId,
  buildTime: workspaceInfo.buildTime,
  gitCommit: workspaceInfo.gitCommit,
  dirty: workspaceInfo.dirty,
  runtimeStartedAt: workspaceInfo.runtimeStartedAt,
  search: workspaceInfo.search,
  toolCount: tools.length,
  readImageDescription,
      toolsWithRoot: tools.filter((tool) => tool.inputSchema?.properties?.root).length,
      defaultRoot: workspaceInfo.defaultRoot,
      roots: rootIds,
      assetScopes: workspaceInfo.assetScopes.map((scope) => scope.id),
      fileReturnScopes: workspaceInfo.limits.fetch.enabledScopes,
      rootCounts,
      approvedChecks,
      deniedChecks,
    },
    null,
    2,
  ),
);
