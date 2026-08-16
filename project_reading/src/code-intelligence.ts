import fs from "node:fs/promises";
import path from "node:path";
import type { ServerConfig, WorkspaceRootConfig } from "./config.js";
import {
  WorkspaceAccessError,
  getDenialReason,
  isWithinRoot,
  resolveWorkspacePath,
  resolveWorkspaceRoot,
  toWorkspaceRelative,
} from "./path-guard.js";
import { assertTextSource, truncateUtf8 } from "./text-reader.js";

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"]);
const IDENTIFIER = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;
const LIMITATIONS = [
  "Results use deterministic lexical parsing, not compiler or LSP type resolution.",
  "Dynamic imports, generated code, aliases, decorators, macros, and runtime dispatch may be incomplete.",
];

export const PROJECT_MAP_DEFAULT_LIMITS = Object.freeze({
  maxFiles: 30,
  maxTotalSymbols: 300,
  maxSymbolsPerFile: 50,
});

export interface CodeScopeArgs {
  root?: string;
  path?: string;
  maxResults?: number;
}

export interface ProjectMapArgs extends CodeScopeArgs {
  maxFiles?: number;
  maxTotalSymbols?: number;
  maxSymbolsPerFile?: number;
}

export interface SymbolArgs extends CodeScopeArgs {
  symbol: string;
}

interface CodeFile {
  path: string;
  absolute: string;
  language: "typescript" | "javascript" | "python";
  lines: string[];
  definitions: SymbolDefinition[];
  imports: ParsedImport[];
}

interface SymbolDefinition {
  name: string;
  line: number;
  kind: "function" | "method" | "class" | "interface" | "type" | "enum" | "namespace" | "variable";
  container?: string;
}

interface ParsedImport {
  module: string;
  line: number;
  kind: "import" | "export" | "require";
}

interface CodeScan {
  root: string;
  path: string;
  files: CodeFile[];
  visited: number;
  skipped: number;
  truncated: boolean;
  sourceBytes: number;
  limitReason?: "files" | "source_bytes" | "timeout" | "visited_entries";
}

export async function findSymbol(config: ServerConfig, args: SymbolArgs): Promise<unknown> {
  const symbol = validateSymbol(args.symbol);
  const scan = await scanCode(config, args);
  const maxResults = clampInt(args.maxResults ?? config.maxCodeResults, 1, config.maxCodeResults);
  const definitions = [];
  for (const file of scan.files) {
    for (const definition of file.definitions) {
      if (definition.name !== symbol) continue;
      definitions.push({ path: file.path, language: file.language, ...definition });
      if (definitions.length >= maxResults) break;
    }
    if (definitions.length >= maxResults) break;
  }
  return codeEnvelope(scan, {
    symbol,
    definitions,
    count: definitions.length,
    truncated: scan.truncated || definitions.length >= maxResults,
  });
}

export async function findReferences(config: ServerConfig, args: SymbolArgs): Promise<unknown> {
  const symbol = validateSymbol(args.symbol);
  const scan = await scanCode(config, args);
  const maxResults = clampInt(args.maxResults ?? config.maxCodeResults, 1, config.maxCodeResults);
  const escaped = escapeRegExp(symbol);
  const expression = new RegExp(`(?<![\\p{L}\\p{N}_$])${escaped}(?![\\p{L}\\p{N}_$])`, "u");
  const references = [];
  for (const file of scan.files) {
    const definitionLines = new Set(
      file.definitions.filter((definition) => definition.name === symbol).map((definition) => definition.line),
    );
    for (let index = 0; index < file.lines.length; index += 1) {
      if (!expression.test(file.lines[index])) continue;
      references.push({
        path: file.path,
        line: index + 1,
        language: file.language,
        isDefinition: definitionLines.has(index + 1),
        text: truncateUtf8(file.lines[index].trimEnd(), 500).text,
      });
      if (references.length >= maxResults) break;
    }
    if (references.length >= maxResults) break;
  }
  return codeEnvelope(scan, {
    symbol,
    references,
    count: references.length,
    semantic: false,
    truncated: scan.truncated || references.length >= maxResults,
  });
}

