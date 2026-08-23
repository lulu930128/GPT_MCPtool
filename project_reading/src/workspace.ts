import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import type { ServerConfig, WorkspaceRootConfig } from "./config.js";
import {
  getGitProjectMetadata,
  gitStatusSummary as scopedGitStatusSummary,
  type GitScopedArgs,
} from "./git-tools.js";
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
import {
  compileGlobMatcher,
  searchWorkspaceText,
  type SearchTextArgs,
} from "./search-tools.js";
import { assertTextSource, readTextWindow } from "./text-reader.js";

export interface RootScopedArgs {
  root?: string;
}

export interface ListProjectsArgs extends RootScopedArgs {}

export interface ListDirArgs extends RootScopedArgs {
  path?: string;
  depth?: number;
  maxEntries?: number;
}

export interface ReadFileArgs extends RootScopedArgs {
  path: string;
  startLine?: number;
  maxLines?: number;
}

export interface ReadFilesArgs extends RootScopedArgs {
  files: Array<{
    path: string;
    startLine?: number;
    maxLines?: number;
  }>;
}

export interface FindFilesArgs extends RootScopedArgs {
  path?: string;
  pattern: string;
  extensions?: string[];
  maxResults?: number;
}

export interface ProjectContextArgs extends RootScopedArgs {
  project?: string;
}

