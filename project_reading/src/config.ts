import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_DENY_DIRS = [
  ".git",
  ".hg",
  ".svn",
  ".agents",
  ".codex",
  ".openai",
  ".secrets",
  ".tunnel-client",
  ".cache",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".next",
  ".nuxt",
  ".turbo",
  ".pnpm-store",
  ".tmp",
  "node_modules",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  "dist",
  "build",
  "coverage",
  "$recycle.bin",
  "system volume information",
] as const;

export const DEFAULT_DENY_EXTENSIONS = [
  ".db",
  ".sqlite",
  ".sqlite3",
  ".mdb",
  ".accdb",
  ".pem",
  ".key",
  ".pfx",
  ".p12",
  ".crt",
  ".cer",
  ".zip",
  ".7z",
  ".rar",
  ".tar",
  ".gz",
  ".xz",
  ".zst",
  ".onnx",
  ".safetensors",
  ".pt",
  ".pth",
  ".ckpt",
  ".bin",
] as const;

export interface ServerConfig {
  defaultRootId: string;
  root: string;
  roots: Map<string, WorkspaceRootConfig>;
  assetScopes: Map<string, AssetScopeConfig>;
  maxFileBytes: number;
  maxReadLines: number;
  maxSearchResults: number;
  maxDirEntries: number;
  searchTimeoutMs: number;
  maxImageFileBytes: number;
  maxImagePixels: number;
  maxImageDimension: number;
  maxImageOutputBytes: number;
  maxSpreadsheetFileBytes: number;
  maxSpreadsheetExpandedBytes: number;
  maxSpreadsheetZipEntries: number;
  maxSpreadsheetCells: number;
  maxSpreadsheetRows: number;
  maxSpreadsheetColumns: number;
  maxOfficeFileBytes: number;
  maxOfficeExpandedBytes: number;
  maxOfficeZipEntries: number;
  maxOfficeXmlPartBytes: number;
  maxOfficeXmlTotalBytes: number;
  maxOfficeTextChars: number;
  maxDocumentBlocks: number;
  maxDocumentTableCells: number;
  maxPresentationSlides: number;
  denyDirs: Set<string>;
  denyExtensions: Set<string>;
}

export interface WorkspaceRootConfig {
  id: string;
  path: string;
  denyDirs: Set<string>;
}

