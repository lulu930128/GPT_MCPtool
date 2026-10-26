import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { WorkspaceWriteError } from "./write-errors.js";

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function decodeUtf8(bytes: Buffer): string {
  try {
    if (bytes.includes(0)) throw new Error("NUL");
    // Keep the BOM in text so a patch preserves it. JSON parsing strips it explicitly.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new WorkspaceWriteError("UNSUPPORTED_FILE_TYPE", "Only valid UTF-8 text without NUL bytes is writable.");
  }
}

export async function readUtf8Snapshot(absolute: string, maxBytes: number) {
  const handle = await fs.open(absolute, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new WorkspaceWriteError("UNSUPPORTED_FILE_TYPE");
    if (before.size > maxBytes) throw new WorkspaceWriteError("PAYLOAD_TOO_LARGE");
    const data = Buffer.alloc(Math.min(before.size + 1, maxBytes + 1));
    let length = 0;
    while (length < data.length) {
      const result = await handle.read(data, length, data.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || length !== before.size) {
      throw new WorkspaceWriteError("FILE_CHANGED_DURING_READ");
    }
    const bytes = data.subarray(0, length);
    return { bytes, text: decodeUtf8(bytes), sha256: sha256(bytes), stat: after };
  } finally {
    await handle.close();
  }
}
