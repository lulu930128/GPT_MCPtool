import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, type ServerConfig } from "../src/config.js";
import {
  findFiles,
  readWorkspaceFile,
  readWorkspaceFiles,
  searchText,
} from "../src/workspace.js";

test("large text files support bounded middle windows", async () => {
  const fixture = await makeFixture();
  const lines = Array.from({ length: 40_000 }, (_, index) => `line-${index + 1}`);
  await fs.writeFile(path.join(fixture.root, "large.log"), lines.join("\r\n"), "utf8");

  const result = (await readWorkspaceFile(fixture.config, {
    path: "large.log",
    startLine: 30_000,
    maxLines: 3,
  })) as {
    text: string;
    startLine: number;
    returnedLines: number;
    bytes: number;
    truncated: boolean;
  };

  assert.ok(result.bytes > 262_144);
  assert.equal(result.startLine, 30_000);
  assert.equal(result.returnedLines, 3);
  assert.equal(result.text, "line-30000\nline-30001\nline-30002");
  assert.equal(result.truncated, true);
});

test("read_files preflights every path and enforces the aggregate line budget", async () => {
  const fixture = await makeFixture();
  await fs.writeFile(path.join(fixture.root, "a.txt"), "a1\na2\n", "utf8");
  await fs.writeFile(path.join(fixture.root, "b.txt"), "b1\nb2\n", "utf8");
  await fs.writeFile(path.join(fixture.root, ".env"), "SECRET=not-returned", "utf8");

  await assert.rejects(
    () =>
      readWorkspaceFiles(fixture.config, {
        files: [{ path: "a.txt", maxLines: 1 }, { path: ".env", maxLines: 1 }],
      }),
    /denied file name/,
  );
  await assert.rejects(
    () =>
      readWorkspaceFiles(fixture.config, {
        files: [
          { path: "a.txt", maxLines: 20 },
          { path: "b.txt", maxLines: 20 },
        ],
      }),
    /line budget/,
  );

  const result = (await readWorkspaceFiles(fixture.config, {
    files: [
      { path: "a.txt", maxLines: 2 },
      { path: "b.txt", maxLines: 2 },
    ],
  })) as { count: number; files: Array<{ path: string; text: string }> };
  assert.equal(result.count, 2);
  assert.deepEqual(
    result.files.map((file) => [file.path, file.text]),
    [
      ["a.txt", "a1\na2"],
      ["b.txt", "b1\nb2"],
    ],
  );
});

test("find_files applies relative glob, extension, deny, and output rules", async () => {
  const fixture = await makeFixture();
  await fs.mkdir(path.join(fixture.root, "src"));
  await fs.mkdir(path.join(fixture.root, "node_modules"));
  await fs.writeFile(path.join(fixture.root, "src", "technical_indicator.py"), "pass\n", "utf8");
  await fs.writeFile(path.join(fixture.root, "src", "indicator.md"), "docs\n", "utf8");
  await fs.writeFile(path.join(fixture.root, "node_modules", "hidden_indicator.py"), "pass\n", "utf8");

  const result = (await findFiles(fixture.config, {
    pattern: "**/*indicator*",
    extensions: [".py"],
  })) as { results: string[]; count: number };
  assert.deepEqual(result.results, ["src/technical_indicator.py"]);
  assert.equal(result.count, 1);

  await assert.rejects(
    () => findFiles(fixture.config, { pattern: "C:\\**\\*.py" }),
    /relative include pattern/,
  );
});

test("JavaScript search fallback returns bounded context and excludes denied files", async () => {
  const fixture = await makeFixture();
  fixture.config.searchRuntime = {
    preferred: "ripgrep",
    active: "javascript",
    version: null,
    source: "fallback",
    command: null,
  };
  await fs.mkdir(path.join(fixture.root, "src"));
  await fs.writeFile(
    path.join(fixture.root, "src", "server.ts"),
    ["before one", "before two", "registerTool()", "after one", "after two"].join("\n"),
    "utf8",
  );
  await fs.writeFile(path.join(fixture.root, ".env"), "registerTool(secret)", "utf8");

  const result = (await searchText(fixture.config, {
    query: "registerTool",
    glob: "**/*.ts",
    beforeLines: 2,
    afterLines: 1,
  })) as {
    engine: string;
    count: number;
    results: Array<{ path: string; line: number; startLine: number; endLine: number; text: string }>;
  };
  assert.equal(result.engine, "javascript");
  assert.equal(result.count, 1);
  assert.deepEqual(result.results[0], {
    path: "src/server.ts",
    line: 3,
    startLine: 1,
    endLine: 4,
    matchText: "registerTool()",
    text: "before one\nbefore two\nregisterTool()\nafter one",
    truncated: false,
  });
});

async function makeFixture(): Promise<{ root: string; config: ServerConfig }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-enhancements-"));
  const config = await loadConfig({
    WORKSPACE_MCP_ROOTS: `projects=${root}`,
    WORKSPACE_MCP_DEFAULT_ROOT: "projects",
    WORKSPACE_MCP_MAX_RETURNED_BYTES: "4096",
    WORKSPACE_MCP_MAX_READ_LINES: "20",
    WORKSPACE_MCP_MAX_BATCH_TOTAL_LINES: "20",
    WORKSPACE_MCP_MAX_BATCH_TOTAL_BYTES: "8192",
  });
  return { root, config };
}
