import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import type { BridgeProject } from "./types.js";

export interface BridgeConfig {
  projectRoot: string;
  projectsFile: string;
  projects: Map<string, BridgeProject>;
  dataDir: string;
  jobsDir: string;
  stagingDir: string;
  widgetPath: string;
  codexCommand: string;
  codexArgs: string[];
  httpHost: string;
  httpPort: number;
  httpToken?: string;
  maxRecentJobs: number;
  buildId: string;
}

interface ProjectsFileShape {
  projects?: Array<{ id?: unknown; name?: unknown; path?: unknown }>;
}

const COMPONENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function loadBridgeConfig(env: NodeJS.ProcessEnv = process.env): Promise<BridgeConfig> {
  const projectRoot = resolve(env.CODEX_BRIDGE_PROJECT_ROOT?.trim() || COMPONENT_ROOT);
  const projectsFile = resolve(
    env.CODEX_BRIDGE_PROJECTS_FILE?.trim() || join(projectRoot, ".local", "projects.json"),
  );
  const dataDir = resolve(
    env.CODEX_BRIDGE_DATA_DIR?.trim() ||
      (process.platform === "win32" ? "C:\\CodexBridge" : join(homedir(), ".codex-bridge")),
  );
  const projects = await loadProjects(projectsFile);
  const codexLaunch = await resolveCodexLaunch(projectRoot, env);

  return {
    projectRoot,
    projectsFile,
    projects,
    dataDir,
    jobsDir: join(dataDir, "jobs"),
    stagingDir: join(dataDir, "staging"),
    widgetPath: join(projectRoot, "web", "codex-console.html"),
    codexCommand: codexLaunch.command,
    codexArgs: codexLaunch.args,
    httpHost: env.CODEX_BRIDGE_HTTP_HOST?.trim() || "127.0.0.1",
    httpPort: parsePort(env.CODEX_BRIDGE_HTTP_PORT, 8828),
    httpToken: env.CODEX_BRIDGE_HTTP_TOKEN?.trim() || undefined,
    maxRecentJobs: parseBoundedInt(env.CODEX_BRIDGE_MAX_RECENT_JOBS, 20, 1, 100),
    buildId: await computeRuntimeBuildId(projectRoot),
  };
}

export async function loadProjects(projectsFile: string): Promise<Map<string, BridgeProject>> {
  let raw: string;
  try {
    raw = await readFile(projectsFile, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `Missing project allowlist: ${projectsFile}. Copy config/projects.example.json to .local/projects.json and configure approved projects.`,
      );
    }
    throw error;
  }

  let parsed: ProjectsFileShape;
  try {
    parsed = JSON.parse(raw) as ProjectsFileShape;
  } catch (error) {
    throw new Error(`Invalid JSON in project allowlist ${projectsFile}: ${errorMessage(error)}`);
  }

  if (!Array.isArray(parsed.projects) || parsed.projects.length === 0) {
    throw new Error(`Project allowlist ${projectsFile} must contain at least one project.`);
  }

  const projects = new Map<string, BridgeProject>();
  for (const entry of parsed.projects) {
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const configuredPath = typeof entry.path === "string" ? entry.path.trim() : "";
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(id)) {
      throw new Error(`Invalid project id '${id || "(empty)"}' in ${projectsFile}.`);
    }
    if (projects.has(id)) {
      throw new Error(`Duplicate project id '${id}' in ${projectsFile}.`);
    }
    if (!name || name.length > 80) {
      throw new Error(`Project '${id}' must have a name between 1 and 80 characters.`);
    }
    if (!configuredPath || !isAbsolute(configuredPath)) {
      throw new Error(`Project '${id}' must use an absolute path.`);
    }

    let resolvedPath: string;
    try {
      resolvedPath = await realpath(configuredPath);
      const info = await stat(resolvedPath);
      if (!info.isDirectory()) {
        throw new Error("not a directory");
      }
    } catch (error) {
      throw new Error(`Project '${id}' path is not a usable directory: ${configuredPath} (${errorMessage(error)}).`);
    }
    if (samePath(resolvedPath, parse(resolvedPath).root)) {
      throw new Error(`Project '${id}' cannot allowlist a filesystem root.`);
    }
    projects.set(id, { id, name, path: resolvedPath });
  }
  return projects;
}

export function requireProject(config: BridgeConfig, projectId: string): BridgeProject {
  const project = config.projects.get(projectId);
  if (!project) {
    throw new Error(`Unknown project id '${projectId}'.`);
  }
  return project;
}

export function parsePort(value: string | undefined, fallback: number): number {
  return parseBoundedInt(value, fallback, 0, 65535);
}

export async function computeRuntimeBuildId(projectRoot: string): Promise<string> {
  const hash = createHash("sha256");
  const candidates = [join(projectRoot, "package.json"), join(projectRoot, "dist", "src"), join(projectRoot, "web")];
  for (const candidate of candidates) {
    await hashPath(hash, candidate, projectRoot);
  }
  return hash.digest("hex").slice(0, 16);
}

async function hashPath(hash: ReturnType<typeof createHash>, path: string, base: string): Promise<void> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        await hashPath(hash, join(path, entry.name), base);
      }
      return;
    }
    if (info.isFile()) {
      hash.update(path.slice(base.length).replaceAll("\\", "/"));
      hash.update(await readFile(path));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function parseCommandArgs(raw: string | undefined): string[] | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string" || !value.trim())) {
      throw new Error("expected a JSON string array");
    }
    return parsed;
  } catch (error) {
    throw new Error(`CODEX_BRIDGE_CODEX_ARGS must be a JSON string array: ${errorMessage(error)}.`);
  }
}

async function resolveCodexLaunch(
  projectRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<{ command: string; args: string[] }> {
  const configuredCommand = env.CODEX_BRIDGE_CODEX_COMMAND?.trim();
  const configuredArgs = parseCommandArgs(env.CODEX_BRIDGE_CODEX_ARGS);
  if (configuredCommand) {
    return { command: configuredCommand, args: configuredArgs ?? ["app-server"] };
  }

  const localLauncher = join(projectRoot, "node_modules", "@openai", "codex", "bin", "codex.js");
  try {
    const info = await stat(localLauncher);
    if (info.isFile()) {
      return { command: process.execPath, args: [localLauncher, ...(configuredArgs ?? ["app-server"])] };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { command: "codex", args: configuredArgs ?? ["app-server"] };
}

function parseBoundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
