import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_DENY_DIRS,
  DEFAULT_DENY_EXTENSIONS,
  loadConfig,
  type ServerConfig,
  type WorkspaceRootConfig,
} from "../src/config.js";
import { resolveWorkspacePath } from "../src/path-guard.js";
import { listProjects, readWorkspaceFile } from "../src/workspace.js";

test("resolveWorkspacePath allows files inside the workspace root", async () => {
  const config = await makeFixture();
  await fs.writeFile(path.join(config.root, "README.md"), "hello\nworld\n", "utf8");

  const resolved = await resolveWorkspacePath(config, "README.md", "file");

  assert.equal(resolved.relative, "README.md");
});

test("resolveWorkspacePath rejects traversal outside the workspace root", async () => {
  const config = await makeFixture();

  await assert.rejects(
    () => resolveWorkspacePath(config, "..", "directory"),
    /outside the configured workspace root/,
  );
});

test("resolveWorkspacePath rejects absolute paths even when they are inside an allowed root", async () => {
  const config = await makeFixture();
  const absolute = path.join(config.root, "README.md");
  await fs.writeFile(absolute, "inside but absolute", "utf8");

  await assert.rejects(
    () => resolveWorkspacePath(config, absolute, "file"),
    /relative to/,
  );
  await assert.rejects(
    () => resolveWorkspacePath(config, "C:\\GPT_MCPtool\\project_reading\\README.md", "file"),
    /relative to/,
  );
});

test("resolveWorkspacePath rejects denied secret-like files", async () => {
  const config = await makeFixture();
  await fs.writeFile(path.join(config.root, ".env"), "SECRET=1", "utf8");

  await assert.rejects(() => resolveWorkspacePath(config, ".env", "file"), /denied file name/);
});

test("resolveWorkspacePath rejects Codex credentials and runtime identity files", async () => {
  const config = await makeFixture();
  const deniedNames = [
    "auth.json",
    "cap_sid",
    "installation_id",
    "session_index.jsonl",
    "transcription-history.jsonl",
    ".codex-global-state.json",
    ".codex-global-state.json.bak",
  ];

  for (const name of deniedNames) {
    await fs.writeFile(path.join(config.root, name), "sensitive", "utf8");
    await assert.rejects(
      () => resolveWorkspacePath(config, name, "file"),
      /denied file name/,
      name,
    );
  }

  const tempState = "..codex-global-state.json.tmp-123";
  await fs.writeFile(path.join(config.root, tempState), "sensitive", "utf8");
  await assert.rejects(
    () => resolveWorkspacePath(config, tempState, "file"),
    /denied file name|outside the configured workspace root/,
  );
});

test("resolveWorkspacePath rejects globally denied runtime secret directories", async () => {
  const config = await makeFixture();
  const secretsDir = path.join(config.root, ".secrets");
  await fs.mkdir(secretsDir);
  await fs.writeFile(path.join(secretsDir, "key.txt"), "encrypted", "utf8");

  await assert.rejects(
    () => resolveWorkspacePath(config, ".secrets/key.txt", "file"),
    /denied directory/,
  );
});

test("loadConfig selects explicit roots and applies per-root denied directories", async () => {
  const projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-projects-"));
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-data-"));
  const config = await loadConfig({
    WORKSPACE_MCP_ROOTS: `projects=${projectsRoot};data=${dataRoot}`,
    WORKSPACE_MCP_DEFAULT_ROOT: "projects",
    WORKSPACE_MCP_ROOT_DENY_DIRS: "data=blocked-private",
  });

  await fs.mkdir(path.join(dataRoot, "blocked-private"));
  await fs.writeFile(path.join(dataRoot, "blocked-private", "orders.txt"), "private", "utf8");
  await fs.mkdir(path.join(dataRoot, "allowed-planning"));
  await fs.writeFile(path.join(dataRoot, "allowed-planning", "plan.txt"), "allowed", "utf8");

  await assert.rejects(
    () => resolveWorkspacePath(config, "blocked-private/orders.txt", "file", "data"),
    /denied directory/,
  );
  const allowed = await resolveWorkspacePath(config, "allowed-planning/plan.txt", "file", "data");
  assert.equal(allowed.rootId, "data");
  assert.equal(allowed.relative, "allowed-planning/plan.txt");
});

