import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";
import JSZip from "jszip";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import type { AssetArgs } from "./assets.js";
import type { ServerConfig } from "./config.js";
import { assertFileReturnScope } from "./file-transfer.js";
import {
  WorkspaceAccessError, assertWithinRoot, getDenialReason, resolveWorkspacePath,
  resolveWorkspaceZipPath, resolveWorkspaceRoot, toWorkspaceRelative,
  type ResolvedWorkspacePath,
} from "./path-guard.js";

export const ARCHIVE_LIMITS = Object.freeze({
  entries: 2048, depth: 32, nameBytes: 512, entryExpandedBytes: 16 * 1024 * 1024,
  expandedBytes: 48 * 1024 * 1024, listingEntries: 200, readBytes: 256 * 1024,
  timeoutMs: 15_000, pending: 8, ttlMs: 10 * 60_000,
});

export const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
function fail(message: string): never { throw new WorkspaceAccessError(message); }

/** Canonical portable names: backslashes accepted at the boundary, never written into ZIPs. */
export function archiveName(raw: string, directory = false): string {
  const value = raw.replace(/\\/g, "/");
  const name = directory && value.endsWith("/") ? value.slice(0, -1) : value;
  const parts = name.split("/");
  if (!name || Buffer.byteLength(name) > ARCHIVE_LIMITS.nameBytes || parts.length > ARCHIVE_LIMITS.depth ||
      /[\x00-\x1f\x7f:<>"|?*\ufffd]/.test(name) || parts.some((p) => !p || p === "." || p === ".." ||
        /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(p))) {
    fail("Unsafe or overlong archive path.");
  }
  return name + (directory ? "/" : "");
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Check each lexical ancestor as well as realpath. Never follow even an in-scope junction. */
async function noLinks(config: ServerConfig, resolved: ResolvedWorkspacePath, zipOnly: boolean): Promise<void> {
  const root = resolveWorkspaceRoot(config, resolved.rootId);
  let cursor = root.path;
  const parts = resolved.relative === "." ? [] : resolved.relative.split("/");
  for (const [index, part] of parts.entries()) {
    cursor = path.join(cursor, part);
    const denial = getDenialReason(config, root, cursor);
    if (denial && !(zipOnly && index === parts.length - 1 && denial === "Path includes denied file extension: .zip")) fail(denial);
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink()) fail("Archive paths cannot include symlinks or junctions.");
    if (!stat.isDirectory() && !stat.isFile()) fail("Archive paths must be regular files or directories.");
    if (stat.isFile() && stat.nlink !== 1) fail("Archive paths cannot include hard-linked files.");
  }
}

export async function resolveArchiveSource(config: ServerConfig, args: AssetArgs, kind: "file" | "directory" | "zip") {
  const scope = config.assetScopes.get(args.scope.trim());
  if (!scope) fail("Unknown asset scope.");
  const relative = args.path === "." ? "." : archiveName(args.path);
  const base = await resolveWorkspacePath(config, scope.path, "directory", scope.rootId);
  // Resolve the lexical path separately so an allowed-target link is not erased by realpath.
  const input = path.join(scope.path, relative);
  const absolute = path.resolve(base.rootPath, input);
  assertWithinRoot(base.absolute, absolute, "Archive path escapes the configured asset scope.");
  const lexical = { ...base, absolute, relative: toWorkspaceRelative(base.rootPath, absolute) };
  await noLinks(config, lexical, kind === "zip");
  const resolved = kind === "zip"
    ? await resolveWorkspaceZipPath(config, input, scope.rootId)
    : await resolveWorkspacePath(config, input, kind, scope.rootId);
  assertWithinRoot(base.absolute, resolved.absolute, "Archive path escapes the configured asset scope.");
  await noLinks(config, resolved, kind === "zip");
  return { ...resolved, scope: scope.id, scopeRelative: toWorkspaceRelative(base.absolute, resolved.absolute) };
}

async function snapshot(config: ServerConfig, args: AssetArgs, kind: "file" | "zip"): Promise<Buffer> {
  const resolved = await resolveArchiveSource(config, args, kind);
  const handle = await fs.open(resolved.absolute, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !sameFile(stat, resolved.stat)) fail("Archive source changed before reading.");
    const maximum = kind === "zip" ? config.maxFetchFileBytes : ARCHIVE_LIMITS.entryExpandedBytes;
    if (stat.size > maximum) fail(`Archive source exceeds ${kind === "zip" ? "fetch" : "entry expanded size"} limit of ${maximum} bytes.`);
    const again = await resolveArchiveSource(config, args, kind);
    if (!sameFile(stat, again.stat)) fail("Archive source changed before reading.");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) fail("Archive source changed while reading.");
      offset += result.bytesRead;
    }
    const end = await handle.stat();
    const final = await resolveArchiveSource(config, args, kind);
    if (!sameFile(stat, end) || !sameFile(stat, final.stat)) fail("Archive source changed while reading.");
    return bytes;
  } finally { await handle.close(); }
}

