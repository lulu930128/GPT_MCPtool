import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Stats } from "node:fs";
import type { AssetArgs } from "./assets.js";
import type { ServerConfig } from "./config.js";
import { ARCHIVE_LIMITS, digest, inspectZipBuffer, openArchive, packageFolder, resolveArchiveSource } from "./archives.js";
import { assertFileReturnScope, createAssetResourceUri, parseAssetResourceUri, readBoundedFile } from "./file-transfer.js";
import { inspectWritePath, WorkspaceAccessError } from "./path-guard.js";

const TEMP_NAME = /^(\d{13})-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.zip$/;
const UNAVAILABLE = "Temporary ZIP is expired, consumed, in progress, or unknown; package the folder again.";
interface PendingZip {
  filename: string; uri: string; sha256: string; expiresAt: number; bytes: number;
  scope: string; sourcePath: string; sourceAbsolute: string; stat: Stats; state: "ready" | "reading" | "cleanup";
}

/** Owns only exact files created with wx in a private, fixed temporary namespace.
 * No caller-selected paths, extraction, recursive deletion, or workspace writes. */
export class ArchiveTempStore {
  private pending = new Map<string, PendingZip>();
  private directory?: { path: string; stat: Stats };
  private initializing?: Promise<void>;
  private timer: ReturnType<typeof setInterval>;
  private sweeping?: Promise<void>;
  private creating = 0;
  private closed = false;

  constructor(private readonly options: {
    directory?: string; ttlMs?: number; sweepMs?: number; now?: () => number;
    log?: (message: string) => void;
  } = {}) {
    this.timer = setInterval(() => { void this.sweep().catch(() => this.log("Temporary ZIP cleanup failed; retained for retry.")); }, options.sweepMs ?? 30_000);
    this.timer.unref();
  }

  private now() { return this.options.now?.() ?? Date.now(); }
  private log(message: string) { (this.options.log ?? console.error)(message); }

  private async initialize(): Promise<void> {
    if (!this.initializing) {
      this.initializing = (async () => {
        const temp = await fs.realpath(os.tmpdir());
        const directory = this.options.directory ?? path.join(temp, "project-workspace-zip-v1");
        await fs.mkdir(directory, { mode: 0o700, recursive: false }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        const inspected = await inspectWritePath(directory);
        if (!inspected.stat?.isDirectory()) throw new WorkspaceAccessError("ZIP temporary directory is unsafe.");
        this.directory = { path: inspected.canonicalPath, stat: inspected.stat };
      })();
    }
    await this.initializing;
  }

  private async checkedPath(filename: string): Promise<string> {
    if (!TEMP_NAME.test(filename)) throw new WorkspaceAccessError("Invalid server-owned ZIP name.");
    await this.initialize();
    const base = this.directory!;
    const inspected = await inspectWritePath(base.path);
    if (!inspected.stat?.isDirectory() || inspected.stat.dev !== base.stat.dev || inspected.stat.ino !== base.stat.ino) {
      throw new WorkspaceAccessError("ZIP temporary directory changed.");
    }
    return path.join(base.path, filename);
  }

  async publish(config: ServerConfig, bytes: Buffer, scope: string, sourcePath: string) {
    if (this.closed || this.pending.size + this.creating >= ARCHIVE_LIMITS.pending) throw new WorkspaceAccessError("Temporary ZIP capacity reached.");
    this.creating++;
    try {
      await this.initialize();
      await this.sweep();
      if (bytes.length > config.maxFetchFileBytes) throw new WorkspaceAccessError("Temporary ZIP exceeds fetch limit.");
      const source = await resolveArchiveSource(config, { scope, path: sourcePath }, "directory");
      const expiresAt = this.now() + (this.options.ttlMs ?? ARCHIVE_LIMITS.ttlMs);
      const filename = `${expiresAt}-${randomUUID()}.zip`;
      const absolute = await this.checkedPath(filename);
      const sha256 = digest(bytes);
      const uri = `workspace-zip-temp:///${filename}?sha256=${sha256}`;
      const handle = await fs.open(absolute, "wx", 0o600);
      const record: PendingZip = { filename, uri, sha256, expiresAt, bytes: bytes.length,
        scope, sourcePath, sourceAbsolute: source.absolute, stat: await handle.stat(), state: "reading" };
      this.pending.set(uri, record);
      try {
        try { await handle.writeFile(bytes); record.stat = await handle.stat(); }
        finally { await handle.close(); }
        record.state = "ready";
        return { resourceUri: uri, expiresAt: new Date(expiresAt).toISOString(), sha256 };
      } catch (error) {
        record.state = "cleanup";
        try { await this.remove(record); }
        catch { this.log("Temporary ZIP publication failed; cleanup retained for retry."); }
        throw error;
      }
    } finally { this.creating--; }
  }

  async consume(config: ServerConfig, uri: string): Promise<Buffer> {
    // Exact string lookup avoids URI normalization tricks and claims the link before any await.
    const record = this.pending.get(uri);
    if (!record || record.state !== "ready") throw new WorkspaceAccessError(UNAVAILABLE);
    record.state = "reading";
    try {
      if (this.now() >= record.expiresAt) throw new WorkspaceAccessError(UNAVAILABLE);
      assertFileReturnScope(config, record.scope);
      // Recheck the entire current source policy, including denied content, without returning it.
      // The packaged snapshot remains immutable; source changes do not replace its bytes.
      const source = await resolveArchiveSource(config, { scope: record.scope, path: record.sourcePath }, "directory");
      if (source.absolute !== record.sourceAbsolute) throw new WorkspaceAccessError("Archive source scope changed.");
      const file = await this.checkedPath(record.filename);
      const before = await fs.lstat(file);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.dev !== record.stat.dev || before.ino !== record.stat.ino) throw new WorkspaceAccessError("Temporary ZIP identity changed.");
      const bytes = await readBoundedFile(file, config.maxFetchFileBytes);
      if (bytes.length !== record.bytes || digest(bytes) !== record.sha256) throw new WorkspaceAccessError("Temporary ZIP integrity check failed.");
      await inspectZipBuffer(config, bytes, source.rootId, source.relative, true);
      return bytes;
    } finally {
      // The callback now owns complete bytes; deletion precedes the SDK response. This is NOT a browser ACK.
      await this.remove(record);
    }
  }