test("resolveWorkspacePath rejects unknown root ids", async () => {
  const config = await makeFixture();

  await assert.rejects(
    () => resolveWorkspacePath(config, ".", "directory", "unknown"),
    /Unknown workspace root/,
  );
});

test("loadConfig rejects root-specific deny rules for unknown roots", async () => {
  const projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-projects-"));

  await assert.rejects(
    () =>
      loadConfig({
        WORKSPACE_MCP_ROOTS: `projects=${projectsRoot}`,
        WORKSPACE_MCP_ROOT_DENY_DIRS: "data=private",
      }),
    /references unknown root data/,
  );
});

test("loadConfig accepts contained asset scopes and rejects unknown roots", async () => {
  const projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-projects-"));
  await fs.mkdir(path.join(projectsRoot, "shared"));
  const config = await loadConfig({
    WORKSPACE_MCP_ROOTS: `projects=${projectsRoot}`,
    WORKSPACE_MCP_ASSET_SCOPES: "shared_assets=projects:shared",
  });

  assert.deepEqual(config.assetScopes.get("shared_assets"), {
    id: "shared_assets",
    rootId: "projects",
    path: "shared",
  });
  await assert.rejects(
    () =>
      loadConfig({
        WORKSPACE_MCP_ROOTS: `projects=${projectsRoot}`,
        WORKSPACE_MCP_ASSET_SCOPES: "bad=data:shared",
      }),
    /references unknown root/,
  );
});

test("loadConfig requires file-return scopes to reference configured asset scopes", async () => {
  const projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-projects-"));
  await fs.mkdir(path.join(projectsRoot, "shared"));

  const config = await loadConfig({
    WORKSPACE_MCP_ROOTS: `projects=${projectsRoot}`,
    WORKSPACE_MCP_ASSET_SCOPES: "shared_assets=projects:shared",
    WORKSPACE_MCP_FILE_RETURN_SCOPES: "shared_assets",
  });
  assert.deepEqual(Array.from(config.fileReturnScopeIds), ["shared_assets"]);

  await assert.rejects(
    () =>
      loadConfig({
        WORKSPACE_MCP_ROOTS: `projects=${projectsRoot}`,
        WORKSPACE_MCP_ASSET_SCOPES: "shared_assets=projects:shared",
        WORKSPACE_MCP_FILE_RETURN_SCOPES: "unknown",
      }),
    /references unknown asset scope unknown/,
  );
});

test("loadConfig rejects asset scopes that traverse above a root", async () => {
  const projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-projects-"));

  await assert.rejects(
    () =>
      loadConfig({
        WORKSPACE_MCP_ROOTS: `projects=${projectsRoot}`,
        WORKSPACE_MCP_ASSET_SCOPES: "bad=projects:../private",
      }),
    /contained relative path/,
  );
});

test("readWorkspaceFile returns bounded line ranges", async () => {
  const config = await makeFixture();
  await fs.writeFile(path.join(config.root, "notes.txt"), "a\nb\nc\nd\n", "utf8");

  const result = (await readWorkspaceFile(config, {
    path: "notes.txt",
    startLine: 2,
    maxLines: 2,
  })) as { text: string; returnedLines: number; truncated: boolean };

  assert.equal(result.text, "b\nc");
  assert.equal(result.returnedLines, 2);
  assert.equal(result.truncated, true);
});