function entryDenial(config: ServerConfig, rootId: string, parent: string, name: string): string | undefined {
  const root = resolveWorkspaceRoot(config, rootId);
  let target = path.resolve(root.path, parent);
  for (const part of name.replace(/\/$/, "").split("/")) {
    target = path.join(target, part);
    const reason = getDenialReason(config, root, target);
    if (reason) return reason;
  }
  return undefined;
}

export interface IncludedEntry { path: string; kind: "file" | "directory"; bytes: number; sha256: string | null }
export interface SkippedEntry { path: string; reason: string; subtree: boolean }

export async function packageFolder(config: ServerConfig, args: AssetArgs, signal?: AbortSignal) {
  assertFileReturnScope(config, args.scope);
  const source = await resolveArchiveSource(config, args, "directory");
  const zip = new JSZip();
  const included: IncludedEntry[] = [];
  const skipped: SkippedEntry[] = [];
  const identities: Array<{ args: AssetArgs; kind: "file" | "directory"; stat: Stats }> = [];
  let visited = 0;
  let inputBytes = 0;
  const deadline = Date.now() + ARCHIVE_LIMITS.timeoutMs;
  const check = () => {
    signal?.throwIfAborted();
    if (Date.now() > deadline) fail("Archive packaging deadline exceeded.");
  };
  async function walk(folderArgs: AssetArgs, prefix: string): Promise<void> {
    check();
    const folder = await resolveArchiveSource(config, folderArgs, "directory");
    identities.push({ args: folderArgs, kind: "directory", stat: folder.stat });
    const dir = await fs.opendir(folder.absolute);
    for await (const child of dir) {
      check();
      if (++visited > ARCHIVE_LIMITS.entries) fail("Archive entry count limit exceeded; no partial archive returned.");
      const name = archiveName(prefix + child.name, child.isDirectory());
      const childArgs = { scope: args.scope, path: path.posix.join(folderArgs.path.replace(/\\/g, "/"), child.name) };
      const reason = entryDenial(config, source.rootId, source.relative, name);
      if (reason || child.isSymbolicLink() || (!child.isFile() && !child.isDirectory())) {
        skipped.push({ path: name, reason: reason ?? "Symlink, junction or special file is excluded.", subtree: !child.isFile() });
        continue;
      }
      // A race, vanished file or failed OS access aborts; it is never relabeled as a policy skip.
      const resolved = await resolveArchiveSource(config, childArgs, child.isDirectory() ? "directory" : "file");
      if (child.isDirectory()) {
        zip.file(name, Buffer.alloc(0), { dir: true, createFolders: false });
        included.push({ path: name, kind: "directory", bytes: 0, sha256: null });
        await walk(childArgs, name);
      } else {
        if (resolved.stat.size > ARCHIVE_LIMITS.entryExpandedBytes || inputBytes + resolved.stat.size > ARCHIVE_LIMITS.expandedBytes) {
          fail("Archive source exceeds entry or total expanded size limit; no partial archive returned.");
        }
        const bytes = await snapshot(config, childArgs, "file");
        if (inputBytes + bytes.length > ARCHIVE_LIMITS.expandedBytes) fail("Archive total expanded size limit exceeded.");
        inputBytes += bytes.length;
        identities.push({ args: childArgs, kind: "file", stat: resolved.stat });
        zip.file(name, bytes, { createFolders: false, date: resolved.stat.mtime });
        included.push({ path: name, kind: "file", bytes: bytes.length, sha256: digest(bytes) });
      }
    }
  }
  await walk(args, "");
  for (const identity of identities) {
    check();
    if (!sameFile(identity.stat, (await resolveArchiveSource(config, identity.args, identity.kind)).stat)) fail("Archive source tree changed while packaging.");
  }
  // Expanded input is independently bounded; only the final compressed ZIP uses the fetch cap.
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 }, platform: "DOS" }, check);
  check();
  if (bytes.length > config.maxFetchFileBytes) fail(`ZIP exceeds fetch limit of ${config.maxFetchFileBytes} bytes, including headers.`);
  // Validate the generated container using the same independent reader before publication.
  await inspectZipBuffer(config, bytes, source.rootId, source.relative, true);
  return {
    bytes, scope: source.scope, path: source.scopeRelative,
    filename: `${source.scopeRelative === "." ? source.scope : path.posix.basename(source.scopeRelative)}.zip`,
    included, skipped, complete: skipped.length === 0, sourceBytes: inputBytes,
  };
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function archiveCrc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ArchiveEntry {
  name: string; kind: "file" | "directory"; bytes: number; compressedBytes: number;
  crc32: string; allowed: boolean; reason: string | null; integrity: "crc32_verified" | "not_read_denied";
}