  private async remove(record: PendingZip): Promise<void> {
    record.state = "cleanup";
    const absolute = await this.checkedPath(record.filename);
    try {
      const stat = await fs.lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.dev !== record.stat.dev || stat.ino !== record.stat.ino) {
        throw new WorkspaceAccessError("Temporary ZIP identity changed; cleanup refused.");
      }
      await fs.unlink(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.pending.delete(record.uri);
  }

  async sweep(): Promise<void> {
    if (!this.directory) return;
    if (this.sweeping) return this.sweeping;
    this.sweeping = this.sweepInternal().finally(() => { this.sweeping = undefined; });
    return this.sweeping;
  }

  private async sweepInternal(): Promise<void> {
    let failed = false;
    for (const record of this.pending.values()) {
      if (record.state === "reading") continue;
      if (record.state === "cleanup" || record.expiresAt <= this.now()) {
        // Claim synchronously; a duplicate resources/read cannot race expiry cleanup.
        record.state = "cleanup";
        try { await this.remove(record); }
        catch { failed = true; this.log("Temporary ZIP deletion failed; retained for retry."); }
      }
    }
    // Recover expired files left by a process crash. Only this exact namespace and filename grammar.
    const probe = `${this.now()}-00000000-0000-0000-0000-000000000000.zip`;
    await this.checkedPath(probe);
    const dir = await fs.opendir(this.directory!.path);
    let visited = 0;
    for await (const entry of dir) {
      if (++visited > 4096) throw new WorkspaceAccessError("ZIP cleanup scan limit exceeded.");
      const match = TEMP_NAME.exec(entry.name);
      if (!match || Number(match[1]) > this.now() || !entry.isFile() || entry.isSymbolicLink() ||
          [...this.pending.values()].some((record) => record.filename === entry.name)) continue;
      const absolute = await this.checkedPath(entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) {
        try { await fs.unlink(absolute); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed = true; }
      }
    }
    if (failed) throw new WorkspaceAccessError("Temporary ZIP cleanup incomplete; will retry.");
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    if (this.sweeping) await this.sweeping;
    for (const record of this.pending.values()) await this.remove(record);
  }
}

let defaultStore: ArchiveTempStore | undefined;
export function archiveTempStore(): ArchiveTempStore {
  return defaultStore ??= new ArchiveTempStore();
}

// Shared by every HTTP session; bounded expensive work without a new permission layer.
let active = 0;
export async function archiveOperation<T>(run: () => Promise<T>): Promise<T> {
  if (active >= 2) throw new WorkspaceAccessError("ARCHIVE_BUSY: at most two archive operations may run concurrently.");
  active++;
  try { return await run(); } finally { active--; }
}

export async function packageFolderResource(config: ServerConfig, args: AssetArgs, store = archiveTempStore(), signal?: AbortSignal) {
  const result = await packageFolder(config, args, signal);
  signal?.throwIfAborted();
  const link = await store.publish(config, result.bytes, result.scope, result.path);
  return {
    ok: true as const, scope: result.scope, path: result.path, filename: result.filename,
    bytes: result.bytes.length, mimeType: "application/zip" as const, transfer: "resource_link" as const,
    ...link, temporary: true, singleUse: true, cleanup: "after_resource_read_buffered_before_sdk_send",
    complete: result.complete, included: result.included, skipped: result.skipped,
    includedFiles: result.included.filter((entry) => entry.kind === "file").length,
    includedDirectories: result.included.filter((entry) => entry.kind === "directory").length,
    skippedEntries: result.skipped.length, sourceBytes: result.sourceBytes,
  };
}

export async function fetchArchive(config: ServerConfig, args: AssetArgs) {
  assertFileReturnScope(config, args.scope);
  const result = await openArchive(config, args, true);
  const uri = createAssetResourceUri(result.source.scope, result.source.scopeRelative, result.sha256).replace("workspace-asset:", "workspace-zip:");
  return { metadata: {
    ok: true as const, scope: result.source.scope, path: result.source.scopeRelative,
    filename: path.posix.basename(result.source.scopeRelative), bytes: result.bytes.length,
    mimeType: "application/zip" as const, sha256: result.sha256, transfer: "resource_link" as const,
    resourceUri: uri, temporary: false, singleUse: false, integrity: "all_entries_crc32_verified",
    entryCount: result.entries.length, expandedBytes: result.expandedBytes,
  }, bytes: result.bytes };
}

export async function readArchiveResource(config: ServerConfig, uri: string) {
  if (!uri.startsWith("workspace-zip:///")) throw new WorkspaceAccessError("Invalid archive resource URI.");
  const reference = parseAssetResourceUri(uri.replace("workspace-zip:", "workspace-asset:"));
  const result = await fetchArchive(config, reference);
  if (result.metadata.sha256 !== reference.sha256 || result.metadata.resourceUri !== uri) throw new WorkspaceAccessError("ZIP changed since the resource link was created.");
  return result.bytes;
}
