import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { fail, TRANSFER_LIMITS } from "./transfer-streams.js";

const SLOT = 48;
function encode(id: string, sequence: number, total: number) {
  const bytes = Buffer.alloc(SLOT);
  bytes.writeBigUInt64LE(BigInt(sequence), 0); bytes.writeBigUInt64LE(BigInt(total), 8);
  createHash("sha256").update(id).update(bytes.subarray(0, 16)).digest().copy(bytes, 16);
  return bytes;
}
async function writeAt(handle: FileHandle, bytes: Buffer, position: number) {
  for (let at = 0; at < bytes.length;) {
    const result = await handle.write(bytes, at, bytes.length - at, position + at);
    if (!result.bytesWritten) fail("Transfer budget short write."); at += result.bytesWritten;
  }
}
export async function initializeBudget(handle: FileHandle, id: string) {
  const slot = encode(id, 0, 0);
  await writeAt(handle, Buffer.concat([slot, slot]), 0); await handle.sync();
}
export async function readBudget(handle: FileHandle, id: string) {
  if ((await handle.stat()).size !== SLOT * 2) fail("Transfer budget ledger size invalid; downloads refused.");
  const buffer = Buffer.alloc(SLOT * 2);
  let at = 0;
  while (at < buffer.length) {
    const result = await handle.read(buffer, at, buffer.length - at, at);
    if (!result.bytesRead) fail("Transfer budget ledger truncated."); at += result.bytesRead;
  }
  const valid: Array<{ sequence: number; total: number }> = [];
  for (const offset of [0, SLOT]) {
    const slot = buffer.subarray(offset, offset + SLOT);
    const sequence = Number(slot.readBigUInt64LE(0)), total = Number(slot.readBigUInt64LE(8));
    if (Number.isSafeInteger(sequence) && sequence >= 0 && Number.isSafeInteger(total) && total >= 0 && total <= TRANSFER_LIMITS.bytes && encode(id, sequence, total).equals(slot)) valid.push({ sequence, total });
  }
  if (!valid.length) fail("Transfer budget ledger corrupt; downloads refused.");
  valid.sort((a, b) => b.sequence - a.sequence);
  if (valid.length === 2 && valid[0].total < valid[1].total) fail("Transfer budget ledger regressed.");
  return valid[0];
}
/** Fixed two-slot ledger: no growing per-read journal and no rename durability window.
 * A torn write leaves the last synced slot; only a fully synced reservation permits SDK handoff. */
export async function reserveBudget(handle: FileHandle, id: string, total: number) {
  const previous = await readBudget(handle, id);
  if (!Number.isSafeInteger(total) || total < previous.total || total > TRANSFER_LIMITS.bytes) fail("Transfer budget reservation invalid.");
  if (total === previous.total) return;
  const sequence = previous.sequence + 1;
  if (!Number.isSafeInteger(sequence)) fail("Transfer budget sequence exhausted.");
  await writeAt(handle, encode(id, sequence, total), (sequence % 2) * SLOT); await handle.sync();
}
