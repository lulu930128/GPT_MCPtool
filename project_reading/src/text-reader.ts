import { createHash } from "node:crypto";
import type { ServerConfig } from "./config.js";
import type { ReadFileArgs } from "./workspace.js";
import { identity, sameIdentity, TRANSFER_LIMITS, tunnelPartBytes } from "./transfer-streams.js";
import { segmentedTransfers } from "./segmented-transfer.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import readline from "node:readline";
import { readUtf8Snapshot } from "./text-snapshot.js";
import { resolveResearchPath, WorkspaceAccessError } from "./path-guard.js";

export interface TextWindowResult {
  sha256?: string;
  bytes: number;
  totalLines: number;
  startLine: number;
  returnedLines: number;
  returnedBytes: number;
  completedLines: number;
  nextStartLine: number | null;
  partialLine: boolean;
  truncationReasons: string[];
  continuationRequiresMoreBytes: boolean;
  requiredBytesForNextLine?: number;
  truncated: boolean;
  eof: boolean;
  text: string;
}

export interface RequestedLineWindow {
  id: number;
  startLine: number;
  endLine: number;
}

export interface CollectedLineWindow {
  id: number;
  startLine: number;
  endLine: number;
  text: string;
}

export async function assertTextSource(
  absolute: string,
  sourceBytes: number,
  maxSourceBytes: number,
): Promise<void> {
  if (sourceBytes > maxSourceBytes) {
    throw new WorkspaceAccessError(
      `File is too large (${sourceBytes} bytes > ${maxSourceBytes} bytes).`,
    );
  }
  const handle = await fsp.open(absolute, "r");
  try {
    const sample = Buffer.alloc(Math.min(sourceBytes, 16_384));
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    if (sample.subarray(0, bytesRead).includes(0)) {
      throw new WorkspaceAccessError("File appears to be binary.");
    }
  } finally {
    await handle.close();
  }
}

function* snapshotLines(text: string): Generator<string> {
  // Match readline's CR/LF framing without a stream lifecycle. A single snapshot
  // chunk can close readline while its async iterator still has buffered lines.
  const endings = /\r\n|[\r\n]/g;
  let start = 0;
  for (let match = endings.exec(text); match; match = endings.exec(text)) {
    yield text.slice(start, match.index);
    start = endings.lastIndex;
  }
  if (start < text.length) yield text.slice(start);
}

