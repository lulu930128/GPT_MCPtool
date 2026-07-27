import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import type { ServerConfig, WorkspaceRootConfig } from "./config.js";
import {
  WorkspaceAccessError,
  assertNotDenied,
  assertWithinRoot,
  getDenialReason,
  isWithinRoot,
  resolveWorkspacePath,
  resolveWorkspaceRoot,
  toWorkspaceRelative,
} from "./path-guard.js";

export interface RootScopedArgs {
  root?: string;
}

export interface ListProjectsArgs extends RootScopedArgs {}

export interface ListDirArgs {
  root?: string;
  path?: string;
  depth?: number;
  maxEntries?: number;
}

export interface ReadFileArgs {
  root?: string;
  path: string;
  startLine?: number;
  maxLines?: number;
}

export interface SearchTextArgs {
  root?: string;
  query: string;
  path?: string;
  glob?: string;
  maxResults?: number;
  caseSensitive?: boolean;
  fixedString?: boolean;
}

export interface ProjectContextArgs {
  root?: string;
  project?: string;
}

export interface GitStatusArgs {
  root?: string;
  project?: string;
}

export async function getWorkspaceInfo(config: ServerConfig): Promise<unknown> {
  return {
    root: config.root,
    defaultRoot: config.defaultRootId,
    roots: Array.from(config.roots.values()).map((workspaceRoot) => ({
      id: workspaceRoot.id,
      path: workspaceRoot.path,
      default: workspaceRoot.id === config.defaultRootId,
      extraDeniedDirectories: Array.from(workspaceRoot.denyDirs)
        .filter((item) => !config.denyDirs.has(item))
        .sort(),
    })),
    assetScopes: Array.from(config.assetScopes.values()).map((scope) => ({
      id: scope.id,
      root: scope.rootId,
      path: scope.path,
    })),
    mode: "read-only",
    transport: "stdio",
    limits: {
      maxFileBytes: config.maxFileBytes,
      maxReadLines: config.maxReadLines,
      maxSearchResults: config.maxSearchResults,
      maxDirEntries: config.maxDirEntries,
      searchTimeoutMs: config.searchTimeoutMs,
      image: {
        maxSourceBytes: config.maxImageFileBytes,
        maxPixels: config.maxImagePixels,
        maxDimension: config.maxImageDimension,
        maxOutputBytes: config.maxImageOutputBytes,
      },
      spreadsheet: {
        maxSourceBytes: config.maxSpreadsheetFileBytes,
        maxExpandedBytes: config.maxSpreadsheetExpandedBytes,
        maxZipEntries: config.maxSpreadsheetZipEntries,
        maxCells: config.maxSpreadsheetCells,
        maxRows: config.maxSpreadsheetRows,
        maxColumns: config.maxSpreadsheetColumns,
      },
      office: {
        maxSourceBytes: config.maxOfficeFileBytes,
        maxExpandedBytes: config.maxOfficeExpandedBytes,
        maxZipEntries: config.maxOfficeZipEntries,
        maxXmlPartBytes: config.maxOfficeXmlPartBytes,
        maxXmlTotalBytes: config.maxOfficeXmlTotalBytes,
        maxTextChars: config.maxOfficeTextChars,
        maxDocumentBlocks: config.maxDocumentBlocks,
        maxDocumentTableCells: config.maxDocumentTableCells,
        maxPresentationSlides: config.maxPresentationSlides,
      },
    },
    denyPolicy: {
      directories: Array.from(config.denyDirs).sort(),
      extensions: Array.from(config.denyExtensions).sort(),
      fileNames: [".env", ".env.*", "credentials.json", "token.json", "id_rsa", "id_ed25519"],
    },
  };
}

export async function listProjects(
  config: ServerConfig,
  args: ListProjectsArgs = {},
): Promise<unknown> {
  const workspaceRoot = resolveWorkspaceRoot(config, args.root);
  const children = await fs.readdir(workspaceRoot.path, { withFileTypes: true });
  const projects = [];
  let skipped = 0;

  for (const child of sortDirents(children)) {
    if (!child.isDirectory()) {
      continue;
    }

    const absolute = path.join(workspaceRoot.path, child.name);
    if (getDenialReason(config, workspaceRoot, absolute)) {
      skipped += 1;
      continue;
    }

    let real: string;
    try {
      real = await fs.realpath(absolute);
      assertWithinRoot(workspaceRoot.path, real, "Project path escapes workspace root.");
      assertNotDenied(config, workspaceRoot, real);
    } catch {
      skipped += 1;
      continue;
    }

    projects.push({
      name: child.name,
      path: toWorkspaceRelative(workspaceRoot.path, real),
      isGitRepo: await exists(path.join(real, ".git")),
      hasReadme: await hasAny(real, ["README.md", "README.txt", "readme.md"]),
      hasAgents: await exists(path.join(real, "AGENTS.md")),
      hasPackageJson: await exists(path.join(real, "package.json")),
      hasPyproject: await exists(path.join(real, "pyproject.toml")),
    });
  }

  return {
    root: workspaceRoot.id,
    rootPath: workspaceRoot.path,
    count: projects.length,
    skipped,
    projects,
  };
}

