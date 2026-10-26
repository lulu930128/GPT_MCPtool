import fs from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";
import type { ServerConfig, WorkspaceRootConfig } from "./config.js";
import { WorkspaceWriteError, errorCode } from "./write-errors.js";

export type ExpectedPathType = "file" | "directory";

export interface ResolvedWorkspacePath {
  rootId: string;
  rootPath: string;
  absolute: string;
  relative: string;
  stat: Stats;
}

export interface WorkspacePathCandidate {
  rootId: string;
  rootPath: string;
  absolute: string;
  relative: string;
}

export class WorkspaceAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceAccessError";
  }
}

export async function resolveWorkspacePath(
  config: ServerConfig,
  inputPath: string | undefined,
  expectedType?: ExpectedPathType,
  rootId?: string,
): Promise<ResolvedWorkspacePath> {
  const candidate = resolveWorkspacePathCandidate(config, inputPath, rootId);
  const workspaceRoot = resolveWorkspaceRoot(config, candidate.rootId);

  let real: string;
  try {
    real = await fs.realpath(candidate.absolute);
  } catch (error) {
    throw new WorkspaceAccessError(`Path does not exist: ${displayInput(candidate.relative)}`);
  }

  assertWithinRoot(workspaceRoot.path, real, "Resolved path escapes the configured workspace root.");
  assertNotDenied(config, workspaceRoot, real);

  const stat = await fs.stat(real);
  if (expectedType === "file" && !stat.isFile()) {
    throw new WorkspaceAccessError("Path is not a regular file.");
  }
  if (expectedType === "directory" && !stat.isDirectory()) {
    throw new WorkspaceAccessError("Path is not a directory.");
  }

  return {
    rootId: workspaceRoot.id,
    rootPath: workspaceRoot.path,
    absolute: real,
    relative: toWorkspaceRelative(workspaceRoot.path, real),
    stat,
  };
}

export function resolveWorkspacePathCandidate(
  config: ServerConfig,
  inputPath: string | undefined,
  rootId?: string,
): WorkspacePathCandidate {
  const workspaceRoot = resolveWorkspaceRoot(config, rootId);
  const rawPath = normalizeUserPath(inputPath);
  const candidate = path.resolve(workspaceRoot.path, rawPath);
  assertWithinRoot(workspaceRoot.path, candidate, "Path is outside the configured workspace root.");
  assertNotDenied(config, workspaceRoot, candidate);
  return {
    rootId: workspaceRoot.id,
    rootPath: workspaceRoot.path,
    absolute: candidate,
    relative: toWorkspaceRelative(workspaceRoot.path, candidate),
  };
}

export function resolveWorkspaceRoot(
  config: ServerConfig,
  rootId: string | undefined,
): WorkspaceRootConfig {
  const selectedId = rootId?.trim() || config.defaultRootId;
  const workspaceRoot = config.roots.get(selectedId);
  if (!workspaceRoot) {
    throw new WorkspaceAccessError(
      `Unknown workspace root: ${selectedId}. Allowed roots: ${Array.from(config.roots.keys()).join(", ")}`,
    );
  }
  return workspaceRoot;
}

export function assertWithinRoot(root: string, target: string, message: string): void {
  const relative = path.relative(root, target);
  if (relative === "") {
    return;
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new WorkspaceAccessError(message);
  }
}

export function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertNotDenied(
  config: ServerConfig,
  workspaceRoot: WorkspaceRootConfig,
  target: string,
): void {
  const denial = getDenialReason(config, workspaceRoot, target);
  if (denial) {
    throw new WorkspaceAccessError(denial);
  }
}

export function getDenialReason(
  config: ServerConfig,
  workspaceRoot: WorkspaceRootConfig,
  target: string,
): string | undefined {
  const relative = path.relative(workspaceRoot.path, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }

  const segments = relative.split(/[\\/]+/).filter(Boolean);
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (workspaceRoot.denyDirs.has(lower)) {
      return `Path includes denied directory: ${segment}`;
    }
  }

  const basename = segments.at(-1) ?? "";
  if (isDeniedFileName(basename)) {
    return `Path includes denied file name: ${basename}`;
  }

  const extension = path.extname(basename).toLowerCase();
  if (extension && config.denyExtensions.has(extension)) {
    return `Path includes denied file extension: ${extension}`;
  }

  return undefined;
}

export function isDeniedFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === ".env" ||
    lower.startsWith(".env.") ||
    lower === "id_rsa" ||
    lower === "id_dsa" ||
    lower === "id_ecdsa" ||
    lower === "id_ed25519" ||
    lower === "auth.json" ||
    lower === "cap_sid" ||
    lower === "credentials.json" ||
    lower === "installation_id" ||
    lower === "session_index.jsonl" ||
    lower === "transcription-history.jsonl" ||
    lower === ".codex-global-state.json" ||
    lower === ".codex-global-state.json.bak" ||
    lower.startsWith("..codex-global-state.json.") ||
    lower === "token.json"
  );
}