export async function readTextWindow(
  absolute: string,
  sourceBytes: number,
  args: {
    startLine: number;
    maxLines: number;
    maxSourceBytes: number;
    maxReturnedBytes: number;
    includeSha256?: boolean;
  },
): Promise<TextWindowResult> {
  const snapshot = args.includeSha256 ? await readUtf8Snapshot(absolute, args.maxSourceBytes) : undefined;
  if (!snapshot) await assertTextSource(absolute, sourceBytes, args.maxSourceBytes);
  const startLine = Math.max(1, Math.trunc(args.startLine));
  const maxLines = Math.max(0, Math.trunc(args.maxLines));
  const lines: string[] = [];
  let totalLines = 0;
  let returnedBytes = 0;
  let outputTruncated = false;
  let partialLine = false;
  let requiredBytesForNextLine: number | undefined;

  const input = snapshot ? undefined : fs.createReadStream(absolute, { encoding: "utf8" });
  const reader = input ? readline.createInterface({ input, crlfDelay: Infinity }) : undefined;
  const sourceLines = snapshot ? snapshotLines(snapshot.text) : reader!;
  try {
    for await (const line of sourceLines) {
      totalLines += 1;
      if (totalLines < startLine || lines.length >= maxLines || outputTruncated) {
        continue;
      }
      const separatorBytes = lines.length === 0 ? 0 : 1;
      const remaining = args.maxReturnedBytes - returnedBytes - separatorBytes;
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (remaining < lineBytes) {
        outputTruncated = true;
        requiredBytesForNextLine = lineBytes;
        // Only the first line may be partial. Completed lines can always be
        // continued at the next whole line without repeating a completed row.
        if (lines.length === 0 && remaining > 0) {
          const bounded = truncateUtf8(line, remaining);
          lines.push(bounded.text);
          returnedBytes = bounded.bytes;
          partialLine = true;
        }
        continue;
      }
      lines.push(line);
      returnedBytes += separatorBytes + lineBytes;
    }
  } finally {
    reader?.close();
    input?.destroy();
  }

  const completedLines = lines.length - (partialLine ? 1 : 0);
  const nextLine = startLine + completedLines;
  const eof = nextLine > totalLines;
  const truncationReasons: string[] = [];
  if (!eof && !outputTruncated && lines.length >= maxLines) truncationReasons.push("max_lines");
  if (outputTruncated) truncationReasons.push("max_returned_bytes");
  if (partialLine) truncationReasons.push("partial_line");
  return {
    bytes: snapshot?.bytes.length ?? sourceBytes,
    ...(snapshot ? { sha256: snapshot.sha256 } : {}),
    totalLines,
    startLine,
    returnedLines: lines.length,
    returnedBytes,
    completedLines,
    nextStartLine: eof ? null : nextLine,
    partialLine,
    truncationReasons,
    continuationRequiresMoreBytes: outputTruncated && completedLines === 0,
    ...(requiredBytesForNextLine === undefined ? {} : { requiredBytesForNextLine }),
    truncated: !eof,
    eof,
    text: lines.join("\n"),
  };
}

export async function collectLineWindows(
  absolute: string,
  sourceBytes: number,
  windows: readonly RequestedLineWindow[],
  maxSourceBytes: number,
): Promise<CollectedLineWindow[]> {
  await assertTextSource(absolute, sourceBytes, maxSourceBytes);
  const normalized = windows.map((window) => ({
    id: window.id,
    startLine: Math.max(1, Math.trunc(window.startLine)),
    endLine: Math.max(Math.max(1, Math.trunc(window.startLine)), Math.trunc(window.endLine)),
    lines: [] as string[],
  }));
  if (normalized.length === 0) {
    return [];
  }
  const maximumLine = Math.max(...normalized.map((window) => window.endLine));
  const input = fs.createReadStream(absolute, { encoding: "utf8" });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of reader) {
      lineNumber += 1;
      for (const window of normalized) {
        if (lineNumber >= window.startLine && lineNumber <= window.endLine) {
          window.lines.push(line);
        }
      }
      if (lineNumber >= maximumLine) {
        break;
      }
    }
  } finally {
    reader.close();
    input.destroy();
  }
  return normalized.map((window) => ({
    id: window.id,
    startLine: window.startLine,
    endLine: window.startLine + Math.max(window.lines.length - 1, 0),
    text: window.lines.join("\n"),
  }));
}

export function truncateUtf8(value: string, maxBytes: number): {
  text: string;
  bytes: number;
  truncated: boolean;
} {
  const actualBytes = Buffer.byteLength(value, "utf8");
  if (actualBytes <= maxBytes) {
    return { text: value, bytes: actualBytes, truncated: false };
  }
  if (maxBytes <= 0) {
    return { text: "", bytes: 0, truncated: value.length > 0 };
  }
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  if (low > 0) {
    const finalCodeUnit = value.charCodeAt(low - 1);
    if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
      low -= 1;
    }
  }
  const text = value.slice(0, low);
  return { text, bytes: Buffer.byteLength(text, "utf8"), truncated: true };
}