export type { SearchTextArgs };
export type GitStatusArgs = GitScopedArgs;

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
      originalFileReturnAllowed: config.fileReturnScopeIds.has(scope.id),
    })),
    mode: "read-only",
    transport: "stdio-or-streamable-http",
    applicationVersion: config.runtimeIdentity.applicationVersion,
    toolContractVersion: config.runtimeIdentity.toolContractVersion,
    buildId: config.runtimeIdentity.buildId,
    buildTime: config.runtimeIdentity.buildTime,
    gitCommit: config.runtimeIdentity.gitCommit,
    dirty: config.runtimeIdentity.dirty,
    runtimeStartedAt: config.runtimeIdentity.runtimeStartedAt,
    search: {
      preferred: config.searchRuntime.preferred,
      active: config.searchRuntime.active,
      version: config.searchRuntime.version,
      source: config.searchRuntime.source,
    },
    limits: {
      text: {
        maxSourceBytes: config.maxFileBytes,
        maxReturnedBytes: config.maxReturnedBytes,
        maxReadLines: config.maxReadLines,
        maxBatchFiles: config.maxBatchFiles,
        maxBatchTotalLines: config.maxBatchTotalLines,
        maxBatchTotalBytes: config.maxBatchTotalBytes,
      },
      search: {
        maxResults: config.maxSearchResults,
        maxReturnedBytes: config.maxSearchReturnedBytes,
        maxVisitedEntries: config.maxSearchVisitedEntries,
        timeoutMs: config.searchTimeoutMs,
      },
      git: {
        timeoutMs: config.gitTimeoutMs,
        maxDiffFiles: config.maxGitDiffFiles,
        maxDiffLines: config.maxGitDiffLines,
        maxDiffBytes: config.maxGitDiffBytes,
      },
      code: {
        maxFiles: config.maxCodeFiles,
        maxSymbols: config.maxCodeSymbols,
        maxResults: config.maxCodeResults,
        maxFileBytes: config.maxCodeFileBytes,
        maxTotalBytes: config.maxCodeTotalBytes,
        timeoutMs: config.codeTimeoutMs,
      },
      maxDirEntries: config.maxDirEntries,
      image: {
        maxSourceBytes: config.maxImageFileBytes,
        maxPixels: config.maxImagePixels,
        maxDimension: config.maxImageDimension,
        maxOutputBytes: config.maxImageOutputBytes,
      },
      fetch: {
        maxFileBytes: config.maxFetchFileBytes,
        enabledScopes: Array.from(config.fileReturnScopeIds),
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
      pdf: {
        maxSourceBytes: config.maxPdfFileBytes,
        maxPages: config.maxPdfPages,
        maxReadPages: config.maxPdfReadPages,
        maxTextChars: config.maxPdfTextChars,
        maxRenderDimension: config.maxPdfRenderDimension,
        maxRenderPixels: config.maxPdfRenderPixels,
        maxOutputBytes: config.maxPdfOutputBytes,
        timeoutMs: config.pdfTimeoutMs,
      },
    },
    denyPolicy: {
      directories: Array.from(config.denyDirs).sort(),
      extensions: Array.from(config.denyExtensions).sort(),
      fileNames: [
        ".env",
        ".env.*",
        ".codex-global-state.json*",
        "auth.json",
        "cap_sid",
        "credentials.json",
        "installation_id",
        "session_index.jsonl",
        "token.json",
        "transcription-history.jsonl",
        "id_rsa",
        "id_ed25519",
      ],
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
    if (!child.isDirectory()) continue;
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
    const resolved = await resolveWorkspacePath(config, child.name, "directory", workspaceRoot.id);
    const git = (await getGitProjectMetadata(config, resolved)) as {
      hasOwnGitRoot: boolean;
      hasTrackedFiles: boolean;
    };
    projects.push({
      name: child.name,
      path: toWorkspaceRelative(workspaceRoot.path, real),
      isGitRepo: await exists(path.join(real, ".git")),
      isGitTracked: git.hasTrackedFiles,
      hasOwnGitRoot: git.hasOwnGitRoot,
      git,
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
  const window = await readTextWindow(resolved.absolute, resolved.stat.size, {
    startLine: args.startLine ?? 1,
    maxLines: clampInt(args.maxLines ?? config.maxReadLines, 1, config.maxReadLines),
    maxSourceBytes: config.maxFileBytes,
    maxReturnedBytes: config.maxReturnedBytes,
  });
  return {
    root: resolved.rootId,
    path: resolved.relative,
    ...window,
  };
}

export async function readWorkspaceFiles(config: ServerConfig, args: ReadFilesArgs): Promise<unknown> {
  if (args.files.length === 0 || args.files.length > config.maxBatchFiles) {
    throw new WorkspaceAccessError(`read_files accepts 1-${config.maxBatchFiles} files.`);
  }
  const requestedLines = args.files.reduce(
    (total, file) => total + clampInt(file.maxLines ?? config.maxReadLines, 1, config.maxReadLines),
    0,
  );
  if (requestedLines > config.maxBatchTotalLines) {
    throw new WorkspaceAccessError(
      `Requested line budget ${requestedLines} exceeds ${config.maxBatchTotalLines}.`,
    );
  }
  const preflight = [];
  for (const file of args.files) {
    const resolved = await resolveWorkspacePath(config, file.path, "file", args.root);
    await assertTextSource(resolved.absolute, resolved.stat.size, config.maxFileBytes);
    preflight.push({ file, resolved });
  }

  const files = [];
  let remainingBytes = config.maxBatchTotalBytes;
  let totalReturnedBytes = 0;
  let truncated = false;
  for (const item of preflight) {
    const maxReturnedBytes = Math.min(config.maxReturnedBytes, Math.max(remainingBytes, 0));
    const window = await readTextWindow(item.resolved.absolute, item.resolved.stat.size, {
      startLine: item.file.startLine ?? 1,
      maxLines: clampInt(item.file.maxLines ?? config.maxReadLines, 1, config.maxReadLines),
      maxSourceBytes: config.maxFileBytes,
      maxReturnedBytes,
    });
    files.push({ root: item.resolved.rootId, path: item.resolved.relative, ...window });
    totalReturnedBytes += window.returnedBytes;
    remainingBytes -= window.returnedBytes;
    truncated ||= window.truncated || remainingBytes <= 0;
  }
  return {
    root: preflight[0]?.resolved.rootId,
    count: files.length,
    totalReturnedBytes,
    truncated,
    files,
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
    if (!(await exists(absolute))) continue;
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
      files.push({ path: relative, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    root: project.rootId,
    project: project.relative,
    files,
    packageScripts,
  };
}

export async function findFiles(config: ServerConfig, args: FindFilesArgs): Promise<unknown> {
  const scope = await resolveWorkspacePath(config, args.path, "directory", args.root);
  const workspaceRoot = resolveWorkspaceRoot(config, scope.rootId);
  const pattern = args.pattern.trim();
  if (!pattern) throw new WorkspaceAccessError("File pattern must not be empty.");
  const matchesPattern = compileGlobMatcher(pattern);
  const extensions = normalizeExtensions(args.extensions);
  const maxResults = clampInt(args.maxResults ?? config.maxSearchResults, 1, config.maxSearchResults);
  const deadline = Date.now() + config.searchTimeoutMs;
  const results: string[] = [];
  let visited = 0;
  let skipped = 0;
  let limitReason: string | undefined;

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
    for (const entry of sortDirents(entries)) {
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
      } else if (entry.isFile()) {
        const relative = path.relative(scope.absolute, absolute).split(path.sep).join("/");
        if (
          matchesPattern(relative) &&
          (extensions.size === 0 || extensions.has(path.extname(entry.name).toLowerCase()))
        ) {
          results.push(relative);
          if (results.length >= maxResults) {
            limitReason = "results";
            return;
          }
        }
      }
    }
  }
  await visit(scope.absolute);
  return {
    root: scope.rootId,
    path: scope.relative,
    pattern,
    extensions: Array.from(extensions),
    results,
    count: results.length,
    skipped,
    visited,
    truncated: Boolean(limitReason),
    limitReason,
  };
}

export async function searchText(config: ServerConfig, args: SearchTextArgs): Promise<unknown> {
  return searchWorkspaceText(config, args);
}

export async function gitStatusSummary(config: ServerConfig, args: GitStatusArgs): Promise<unknown> {
  return scopedGitStatusSummary(config, args);
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
    if (getDenialReason(config, workspaceRoot, childPath)) {
      counters.skipped += 1;
      continue;
    }
    const lstat = await fs.lstat(childPath);
    const type = direntType(child, lstat.isSymbolicLink());
    if (type === "symlink") {
      try {
        const real = await fs.realpath(childPath);
        if (!isWithinRoot(workspaceRoot.path, real) || getDenialReason(config, workspaceRoot, real)) {
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
      if (!isWithinRoot(workspaceRoot.path, real) || getDenialReason(config, workspaceRoot, real)) {
        counters.skipped += 1;
        continue;
      }
      await visitDirectory(config, workspaceRoot, real, depth - 1, maxEntries, entries, counters);
    }
  }
}

function direntType(child: Dirent, isSymlink: boolean): string {
  if (isSymlink) return "symlink";
  if (child.isDirectory()) return "directory";
  if (child.isFile()) return "file";
  return "other";
}

function normalizeExtensions(values: string[] | undefined): Set<string> {
  const result = new Set<string>();
  for (const raw of values ?? []) {
    const value = raw.trim().toLowerCase();
    if (!/^\.[a-z0-9][a-z0-9._-]{0,15}$/.test(value)) {
      throw new WorkspaceAccessError(`Invalid extension filter: ${raw}`);
    }
    result.add(value);
  }
  if (result.size > 20) {
    throw new WorkspaceAccessError("At most 20 extension filters are allowed.");
  }
  return result;
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
    if (await exists(path.join(directory, name))) return true;
  }
  return false;
}

function sortDirents(entries: Dirent[]): Dirent[] {
  return entries.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

function clampInt(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}