export async function importGraph(config: ServerConfig, args: CodeScopeArgs): Promise<unknown> {
  const scan = await scanCode(config, args);
  const knownFiles = new Set(scan.files.map((file) => file.path));
  const maxResults = clampInt(args.maxResults ?? config.maxCodeResults, 1, config.maxCodeResults);
  const edges = [];
  for (const file of scan.files) {
    for (const item of file.imports) {
      const resolvedPath = resolveImport(file, item.module, knownFiles);
      edges.push({
        from: file.path,
        module: item.module,
        line: item.line,
        kind: item.kind,
        resolvedPath,
        external: resolvedPath === null,
      });
      if (edges.length >= maxResults) break;
    }
    if (edges.length >= maxResults) break;
  }
  return codeEnvelope(scan, {
    nodes: scan.files.map((file) => ({ path: file.path, language: file.language })),
    edges,
    count: edges.length,
    truncated: scan.truncated || edges.length >= maxResults,
  });
}

export async function projectMap(config: ServerConfig, args: ProjectMapArgs): Promise<unknown> {
  const maxFilesCap = Math.min(config.maxCodeFiles, config.maxCodeResults);
  if (
    args.maxFiles !== undefined &&
    args.maxResults !== undefined &&
    args.maxFiles !== args.maxResults
  ) {
    throw new WorkspaceAccessError(
      "project_map maxResults is a deprecated alias for maxFiles; do not provide conflicting values.",
    );
  }
  const maxFiles = clampInt(
    args.maxFiles ?? args.maxResults ?? PROJECT_MAP_DEFAULT_LIMITS.maxFiles,
    1,
    maxFilesCap,
  );
  const maxTotalSymbols = clampInt(
    args.maxTotalSymbols ?? PROJECT_MAP_DEFAULT_LIMITS.maxTotalSymbols,
    1,
    config.maxCodeSymbols,
  );
  const maxSymbolsPerFile = clampInt(
    args.maxSymbolsPerFile ?? PROJECT_MAP_DEFAULT_LIMITS.maxSymbolsPerFile,
    1,
    config.maxCodeSymbols,
  );
  const scan = await scanCode(config, args);
  let symbolCount = 0;
  const truncationReasons = new Set<string>();
  if (scan.limitReason) truncationReasons.add(`scan_${scan.limitReason}`);
  if (scan.files.length > maxFiles) truncationReasons.add("maxFiles");
  const files = [];
  for (const file of scan.files.slice(0, maxFiles)) {
    const fileTruncationReasons = [];
    const perFileSymbols = file.definitions.slice(0, maxSymbolsPerFile);
    if (file.definitions.length > perFileSymbols.length) {
      fileTruncationReasons.push("maxSymbolsPerFile");
      truncationReasons.add("maxSymbolsPerFile");
    }
    const remaining = Math.max(maxTotalSymbols - symbolCount, 0);
    const symbols = perFileSymbols.slice(0, remaining);
    if (perFileSymbols.length > symbols.length) {
      fileTruncationReasons.push("maxTotalSymbols");
      truncationReasons.add("maxTotalSymbols");
    }
    symbolCount += symbols.length;
    files.push({
      path: file.path,
      language: file.language,
      symbols,
      symbolCount: symbols.length,
      imports: file.imports.length,
      truncated: file.definitions.length > symbols.length,
      truncationReasons: fileTruncationReasons,
    });
  }
  return codeEnvelope(scan, {
    files,
    fileCount: files.length,
    symbolCount,
    appliedLimits: {
      maxFiles,
      maxTotalSymbols,
      maxSymbolsPerFile,
    },
    deprecatedInputs: args.maxResults === undefined ? [] : ["maxResults"],
    truncated: truncationReasons.size > 0,
    truncationReasons: Array.from(truncationReasons),
  });
}