// Reserve room for MCP metadata. A JSON control character can expand to six bytes.
export const messageBytes = 10 * 1024 * 1024;
export const inlineTextBytes = Math.floor((messageBytes - 65536) / 6);
const decoder = () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export async function readWorkspaceWindow(config: ServerConfig, args: ReadFileArgs, maxLines: number, budget: number) {
  const begin = performance.now();
  const resolved = await resolveResearchPath(config, args.path, "file", args.root);
  const original = identity(resolved.stat);
  const snapshotId = createHash("sha256").update(JSON.stringify([resolved.rootId, resolved.relative, original])).digest("hex");
  if (args.snapshotId && args.snapshotId !== snapshotId) throw new WorkspaceAccessError("SOURCE_CHANGED");
  if (original.size > config.maxFileBytes) throw new WorkspaceAccessError("File is too large.");
  const handle = await fsp.open(resolved.absolute, "r");
  let diskIO = 0, scanned = 0;
  async function read(position: number, length: number) {
    const at = performance.now();
    const data = Buffer.allocUnsafe(Math.min(length, original.size - position));
    let n = 0;
    while (n < data.length) {
      const { bytesRead } = await handle.read(data, n, data.length - n, position + n);
      if (!bytesRead) throw new WorkspaceAccessError("SOURCE_CHANGED");
      n += bytesRead;
    }
    diskIO += performance.now() - at;
    scanned += n;
    return data;
  }
  try {
    if (!sameIdentity(identity(await handle.stat()), original)) throw new WorkspaceAccessError("SOURCE_CHANGED");
    const startLine = args.startLine ?? 1;
    let offset = args.offset ?? 0;
    if (offset > original.size) throw new WorkspaceAccessError("Offset exceeds source size.");
    const probe = await read(offset, Math.min(Math.max(budget + 4, TRANSFER_LIMITS.ioBytes), inlineTextBytes + 4));
    let binary = args.format === "binary";
    if (!binary) {
      try {
        decoder().decode(probe, { stream: offset + probe.length < original.size });
        if (probe.includes(0)) throw new Error("NUL");
      } catch {
        if (args.format === "text" || (args.includeSha256 && !args.format)) throw new WorkspaceAccessError("Invalid UTF-8 text.");
        binary = true;
      }
    }
    // With a snapshot-bound offset the caller resumes directly at the first unread byte.
    let line = 1;
    if (!binary && args.offset === undefined && startLine > 1) {
      let skipLF = false;
      while (offset < original.size && line < startLine) {
        const bytes = await read(offset, TRANSFER_LIMITS.ioBytes);
        for (const byte of bytes) {
          offset++;
          if (skipLF && byte === 10) { skipLF = false; continue; }
          skipLF = byte === 13;
          if (skipLF || byte === 10) line++;
          if (line === startLine) break;
        }
      }
      if (skipLF && offset < original.size && (await read(offset, 1))[0] === 10) offset++;
    }
    const bytes = offset === (args.offset ?? 0) ? probe : await read(offset, budget + 4);
    const fileId = createHash("sha256").update(JSON.stringify([resolved.rootId,resolved.relative,original.dev,original.ino])).digest("hex");
    const base = { root: resolved.rootId, path: resolved.relative, bytes: original.size, size: original.size,
      fileId, snapshotId, sourceIdentity: original, startLine, offset };
    let returnedLines = 0, completedLines = 0, consumed = 0, text = "", returnedBytes = 0, partialLine = false;
    let requiredBytesForNextLine: number | undefined;
    const lines: string[] = [];
    if (binary) {
      consumed = Math.min(bytes.length, budget, args.length ?? original.size);
      returnedBytes = consumed;
    } else {
      while (consumed < bytes.length && returnedLines < maxLines) {
        let end = consumed;
        while (end < bytes.length && bytes[end] !== 10 && bytes[end] !== 13) end++;
        const remaining = budget - returnedBytes - Number(returnedLines > 0);
        if (end - consumed > remaining || (end === bytes.length && offset + end < original.size)) {
          if (end < bytes.length || offset + end === original.size) requiredBytesForNextLine = end - consumed;
          if (!returnedLines && remaining > 0) {
            const prefix = decoder().decode(bytes.subarray(consumed, Math.min(end, consumed + remaining)), { stream: true });
            lines.push(prefix); returnedBytes = Buffer.byteLength(prefix); returnedLines++; partialLine = true;
          }
          break;
        }
        lines.push(decoder().decode(bytes.subarray(consumed, end)));
        returnedBytes += end - consumed + Number(returnedLines > 0);
        returnedLines++; completedLines++;
        consumed = end + (end < bytes.length ? (bytes[end] === 13 && bytes[end + 1] === 10 ? 2 : 1) : 0);
      }
      // An inline byte window can end on the CR half of a CRLF pair.
      if (consumed > 0 && consumed === bytes.length && bytes[consumed-1] === 13 && offset+consumed < original.size &&
          (await read(offset+consumed,1))[0] === 10) consumed++;
      text = lines.join("\n");
    }
    const eof = offset + consumed === original.size;
    const byteLimited = (!binary && !eof && returnedLines < maxLines) || partialLine;
    const reasons = eof || binary ? [] : byteLimited ? ["max_returned_bytes"] : ["max_lines"];
    if (partialLine) reasons.push("partial_line");
    let sha256: string | null = null;
    const needsResource = args.delivery === "resource" || (args.delivery !== "inline" &&
      (byteLimited || (binary && !eof && args.length === undefined)));
    let transfer;
    if (needsResource) {
      transfer = await segmentedTransfers().start(config, { scope: resolved.rootId, path: resolved.relative, kind: "file",
        chunkBytes: Math.min(config.maxFetchFileBytes, tunnelPartBytes) }, original);
    }
    if ((args.includeSha256 && (!needsResource || original.size <= probe.length)) || (binary && eof && offset === 0)) {
      const hash = createHash("sha256");
      for (let pos = 0; pos < original.size;) {
        const chunk = pos === 0 && probe.length && (args.offset ?? 0) === 0 ? probe : await read(pos, TRANSFER_LIMITS.ioBytes);
        hash.update(chunk); pos += chunk.length;
      }
      sha256 = hash.digest("hex");
    }
    const after = await resolveResearchPath(config, args.path, "file", args.root);
    if (!sameIdentity(original, identity(after.stat)) || !sameIdentity(original, identity(await handle.stat()))) throw new WorkspaceAccessError("SOURCE_CHANGED");
    const entire = !binary && (args.offset ?? 0) === 0 && probe.length === original.size;
    let exactLines = 0;
    if (entire) {
      for (let i=0; i<probe.length; i++) if (probe[i] === 13 || (probe[i] === 10 && probe[i-1] !== 13)) exactLines++;
      if (probe.length && ![10,13].includes(probe[probe.length-1])) exactLines++;
    }
    const totalLines = entire ? exactLines :
      !binary && eof && args.offset === undefined && line >= startLine ? startLine - 1 + completedLines : null;
    return { ...base, ...(sha256 || args.delivery || args.format || transfer ? { sha256 } : {}), totalLines, returnedLines, completedLines, returnedBytes, partialLine,
      requiredBytesForNextLine, continuationRequiresMoreBytes: partialLine, truncated: !eof, truncationReasons: reasons,
      eof, nextStartLine: binary || eof ? null : startLine + completedLines, nextOffset: eof ? null : offset + consumed,
      encoding: binary ? "base64" : "utf-8", ...(binary ? { base64: bytes.subarray(0,consumed).toString("base64"), length: consumed,
        rangeSha256: createHash("sha256").update(bytes.subarray(0,consumed)).digest("hex") } : { text }),
      ...(transfer ? { transfer, continuation: { tool: "get_segmented_transfer", arguments: { taskId: transfer.taskId } } } : {}),
      metrics: { diskIOMs: diskIO, scannedBytes: scanned, serverExecMs: performance.now() - begin, hostMs: "UNKNOWN", tunnelMs: "UNKNOWN", queueMs: "UNKNOWN" } };
  } finally { await handle.close(); }
}
