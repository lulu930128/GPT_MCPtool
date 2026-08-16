import fs from "node:fs";
import fsp from "node:fs/promises";
import readline from "node:readline";
import { WorkspaceAccessError } from "./path-guard.js";

export interface TextWindowResult {
  bytes: number;
  totalLines: number;
  startLine: number;
  returnedLines: number;
  returnedBytes: number;
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

export async function readTextWindow(
  absolute: string,
  sourceBytes: number,
  args: {
    startLine: number;
    maxLines: number;
    maxSourceBytes: number;
    maxReturnedBytes: number;
  },
): Promise<TextWindowResult> {
  await assertTextSource(absolute, sourceBytes, args.maxSourceBytes);
  const startLine = Math.max(1, Math.trunc(args.startLine));
  const maxLines = Math.max(1, Math.trunc(args.maxLines));
  const lines: string[] = [];
  let totalLines = 0;
  let returnedBytes = 0;
  let outputTruncated = false;

  const input = fs.createReadStream(absolute, { encoding: "utf8" });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      totalLines += 1;
      if (totalLines < startLine || lines.length >= maxLines || outputTruncated) {
        continue;
      }
      const separatorBytes = lines.length === 0 ? 0 : 1;
      const remaining = args.maxReturnedBytes - returnedBytes - separatorBytes;
      if (remaining <= 0) {
        outputTruncated = true;
        continue;
      }
      const bounded = truncateUtf8(line, remaining);
      lines.push(bounded.text);
      returnedBytes += separatorBytes + bounded.bytes;
      outputTruncated ||= bounded.truncated;
    }
  } finally {
    reader.close();
    input.destroy();
  }

  const lastReturnedLine = startLine + lines.length - 1;
  const moreLinesExist = lines.length > 0 && totalLines > lastReturnedLine;
  return {
    bytes: sourceBytes,
    totalLines,
    startLine,
    returnedLines: lines.length,
    returnedBytes,
    truncated: outputTruncated || moreLinesExist,
    eof: lines.length === 0 ? startLine > totalLines : lastReturnedLine >= totalLines,
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
