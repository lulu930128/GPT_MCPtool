import fs from "node:fs/promises";
import path from "node:path";
import type { ServerConfig } from "./config.js";
import {
  WorkspaceAccessError,
  assertWithinRoot,
  resolveWorkspacePath,
  resolveWorkspacePathCandidate,
  resolveWorkspaceRoot,
  toWorkspaceRelative,
  type ResolvedWorkspacePath,
} from "./path-guard.js";
import { runBoundedProcess, type BoundedProcessResult } from "./process-runner.js";
import { readTextWindow, truncateUtf8 } from "./text-reader.js";

export type GitDiffMode = "unstaged" | "staged" | "all";

export interface GitScopedArgs {
  root?: string;
  project?: string;
}

export interface GitDiffArgs extends GitScopedArgs {
  mode?: GitDiffMode;
  path?: string;
  maxFiles?: number;
  maxLines?: number;
  includeUntracked?: boolean;
}

export interface GitContext {
  rootId: string;
  project: ResolvedWorkspacePath;
  repoRootAbsolute: string;
  repoRoot: string;
  scope: string;
  relation: "self" | "parent";
  hasOwnGitRoot: boolean;
  hasTrackedFiles: boolean;
}

interface GitChange {
  statusCode: string;
  status: string;
  path: string;
  oldPath?: string;
  untracked?: boolean;
}

