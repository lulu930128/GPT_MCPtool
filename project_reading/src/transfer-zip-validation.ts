import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { archiveName, resolveArchiveSource } from "./archives.js";
import type { AssetArgs } from "./assets.js";
import { getDenialReason, resolveWorkspaceRoot } from "./path-guard.js";
import { addBytes, fail, identity, sameIdentity, TRANSFER_LIMITS, updateCrc, type CaptureContext } from "./transfer-streams.js";

async function readAt(handle: FileHandle, offset: number, length: number) {
  const bytes = Buffer.alloc(length);
  let at = 0;
  while (at < length) {
    const result = await handle.read(bytes, at, length - at, offset + at);
    if (!result.bytesRead) fail("ZIP truncated.");
    at += result.bytesRead;
  }
  return bytes;
}
function safe64(bytes: Buffer, at: number): number {
  const value = bytes.readBigUInt64LE(at);
  if (value > BigInt(TRANSFER_LIMITS.bytes)) fail("ZIP64 value exceeds input limit.");
  return Number(value);
}
class HandleReader extends yauzl.RandomAccessReader {
  constructor(private handle: FileHandle, private check: () => void) { super(); }
  _readStreamForRange(start: number, end: number) {
    const handle = this.handle, check = this.check;
    return Readable.from((async function* () {
      for (let at = start; at < end;) {
        check(); const bytes = await readAt(handle, at, Math.min(TRANSFER_LIMITS.ioBytes, end - at));
        at += bytes.length; yield bytes;
      }
    })());
  }
}

/** Validate an existing ZIP without reading it into memory or extracting it.
 * Collision metadata shares the 100,000-entry cap with segmented folder output.
 * Payload inflation and every random-access read remain streamed and byte-bounded. */
