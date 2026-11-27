import type { FileHandle } from "node:fs/promises";

// Fixed byte offsets include CR/LF. Decode only complete records, even when
// UTF-8 characters cross a chunk boundary. The reader never owns the handle.
export async function* jsonLines(file: FileHandle, start = 0, end?: number) {
  end ??= (await file.stat()).size;
  let position = start, lineStart = start;
  let parts: Buffer[] = [];
  while (position < end) {
    const buffer = Buffer.allocUnsafe(Math.min(65536, end - position));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    if (!bytesRead) throw new Error("JSONL_CHANGED_DURING_READ");
    const chunk = buffer.subarray(0, bytesRead);
    let offset = 0;
    while (offset < bytesRead) {
      const newline = chunk.indexOf(10, offset);
      if (newline < 0) { parts.push(chunk.subarray(offset)); break; }
      const segment = chunk.subarray(offset, newline);
      const line = parts.length ? Buffer.concat([...parts, segment]) : segment;
      yield { text: line.toString("utf8"), start: lineStart, end: position + newline + 1, terminated: true };
      parts = [];
      offset = newline + 1;
      lineStart = position + offset;
    }
    position += bytesRead;
  }
  if (parts.length) yield { text: Buffer.concat(parts).toString("utf8"), start: lineStart, end, terminated: false };
}

