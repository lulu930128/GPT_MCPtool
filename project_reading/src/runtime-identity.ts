import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBoundedProcess } from "./process-runner.js";

export interface RuntimeIdentity {
  applicationVersion: string;
  toolContractVersion: string;
  buildId: string | null;
  buildTime: string | null;
  gitCommit: string | null;
  dirty: boolean | null;
  runtimeStartedAt: string;
}

export interface SearchRuntime {
  preferred: "ripgrep";
  active: "ripgrep" | "javascript";
  version: string | null;
  source: "configured" | "bundled" | "path" | "fallback";
  command: string | null;
}

interface PackageMetadata {
  version?: string;
  toolContractVersion?: string;
}

interface BuildMetadata {
  buildId?: string | null;
  buildTime?: string | null;
  gitCommit?: string | null;
  dirty?: boolean | null;
}

export async function loadRuntimeIdentity(): Promise<RuntimeIdentity> {
  const projectRoot = getProjectRoot();
  const packageMetadata = await readJson<PackageMetadata>(path.join(projectRoot, "package.json"));
  const buildMetadata = await readJson<BuildMetadata>(path.join(projectRoot, "dist", "build-info.json"));
  return {
    applicationVersion: packageMetadata?.version ?? "0.0.0-unknown",
    toolContractVersion: packageMetadata?.toolContractVersion ?? "unknown",
    buildId: buildMetadata?.buildId ?? null,
    buildTime: buildMetadata?.buildTime ?? null,
    gitCommit: buildMetadata?.gitCommit ?? null,
    dirty: typeof buildMetadata?.dirty === "boolean" ? buildMetadata.dirty : null,
    runtimeStartedAt: new Date().toISOString(),
  };
}

export async function detectSearchRuntime(env: NodeJS.ProcessEnv): Promise<SearchRuntime> {
  const configured = env.WORKSPACE_MCP_RG_PATH?.trim();
  if (configured) {
    if (!path.isAbsolute(configured) && !path.win32.isAbsolute(configured)) {
      throw new Error("WORKSPACE_MCP_RG_PATH must be an absolute executable path.");
    }
    const real = await fs.realpath(configured);
    const stat = await fs.stat(real);
    if (!stat.isFile()) {
      throw new Error("WORKSPACE_MCP_RG_PATH is not a regular file.");
    }
    const version = await probeRipgrep(real);
    if (!version) {
      throw new Error("Configured ripgrep executable did not return a supported version.");
    }
    return { preferred: "ripgrep", active: "ripgrep", version, source: "configured", command: real };
  }

  try {
    const { rgPath } = await import("@vscode/ripgrep");
    const version = await probeRipgrep(rgPath);
    if (version) {
      return {
        preferred: "ripgrep",
        active: "ripgrep",
        version,
        source: "bundled",
        command: rgPath,
      };
    }
  } catch {
    // Missing platform optional dependency or an unusable binary falls through safely.
  }

  try {
    const version = await probeRipgrep("rg");
    if (version) {
      return { preferred: "ripgrep", active: "ripgrep", version, source: "path", command: "rg" };
    }
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      // A broken PATH candidate is not trusted; use the bounded in-process fallback.
    }
  }
  return { preferred: "ripgrep", active: "javascript", version: null, source: "fallback", command: null };
}

async function probeRipgrep(command: string): Promise<string | null> {
  const result = await runBoundedProcess(command, ["--version"], {
    timeoutMs: 2_000,
    maxStdoutBytes: 8_192,
    maxStderrBytes: 8_192,
  });
  if (result.code !== 0 || result.terminationReason) {
    return null;
  }
  const firstLine = result.stdout.split(/\r?\n/, 1)[0]?.trim();
  const match = firstLine?.match(/^ripgrep\s+(.+)$/i);
  return match?.[1] ?? null;
}

function getProjectRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "..", "..");
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}
