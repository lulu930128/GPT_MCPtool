import { createHash } from "node:crypto";
import { z } from "zod";
import { ApprovalError } from "./contract.js";

// The DIRECT request authorizes output return. Output stays in the existing
// temporary Store cache, never receipts.jsonl, events or logs.
const bytes = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);
export const normalOutputSchema = z.object({ stdoutBase64: bytes, stderrBase64: bytes }).strict();
export const normalOutputChunkSchema = bytes.max(16384);
export type NormalOutput = z.infer<typeof normalOutputSchema>;
export function validateNormalOutput(output: NormalOutput, expectedHash: string) {
  const a = Buffer.from(output.stdoutBase64, "base64"), b = Buffer.from(output.stderrBase64, "base64");
  if (a.toString("base64") !== output.stdoutBase64 || b.toString("base64") !== output.stderrBase64)
    throw new ApprovalError("NORMAL_OUTPUT_REJECTED");
  const sizes = [Buffer.alloc(4), Buffer.alloc(4)];
  sizes[0].writeUInt32LE(a.length); sizes[1].writeUInt32LE(b.length);
  if (createHash("sha256").update(sizes[0]).update(a).update(sizes[1]).update(b).digest("hex") !== expectedHash)
    throw new ApprovalError("NORMAL_OUTPUT_REJECTED");
  return { stdout: a.toString("utf8"), stderr: b.toString("utf8"), encoding: "UTF8_REPLACEMENT_FOR_PARTIAL_SEQUENCE" as const };
}

/** Pages complete output; offsets are UTF-16 positions across stdout then stderr.
 * Follow nextOffset without deriving offsets from rendered text. */
export function pageNormalOutput(text: ReturnType<typeof validateNormalOutput>, offset = 0) {
  const total = text.stdout.length + text.stderr.length;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > total) throw new ApprovalError("OUTPUT_OFFSET_INVALID");
  const charAt = (n: number) => n < text.stdout.length ? text.stdout.charCodeAt(n) : text.stderr.charCodeAt(n - text.stdout.length);
  if (offset > 0 && charAt(offset) >= 0xdc00 && charAt(offset) <= 0xdfff
    && charAt(offset - 1) >= 0xd800 && charAt(offset - 1) <= 0xdbff) throw new ApprovalError("OUTPUT_OFFSET_INVALID");
  let end = Math.min(total, offset + 8192);
  if (end < total && charAt(end - 1) >= 0xd800 && charAt(end - 1) <= 0xdbff
    && charAt(end) >= 0xdc00 && charAt(end) <= 0xdfff) end--;
  return { stdout: text.stdout.slice(offset, Math.min(end, text.stdout.length)),
    stderr: text.stderr.slice(Math.max(0, offset - text.stdout.length), Math.max(0, end - text.stdout.length)),
    encoding: text.encoding, offset, nextOffset: end < total ? end : null, totalChars: total };
}