export async function validateTransferZip(ctx: CaptureContext, args: AssetArgs) {
  const source = await resolveArchiveSource(ctx.config, args, "zip");
  if (source.stat.size > TRANSFER_LIMITS.bytes || source.stat.size < 22) fail("ZIP input size invalid.");
  const handle = await fs.open(source.absolute, "r");
  let zip: ZipFile | undefined;
  try {
    if (!sameIdentity(identity(source.stat), identity(await handle.stat()))) fail("SOURCE_CHANGED: ZIP before validation.");
    const tailAt = Math.max(0, source.stat.size - 65557);
    const tail = await readAt(handle, tailAt, source.stat.size - tailAt);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
    }
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) fail("ZIP end or disk invalid.");
    let count = tail.readUInt16LE(end + 10), size = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
    let centralEnd = tailAt + end;
    if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
      const locator = await readAt(handle, centralEnd - 20, 20);
      if (locator.readUInt32LE(0) !== 0x07064b50 || locator.readUInt32LE(4) || locator.readUInt32LE(16) !== 1) fail("ZIP64 locator invalid.");
      const at = safe64(locator, 8), record = await readAt(handle, at, 56);
      if (record.readUInt32LE(0) !== 0x06064b50 || safe64(record, 4) !== 44 || at + 56 !== centralEnd - 20 ||
          record.readUInt32LE(16) || record.readUInt32LE(20) || safe64(record, 24) !== safe64(record, 32)) fail("ZIP64 end invalid.");
      count = safe64(record, 32); size = safe64(record, 40); offset = safe64(record, 48); centralEnd = at;
    } else if (tail.readUInt16LE(end + 8) !== count) fail("ZIP disk count mismatch.");
    if (count > TRANSFER_LIMITS.entries || offset + size !== centralEnd) fail("ZIP entry count or central directory invalid.");
    zip = await new Promise<ZipFile>((resolve, reject) => yauzl.fromRandomAccessReader(new HandleReader(handle, ctx.check), source.stat.size,
      { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: false }, (error, value) => error ? reject(error) : resolve(value)));
    const archive = zip;
    let zipError: Error | undefined;
    archive.on("error", (error) => { zipError = error; });
    const names = new Map<string, boolean>();
    let cursor = 0, centralSize = 0, total = 0;
    for (let i = 0; i < count; i++) {
      ctx.check(); if (zipError) throw zipError;
      const entry = await new Promise<Entry>((resolve, reject) => {
        const clean = () => { archive.off("entry", onEntry); archive.off("error", onError); archive.off("end", onEnd); };
        const onEntry = (value: Entry) => { clean(); resolve(value); };
        const onError = (error: Error) => { clean(); reject(error); };
        const onEnd = () => { clean(); reject(new Error("ZIP entry count mismatch.")); };
        archive.once("entry", onEntry); archive.once("error", onError); archive.once("end", onEnd); archive.readEntry();
      });
      const directory = entry.fileName.endsWith("/");
      const name = archiveName(entry.fileName, directory), key = name.replace(/\/$/, "").normalize("NFC").toLowerCase();
      if (names.has(key)) fail("ZIP duplicate name."); names.set(key, directory);
      const root = resolveWorkspaceRoot(ctx.config, source.rootId);
      let target = path.resolve(root.path, path.posix.dirname(source.relative));
      for (const part of name.replace(/\/$/, "").split("/")) {
        target = path.join(target, part); const reason = getDenialReason(ctx.config, root, target);
        if (reason) fail(`ZIP contains denied content: ${name}: ${reason}`);
      }
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
      if ((mode && mode !== 0x8000 && mode !== 0x4000) || (mode === 0x4000 && !directory) ||
          (mode === 0x8000 && directory) || (entry.externalFileAttributes & 0x400) || entry.isEncrypted() ||
          (entry.generalPurposeBitFlag & ~0x80e) || ![0, 8].includes(entry.compressionMethod) || entry.extraFields.some((f) => f.id === 0x7075)) fail("ZIP unsupported flags, alternate names or special entry.");
      total = addBytes(total, entry.uncompressedSize);
      if (directory && entry.uncompressedSize !== 0) fail("ZIP directory contains payload.");
      if (entry.relativeOffsetOfLocalHeader !== cursor) fail("ZIP overlap, prefix or reordered local entries unsupported.");
      const local = await readAt(handle, cursor, 30);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== entry.generalPurposeBitFlag || local.readUInt16LE(8) !== entry.compressionMethod) fail("ZIP local header mismatch.");
      const nameLength = local.readUInt16LE(26), extraLength = local.readUInt16LE(28);
      const localName = await readAt(handle, cursor + 30, nameLength);
      if (!localName.equals((entry as Entry & { fileNameRaw: Buffer }).fileNameRaw)) fail("ZIP local name mismatch.");
      const extra = await readAt(handle, cursor + 30 + nameLength, extraLength);
      let localSize = local.readUInt32LE(22), localCompressed = local.readUInt32LE(18), zip64 = false;
      for (let at = 0; at < extra.length;) {
        if (at + 4 > extra.length) fail("ZIP extra truncated.");
        const id = extra.readUInt16LE(at), length = extra.readUInt16LE(at + 2); at += 4;
        if (at + length > extra.length || id === 0x7075) fail("ZIP extra invalid or alternate name.");
        if (id === 1) {
          if (zip64 || length !== 16) fail("ZIP64 local extra invalid."); zip64 = true;
          localSize = safe64(extra, at); localCompressed = safe64(extra, at + 8);
        }
        at += length;
      }
      cursor += 30 + nameLength + extraLength + entry.compressedSize;
      if (cursor > offset) fail("ZIP entry overlaps central directory.");
      if (entry.generalPurposeBitFlag & 8) {
        const signature = await readAt(handle, cursor, 4);
        const signed = signature.readUInt32LE(0) === 0x08074b50;
        const descriptor = await readAt(handle, cursor + (signed ? 4 : 0), zip64 ? 20 : 12);
        if (descriptor.readUInt32LE(0) !== entry.crc32 || (zip64 ? safe64(descriptor, 4) : descriptor.readUInt32LE(4)) !== entry.compressedSize ||
            (zip64 ? safe64(descriptor, 12) : descriptor.readUInt32LE(8)) !== entry.uncompressedSize) fail("ZIP descriptor mismatch.");
        cursor += descriptor.length + (signed ? 4 : 0);
      } else if (local.readUInt32LE(14) !== entry.crc32 || localSize !== entry.uncompressedSize || localCompressed !== entry.compressedSize) fail("ZIP local sizes mismatch.");
      const stream = await new Promise<Readable>((resolve, reject) => archive.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value)));
      let crc = 0xffffffff, actual = 0;
      try {
        for await (const chunk of stream) { ctx.check(); actual = addBytes(actual, chunk.length, entry.uncompressedSize); crc = updateCrc(crc, chunk); }
      } finally { stream.destroy(); }
      if (actual !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) fail("ZIP CRC32 or expanded size mismatch.");
      centralSize += 46 + entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength;
    }
    if (cursor !== offset || centralSize !== size || zipError) fail("ZIP unreferenced data or directory mismatch.");
    for (const key of names.keys()) {
      const parts = key.split("/"); for (let i = 1; i < parts.length; i++) if (names.get(parts.slice(0, i).join("/")) === false) fail("ZIP file/directory collision.");
    }
    if (!sameIdentity(identity(source.stat), identity(await handle.stat())) ||
        !sameIdentity(identity(source.stat), identity((await resolveArchiveSource(ctx.config, args, "zip")).stat))) fail("SOURCE_CHANGED: ZIP during validation.");
    return { identity: identity(source.stat), expandedBytes: total, entryCount: count };
  } finally { zip?.close(); await handle.close(); }
}