export async function getGitProjectMetadata(
  config: ServerConfig,
  project: ResolvedWorkspacePath,
): Promise<unknown> {
  try {
    const context = await discoverGitContext(config, project);
    if (!context) {
      return {
        inWorkTree: false,
        hasOwnGitRoot: false,
        hasTrackedFiles: false,
        repoRoot: null,
        scope: null,
        relation: null,
      };
    }
    return publicGitContext(context);
  } catch (error) {
    return {
      inWorkTree: false,
      hasOwnGitRoot: false,
      hasTrackedFiles: false,
      repoRoot: null,
      scope: null,
      relation: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function gitStatusSummary(config: ServerConfig, args: GitScopedArgs): Promise<unknown> {
  const project = await resolveWorkspacePath(config, args.project, "directory", args.root);
  const context = await discoverGitContext(config, project);
  if (!context) {
    return {
      root: project.rootId,
      project: project.relative,
      isGitRepo: false,
      git: {
        inWorkTree: false,
        hasOwnGitRoot: false,
        hasTrackedFiles: false,
      },
      changedFiles: [],
      changes: [],
      partial: false,
    };
  }

  const result = await runGit(config, project.absolute, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    ".",
  ]);
  assertGitSuccess(result, "git status");
  const parsed = parsePorcelainStatus(result.stdout);
  const allowed: GitChange[] = [];
  let omittedDenied = 0;
  for (const rawChange of parsed) {
    const change = toProjectRelativeChange(context, rawChange);
    if (!change) {
      omittedDenied += 1;
      continue;
    }
    if (!isAllowedGitChange(config, context, change)) {
      omittedDenied += 1;
      continue;
    }
    allowed.push(change);
  }
  const branch = await readBranch(config, project.absolute);

  return {
    root: project.rootId,
    project: project.relative,
    isGitRepo: true,
    git: publicGitContext(context),
    branch,
    changedFiles: allowed.map((change) => change.path),
    changes: allowed.map(publicGitChange),
    omitted: { denied: omittedDenied },
    partial: omittedDenied > 0,
  };
}

export async function gitDiff(config: ServerConfig, args: GitDiffArgs): Promise<unknown> {
  const project = await resolveWorkspacePath(config, args.project, "directory", args.root);
  const context = await discoverGitContext(config, project);
  if (!context) {
    throw new WorkspaceAccessError("Project is not inside an allowed Git worktree.");
  }
  const mode = args.mode ?? "unstaged";
  const maxFiles = clampInt(args.maxFiles ?? config.maxGitDiffFiles, 1, config.maxGitDiffFiles);
  const maxLines = clampInt(args.maxLines ?? config.maxGitDiffLines, 1, config.maxGitDiffLines);
  const requestedPath = args.path?.trim();
  if (requestedPath) {
    validateProjectRelativePath(config, context, requestedPath);
  }
  if (mode === "all" && !(await hasHead(config, project.absolute))) {
    throw new WorkspaceAccessError(
      "Git diff mode 'all' requires HEAD. Use staged or unstaged on an unborn branch.",
    );
  }

  const modeArgs = diffModeArgs(mode);
  const pathspec = requestedPath || ".";
  const summary = await runGit(config, project.absolute, [
    "diff",
    ...modeArgs,
    "--name-status",
    "-z",
    "--find-renames",
    "--relative",
    "--",
    pathspec,
  ]);
  assertGitSuccess(summary, "git diff name summary");
  let changes = parseNameStatus(summary.stdout);

  if (args.includeUntracked === true && mode !== "staged") {
    const status = await runGit(config, project.absolute, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      pathspec,
    ]);
    assertGitSuccess(status, "git untracked status");
    const untracked = parsePorcelainStatus(status.stdout)
      .map((change) => toProjectRelativeChange(context, change))
      .filter((change): change is GitChange => Boolean(change?.untracked));
    const existing = new Set(changes.map((change) => change.path.toLowerCase()));
    changes.push(...untracked.filter((change) => !existing.has(change.path.toLowerCase())));
  }

  let omittedDenied = 0;
  const safeChanges: GitChange[] = [];
  for (const change of changes) {
    if (!isAllowedGitChange(config, context, change)) {
      omittedDenied += 1;
      continue;
    }
    safeChanges.push(change);
  }
  const selected = safeChanges.slice(0, maxFiles);
  let remainingLines = maxLines;
  let remainingBytes = config.maxGitDiffBytes;
  const files: unknown[] = [];
  for (const change of selected) {
    if (remainingLines <= 0 || remainingBytes <= 0) {
      break;
    }
    const file = change.untracked
      ? await readUntrackedDiff(config, context, change, remainingLines, remainingBytes)
      : await readTrackedDiff(config, context, change, modeArgs, remainingLines, remainingBytes);
    files.push(file.output);
    remainingLines -= file.usedLines;
    remainingBytes -= file.usedBytes;
  }

  const truncated =
    safeChanges.length > selected.length ||
    files.length < selected.length ||
    remainingLines <= 0 ||
    remainingBytes <= 0;
  return {
    root: project.rootId,
    project: project.relative,
    mode,
    includeUntracked: args.includeUntracked === true,
    git: publicGitContext(context),
    files,
    count: files.length,
    omitted: {
      denied: omittedDenied,
      overFileLimit: Math.max(safeChanges.length - maxFiles, 0),
    },
    partial: omittedDenied > 0,
    truncated,
  };
}

export async function gitDiffFile(config: ServerConfig, args: GitDiffArgs & { path: string }): Promise<unknown> {
  const result = (await gitDiff(config, { ...args, maxFiles: 1 })) as {
    root: string;
    project: string;
    mode: GitDiffMode;
    files: unknown[];
    partial: boolean;
    truncated: boolean;
  };
  return {
    root: result.root,
    project: result.project,
    mode: result.mode,
    file: result.files[0] ?? null,
    partial: result.partial,
    truncated: result.truncated,
  };
}

export async function discoverGitContext(
  config: ServerConfig,
  project: ResolvedWorkspacePath,
): Promise<GitContext | undefined> {
  const result = await runGit(config, project.absolute, ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0) {
    return undefined;
  }
  assertGitBounded(result, "git rev-parse");
  const repoRootAbsolute = await fs.realpath(result.stdout.trim());
  const workspaceRoot = resolveWorkspaceRoot(config, project.rootId);
  assertWithinRoot(
    workspaceRoot.path,
    repoRootAbsolute,
    "Git repository root is outside the selected workspace root.",
  );
  const scope = normalizeGitPath(path.relative(repoRootAbsolute, project.absolute)) || ".";
  const tracked = await runGit(config, project.absolute, ["ls-files", "-z", "--", "."], {
    maxStdoutBytes: 65_536,
  });
  const hasTrackedFiles = tracked.stdout.length > 0 || tracked.terminationReason === "output_limit";
  return {
    rootId: project.rootId,
    project,
    repoRootAbsolute,
    repoRoot: toWorkspaceRelative(workspaceRoot.path, repoRootAbsolute),
    scope,
    relation: samePath(repoRootAbsolute, project.absolute) ? "self" : "parent",
    hasOwnGitRoot: samePath(repoRootAbsolute, project.absolute),
    hasTrackedFiles,
  };
}

function publicGitContext(context: GitContext): unknown {
  return {
    inWorkTree: true,
    hasOwnGitRoot: context.hasOwnGitRoot,
    hasTrackedFiles: context.hasTrackedFiles,
    repoRoot: context.repoRoot,
    scope: context.scope,
    relation: context.relation,
  };
}

function publicGitChange(change: GitChange): Record<string, unknown> {
  return {
    path: change.path,
    oldPath: change.oldPath,
    status: change.status,
    statusCode: change.statusCode,
    untracked: change.untracked === true,
  };
}

async function readTrackedDiff(
  config: ServerConfig,
  context: GitContext,
  change: GitChange,
  modeArgs: string[],
  maxLines: number,
  maxBytes: number,
): Promise<{ output: unknown; usedLines: number; usedBytes: number }> {
  const paths = [change.oldPath, change.path].filter((item): item is string => Boolean(item));
  const result = await runGit(
    config,
    context.project.absolute,
    [
      "diff",
      ...modeArgs,
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--unified=3",
      "--relative",
      "--",
      ...paths,
    ],
    { maxStdoutBytes: Math.max(maxBytes, 16_384) },
  );
  if (result.terminationReason === "timeout") {
    throw new WorkspaceAccessError(`Git diff timed out for ${change.path}.`);
  }
  const unsafeKind = detectUnsafeGitObject(result.stdout);
  if (unsafeKind) {
    return {
      output: {
        ...publicGitChange(change),
        additions: null,
        deletions: null,
        diff: null,
        binary: unsafeKind === "binary",
        omittedReason: unsafeKind,
        truncated: false,
      },
      usedLines: 0,
      usedBytes: 0,
    };
  }
  const bounded = boundPatch(result.stdout, maxLines, maxBytes);
  const counts = countPatchLines(result.stdout);
  return {
    output: {
      ...publicGitChange(change),
      additions: counts.additions,
      deletions: counts.deletions,
      diff: bounded.text,
      binary: false,
      truncated: bounded.truncated || result.terminationReason === "output_limit",
    },
    usedLines: bounded.lines,
    usedBytes: bounded.bytes,
  };
}

async function readUntrackedDiff(
  config: ServerConfig,
  context: GitContext,
  change: GitChange,
  maxLines: number,
  maxBytes: number,
): Promise<{ output: unknown; usedLines: number; usedBytes: number }> {
  const rootRelative = projectPathToRootRelative(context, change.path);
  const resolved = await resolveWorkspacePath(config, rootRelative, "file", context.rootId);
  const window = await readTextWindow(resolved.absolute, resolved.stat.size, {
    startLine: 1,
    maxLines,
    maxSourceBytes: config.maxFileBytes,
    maxReturnedBytes: Math.max(1, maxBytes - 128),
  });
  const header = `diff --git a/${change.path} b/${change.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${change.path}\n@@ -0,0 +1,${window.totalLines} @@`;
  const body = window.text
    .split("\n")
    .map((line) => `+${line}`)
    .join("\n");
  const bounded = boundPatch(`${header}\n${body}`, maxLines, maxBytes);
  return {
    output: {
      ...publicGitChange(change),
      additions: window.totalLines,
      deletions: 0,
      diff: bounded.text,
      binary: false,
      truncated: window.truncated || bounded.truncated,
    },
    usedLines: bounded.lines,
    usedBytes: bounded.bytes,
  };
}

function parsePorcelainStatus(stdout: string): GitChange[] {
  const tokens = stdout.split("\0");
  const changes: GitChange[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.length < 3) {
      continue;
    }
    const statusCode = token.slice(0, 2);
    const pathValue = normalizeGitPath(token.slice(3));
    if (!pathValue) {
      continue;
    }
    let oldPath: string | undefined;
    if (statusCode.includes("R") || statusCode.includes("C")) {
      oldPath = normalizeGitPath(tokens[++index] ?? "") || undefined;
    }
    changes.push({
      statusCode,
      status: statusName(statusCode),
      path: pathValue,
      oldPath,
      untracked: statusCode === "??",
    });
  }
  return changes;
}