async function scanCode(config: ServerConfig, args: CodeScopeArgs): Promise<CodeScan> {
  const scope = await resolveWorkspacePath(config, args.path, "directory", args.root);
  const workspaceRoot = resolveWorkspaceRoot(config, scope.rootId);
  const deadline = Date.now() + config.codeTimeoutMs;
  const files: CodeFile[] = [];
  let visited = 0;
  let skipped = 0;
  let sourceBytes = 0;
  let limitReason: CodeScan["limitReason"];

  async function visit(current: string): Promise<void> {
    if (limitReason) return;
    if (Date.now() > deadline) {
      limitReason = "timeout";
      return;
    }
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => undefined);
    if (!entries) {
      skipped += 1;
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
    for (const entry of entries) {
      if (limitReason) return;
      visited += 1;
      if (visited > config.maxSearchVisitedEntries) {
        limitReason = "visited_entries";
        return;
      }
      const absolute = path.join(current, entry.name);
      if (getDenialReason(config, workspaceRoot, absolute) || entry.isSymbolicLink()) {
        skipped += 1;
        continue;
      }
      if (entry.isDirectory()) {
        const real = await fs.realpath(absolute).catch(() => undefined);
        if (!real || !isWithinRoot(workspaceRoot.path, real)) {
          skipped += 1;
          continue;
        }
        await visit(real);
        continue;
      }
      if (!entry.isFile() || !CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      if (files.length >= config.maxCodeFiles) {
        limitReason = "files";
        return;
      }
      const stat = await fs.stat(absolute);
      if (stat.size > config.maxCodeFileBytes) {
        skipped += 1;
        continue;
      }
      if (sourceBytes + stat.size > config.maxCodeTotalBytes) {
        limitReason = "source_bytes";
        return;
      }
      try {
        await assertTextSource(absolute, stat.size, config.maxCodeFileBytes);
      } catch {
        skipped += 1;
        continue;
      }
      const text = await fs.readFile(absolute, "utf8");
      sourceBytes += stat.size;
      const lines = text.split(/\r?\n/);
      const language = languageFor(entry.name);
      files.push({
        path: toWorkspaceRelative(scope.absolute, absolute),
        absolute,
        language,
        lines,
        definitions: parseDefinitions(lines, language),
        imports: parseImports(lines, language),
      });
    }
  }
  await visit(scope.absolute);
  return {
    root: scope.rootId,
    path: scope.relative,
    files,
    visited,
    skipped,
    sourceBytes,
    truncated: Boolean(limitReason),
    limitReason,
  };
}

function parseDefinitions(
  lines: string[],
  language: CodeFile["language"],
): SymbolDefinition[] {
  return language === "python" ? parsePythonDefinitions(lines) : parseJavaScriptDefinitions(lines);
}

function parseJavaScriptDefinitions(lines: string[]): SymbolDefinition[] {
  const definitions: SymbolDefinition[] = [];
  let className: string | undefined;
  let classBraceDepth = 0;
  let braceDepth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const declaration = line.match(
      /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:(async)\s+)?(function|class|interface|type|enum|namespace)\s+([\p{L}_$][\p{L}\p{N}_$]*)/u,
    );
    if (declaration) {
      const kind = declaration[2] as SymbolDefinition["kind"];
      definitions.push({ name: declaration[3], line: index + 1, kind });
      if (kind === "class") {
        className = declaration[3];
        classBraceDepth = braceDepth + Math.max(countChar(line, "{") - countChar(line, "}"), 1);
      }
    }
    const variable = line.match(
      /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([\p{L}_$][\p{L}\p{N}_$]*)/u,
    );
    if (variable) definitions.push({ name: variable[1], line: index + 1, kind: "variable" });
    if (className && !declaration) {
      const method = line.match(
        /^\s*(?:(?:public|private|protected|static|abstract|override|readonly|async|get|set)\s+)*([\p{L}_$][\p{L}\p{N}_$]*)\s*(?:<[^>]+>)?\s*\(/u,
      );
      if (method && !["if", "for", "while", "switch", "catch", "function"].includes(method[1])) {
        definitions.push({ name: method[1], line: index + 1, kind: "method", container: className });
      }
    }
    braceDepth += countChar(line, "{") - countChar(line, "}");
    if (className && braceDepth < classBraceDepth) className = undefined;
  }
  return definitions;
}