export async function listDirectory(config: ServerConfig, args: ListDirArgs): Promise<unknown> {
  const depth = clampInt(args.depth ?? 1, 0, 3);
  const maxEntries = clampInt(args.maxEntries ?? config.maxDirEntries, 1, config.maxDirEntries);
  const base = await resolveWorkspacePath(config, args.path, "directory", args.root);
  const workspaceRoot = resolveWorkspaceRoot(config, base.rootId);
  const entries: unknown[] = [];
  const counters = { skipped: 0, truncated: false };

  await visitDirectory(config, workspaceRoot, base.absolute, depth, maxEntries, entries, counters);

  return {
    root: base.rootId,
    path: base.relative,
    depth,
    count: entries.length,
    skipped: counters.skipped,
    truncated: counters.truncated,
    entries,
  };
}

export async function readWorkspaceFile(config: ServerConfig, args: ReadFileArgs): Promise<unknown> {
  const resolved = await resolveWorkspacePath(config, args.path, "file", args.root);
  if (resolved.stat.size > config.maxFileBytes) {
    throw new WorkspaceAccessError(
      `File is too large (${resolved.stat.size} bytes > ${config.maxFileBytes} bytes).`,
    );
  }

  const raw = await fs.readFile(resolved.absolute, "utf8");
  if (raw.includes("\0")) {
    throw new WorkspaceAccessError("File appears to be binary.");
  }

  const lines = raw.split(/\r?\n/);
  const startLine = clampInt(args.startLine ?? 1, 1, Math.max(lines.length, 1));
  const maxLines = clampInt(args.maxLines ?? config.maxReadLines, 1, config.maxReadLines);
  const startIndex = startLine - 1;
  const selected = lines.slice(startIndex, startIndex + maxLines);

  return {
    root: resolved.rootId,
    path: resolved.relative,
    bytes: resolved.stat.size,
    totalLines: lines.length,
    startLine,
    returnedLines: selected.length,
    truncated: startIndex + selected.length < lines.length,
    text: selected.join("\n"),
  };
}

