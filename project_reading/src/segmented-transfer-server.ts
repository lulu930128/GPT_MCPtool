import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ServerConfig } from "./config.js";
import { segmentedTransfers, type SegmentedTransferStore } from "./segmented-transfer.js";
import { TRANSFER_LIMITS } from "./transfer-streams.js";

export function registerSegmentedTransferTools(server: McpServer, config: ServerConfig, supplied?: SegmentedTransferStore) {
  const store = () => supplied ?? segmentedTransfers();
  const taskId = z.string().regex(/^\d{13}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  const hash = z.string().regex(/^[a-f0-9]{64}$/);
  const count = z.number().int().nonnegative();
  const output = z.object({ workspace: z.literal(true).optional(), ok: z.literal(true), version: z.literal(1), taskId,
    scope: z.string(), path: z.string(), kind: z.enum(["folder", "file", "zip"]), filename: z.string(), binding: hash,
    state: z.enum(["running", "ready", "failed", "canceled", "completed", "expired"]),
    createdAt: count, expiresAt: count, chunkBytes: count, sourceBytes: count, archiveBytes: count, transmittedBytes: count,
    expandedBytes: count.nullable(), chunkCount: count, entryCount: count, skippedEntries: count, archiveSha256: hash.nullable(),
    complete: z.boolean(), cleaned: z.boolean(), error: z.string().nullable(), integrity: z.string(),
    payloadLimitBytes: count, inputLimitBytes: count, remainingPayloadBytes: count, cleanupPending: z.boolean(),
    deliveryEvidence: z.object({ prepared:z.boolean(), delivered:z.enum(["CALLER_ATTESTED","UNKNOWN"]),
      reconstructedVerified:z.enum(["CALLER_SHA256_MATCH","UNVERIFIED"]) }).optional(),
    downloadAcknowledged: z.literal(false), retryable: z.boolean(),
  });
  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  server.registerTool("start_segmented_transfer", {
    title: "Start Segmented Transfer",
    description: "Start a bounded background folder ZIP64, original file, or validated existing ZIP capture. Uses current asset/file-return scopes and deny policy. Source is unchanged. Poll status; ready alone does not mean complete when skippedEntries>0. Each job has a HARD 100,000,000,000-byte aggregate decoded payload budget INCLUDING repeated/prefetched reads; input and archive output each independently <=100 GB. No claim of ChatGPT attachment capacity. Links are reusable until expiry or explicit cleanup. No partial downloads before ready.",
    annotations: { ...annotations, readOnlyHint: false, idempotentHint: false },
    inputSchema: z.object({ scope: z.string().min(1).max(32), path: z.string().min(1).max(512), kind: z.enum(["folder", "file", "zip"]),
      chunkBytes: z.number().int().min(TRANSFER_LIMITS.minChunkBytes).max(Math.min(config.maxFetchFileBytes, 12 * 1024 * 1024)).optional() }).strict(),
    outputSchema: output,
  }, async (args) => safe(async () => text(await store().start(config, args))));
  server.registerTool("get_segmented_transfer", {
    title: "Get Segmented Transfer Status", annotations,
    description: "Poll bounded capture progress/status by taskId; no payload or huge arrays. ready is a verified captured snapshot, not a browser ACK. Running capture interrupted by restart fails and is cleaned; ready jobs and charged read budgets persist. Status remains available until cleanup sweep removes the tombstone.",
    inputSchema: z.object({ taskId }).strict(), outputSchema: output,
  }, async (args) => safe(async () => text(await store().status(config, args.taskId))));
  server.registerTool("list_segmented_transfer", {
    title: "List Segmented Transfer Manifest", annotations,
    description: "Read a manifest page after ready. parts provides resource links, zero-based index, offset, length and SHA-256. For legacy 8–12 MiB parts, keep the same taskId, read records[].ranges by offset and verify the original part hash. entries lists included files and skipped paths/subtrees. Save every parts page for reconstruction. Listing is free of payload charges. Resource prefetch consumes payload budget. Default 20, maximum 100 records. nextOffset=null ends the collection.",
    inputSchema: z.object({ taskId, collection: z.enum(["parts", "entries"]).default("parts"), offset: count.optional(), limit: z.number().int().min(1).max(TRANSFER_LIMITS.page).optional() }).strict(),
    outputSchema: output.extend({ collection: z.enum(["parts", "entries"]), offset: count, total: count,
      records: z.array(z.union([
        z.object({ index: count, offset: count, length: count, sha256: hash, filename: z.string(), resourceUri: z.string(), ranges: z.array(z.object({offset:count,length:count,resourceUri:z.string()})).optional(), mimeType: z.literal("application/octet-stream") }),
        z.object({ path: z.string(), disposition: z.literal("included"), kind: z.enum(["file", "directory"]), bytes: count, sha256: hash.nullable() }),
        z.object({ path: z.string(), disposition: z.literal("skipped"), reason: z.string(), subtree: z.boolean() }),
      ])).max(TRANSFER_LIMITS.page), nextOffset: count.nullable() }),
  }, async (args) => safe(async () => {
    const result = await store().page(config, args.taskId, args.collection, args.offset, args.limit);
    return { structuredContent: result, content: [
      { type: "text" as const, text: JSON.stringify(result) },
      ...result.records.filter((record) => typeof record.resourceUri === "string").flatMap((record) =>
        Array.isArray(record.ranges) ? record.ranges.map(range => ({...record,...range})) : [record]).map((record) => ({
        type: "resource_link" as const, uri: record.resourceUri as string, name: record.filename as string,
        mimeType: "application/octet-stream", size: record.length as number,
        annotations: { audience: ["user" as const], priority: 1 },
      })),
    ] };
  }));
  server.registerTool("finish_segmented_transfer", {
    title: "Finish or Cancel Segmented Transfer",
    description: "Cancel/cleanup only this job's server-owned staging, or complete after offline reconstruction using archiveSha256. Returns cleanupPending; poll status until cleaned or unknown after tombstone removal. Completion is caller attestation, not a host delivery ACK. Never deletes or modifies source. No automatic completion from resource prefetch/read.",
    annotations: { ...annotations, readOnlyHint: false, idempotentHint: false },
    inputSchema: z.object({ taskId, action: z.enum(["cancel", "complete", "cleanup"]), archiveSha256: hash.optional() }).strict(), outputSchema: output,
  }, async (args) => safe(async () => text(await store().finish(config, args.taskId, args.action, args.archiveSha256))));
  server.registerResource("workspace-transfer-range", new ResourceTemplate("workspace-transfer-range:///{taskId}/{index}/{offset}/{length}", {list:undefined}), {
    mimeType:"application/octet-stream", description:"Original part range. Reassemble in offset order and verify the part SHA-256.",
  }, async uri => {
    const match = /^workspace-transfer-range:\/\/\/(\d{13}-[a-f0-9-]{36})\/(\d+)\/(\d+)\/(\d+)\?sha256=([a-f0-9]{64})$/.exec(uri.href);
    if (!match) throw new McpError(ErrorCode.InvalidParams,"Invalid part range URI.");
    const [,id,index,offset,length,sha256] = match;
    const original = `workspace-transfer:///${id}/${index}?sha256=${sha256}`;
    const bytes = await store().read(config,original,{offset:Number(offset),length:Number(length)});
    return { contents:[{uri:uri.href,mimeType:"application/octet-stream",blob:bytes.toString("base64")}] };
  });
  server.registerResource("workspace-transfer-part", new ResourceTemplate("workspace-transfer:///{taskId}/{index}", { list: undefined }), {
    title: "Segmented Transfer Part", mimeType: "application/octet-stream",
    description: "Reusable SHA-256-bound binary part. Every read reserves persistent job payload budget before SDK send. Does not delete on read; retained until explicit completion/cancel/expiry. Host MIME/name/download rendering requires separate E2E.",
  }, async (uri) => {
    try { return { contents: [{ uri: uri.href, mimeType: "application/octet-stream", blob: (await store().read(config, uri.href)).toString("base64") }] }; }
    catch (error) { throw new McpError(ErrorCode.InvalidParams, error instanceof Error ? error.message : "Transfer read failed."); }
  });
}
function text(value: Record<string, unknown>) { return { structuredContent: value, content: [{ type: "text" as const, text: JSON.stringify(value) }] }; }
async function safe<T>(operation: () => Promise<T>) {
  try { return await operation(); }
  catch (error) { return { ...text({ ok: false, error: error instanceof Error ? error.message : "Transfer operation failed." }), isError: true }; }
}
