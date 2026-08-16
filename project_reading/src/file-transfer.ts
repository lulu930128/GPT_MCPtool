import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveAssetFile, type AssetArgs } from "./assets.js";
import type { ServerConfig } from "./config.js";
import { WorkspaceAccessError } from "./path-guard.js";

const MIME_TYPES = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".json", "application/json"],
  [".csv", "text/csv"],
  [".pdf", "application/pdf"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".wav", "audio/wav"],
  [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".flac", "audio/flac"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
]);

export interface FetchAssetArgs extends AssetArgs {}

export interface FetchAssetMetadata extends Record<string, unknown> {
  ok: true;
  scope: string;
  path: string;
  filename: string;
  bytes: number;
  mimeType: string;
  sha256: string;
  transfer: "resource_link";
  resourceUri: string;
}

export interface FetchAssetResult {
  metadata: FetchAssetMetadata;
  data: string;
  mimeType: string;
  resourceUri: string;
}

export interface AssetResourceReference extends FetchAssetArgs {
  sha256: string;
}

export async function fetchAsset(
  config: ServerConfig,
  args: FetchAssetArgs,
): Promise<FetchAssetResult> {
  assertFileReturnScope(config, args.scope);
  const asset = await resolveAssetFile(config, args);
  assertFetchSize(asset.bytes, config.maxFetchFileBytes);

  const bytes = await readBoundedFile(asset.absolute, config.maxFetchFileBytes);
  const mimeType = inferMimeType(asset.relative);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const resourceUri = createAssetResourceUri(asset.scopeId, asset.relative, sha256);
  const metadata: FetchAssetMetadata = {
    ok: true,
    scope: asset.scopeId,
    path: asset.relative,
    filename: path.basename(asset.relative),
    bytes: bytes.length,
    mimeType,
    sha256,
    transfer: "resource_link",
    resourceUri,
  };

  return {
    metadata,
    data: bytes.toString("base64"),
    mimeType,
    resourceUri,
  };
}

export async function readAssetResource(
  config: ServerConfig,
  uri: string | URL,
): Promise<FetchAssetResult> {
  const reference = parseAssetResourceUri(uri);
  const result = await fetchAsset(config, reference);
  if (result.metadata.sha256 !== reference.sha256) {
    throw new WorkspaceAccessError("Asset changed since the resource link was created.");
  }
  return result;
}

export function inferMimeType(filePath: string): string {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

export function createAssetResourceUri(
  scope: string,
  relativePath: string,
  sha256: string,
): string {
  const encodedPath = relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `workspace-asset:///${encodeURIComponent(scope)}/${encodedPath}?sha256=${sha256}`;
}

export function parseAssetResourceUri(uri: string | URL): AssetResourceReference {
  let parsed: URL;
  try {
    parsed = uri instanceof URL ? uri : new URL(uri);
  } catch {
    throw new WorkspaceAccessError("Invalid workspace asset resource URI.");
  }
  if (
    parsed.protocol !== "workspace-asset:" ||
    parsed.host !== "" ||
    parsed.hash !== "" ||
    !parsed.pathname.startsWith("/")
  ) {
    throw new WorkspaceAccessError("Invalid workspace asset resource URI.");
  }

  const rawSegments = parsed.pathname.slice(1).split("/");
  if (rawSegments.length < 2 || rawSegments.some((segment) => segment.length === 0)) {
    throw new WorkspaceAccessError("Invalid workspace asset resource URI path.");
  }

  let segments: string[];
  try {
    segments = rawSegments.map((segment) => decodeURIComponent(segment));
  } catch {
    throw new WorkspaceAccessError("Invalid workspace asset resource URI encoding.");
  }
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\") ||
        segment.includes("\0"),
    )
  ) {
    throw new WorkspaceAccessError("Invalid workspace asset resource URI path.");
  }

  const queryKeys = Array.from(parsed.searchParams.keys());
  const sha256Values = parsed.searchParams.getAll("sha256");
  if (
    queryKeys.length !== 1 ||
    queryKeys[0] !== "sha256" ||
    sha256Values.length !== 1 ||
    !/^[a-f0-9]{64}$/.test(sha256Values[0] ?? "")
  ) {
    throw new WorkspaceAccessError("Workspace asset resource URI requires one SHA-256 value.");
  }

  return {
    scope: segments[0],
    path: segments.slice(1).join("/"),
    sha256: sha256Values[0],
  };
}

function assertFileReturnScope(config: ServerConfig, rawScope: string): void {
  const scope = rawScope.trim();
  if (!config.assetScopes.has(scope)) {
    throw new WorkspaceAccessError(
      `Unknown asset scope: ${scope}. Allowed scopes: ${
        Array.from(config.assetScopes.keys()).join(", ") || "(none configured)"
      }`,
    );
  }
  if (!config.fileReturnScopeIds.has(scope)) {
    throw new WorkspaceAccessError(
      `Original file return is not enabled for asset scope: ${scope}.`,
    );
  }
}

async function readBoundedFile(absolute: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(absolute, "r");
  try {
    const stat = await handle.stat();
    assertFetchSize(stat.size, maxBytes);

    const output = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < output.length) {
      const { bytesRead } = await handle.read(output, offset, output.length - offset, offset);
      if (bytesRead === 0) {
        throw new WorkspaceAccessError("Asset changed while it was being returned.");
      }
      offset += bytesRead;
    }

    const tail = Buffer.allocUnsafe(1);
    const { bytesRead: tailBytesRead } = await handle.read(tail, 0, 1, output.length);
    if (tailBytesRead !== 0) {
      throw new WorkspaceAccessError("Asset changed while it was being returned.");
    }
    return output;
  } finally {
    await handle.close();
  }
}

function assertFetchSize(bytes: number, maxBytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes) {
    throw new WorkspaceAccessError(`Asset exceeds fetch limit of ${maxBytes} bytes.`);
  }
}