function classicDirectory(bytes: Buffer): { offset: number; count: number; size: number } {
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) !== 0x06054b50 || i + 22 + bytes.readUInt16LE(i + 20) !== bytes.length) continue;
    const count = bytes.readUInt16LE(i + 10);
    const size = bytes.readUInt32LE(i + 12);
    const offset = bytes.readUInt32LE(i + 16);
    if (bytes.readUInt16LE(i + 4) || bytes.readUInt16LE(i + 6) || bytes.readUInt16LE(i + 8) !== count ||
        count === 0xffff || size === 0xffffffff || offset === 0xffffffff || offset + size !== i) {
      fail("Unsupported multi-disk, ZIP64 or inconsistent ZIP directory.");
    }
    if (count > ARCHIVE_LIMITS.entries) fail("Archive entry count limit exceeded.");
    return { offset, count, size };
  }
  return fail("Corrupted ZIP: missing end of central directory.");
}

function validateHeader(bytes: Buffer, entry: Entry, directoryOffset: number): { start: number; end: number; rawName: string } {
  const at = entry.relativeOffsetOfLocalHeader;
  if (!Number.isSafeInteger(at) || at < 0 || at + 30 > directoryOffset || bytes.readUInt32LE(at) !== 0x04034b50) fail("Corrupted ZIP local header.");
  const flags = bytes.readUInt16LE(at + 6);
  const nameLength = bytes.readUInt16LE(at + 26);
  const extraLength = bytes.readUInt16LE(at + 28);
  const start = at + 30 + nameLength + extraLength;
  let end = start + entry.compressedSize;
  const raw = bytes.subarray(at + 30, at + 30 + nameLength);
  const centralRaw = (entry as Entry & { fileNameRaw: Buffer }).fileNameRaw;
  if (end > directoryOffset || flags !== entry.generalPurposeBitFlag || bytes.readUInt16LE(at + 8) !== entry.compressionMethod || !raw.equals(centralRaw)) {
    fail("ZIP local and central headers disagree.");
  }
  if (flags & 8) {
    const descriptor = end + (bytes.readUInt32LE(end) === 0x08074b50 ? 4 : 0);
    if (descriptor + 12 > directoryOffset || bytes.readUInt32LE(descriptor) !== entry.crc32 ||
        bytes.readUInt32LE(descriptor + 4) !== entry.compressedSize || bytes.readUInt32LE(descriptor + 8) !== entry.uncompressedSize) fail("Corrupted ZIP data descriptor.");
    end = descriptor + 12;
  } else if (bytes.readUInt32LE(at + 14) !== entry.crc32 || bytes.readUInt32LE(at + 18) !== entry.compressedSize || bytes.readUInt32LE(at + 22) !== entry.uncompressedSize) {
    fail("ZIP local and central sizes or CRC disagree.");
  }
  // Reject conflicting local Unicode-path overrides (different extractors must see the same name).
  for (let cursor = at + 30 + nameLength; cursor < start;) {
    if (cursor + 4 > start) fail("Corrupted ZIP extra field.");
    const id = bytes.readUInt16LE(cursor), length = bytes.readUInt16LE(cursor + 2);
    if (cursor + 4 + length > start || id === 1) fail("Unsupported or corrupted ZIP extra field.");
    if (id === 0x7075 && !entry.extraFields.some((f) => f.id === id && f.data.equals(bytes.subarray(cursor + 4, cursor + 4 + length)))) fail("Conflicting ZIP Unicode path fields.");
    cursor += 4 + length;
  }
  let rawName: string;
  try { rawName = flags & 0x800 ? new TextDecoder("utf-8", { fatal: true }).decode(raw) : raw.toString("latin1"); }
  catch { return fail("Invalid UTF-8 ZIP filename."); }
  if (rawName.endsWith("/") !== entry.fileName.endsWith("/")) fail("Conflicting ZIP directory names.");
  archiveName(rawName, entry.fileName.endsWith("/"));
  return { start: at, end, rawName: rawName.replace(/\\/g, "/") };
}