export interface AssetScopeConfig {
  id: string;
  rootId: string;
  path: string;
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<ServerConfig> {
  const denyDirs = mergeSet(DEFAULT_DENY_DIRS, env.WORKSPACE_MCP_EXTRA_DENY_DIRS);
  const rootSpecs = parseRootSpecs(env.WORKSPACE_MCP_ROOTS, env.WORKSPACE_MCP_ROOT);
  const rootDenyDirs = parseRootDenyDirs(env.WORKSPACE_MCP_ROOT_DENY_DIRS);
  const roots = new Map<string, WorkspaceRootConfig>();
  const resolvedPaths = new Set<string>();

  for (const rootSpec of rootSpecs) {
    const resolvedPath = await fs.realpath(path.resolve(rootSpec.path));
    const normalizedPath = resolvedPath.toLowerCase();
    if (resolvedPaths.has(normalizedPath)) {
      throw new Error(`Workspace root path is configured more than once: ${resolvedPath}`);
    }
    resolvedPaths.add(normalizedPath);

    const perRootDenyDirs = new Set(denyDirs);
    for (const item of rootDenyDirs.get(rootSpec.id) ?? []) {
      perRootDenyDirs.add(item);
    }
    roots.set(rootSpec.id, {
      id: rootSpec.id,
      path: resolvedPath,
      denyDirs: perRootDenyDirs,
    });
  }
  for (const rootId of rootDenyDirs.keys()) {
    if (!roots.has(rootId)) {
      throw new Error(
        `WORKSPACE_MCP_ROOT_DENY_DIRS references unknown root ${rootId}. ` +
          `Configured roots: ${Array.from(roots.keys()).join(", ")}`,
      );
    }
  }

  const requestedDefaultRoot = env.WORKSPACE_MCP_DEFAULT_ROOT?.trim();
  const defaultRootId =
    requestedDefaultRoot || (roots.has("projects") ? "projects" : roots.keys().next().value);
  if (!defaultRootId || !roots.has(defaultRootId)) {
    throw new Error(
      `Unknown WORKSPACE_MCP_DEFAULT_ROOT: ${requestedDefaultRoot || "(empty)"}. ` +
        `Configured roots: ${Array.from(roots.keys()).join(", ")}`,
    );
  }
  const root = roots.get(defaultRootId)?.path;
  if (!root) {
    throw new Error(`Default workspace root is unavailable: ${defaultRootId}`);
  }
  const assetScopes = parseAssetScopes(env.WORKSPACE_MCP_ASSET_SCOPES, roots);

  return {
    defaultRootId,
    root,
    roots,
    assetScopes,
    maxFileBytes: parsePositiveInt(env.WORKSPACE_MCP_MAX_FILE_BYTES, 262_144),
    maxReadLines: parsePositiveInt(env.WORKSPACE_MCP_MAX_READ_LINES, 300),
    maxSearchResults: parsePositiveInt(env.WORKSPACE_MCP_MAX_SEARCH_RESULTS, 80),
    maxDirEntries: parsePositiveInt(env.WORKSPACE_MCP_MAX_DIR_ENTRIES, 200),
    searchTimeoutMs: parsePositiveInt(env.WORKSPACE_MCP_SEARCH_TIMEOUT_MS, 8_000),
    maxImageFileBytes: parsePositiveInt(env.WORKSPACE_MCP_MAX_IMAGE_FILE_BYTES, 52_428_800),
    maxImagePixels: parsePositiveInt(env.WORKSPACE_MCP_MAX_IMAGE_PIXELS, 100_000_000),
    maxImageDimension: parsePositiveInt(env.WORKSPACE_MCP_MAX_IMAGE_DIMENSION, 4_096),
    maxImageOutputBytes: parsePositiveInt(env.WORKSPACE_MCP_MAX_IMAGE_OUTPUT_BYTES, 12_582_912),
    maxSpreadsheetFileBytes: parsePositiveInt(
      env.WORKSPACE_MCP_MAX_SPREADSHEET_FILE_BYTES,
      26_214_400,
    ),
    maxSpreadsheetExpandedBytes: parsePositiveInt(
      env.WORKSPACE_MCP_MAX_SPREADSHEET_EXPANDED_BYTES,
      104_857_600,
    ),
    maxSpreadsheetZipEntries: parsePositiveInt(
      env.WORKSPACE_MCP_MAX_SPREADSHEET_ZIP_ENTRIES,
      2_048,
    ),
    maxSpreadsheetCells: parsePositiveInt(env.WORKSPACE_MCP_MAX_SPREADSHEET_CELLS, 5_000),
    maxSpreadsheetRows: parsePositiveInt(env.WORKSPACE_MCP_MAX_SPREADSHEET_ROWS, 500),
    maxSpreadsheetColumns: parsePositiveInt(env.WORKSPACE_MCP_MAX_SPREADSHEET_COLUMNS, 100),
    maxOfficeFileBytes: parsePositiveInt(env.WORKSPACE_MCP_MAX_OFFICE_FILE_BYTES, 104_857_600),
    maxOfficeExpandedBytes: parsePositiveInt(
      env.WORKSPACE_MCP_MAX_OFFICE_EXPANDED_BYTES,
      524_288_000,
    ),
    maxOfficeZipEntries: parsePositiveInt(env.WORKSPACE_MCP_MAX_OFFICE_ZIP_ENTRIES, 4_096),
    maxOfficeXmlPartBytes: parsePositiveInt(
      env.WORKSPACE_MCP_MAX_OFFICE_XML_PART_BYTES,
      10_485_760,
    ),
    maxOfficeXmlTotalBytes: parsePositiveInt(
      env.WORKSPACE_MCP_MAX_OFFICE_XML_TOTAL_BYTES,
      52_428_800,
    ),
    maxOfficeTextChars: parsePositiveInt(env.WORKSPACE_MCP_MAX_OFFICE_TEXT_CHARS, 100_000),
    maxDocumentBlocks: parsePositiveInt(env.WORKSPACE_MCP_MAX_DOCUMENT_BLOCKS, 300),
    maxDocumentTableCells: parsePositiveInt(
      env.WORKSPACE_MCP_MAX_DOCUMENT_TABLE_CELLS,
      5_000,
    ),
    maxPresentationSlides: parsePositiveInt(
      env.WORKSPACE_MCP_MAX_PRESENTATION_SLIDES,
      50,
    ),
    denyDirs,
    denyExtensions: mergeSet(DEFAULT_DENY_EXTENSIONS, env.WORKSPACE_MCP_EXTRA_DENY_EXTENSIONS),
  };
}

function parseAssetScopes(
  value: string | undefined,
  roots: Map<string, WorkspaceRootConfig>,
): Map<string, AssetScopeConfig> {
  const result = new Map<string, AssetScopeConfig>();
  if (!value?.trim()) {
    return result;
  }

  for (const rawEntry of value.split(";")) {
    const entry = rawEntry.trim();
    if (!entry) {
      continue;
    }
    const separatorIndex = entry.indexOf("=");
    const rootSeparatorIndex = entry.indexOf(":", separatorIndex + 1);
    if (
      separatorIndex <= 0 ||
      rootSeparatorIndex <= separatorIndex + 1 ||
      rootSeparatorIndex === entry.length - 1
    ) {
      throw new Error(`Invalid WORKSPACE_MCP_ASSET_SCOPES entry: ${entry}`);
    }

    const id = entry.slice(0, separatorIndex).trim();
    const rootId = entry.slice(separatorIndex + 1, rootSeparatorIndex).trim();
    const relativePath = entry.slice(rootSeparatorIndex + 1).trim();
    if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(id)) {
      throw new Error(`Invalid asset scope id: ${id}`);
    }
    if (result.has(id)) {
      throw new Error(`Asset scope id is configured more than once: ${id}`);
    }
    if (!roots.has(rootId)) {
      throw new Error(`Asset scope ${id} references unknown root: ${rootId}`);
    }
    if (
      relativePath.includes("\0") ||
      path.isAbsolute(relativePath) ||
      /^[a-z]:/i.test(relativePath) ||
      relativePath.split(/[\\/]+/).includes("..")
    ) {
      throw new Error(`Asset scope ${id} must use a contained relative path.`);
    }

    result.set(id, {
      id,
      rootId,
      path: path.normalize(relativePath || "."),
    });
  }