export async function readProjectContext(config: ServerConfig, args: ProjectContextArgs): Promise<unknown> {
  const projectPath = args.project?.trim() || ".";
  const project = await resolveWorkspacePath(config, projectPath, "directory", args.root);
  const candidates = [
    "AGENTS.md",
    "README.md",
    "README.txt",
    "package.json",
    "pyproject.toml",
    "Makefile",
    "requirements.txt",
    "tsconfig.json",
  ];

  const files = [];
  let packageScripts: Record<string, string> | undefined;

  for (const fileName of candidates) {
    const absolute = path.join(project.absolute, fileName);
    if (!(await exists(absolute))) {
      continue;
    }
    const relative = toWorkspaceRelative(project.rootPath, absolute);
    try {
      const file = await readWorkspaceFile(config, {
        root: project.rootId,
        path: relative,
        maxLines: fileName === "package.json" ? 240 : 120,
      });
      files.push(file);
      if (fileName === "package.json") {
        packageScripts = parsePackageScripts((file as { text: string }).text);
      }
    } catch (error) {
      files.push({
        path: relative,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    root: project.rootId,
    project: project.relative,
    files,
    packageScripts,
  };
}

export async function searchText(config: ServerConfig, args: SearchTextArgs): Promise<unknown> {
  const query = args.query.trim();
  if (!query) {
    throw new WorkspaceAccessError("Search query must not be empty.");
  }

  const scope = await resolveWorkspacePath(config, args.path, "directory", args.root);
  const workspaceRoot = resolveWorkspaceRoot(config, scope.rootId);
  const maxResults = clampInt(args.maxResults ?? config.maxSearchResults, 1, config.maxSearchResults);
  const options = {
    query,
    glob: args.glob?.trim(),
    maxResults,
    caseSensitive: args.caseSensitive === true,
    fixedString: args.fixedString !== false,
  };

  try {
    return await searchWithRipgrep(config, workspaceRoot, scope.absolute, options);
  } catch (error) {
    if (error instanceof Error && !error.message.includes("ENOENT")) {
      return {
        engine: "rg",
        root: scope.rootId,
        path: scope.relative,
        query,
        error: error.message,
        results: [],
      };
    }
    return searchWithJavaScript(config, workspaceRoot, scope.absolute, options);
  }
}

export async function gitStatusSummary(config: ServerConfig, args: GitStatusArgs): Promise<unknown> {
  const project = await resolveWorkspacePath(config, args.project, "directory", args.root);
  const result = await runProcess("git", ["-C", project.absolute, "status", "--short", "--branch"], 10_000);
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);

  if (result.code !== 0) {
    return {
      root: project.rootId,
      project: project.relative,
      isGitRepo: false,
      error: result.stderr.trim() || result.stdout.trim() || `git exited with ${result.code}`,
    };
  }

  return {
    root: project.rootId,
    project: project.relative,
    isGitRepo: true,
    branch: lines[0] ?? "",
    changedFiles: lines.slice(1),
  };
}

async function visitDirectory(
  config: ServerConfig,
  workspaceRoot: WorkspaceRootConfig,
  absolute: string,
  depth: number,
  maxEntries: number,
  entries: unknown[],
  counters: { skipped: number; truncated: boolean },
): Promise<void> {
  if (entries.length >= maxEntries) {
    counters.truncated = true;
    return;
  }

  const children = await fs.readdir(absolute, { withFileTypes: true });
  for (const child of sortDirents(children)) {
    if (entries.length >= maxEntries) {
      counters.truncated = true;
      return;
    }

    const childPath = path.join(absolute, child.name);
    const denial = getDenialReason(config, workspaceRoot, childPath);
    if (denial) {
      counters.skipped += 1;
      continue;
    }

    const lstat = await fs.lstat(childPath);
    let type = direntType(child, lstat.isSymbolicLink());

    if (type === "symlink") {
      try {
        const real = await fs.realpath(childPath);
        if (
          !isWithinRoot(workspaceRoot.path, real) ||
          getDenialReason(config, workspaceRoot, real)
        ) {
          counters.skipped += 1;
          continue;
        }
      } catch {
        counters.skipped += 1;
        continue;
      }
    }

    entries.push({
      path: toWorkspaceRelative(workspaceRoot.path, childPath),
      type,
      size: lstat.isFile() ? lstat.size : undefined,
      modified: lstat.mtime.toISOString(),
    });

    if (type === "directory" && depth > 0) {
      const real = await fs.realpath(childPath);
      if (
        !isWithinRoot(workspaceRoot.path, real) ||
        getDenialReason(config, workspaceRoot, real)
      ) {
        counters.skipped += 1;
        continue;
      }
      await visitDirectory(
        config,
        workspaceRoot,
        real,
        depth - 1,
        maxEntries,
        entries,
        counters,
      );
    }
  }
}

function direntType(child: Dirent, isSymlink: boolean): string {
  if (isSymlink) {
    return "symlink";
  }
  if (child.isDirectory()) {
    return "directory";
  }
  if (child.isFile()) {
    return "file";
  }
  return "other";
}

async function searchWithRipgrep(
  config: ServerConfig,
  workspaceRoot: WorkspaceRootConfig,
  scope: string,
  options: {
    query: string;
    glob?: string;
    maxResults: number;
    caseSensitive: boolean;
    fixedString: boolean;
  },
): Promise<unknown> {
  const rgArgs = [
    "--json",
    "--line-number",
    "--max-columns",
    "240",
    "--max-filesize",
    `${Math.ceil(config.maxFileBytes / 1024)}K`,
    "--glob",
    "!**/.env*",
  ];

  for (const directory of workspaceRoot.denyDirs) {
    rgArgs.push("--glob", `!**/${escapeGlob(directory)}/**`);
  }
  for (const extension of config.denyExtensions) {
    rgArgs.push("--glob", `!**/*${extension}`);
  }
  if (!options.caseSensitive) {
    rgArgs.push("--ignore-case");
  }
  if (options.fixedString) {
    rgArgs.push("--fixed-strings");
  }
  if (options.glob) {
    rgArgs.push("--glob", options.glob);
  }
  rgArgs.push(options.query, scope);

  const matches: unknown[] = [];
  let truncated = false;
  const result = await runProcess(
    "rg",
    rgArgs,
    config.searchTimeoutMs,
    (line, child) => {
      if (!line.trim()) {
        return;
      }
      try {
        const event = JSON.parse(line) as {
          type?: string;
          data?: {
            path?: { text?: string };
            line_number?: number;
            lines?: { text?: string };
          };
        };
        if (event.type !== "match" || !event.data?.path?.text) {
          return;
        }
        const absolutePath = path.resolve(event.data.path.text);
        if (
          !isWithinRoot(workspaceRoot.path, absolutePath) ||
          getDenialReason(config, workspaceRoot, absolutePath)
        ) {
          return;
        }
        matches.push({
          path: toWorkspaceRelative(workspaceRoot.path, absolutePath),
          line: event.data.line_number,
          text: truncate((event.data.lines?.text ?? "").trimEnd(), 500),
        });
        if (matches.length >= options.maxResults) {
          truncated = true;
          child.kill();
        }
      } catch {
        // Ignore malformed rg JSON lines.
      }
    },
  );

  if (result.code !== 0 && result.code !== 1 && !truncated) {
    throw new Error(result.stderr.trim() || `rg exited with ${result.code}`);
  }

  return {
    engine: "rg",
    root: workspaceRoot.id,
    query: options.query,
    path: toWorkspaceRelative(workspaceRoot.path, scope),
    count: matches.length,
    truncated,
    results: matches,
  };
}

async function searchWithJavaScript(
  config: ServerConfig,
  workspaceRoot: WorkspaceRootConfig,
  scope: string,
  options: {
    query: string;
    glob?: string;
    maxResults: number;
    caseSensitive: boolean;
    fixedString: boolean;
  },
): Promise<unknown> {
  const query = options.caseSensitive ? options.query : options.query.toLowerCase();
  const matches: unknown[] = [];
  let skipped = 0;
  let truncated = false;

  async function visit(current: string): Promise<void> {
    if (matches.length >= options.maxResults) {
      truncated = true;
      return;
    }
    const children = await fs.readdir(current, { withFileTypes: true });
    for (const child of sortDirents(children)) {
      if (matches.length >= options.maxResults) {
        truncated = true;
        return;
      }
      const absolute = path.join(current, child.name);
      if (getDenialReason(config, workspaceRoot, absolute)) {
        skipped += 1;
        continue;
      }
      if (child.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!child.isFile()) {
        skipped += 1;
        continue;
      }
      const stat = await fs.stat(absolute);
      if (stat.size > config.maxFileBytes) {
        skipped += 1;
        continue;
      }
      const text = await fs.readFile(absolute, "utf8").catch(() => undefined);
      if (text === undefined || text.includes("\0")) {
        skipped += 1;
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const haystack = options.caseSensitive ? lines[index] : lines[index].toLowerCase();
        const matched = options.fixedString ? haystack.includes(query) : new RegExp(query).test(haystack);
        if (matched) {
          matches.push({
            path: toWorkspaceRelative(workspaceRoot.path, absolute),
            line: index + 1,
            text: truncate(lines[index], 500),
          });
          if (matches.length >= options.maxResults) {
            truncated = true;
            return;
          }
        }
      }
    }
  }

  await visit(scope);

  return {
    engine: "javascript",
    root: workspaceRoot.id,
    query: options.query,
    path: toWorkspaceRelative(workspaceRoot.path, scope),
    count: matches.length,
    skipped,
    truncated,
    results: matches,
  };
}

function escapeGlob(value: string): string {
  return value.replace(/([\\*?[\]{}])/g, "\\$1");
}

function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  onStdoutLine?: (line: string, child: ReturnType<typeof spawn>) => void,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    const timer = setTimeout(() => {
      child.kill();
    }, timeoutMs);

    child.on("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      if (!onStdoutLine) {
        return;
      }
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        onStdoutLine(line, child);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stdoutBuffer && onStdoutLine) {
        onStdoutLine(stdoutBuffer, child);
      }
      resolve({ code, stdout, stderr });
    });
  });
}

function parsePackageScripts(text: string): Record<string, string> | undefined {
  try {
    const parsed = JSON.parse(text) as { scripts?: Record<string, string> };
    return parsed.scripts;
  } catch {
    return undefined;
  }
}

async function exists(absolute: string): Promise<boolean> {
  try {
    await fs.access(absolute);
    return true;
  } catch {
    return false;
  }
}

async function hasAny(directory: string, names: string[]): Promise<boolean> {
  for (const name of names) {
    if (await exists(path.join(directory, name))) {
      return true;
    }
  }
  return false;
}

function sortDirents(entries: Dirent[]): Dirent[] {
  return entries.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}