async function unzipEntry(zip: ZipFile, entry: Entry, limit: number, deadline: number, keep: boolean): Promise<Buffer | undefined> {
  const stream = await new Promise<import("node:stream").Readable>((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream));
  });
  let total = 0, crc = 0xffffffff;
  const chunks: Buffer[] = [];
  const timer = setTimeout(() => stream.destroy(new WorkspaceAccessError("Archive read deadline exceeded.")), Math.max(1, deadline - Date.now()));
  timer.unref();
  try {
    for await (const chunk of stream) {
      const data = Buffer.from(chunk);
      total += data.length;
      if (total > limit || total > entry.uncompressedSize || Date.now() > deadline) fail("Archive expanded size or deadline limit exceeded.");
      for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
      if (keep) chunks.push(data);
    }
    if (total !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) fail("ZIP entry CRC32 or size integrity check failed.");
    return keep ? Buffer.concat(chunks, total) : undefined;
  } finally { clearTimeout(timer); stream.destroy(); }
}

/** No extraction. All headers are checked before any bounded decompression. */
export async function inspectZipBuffer(config: ServerConfig, bytes: Buffer, rootId: string, parent: string, requireAll = false, selected?: string) {
  if (bytes.length > config.maxFetchFileBytes) fail(`Archive exceeds fetch limit of ${config.maxFetchFileBytes} bytes.`);
  const directory = classicDirectory(bytes);
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: false }, (error, zip) => error ? reject(error) : resolve(zip));
  });
  const deadline = Date.now() + ARCHIVE_LIMITS.timeoutMs;
  const entries: Entry[] = [];
  const metadata: ArchiveEntry[] = [];
  const ranges: Array<{ start: number; end: number }> = [];
  const names = new Map<string, string>();
  let expandedBytes = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new WorkspaceAccessError("Archive inspection deadline exceeded.")), ARCHIVE_LIMITS.timeoutMs);
      timer.unref();
      const finish = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
      zip.on("error", finish);
      zip.on("end", () => finish());
      zip.on("entry", (entry: Entry) => {
        try {
          if (Date.now() > deadline || entries.length >= ARCHIVE_LIMITS.entries) fail("Archive entry count or deadline limit exceeded.");
          const directoryEntry = entry.fileName.endsWith("/");
          const name = archiveName(entry.fileName, directoryEntry);
          const key = name.replace(/\/$/, "").normalize("NFC").toLowerCase();
          if (names.has(key)) fail("Duplicate or ambiguous ZIP entry name.");
          names.set(key, directoryEntry ? "directory" : "file");
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if ((mode && mode !== 0x8000 && mode !== 0x4000) || (mode === 0x4000 && !directoryEntry) ||
              (mode === 0x8000 && directoryEntry) || (entry.externalFileAttributes & 0x400)) fail("ZIP symlink, reparse point or special entry is forbidden.");
          if (entry.isEncrypted() || (entry.generalPurposeBitFlag & ~0x80e) || ![0, 8].includes(entry.compressionMethod) || entry.extraFields.some((f) => f.id === 1)) fail("Encrypted, ZIP64 or unsupported ZIP entry.");
          if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > ARCHIVE_LIMITS.entryExpandedBytes ||
              !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0 ||
              (directoryEntry && entry.uncompressedSize !== 0)) fail("Archive entry expanded size limit exceeded.");
          expandedBytes += entry.uncompressedSize;
          if (expandedBytes > ARCHIVE_LIMITS.expandedBytes) fail("Archive total expanded size limit exceeded.");
          const header = validateHeader(bytes, entry, directory.offset);
          const rawKey = header.rawName.replace(/\/$/, "").normalize("NFC").toLowerCase();
          if (rawKey !== key && names.has(rawKey)) fail("Duplicate or ambiguous raw ZIP entry name.");
          names.set(rawKey, directoryEntry ? "directory" : "file");
          ranges.push(header);
          const reason = entryDenial(config, rootId, parent, name) ?? entryDenial(config, rootId, parent, header.rawName);
          if (requireAll && reason) fail(`ZIP contains denied content: ${name}: ${reason}`);
          metadata.push({ name, kind: directoryEntry ? "directory" : "file", bytes: entry.uncompressedSize,
            compressedBytes: entry.compressedSize, crc32: entry.crc32.toString(16).padStart(8, "0"),
            allowed: !reason, reason: reason ?? null, integrity: reason ? "not_read_denied" : "crc32_verified" });
          entries.push(entry);
          zip.readEntry();
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
      zip.readEntry();
    });
    if (entries.length !== directory.count) fail("ZIP entry count mismatch.");
    if (entries.reduce((size, entry) => size + 46 + entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength, 0) !== directory.size) fail("ZIP central directory size mismatch.");
    let cursor = 0;
    for (const range of ranges.sort((a, b) => a.start - b.start)) {
      if (range.start !== cursor) fail("Overlapping, hidden or prefixed ZIP entries are unsupported.");
      cursor = range.end;
    }
    if (cursor !== directory.offset) fail("Unreferenced ZIP data is unsupported.");
    for (const key of names.keys()) {
      const parts = key.split("/");
      for (let i = 1; i < parts.length; i++) if (names.get(parts.slice(0, i).join("/")) === "file") fail("ZIP file/directory name collision.");
    }
    let selectedBytes: Buffer | undefined;
    for (const [i, entry] of entries.entries()) {
      if (!metadata[i].allowed) continue;
      const output = await unzipEntry(zip, entry, ARCHIVE_LIMITS.entryExpandedBytes, deadline, metadata[i].name === selected);
      if (output) selectedBytes = output;
    }
    return { entries: metadata, expandedBytes, selectedBytes };
  } finally { zip.close(); }
}

