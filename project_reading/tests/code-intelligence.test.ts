import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findReferences, findSymbol, importGraph, projectMap } from "../src/code-intelligence.js";
import { loadConfig } from "../src/config.js";

test("code intelligence reports deterministic lexical definitions and references", async () => {
  const fixture = await makeFixture();
  const symbolResult = (await findSymbol(fixture.config, {
    path: "demo",
    symbol: "calculate_rsi",
  })) as {
    analysisMode: string;
    semantic: boolean;
    definitions: Array<{ path: string; line: number; kind: string }>;
  };
  assert.equal(symbolResult.analysisMode, "deterministic-lexical");
  assert.equal(symbolResult.semantic, false);
  assert.deepEqual(symbolResult.definitions, [
    { path: "indicators/rsi.py", language: "python", name: "calculate_rsi", line: 1, kind: "function" },
  ]);

  const references = (await findReferences(fixture.config, {
    path: "demo",
    symbol: "calculate_rsi",
  })) as { references: Array<{ path: string; line: number; isDefinition: boolean }> };
  assert.deepEqual(
    references.references.map(({ path: file, line, isDefinition }) => [file, line, isDefinition]),
    [
      ["api.py", 1, false],
      ["api.py", 4, false],
      ["indicators/rsi.py", 1, true],
    ],
  );
});

test("import_graph and project_map expose limitations and bounded structure", async () => {
  const fixture = await makeFixture();
  const graph = (await importGraph(fixture.config, { path: "demo" })) as {
    edges: Array<{ from: string; module: string; resolvedPath: string | null; external: boolean }>;
    limitations: string[];
  };
  assert.ok(graph.limitations.some((value) => value.includes("not compiler")));
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.from === "web.ts" &&
        edge.module === "./service" &&
        edge.resolvedPath === "service.ts" &&
        edge.external === false,
    ),
  );

  const map = (await projectMap(fixture.config, { path: "demo" })) as {
    fileCount: number;
    symbolCount: number;
    files: Array<{ path: string; symbols: Array<{ name: string }> }>;
    appliedLimits: { maxFiles: number; maxTotalSymbols: number; maxSymbolsPerFile: number };
    deprecatedInputs: string[];
  };
  assert.equal(map.fileCount, 4);
  assert.ok(map.symbolCount >= 4);
  assert.ok(map.files.some((file) => file.path === "service.ts" && file.symbols[0]?.name === "Service"));
  assert.deepEqual(map.appliedLimits, {
    maxFiles: 30,
    maxTotalSymbols: 300,
    maxSymbolsPerFile: 50,
  });
  assert.deepEqual(map.deprecatedInputs, []);

  const explicitLimits = (await projectMap(fixture.config, {
    path: "demo",
    maxFiles: 3,
    maxTotalSymbols: 2,
    maxSymbolsPerFile: 1,
  })) as {
    fileCount: number;
    symbolCount: number;
    files: Array<{ symbolCount: number; truncated: boolean; truncationReasons: string[] }>;
    appliedLimits: { maxFiles: number; maxTotalSymbols: number; maxSymbolsPerFile: number };
    truncated: boolean;
    truncationReasons: string[];
  };
  assert.equal(explicitLimits.fileCount, 3);
  assert.equal(explicitLimits.symbolCount, 2);
  assert.ok(explicitLimits.files.every((file) => file.symbolCount <= 1));
  assert.deepEqual(explicitLimits.appliedLimits, {
    maxFiles: 3,
    maxTotalSymbols: 2,
    maxSymbolsPerFile: 1,
  });
  assert.equal(explicitLimits.truncated, true);
  assert.ok(explicitLimits.truncationReasons.includes("maxFiles"));
  assert.ok(explicitLimits.truncationReasons.includes("maxTotalSymbols"));

  const legacyAlias = (await projectMap(fixture.config, {
    path: "demo",
    maxResults: 2,
  })) as {
    fileCount: number;
    appliedLimits: { maxFiles: number };
    deprecatedInputs: string[];
  };
  assert.equal(legacyAlias.fileCount, 2);
  assert.equal(legacyAlias.appliedLimits.maxFiles, 2);
  assert.deepEqual(legacyAlias.deprecatedInputs, ["maxResults"]);

  await assert.rejects(
    projectMap(fixture.config, { path: "demo", maxFiles: 3, maxResults: 2 }),
    /deprecated alias for maxFiles; do not provide conflicting values/,
  );

  fixture.config.maxCodeResults = 2;
  fixture.config.maxCodeSymbols = 2;
  const operatorCapped = (await projectMap(fixture.config, { path: "demo" })) as {
    fileCount: number;
    symbolCount: number;
    appliedLimits: { maxFiles: number; maxTotalSymbols: number; maxSymbolsPerFile: number };
  };
  assert.equal(operatorCapped.fileCount, 2);
  assert.equal(operatorCapped.symbolCount, 2);
  assert.deepEqual(operatorCapped.appliedLimits, {
    maxFiles: 2,
    maxTotalSymbols: 2,
    maxSymbolsPerFile: 2,
  });

  fixture.config.maxCodeTotalBytes = 1;
  const bounded = (await projectMap(fixture.config, { path: "demo" })) as {
    partial: boolean;
    limitReason: string;
    scannedFiles: number;
  };
  assert.equal(bounded.partial, true);
  assert.equal(bounded.limitReason, "source_bytes");
  assert.equal(bounded.scannedFiles, 0);
});

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-intelligence-"));
  const demo = path.join(root, "demo");
  await fs.mkdir(path.join(demo, "indicators"), { recursive: true });
  await fs.writeFile(
    path.join(demo, "indicators", "rsi.py"),
    "def calculate_rsi(values):\n    return values[-1]\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(demo, "api.py"),
    "from indicators.rsi import calculate_rsi\n\ndef handler(values):\n    return calculate_rsi(values)\n",
    "utf8",
  );
  await fs.writeFile(path.join(demo, "service.ts"), "export class Service {\n  run() {}\n}\n", "utf8");
  await fs.writeFile(
    path.join(demo, "web.ts"),
    'import { Service } from "./service";\nexport function start() { return new Service(); }\n',
    "utf8",
  );
  const config = await loadConfig({
    WORKSPACE_MCP_ROOTS: `projects=${root}`,
    WORKSPACE_MCP_DEFAULT_ROOT: "projects",
  });
  return { root, demo, config };
}