  return result;
}

function parseRootSpecs(
  rootsValue: string | undefined,
  legacyRootValue: string | undefined,
): Array<{ id: string; path: string }> {
  const rawRoots = rootsValue?.trim();
  if (!rawRoots) {
    return [
      {
        id: "projects",
        path: legacyRootValue?.trim() || "C:\\project",
      },
    ];
  }

  const roots: Array<{ id: string; path: string }> = [];
  const seenIds = new Set<string>();
  for (const rawEntry of rawRoots.split(";")) {
    const entry = rawEntry.trim();
    if (!entry) {
      continue;
    }
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex <= 0 || separatorIndex === entry.length - 1) {
      throw new Error(`Invalid WORKSPACE_MCP_ROOTS entry: ${entry}`);
    }
    const id = entry.slice(0, separatorIndex).trim();
    const rootPath = entry.slice(separatorIndex + 1).trim();
    if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(id)) {
      throw new Error(`Invalid workspace root id: ${id}`);
    }
    if (seenIds.has(id)) {
      throw new Error(`Workspace root id is configured more than once: ${id}`);
    }
    seenIds.add(id);
    roots.push({ id, path: rootPath });
  }
  if (roots.length === 0) {
    throw new Error("WORKSPACE_MCP_ROOTS did not contain any usable roots.");
  }
  return roots;
}

function parseRootDenyDirs(value: string | undefined): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  if (!value?.trim()) {
    return result;
  }

  for (const rawEntry of value.split(";")) {
    const entry = rawEntry.trim();
    if (!entry) {
      continue;
    }
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex <= 0 || separatorIndex === entry.length - 1) {
      throw new Error(`Invalid WORKSPACE_MCP_ROOT_DENY_DIRS entry: ${entry}`);
    }
    const rootId = entry.slice(0, separatorIndex).trim();
    const directories = entry
      .slice(separatorIndex + 1)
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    if (directories.length === 0) {
      throw new Error(`No denied directories configured for root: ${rootId}`);
    }
    const current = result.get(rootId) ?? new Set<string>();
    for (const directory of directories) {
      current.add(directory);
    }
    result.set(rootId, current);
  }
  return result;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function mergeSet(defaults: readonly string[], extra: string | undefined): Set<string> {
  const values = defaults.map((item) => item.toLowerCase());
  if (extra) {
    for (const item of extra.split(";")) {
      const normalized = item.trim().toLowerCase();
      if (normalized) {
        values.push(normalized);
      }
    }
  }
  return new Set(values);
}