function parseNameStatus(stdout: string): GitChange[] {
  const tokens = stdout.split("\0").filter((token) => token.length > 0);
  const changes: GitChange[] = [];
  let index = 0;
  while (index < tokens.length) {
    let statusCode = tokens[index++];
    let firstPath: string | undefined;
    const tabIndex = statusCode.indexOf("\t");
    if (tabIndex >= 0) {
      firstPath = statusCode.slice(tabIndex + 1);
      statusCode = statusCode.slice(0, tabIndex);
    } else {
      firstPath = tokens[index++];
    }
    if (!firstPath) {
      continue;
    }
    let pathValue = normalizeGitPath(firstPath);
    let oldPath: string | undefined;
    if (statusCode.startsWith("R") || statusCode.startsWith("C")) {
      oldPath = pathValue;
      pathValue = normalizeGitPath(tokens[index++] ?? "");
    }
    if (!pathValue) {
      continue;
    }
    changes.push({
      statusCode,
      status: statusName(statusCode),
      path: pathValue,
      oldPath,
    });
  }
  return changes;
}

function toProjectRelativeChange(
  context: GitContext,
  change: GitChange,
): GitChange | undefined {
  const projectPath = stripGitScope(context.scope, change.path);
  if (!projectPath) {
    return undefined;
  }
  const oldPath = change.oldPath ? stripGitScope(context.scope, change.oldPath) : undefined;
  if (change.oldPath && !oldPath) {
    return undefined;
  }
  return { ...change, path: projectPath, oldPath };
}