test("listProjects reports direct project metadata and skips denied folders", async () => {
  const config = await makeFixture();
  const project = path.join(config.root, "demo");
  await fs.mkdir(project);
  await fs.mkdir(path.join(config.root, "node_modules"));
  await fs.mkdir(path.join(project, ".git"));
  await fs.writeFile(path.join(project, "README.md"), "# Demo\n", "utf8");
  await fs.writeFile(path.join(project, "AGENTS.md"), "# Rules\n", "utf8");

  const result = (await listProjects(config)) as {
    count: number;
    skipped: number;
    projects: Array<{ name: string; isGitRepo: boolean; hasReadme: boolean; hasAgents: boolean }>;
  };

  assert.equal(result.count, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.projects[0]?.name, "demo");
  assert.equal(result.projects[0]?.isGitRepo, true);
  assert.equal(result.projects[0]?.hasReadme, true);
  assert.equal(result.projects[0]?.hasAgents, true);
});

async function makeFixture(): Promise<ServerConfig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-mcp-"));
  const realRoot = await fs.realpath(root);
  const denyDirs = new Set(DEFAULT_DENY_DIRS);
  const workspaceRoot: WorkspaceRootConfig = {
    id: "projects",
    path: realRoot,
    denyDirs: new Set(denyDirs),
  };
  return {
    defaultRootId: "projects",
    root: realRoot,
    roots: new Map([["projects", workspaceRoot]]),
    assetScopes: new Map(),
    fileReturnScopeIds: new Set(),
    runtimeIdentity: {
      applicationVersion: "test",
      toolContractVersion: "test",
      buildId: "test",
      buildTime: "2026-08-13T00:00:00.000Z",
      gitCommit: null,
      dirty: false,
      runtimeStartedAt: "2026-08-13T00:00:00.000Z",
    },
    searchRuntime: {
      preferred: "ripgrep",
      active: "javascript",
      version: null,
      source: "fallback",
      command: null,
    },
    maxFileBytes: 20_971_520,
    maxReturnedBytes: 4096,
    maxReadLines: 20,
    maxBatchFiles: 10,
    maxBatchTotalLines: 100,
    maxBatchTotalBytes: 16_384,
    maxSearchResults: 10,
    maxSearchReturnedBytes: 16_384,
    maxSearchVisitedEntries: 1_000,
    maxDirEntries: 20,
    searchTimeoutMs: 1000,
    gitTimeoutMs: 5_000,
    maxGitDiffFiles: 10,
    maxGitDiffLines: 1_000,
    maxGitDiffBytes: 262_144,
    maxCodeFiles: 100,
    maxCodeSymbols: 500,
    maxCodeResults: 100,
    maxCodeFileBytes: 1_048_576,
    maxCodeTotalBytes: 33_554_432,
    codeTimeoutMs: 5_000,
    maxImageFileBytes: 52_428_800,
    maxImagePixels: 100_000_000,
    maxImageDimension: 4_096,
    maxImageOutputBytes: 12_582_912,
    maxFetchFileBytes: 12_582_912,
    maxSpreadsheetFileBytes: 26_214_400,
    maxSpreadsheetExpandedBytes: 104_857_600,
    maxSpreadsheetZipEntries: 2_048,
    maxSpreadsheetCells: 5_000,
    maxSpreadsheetRows: 500,
    maxSpreadsheetColumns: 100,
    maxOfficeFileBytes: 104_857_600,
    maxOfficeExpandedBytes: 524_288_000,
    maxOfficeZipEntries: 4_096,
    maxOfficeXmlPartBytes: 10_485_760,
    maxOfficeXmlTotalBytes: 52_428_800,
    maxOfficeTextChars: 100_000,
    maxDocumentBlocks: 300,
    maxDocumentTableCells: 5_000,
    maxPresentationSlides: 50,
    maxPdfFileBytes: 52_428_800,
    maxPdfPages: 500,
    maxPdfReadPages: 10,
    maxPdfTextChars: 100_000,
    maxPdfRenderDimension: 4_096,
    maxPdfRenderPixels: 16_777_216,
    maxPdfOutputBytes: 12_582_912,
    pdfTimeoutMs: 15_000,
    denyDirs,
    denyExtensions: new Set(DEFAULT_DENY_EXTENSIONS),
  };
}
