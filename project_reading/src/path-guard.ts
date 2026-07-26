import fs from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";
import type { ServerConfig, WorkspaceRootConfig } from "./config.js";

export type ExpectedPathType = "file" | "directory";

export interface ResolvedWorkspacePath {
  rootId: string;
  rootPath: string;
  absolute: string;
  relative: string;
  stat: Stats;
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
  const workspaceRoot = resolveWorkspaceRoot(config, rootId);
  const rawPath = normalizeUserPath(inputPath);
  const candidate = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(workspaceRoot.path, rawPath);

  assertWithinRoot(workspaceRoot.path, candidate, "Path is outside the configured workspace root.");
  assertNotDenied(config, workspaceRoot, candidate);

  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch (error) {
    throw new WorkspaceAccessError(`Path does not exist: ${displayInput(rawPath)}`);
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
    lower === "credentials.json" ||
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
  return value;
}

function displayInput(input: string): string {
  return input === "." ? "workspace root" : input;
}