export async function openArchive(config: ServerConfig, args: AssetArgs, requireAll = false, selected?: string) {
  const source = await resolveArchiveSource(config, args, "zip");
  const bytes = await snapshot(config, args, "zip");
  const inspection = await inspectZipBuffer(config, bytes, source.rootId, path.posix.dirname(source.relative), requireAll, selected);
  return { bytes, source, ...inspection, sha256: digest(bytes) };
}

export async function inspectArchive(config: ServerConfig, args: AssetArgs & { offset?: number; limit?: number }) {
  const archive = await openArchive(config, args);
  const offset = args.offset ?? 0, limit = args.limit ?? ARCHIVE_LIMITS.listingEntries;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > ARCHIVE_LIMITS.listingEntries) fail("Invalid ZIP listing range.");
  const deniedEntries = archive.entries.filter((e) => !e.allowed).length;
  return { ok: true as const, scope: archive.source.scope, path: archive.source.scopeRelative,
    filename: path.posix.basename(archive.source.scopeRelative), bytes: archive.bytes.length, sha256: archive.sha256,
    entryCount: archive.entries.length, expandedBytes: archive.expandedBytes, deniedEntries,
    integrity: deniedEntries ? "allowed_entries_crc32_verified" : "all_entries_crc32_verified",
    entries: archive.entries.slice(offset, offset + limit), offset,
    nextOffset: offset + limit < archive.entries.length ? offset + limit : null,
    limits: { ...ARCHIVE_LIMITS, fileBytes: config.maxFetchFileBytes } };
}

export async function readArchiveEntry(config: ServerConfig, args: AssetArgs & { entry: string; offset?: number; maxBytes?: number; encoding?: "utf8" | "base64" }) {
  const entry = archiveName(args.entry);
  const offset = args.offset ?? 0;
  const cap = Math.min(ARCHIVE_LIMITS.readBytes, Math.floor(config.maxReturnedBytes / 4) * 3);
  const maximum = args.maxBytes ?? Math.min(65536, cap);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(maximum) || maximum < 1 || maximum > cap) fail("Invalid ZIP entry byte range.");
  const archive = await openArchive(config, args, false, entry);
  const metadata = archive.entries.find((e) => e.name === entry);
  if (!metadata || metadata.kind !== "file") fail("ZIP file entry not found.");
  if (!metadata.allowed) fail(metadata.reason ?? "ZIP entry denied.");
  const bytes = archive.selectedBytes!;
  if (offset > bytes.length) fail("ZIP entry offset exceeds entry size.");
  const window = bytes.subarray(offset, offset + maximum);
  const encoding = args.encoding ?? "base64";
  let data: string;
  if (encoding === "base64") data = window.toString("base64");
  else if (encoding === "utf8") {
    try { data = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(window); }
    catch { return fail("Entry byte range is not valid UTF-8; use base64 or aligned byte boundaries."); }
  } else return fail("Unsupported ZIP entry encoding.");
  const next = offset + window.length;
  return { ok: true as const, scope: archive.source.scope, path: archive.source.scopeRelative, entry,
    archiveSha256: archive.sha256, sha256: digest(bytes), crc32: metadata.crc32, integrity: "crc32_verified",
    bytes: bytes.length, offset, returnedBytes: window.length, nextOffset: next < bytes.length ? next : null,
    eof: next === bytes.length, encoding, data };
}
