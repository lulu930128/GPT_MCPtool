import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ServerConfig } from "./config.js";
import { ARCHIVE_LIMITS, inspectArchive, readArchiveEntry } from "./archives.js";
import { archiveOperation, archiveTempStore, fetchArchive, packageFolderResource, readArchiveResource } from "./archive-transfer.js";

export function registerArchiveTools(server: McpServer, config: ServerConfig): void {
  const scope = z.string().min(1).max(32).describe(`Existing asset scope id: ${[...config.assetScopes.keys()].join(", ") || "(none configured)"}. Sending ZIPs also requires existing fileReturnScopeIds.`);
  const filePath = z.string().min(1).max(512).describe("Relative path within the selected asset scope; never an absolute path.");
  const base = { scope, path: filePath };
  const sha = z.string().regex(/^[a-f0-9]{64}$/);
  const linkOutput = z.object({
    ok: z.literal(true), scope: z.string(), path: z.string(), filename: z.string(),
    bytes: z.number().int().nonnegative(), mimeType: z.literal("application/zip"), sha256: sha,
    transfer: z.literal("resource_link"), resourceUri: z.string(), temporary: z.boolean(), singleUse: z.boolean(),
  });
  const listedEntry = z.object({ name: z.string(), kind: z.enum(["file", "directory"]),
    bytes: z.number().int().nonnegative(), compressedBytes: z.number().int().nonnegative(), crc32: z.string(),
    allowed: z.boolean(), reason: z.string().nullable(), integrity: z.enum(["crc32_verified", "not_read_denied"]) });
  const inspection = z.object({ ok: z.literal(true), scope: z.string(), path: z.string(), filename: z.string(),
    bytes: z.number().int().nonnegative(), sha256: sha, entryCount: z.number().int().nonnegative(),
    expandedBytes: z.number().int().nonnegative(), deniedEntries: z.number().int().nonnegative(),
    integrity: z.string(), limits: z.object({}).passthrough() });
  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

  for (const [name, template, read] of [
    ["workspace-zip-file", "workspace-zip:///{scope}/{+path}", (uri: string) => readArchiveResource(config, uri)],
    ["workspace-zip-temporary", "workspace-zip-temp:///{filename}", (uri: string) => archiveTempStore().consume(config, uri)],
  ] as const) {
    server.registerResource(name, new ResourceTemplate(template, { list: undefined }), {
      title: name === "workspace-zip-file" ? "Existing ZIP" : "Temporary folder ZIP",
      mimeType: "application/zip",
      description: "SHA-256 bound ZIP bytes. Temporary ZIP links are single-use: removed after buffering resources/read, before SDK send; no browser-download acknowledgement exists. Unclaimed links expire.",
    }, async (uri) => {
      try {
        return await archiveOperation(async () => ({ contents: [{ uri: uri.href, mimeType: "application/zip", blob: (await read(uri.href)).toString("base64") }] }));
      } catch (error) { throw new McpError(ErrorCode.InvalidParams, error instanceof Error ? error.message : "ZIP read failed."); }
    });
  }

  server.registerTool("package_folder_zip", {
    title: "Package Folder as ZIP",
    description: "Send an existing allowed folder as a UTF-8 ZIP resource_link. Requires an existing file-return-enabled asset scope. Source is preserved. Denied files/directories and links are skipped with explicit reasons and complete=false; never claim a complete archive then. Size/count/deadline failures return no partial ZIP. Server-owned temporary file expires after ten minutes and is deleted after the first resources/read is buffered, before SDK send, or on read failure. This does not prove a browser download. Repackage after an uncertain transfer; no general delete tool.",
    annotations: { ...annotations, readOnlyHint: false, idempotentHint: false },
    inputSchema: z.object(base).strict(),
    outputSchema: linkOutput.extend({ expiresAt: z.string(), cleanup: z.string(), complete: z.boolean(),
      included: z.array(z.object({ path: z.string(), kind: z.enum(["file", "directory"]), bytes: z.number(), sha256: sha.nullable() })),
      skipped: z.array(z.object({ path: z.string(), reason: z.string(), subtree: z.boolean() })),
      includedFiles: z.number(), includedDirectories: z.number(), skippedEntries: z.number(), sourceBytes: z.number() }),
  }, async (args, extra) => safe(async () => link(await packageFolderResource(config, args, archiveTempStore(), extra.signal))));

  server.registerTool("fetch_zip", {
    title: "Fetch Existing ZIP", annotations,
    description: "Return an existing ZIP through resource_link/resources/read without modifying it. Uses the existing file-return scope and fetch cap. Validates names, limits, local/central headers and CRC32; rejects the entire return if ANY entry is denied. Each resource read rechecks current policy and archive SHA-256. General fetch_asset remains unchanged.",
    inputSchema: z.object(base).strict(),
    outputSchema: linkOutput.extend({ integrity: z.string(), entryCount: z.number(), expandedBytes: z.number() }),
  }, async (args) => safe(async () => link((await fetchArchive(config, args)).metadata)));

  server.registerTool("inspect_zip", {
    title: "Inspect ZIP", annotations,
    description: "Inspect a bounded existing .zip in an asset scope without extraction. Returns archive size/SHA-256, entry/expanded counts, denied count and integrity scope. CRC32 is verified for allowed entries; denied payloads are not read. ZIP64, encryption, special entries, traversal, ambiguous names and bombs are rejected.",
    inputSchema: z.object(base).strict(), outputSchema: inspection,
  }, async (args) => safe(async () => {
    const { entries, offset, nextOffset, ...metadata } = await inspectArchive(config, args);
    return text(metadata);
  }));

  server.registerTool("list_zip_entries", {
    title: "List ZIP Entries", annotations,
    description: "List a bounded page of ZIP metadata with explicit allowed/reason and CRC32 status; no extraction or denied payload reads. offset and nextOffset count entries, not bytes. All headers and allowed-entry CRCs are validated before returning a page.",
    inputSchema: z.object({ ...base, offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(ARCHIVE_LIMITS.listingEntries).optional() }).strict(),
    outputSchema: inspection.extend({ entries: z.array(listedEntry), offset: z.number(), nextOffset: z.number().nullable() }),
  }, async (args) => safe(async () => text(await inspectArchive(config, args))));

  server.registerTool("read_zip_entry", {
    title: "Read ZIP Entry", annotations,
    description: "Read one allowed ZIP file entry without extracting. Returns full-entry SHA-256/CRC32 and a bounded byte window. Defaults to base64 for exact binary bytes; utf8 requires valid aligned UTF-8. offset/nextOffset are byte offsets. Oversized entries fail rather than silently truncating; the returned window is explicitly marked with eof/nextOffset.",
    inputSchema: z.object({ ...base, entry: filePath, offset: z.number().int().nonnegative().optional(),
      maxBytes: z.number().int().min(1).max(Math.min(ARCHIVE_LIMITS.readBytes, Math.floor(config.maxReturnedBytes / 4) * 3)).optional(),
      encoding: z.enum(["base64", "utf8"]).optional() }).strict(),
    outputSchema: z.object({ ok: z.literal(true), scope: z.string(), path: z.string(), entry: z.string(),
      archiveSha256: sha, sha256: sha, crc32: z.string(), integrity: z.string(), bytes: z.number(), offset: z.number(),
      returnedBytes: z.number(), nextOffset: z.number().nullable(), eof: z.boolean(), encoding: z.enum(["base64", "utf8"]), data: z.string() }),
  }, async (args) => safe(async () => text(await readArchiveEntry(config, args))));
}

function text(value: Record<string, unknown>) {
  return { structuredContent: value, content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function link(metadata: { resourceUri: string; filename: string; bytes: number; [key: string]: unknown }) {
  return { structuredContent: metadata, content: [
    { type: "text" as const, text: JSON.stringify(metadata) },
    { type: "resource_link" as const, uri: metadata.resourceUri, name: metadata.filename, title: metadata.filename,
      mimeType: "application/zip", size: metadata.bytes, annotations: { audience: ["user" as const], priority: 1 } },
  ] };
}

async function safe<T>(run: () => Promise<T>) {
  try { return await archiveOperation(run); }
  catch (error) { return { ...text({ ok: false, error: error instanceof Error ? error.message : "ZIP operation failed." }), isError: true }; }
}
