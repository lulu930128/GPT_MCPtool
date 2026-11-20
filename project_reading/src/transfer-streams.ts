import { createHash } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createDeflateRaw } from "node:zlib";
import { archiveName, resolveArchiveSource } from "./archives.js";
import type { AssetArgs } from "./assets.js";
import type { ServerConfig } from "./config.js";
import { getDenialReason, resolveResearchPath, resolveWorkspaceRoot, WorkspaceAccessError } from "./path-guard.js";

// Base64 expands 3:4. Reserve 64 KiB for MCP and JSON-RPC framing.
export const tunnelPartBytes = Math.floor((10 * 1024 * 1024 - 65536) / 4) * 3;
export const TRANSFER_LIMITS = Object.freeze({
  bytes: 100_000_000_000, inputBytes: 100_000_000_000, stagingBytes: 100_000_000_000,
  chunkBytes: 8 * 1024 * 1024, minChunkBytes: 1024 * 1024, page: 100,
  entries: 100_000, jobs: 4, ttlMs: 7 * 24 * 60 * 60_000,
  workMs: 3 * 24 * 60 * 60_000, ioBytes: 64 * 1024,
});
export function fail(message: string): never { throw new WorkspaceAccessError(message); }
export function addBytes(current: number, increment: number, maximum: number = TRANSFER_LIMITS.bytes): number {
  if (!Number.isSafeInteger(current) || current < 0 || !Number.isSafeInteger(increment) || increment < 0 ||
      !Number.isSafeInteger(maximum) || maximum < 0 || maximum > TRANSFER_LIMITS.bytes || current > maximum - increment) {
    fail("TRANSFER_LIMIT: byte budget exceeded.");
  }
  return current + increment;
}
export function identity(stat: Stats) {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, nlink: stat.nlink };
}
export function sameIdentity(a: ReturnType<typeof identity>, b: ReturnType<typeof identity>): boolean {
  return Object.keys(a).every((key) => a[key as keyof typeof a] === b[key as keyof typeof b]);
}
export async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
  let at = 0;
  while (at < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, at, bytes.length - at);
    if (!bytesWritten) fail("TRANSFER_IO: short write.");
    at += bytesWritten;
  }
}
export interface CaptureContext {
  config: ServerConfig; signal: AbortSignal;
  check(): void;
  input(bytes: number): void;
  record(value: Record<string, unknown>): Promise<void>;
  remember(value: Record<string, unknown>): Promise<void>;
}
export async function resolveTransferFile(config: ServerConfig, args: AssetArgs, kind: "file" | "zip" | "directory", workspace = false) {
  if (!workspace) return resolveArchiveSource(config, args, kind);
  if (kind !== "file") fail("Workspace capture requires a regular file.");
  const resolved = await resolveResearchPath(config, args.path, "file", args.scope);
  return { ...resolved, scope: resolved.rootId, scopeRelative: resolved.relative };
}
export async function* sourceBytes(ctx: CaptureContext, args: AssetArgs, kind: "file" | "zip", expected?: ReturnType<typeof identity>, workspace = false) {
  const source = await resolveTransferFile(ctx.config, args, kind, workspace);
  const original = identity(source.stat);
  if (expected && !sameIdentity(expected, original)) fail("SOURCE_CHANGED: before capture.");
  if (original.size > TRANSFER_LIMITS.inputBytes) fail("TRANSFER_LIMIT: input size exceeded.");
  const handle = await fs.open(source.absolute, "r");
  const hash = createHash("sha256");
  let position = 0;
  try {
    if (!sameIdentity(original, identity(await handle.stat())) || (!workspace && original.nlink !== 1)) fail("SOURCE_CHANGED: opened identity.");
    const again = await resolveTransferFile(ctx.config, args, kind, workspace);
    if (!sameIdentity(original, identity(again.stat))) fail("SOURCE_CHANGED: path identity.");
    while (position < original.size) {
      ctx.check();
      const buffer = Buffer.allocUnsafe(Math.min(TRANSFER_LIMITS.ioBytes, original.size - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) fail("SOURCE_CHANGED: shortened file.");
      const bytes = buffer.subarray(0, bytesRead);
      ctx.input(bytesRead); hash.update(bytes); position += bytesRead;
      yield bytes;
    }
    if (!sameIdentity(original, identity(await handle.stat())) ||
        !sameIdentity(original, identity((await resolveTransferFile(ctx.config, args, kind, workspace)).stat))) fail("SOURCE_CHANGED: during capture.");
    await ctx.record({ path: args.path, kind: "file", bytes: position, sha256: hash.digest("hex"), disposition: "included" });
    await ctx.remember({ args, kind, identity: original });
  } finally { await handle.close(); }
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let n = 0; n < 8; n++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function updateCrc(crc: number, bytes: Buffer): number {
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc;
}

/** Streaming ZIP64, including local size extra fields and 64-bit descriptors.
 * Central headers are spooled, not retained in an entry array. PKWARE APPNOTE 4.3.
 * All offsets/counts are exact JS integers within the independent 100 GB cap. */
export class StreamingZip64 {
  private offset = 0;
  private entries = 0;
  constructor(private central: FileHandle, private output: (bytes: Buffer) => Promise<void>) {}
  private async emit(bytes: Buffer) { this.offset = addBytes(this.offset, bytes.length); await this.output(bytes); }
  async entry(name: string, source: AsyncIterable<Buffer>, signal: AbortSignal, directory = false) {
    const encoded = Buffer.from(archiveName(name, directory));
    const start = this.offset;
    const header = Buffer.alloc(30 + encoded.length + 20);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(45, 4);
    header.writeUInt16LE(0x808, 6); header.writeUInt16LE(directory ? 0 : 8, 8);
    header.writeUInt16LE(33, 12); // 1980-01-01, deterministic; source mtime is in identity ledger.
    header.writeUInt32LE(0xffffffff, 18); header.writeUInt32LE(0xffffffff, 22);
    header.writeUInt16LE(encoded.length, 26); header.writeUInt16LE(20, 28);
    encoded.copy(header, 30); header.writeUInt16LE(1, 30 + encoded.length); header.writeUInt16LE(16, 32 + encoded.length);
    await this.emit(header);
    let size = 0, crc = 0xffffffff;
    const measured = async function* () {
      for await (const bytes of source) { signal.throwIfAborted(); size = addBytes(size, bytes.length); crc = updateCrc(crc, bytes); yield bytes; }
    };
    const dataStart = this.offset;
    const sink = new Writable({ write: (bytes: Buffer, _encoding, done) => { this.emit(bytes).then(() => done(), done); } });
    if (directory) await pipeline(Readable.from(measured()), sink, { signal });
    else await pipeline(Readable.from(measured()), createDeflateRaw({ level: 6, chunkSize: TRANSFER_LIMITS.ioBytes }), sink, { signal });
    const compressed = this.offset - dataStart;
    crc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = Buffer.alloc(24);
    descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4);
    descriptor.writeBigUInt64LE(BigInt(compressed), 8); descriptor.writeBigUInt64LE(BigInt(size), 16);
    await this.emit(descriptor);
    const central = Buffer.alloc(46 + encoded.length + 28);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(45, 4); central.writeUInt16LE(45, 6);
    central.writeUInt16LE(0x808, 8); central.writeUInt16LE(directory ? 0 : 8, 10); central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(0xffffffff, 20); central.writeUInt32LE(0xffffffff, 24);
    central.writeUInt16LE(encoded.length, 28); central.writeUInt16LE(28, 30);
    central.writeUInt32LE(directory ? 16 : 0, 38); central.writeUInt32LE(0xffffffff, 42);
    encoded.copy(central, 46); central.writeUInt16LE(1, 46 + encoded.length); central.writeUInt16LE(24, 48 + encoded.length);
    central.writeBigUInt64LE(BigInt(size), 50 + encoded.length); central.writeBigUInt64LE(BigInt(compressed), 58 + encoded.length);
    central.writeBigUInt64LE(BigInt(start), 66 + encoded.length);
    await writeAll(this.central, central); this.entries++;
  }
  async finish() {
    const centralOffset = this.offset;
    const size = (await this.central.stat()).size;
    for (let at = 0; at < size;) {
      const buffer = Buffer.allocUnsafe(Math.min(TRANSFER_LIMITS.ioBytes, size - at));
      const { bytesRead } = await this.central.read(buffer, 0, buffer.length, at);
      if (!bytesRead) fail("TRANSFER_IO: incomplete central directory.");
      await this.emit(buffer.subarray(0, bytesRead)); at += bytesRead;
    }
    await this.emit(zip64End(this.entries, size, centralOffset));
  }
}
export function zip64End(count: number, size: number, offset: number): Buffer {
  const result = Buffer.alloc(98);
  result.writeUInt32LE(0x06064b50); result.writeBigUInt64LE(44n, 4);
  result.writeUInt16LE(45, 12); result.writeUInt16LE(45, 14);
  result.writeBigUInt64LE(BigInt(count), 24); result.writeBigUInt64LE(BigInt(count), 32);
  result.writeBigUInt64LE(BigInt(size), 40); result.writeBigUInt64LE(BigInt(offset), 48);
  result.writeUInt32LE(0x07064b50, 56); result.writeBigUInt64LE(BigInt(offset + size), 64); result.writeUInt32LE(1, 72);
  result.writeUInt32LE(0x06054b50, 76); result.writeUInt16LE(0xffff, 84); result.writeUInt16LE(0xffff, 86);
  result.writeUInt32LE(0xffffffff, 88); result.writeUInt32LE(0xffffffff, 92);
  return result;
}

export async function captureFolder(ctx: CaptureContext, args: AssetArgs, zip: StreamingZip64) {
  let visited = 0;
  async function walk(current: AssetArgs, prefix: string): Promise<void> {
    ctx.check();
    const source = await resolveArchiveSource(ctx.config, current, "directory");
    await ctx.remember({ args: current, kind: "directory", identity: identity(source.stat) });
    const root = resolveWorkspaceRoot(ctx.config, source.rootId);
    const names = new Set<string>(); // Collision metadata bounded by the global entry cap.
    const dir = await fs.opendir(source.absolute);
    for await (const child of dir) {
      ctx.check();
      if (++visited > TRANSFER_LIMITS.entries) fail("TRANSFER_LIMIT: entry count exceeded.");
      const key = child.name.normalize("NFC").toLowerCase();
      if (names.has(key)) fail("Ambiguous source names.");
      names.add(key);
      const name = archiveName(prefix + child.name, child.isDirectory());
      const childArgs = { scope: args.scope, path: path.posix.join(current.path, child.name) };
      const denial = getDenialReason(ctx.config, root, path.join(source.absolute, child.name));
      const stat = denial || child.isSymbolicLink() ? undefined : await fs.lstat(path.join(source.absolute, child.name));
      if (denial || child.isSymbolicLink() || !stat || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) {
        await ctx.record({ path: name, disposition: "skipped", reason: denial ?? "Link or special file excluded.", subtree: !child.isFile() });
        continue;
      }
      if (child.isDirectory()) {
        await zip.entry(name, (async function* () {})(), ctx.signal, true);
        await ctx.record({ path: name, kind: "directory", bytes: 0, sha256: null, disposition: "included" });
        await walk(childArgs, name);
      } else {
        const childContext = { ...ctx, record: (record: Record<string, unknown>) => ctx.record({ ...record, path: name }) };
        await zip.entry(name, sourceBytes(childContext, childArgs, "file", identity(stat)), ctx.signal);
      }
    }
    if (!sameIdentity(identity(source.stat), identity((await resolveArchiveSource(ctx.config, current, "directory")).stat))) fail("SOURCE_CHANGED: directory during capture.");
  }
  await walk(args, "");
  await zip.finish();
}