export function toWorkspaceRelative(root: string, target: string): string {
  const relative = path.relative(root, target);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

function normalizeUserPath(inputPath: string | undefined): string {
  const value = inputPath?.trim() || ".";
  if (value.includes("\0")) {
    throw new WorkspaceAccessError("Path contains a NUL byte.");
  }
  if (
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    path.posix.isAbsolute(value) ||
    /^[a-z]:/i.test(value)
  ) {
    throw new WorkspaceAccessError("Path must be relative to the selected workspace root.");
  }
  return value;
}

function displayInput(input: string): string {
  return input === "." ? "workspace root" : input;
}

/** Strict lexical rules for writes; read-path compatibility remains unchanged. */
export function validateWriteRelativePath(value: string): void {
  if (!value || value.length > 512 || path.win32.isAbsolute(value) || path.posix.isAbsolute(value) ||
      /[\x00-\x1f\x7f:<>"|?*]/.test(value)) {
    throw new WorkspaceWriteError("PATH_DENIED", "Write paths must be ordinary relative file paths.");
  }
  const segments = value.split(/[\\/]/);
  if (segments.length > 32 || segments.some((part) => !part || part === "." || part === ".." ||
      /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part))) {
    throw new WorkspaceWriteError("PATH_DENIED", "Ambiguous or reserved path segments are not writable.");
  }
}

export interface WritePathInspection {
  canonicalPath: string;
  stat?: Stats;
  ancestors: Array<{ path: string; dev: number; ino: number }>;
}

/** Also used for operator-owned policy/state paths, without workspace authorization. */
export async function inspectWritePath(absolute: string): Promise<WritePathInspection> {
  return inspectWritePathInternal(absolute, false);
}

/** Only an operator-owned state anchor may resolve a non-symlink filesystem alias.
 * Workspace candidates and all children of the bound state remain strict. */
export async function inspectOperatorStatePath(absolute: string): Promise<WritePathInspection> {
  return inspectWritePathInternal(absolute, true);
}

async function inspectWritePathInternal(absolute: string, allowStateAlias: boolean): Promise<WritePathInspection> {
  const parsed = path.parse(absolute);
  if (!parsed.root || absolute.startsWith("\\\\")) throw new WorkspaceWriteError("PATH_DENIED");
  let cursor = parsed.root;
  const ancestors: WritePathInspection["ancestors"] = [];
  let stat: Stats | undefined = await fs.lstat(cursor);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new WorkspaceWriteError("PATH_DENIED");
  ancestors.push({ path: cursor, dev: stat.dev, ino: stat.ino });
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]);
    try {
      stat = await fs.lstat(cursor);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { canonicalPath: path.join(cursor, ...segments.slice(index + 1)), ancestors };
      throw error;
    }
    if (stat.isSymbolicLink()) throw new WorkspaceWriteError("SYMLINK_DENIED", "Symbolic link or junction node is not writable.");
    if (stat.isFile() && stat.nlink !== 1) throw new WorkspaceWriteError("HARDLINK_DENIED");
    if (!stat.isFile() && !stat.isDirectory()) throw new WorkspaceWriteError("UNSUPPORTED_FILE_TYPE");
    if (index < segments.length - 1 && !stat.isDirectory()) throw new WorkspaceWriteError("PATH_DENIED");
    const real = await fs.realpath(cursor);
    if (real.toLowerCase() !== cursor.toLowerCase()) {
      if (!allowStateAlias) throw new WorkspaceWriteError("SYMLINK_DENIED", "Canonical path differs from the bound write path.");
      // MSIX AppData virtualization can expose the same directory under a second
      // name without a symlink. Verify both identities and the complete physical
      // ancestry before binding state IO to that physical path.
      const physical = await inspectWritePath(real);
      const logicalIdentity = await fs.lstat(cursor, { bigint: true });
      const physicalIdentity = await fs.lstat(real, { bigint: true });
      if (!logicalIdentity.isDirectory() || !physicalIdentity.isDirectory() ||
          logicalIdentity.isSymbolicLink() || physicalIdentity.isSymbolicLink() ||
          logicalIdentity.ino === 0n || logicalIdentity.ino !== physicalIdentity.ino || logicalIdentity.dev !== physicalIdentity.dev ||
          Number(logicalIdentity.ino) !== stat.ino || Number(logicalIdentity.dev) !== stat.dev) {
        throw new WorkspaceWriteError("PATH_CHANGED", "Operator state alias must identify the same physical directory.");
      }
      return inspectWritePath(path.join(physical.canonicalPath, ...segments.slice(index + 1)));
    }
    if (stat.isDirectory()) ancestors.push({ path: cursor, dev: stat.dev, ino: stat.ino });
  }
  return { canonicalPath: cursor, stat, ancestors };
}

export async function resolveWorkspaceWritePath(config: ServerConfig, inputPath: string, rootId: string) {
  validateWriteRelativePath(inputPath);
  let candidate: WorkspacePathCandidate;
  try {
    candidate = resolveWorkspacePathCandidate(config, inputPath, rootId);
  } catch {
    throw new WorkspaceWriteError("PATH_DENIED", "Unknown root, denied path, or path outside the workspace root.");
  }
  const forbidden = new Set(["credentials", "secrets", "policy", "policies"]);
  const names = new Set(["agents.md", "skill.md", "write_policy.json", "write-policy.json"]);
  // Inspect the full physical path too: a named root inside a protected directory
  // must not bypass the relative-path deny rules.
  const fullParts = candidate.absolute.split(/[\\/]+/);
  if (fullParts.some((part) => part.startsWith(".") || forbidden.has(part.toLowerCase()) || names.has(part.toLowerCase()) ||
      config.denyDirs.has(part.toLowerCase()))) throw new WorkspaceWriteError("PATH_DENIED");
  for (const protectedPath of config.writePolicy.protectedPaths) {
    if (isWithinRoot(protectedPath, candidate.absolute) || isWithinRoot(candidate.absolute, protectedPath)) {
      throw new WorkspaceWriteError("PATH_DENIED", "Server, policy, and operation state are protected.");
    }
  }
  const inspection = await inspectWritePath(candidate.absolute);
  return { ...candidate, ...inspection };
}

export async function assertWriteAncestorsUnchanged(ancestors: WritePathInspection["ancestors"]): Promise<void> {
  for (const previous of ancestors) {
    const now = await fs.lstat(previous.path);
    if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== previous.dev || now.ino !== previous.ino) {
      throw new WorkspaceWriteError("PATH_CHANGED");
    }
  }
}