function stripGitScope(scope: string, value: string): string | undefined {
  const normalized = normalizeGitPath(value);
  if (scope === ".") {
    return normalized || undefined;
  }
  const prefix = `${normalizeGitPath(scope)}/`;
  if (!normalized.toLowerCase().startsWith(prefix.toLowerCase())) {
    return undefined;
  }
  return normalized.slice(prefix.length) || undefined;
}

function isAllowedGitChange(config: ServerConfig, context: GitContext, change: GitChange): boolean {
  try {
    validateProjectRelativePath(config, context, change.path);
    if (change.oldPath) {
      validateProjectRelativePath(config, context, change.oldPath);
    }
    return true;
  } catch {
    return false;
  }
}

function validateProjectRelativePath(config: ServerConfig, context: GitContext, value: string): void {
  if (!value || path.isAbsolute(value) || path.win32.isAbsolute(value) || /^[a-z]:/i.test(value)) {
    throw new WorkspaceAccessError("Git path must be relative to the selected project.");
  }
  const absolute = path.resolve(context.project.absolute, value.split("/").join(path.sep));
  assertWithinRoot(context.project.absolute, absolute, "Git path escapes the selected project scope.");
  const workspaceRoot = resolveWorkspaceRoot(config, context.rootId);
  const rootRelative = toWorkspaceRelative(workspaceRoot.path, absolute);
  resolveWorkspacePathCandidate(config, rootRelative, context.rootId);
}