function parsePythonDefinitions(lines: string[]): SymbolDefinition[] {
  const definitions: SymbolDefinition[] = [];
  let className: string | undefined;
  let classIndent = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (className && indent <= classIndent) className = undefined;
    const classMatch = line.match(/^\s*class\s+([\p{L}_][\p{L}\p{N}_]*)/u);
    if (classMatch) {
      className = classMatch[1];
      classIndent = indent;
      definitions.push({ name: className, line: index + 1, kind: "class" });
      continue;
    }
    const functionMatch = line.match(/^\s*(?:async\s+)?def\s+([\p{L}_][\p{L}\p{N}_]*)/u);
    if (functionMatch) {
      const insideClass = Boolean(className && indent > classIndent);
      definitions.push({
        name: functionMatch[1],
        line: index + 1,
        kind: insideClass ? "method" : "function",
        ...(insideClass ? { container: className } : {}),
      });
      continue;
    }
    const variable = line.match(/^([\p{L}_][\p{L}\p{N}_]*)\s*(?::[^=]+)?=/u);
    if (variable && indent === 0) {
      definitions.push({ name: variable[1], line: index + 1, kind: "variable" });
    }
  }
  return definitions;
}

function parseImports(lines: string[], language: CodeFile["language"]): ParsedImport[] {
  const imports: ParsedImport[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (language === "python") {
      const from = line.match(/^\s*from\s+([\w.]+)\s+import\s+/);
      if (from) imports.push({ module: from[1], line: index + 1, kind: "import" });
      const direct = line.match(/^\s*import\s+(.+)$/);
      if (direct) {
        for (const item of direct[1].split(",")) {
          const module = item.trim().split(/\s+as\s+/)[0];
          if (module) imports.push({ module, line: index + 1, kind: "import" });
        }
      }
      continue;
    }
    const staticImport = line.match(/^\s*import(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/);
    if (staticImport) imports.push({ module: staticImport[1], line: index + 1, kind: "import" });
    const exported = line.match(/^\s*export[\s\S]*?\s+from\s+["']([^"']+)["']/);
    if (exported) imports.push({ module: exported[1], line: index + 1, kind: "export" });
    const required = line.match(/\brequire\(\s*["']([^"']+)["']\s*\)/);
    if (required) imports.push({ module: required[1], line: index + 1, kind: "require" });
  }
  return imports;
}

function resolveImport(file: CodeFile, module: string, knownFiles: Set<string>): string | null {
  if (file.language === "python") {
    const normalized = module.replace(/^\.+/, "").replace(/\./g, "/");
    const candidates = [`${normalized}.py`, `${normalized}/__init__.py`];
    return candidates.find((candidate) => knownFiles.has(candidate)) ?? null;
  }
  if (!module.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), module));
  const candidates = [
    base,
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].map((extension) => `${base}${extension}`),
    ...[".ts", ".tsx", ".js", ".jsx"].map((extension) => `${base}/index${extension}`),
  ];
  return candidates.find((candidate) => knownFiles.has(candidate)) ?? null;
}

function languageFor(fileName: string): CodeFile["language"] {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".py") return "python";
  if (extension === ".ts" || extension === ".tsx") return "typescript";
  return "javascript";
}

function codeEnvelope(scan: CodeScan, payload: Record<string, unknown>): unknown {
  return {
    root: scan.root,
    path: scan.path,
    analysisMode: "deterministic-lexical",
    semantic: false,
    supportedLanguages: ["TypeScript", "JavaScript", "Python"],
    limitations: LIMITATIONS,
    scannedFiles: scan.files.length,
    visited: scan.visited,
    skipped: scan.skipped,
    sourceBytes: scan.sourceBytes,
    partial: scan.truncated,
    limitReason: scan.limitReason,
    ...payload,
  };
}

function validateSymbol(value: string): string {
  const symbol = value.trim();
  if (!IDENTIFIER.test(symbol) || symbol.length > 200) {
    throw new WorkspaceAccessError("Symbol must be one bounded identifier.");
  }
  return symbol;
}

function countChar(value: string, character: string): number {
  return value.split(character).length - 1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clampInt(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}