function projectPathToRootRelative(context: GitContext, value: string): string {
  const absolute = path.resolve(context.project.absolute, value.split("/").join(path.sep));
  return toWorkspaceRelative(context.project.rootPath, absolute);
}

function detectUnsafeGitObject(diff: string): "binary" | "symlink" | "submodule" | undefined {
  if (/^(?:old|new|deleted file|new file) mode 120000$/m.test(diff)) {
    return "symlink";
  }
  if (/^(?:old|new|deleted file|new file) mode 160000$/m.test(diff) || /^Subproject commit /m.test(diff)) {
    return "submodule";
  }
  if (/^Binary files .* differ$/m.test(diff) || /^GIT binary patch$/m.test(diff)) {
    return "binary";
  }
  return undefined;
}

function countPatchLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

function boundPatch(value: string, maxLines: number, maxBytes: number): {
  text: string;
  lines: number;
  bytes: number;
  truncated: boolean;
} {
  const allLines = value.split(/\r?\n/);
  const lineBounded = allLines.slice(0, maxLines).join("\n");
  const byteBounded = truncateUtf8(lineBounded, maxBytes);
  return {
    text: byteBounded.text,
    lines: byteBounded.text ? byteBounded.text.split("\n").length : 0,
    bytes: byteBounded.bytes,
    truncated: allLines.length > maxLines || byteBounded.truncated,
  };
}

function diffModeArgs(mode: GitDiffMode): string[] {
  if (mode === "staged") {
    return ["--cached"];
  }
  if (mode === "all") {
    return ["HEAD"];
  }
  return [];
}

async function hasHead(config: ServerConfig, cwd: string): Promise<boolean> {
  const result = await runGit(config, cwd, ["rev-parse", "--verify", "HEAD"]);
  return result.code === 0;
}

async function readBranch(config: ServerConfig, cwd: string): Promise<string> {
  const symbolic = await runGit(config, cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (symbolic.code === 0) {
    return symbolic.stdout.trim();
  }
  const detached = await runGit(config, cwd, ["rev-parse", "--short", "HEAD"]);
  return detached.code === 0 ? `detached@${detached.stdout.trim()}` : "unborn";
}

function statusName(statusCode: string): string {
  if (statusCode === "??") return "untracked";
  if (statusCode.includes("R") || statusCode.startsWith("R")) return "renamed";
  if (statusCode.includes("C") || statusCode.startsWith("C")) return "copied";
  if (statusCode.includes("D") || statusCode.startsWith("D")) return "deleted";
  if (statusCode.includes("A") || statusCode.startsWith("A")) return "added";
  if (statusCode.includes("U") || statusCode.startsWith("U")) return "unmerged";
  if (statusCode.includes("T") || statusCode.startsWith("T")) return "type-changed";
  return "modified";
}

function normalizeGitPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

async function runGit(
  config: ServerConfig,
  cwd: string,
  args: readonly string[],
  overrides: { maxStdoutBytes?: number } = {},
): Promise<BoundedProcessResult> {
  return runBoundedProcess(
    "git",
    ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", cwd, ...args],
    {
      timeoutMs: config.gitTimeoutMs,
      maxStdoutBytes: overrides.maxStdoutBytes ?? Math.max(config.maxGitDiffBytes, 262_144),
      maxStderrBytes: 131_072,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_EXTERNAL_DIFF: "" },
    },
  );
}

function assertGitSuccess(result: BoundedProcessResult, operation: string): void {
  assertGitBounded(result, operation);
  if (result.code !== 0) {
    throw new WorkspaceAccessError(
      `${operation} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
    );
  }
}

function assertGitBounded(result: BoundedProcessResult, operation: string): void {
  if (result.terminationReason === "timeout") {
    throw new WorkspaceAccessError(`${operation} timed out.`);
  }
  if (result.terminationReason === "output_limit") {
    throw new WorkspaceAccessError(`${operation} exceeded its output limit.`);
  }
}

function clampInt(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}
