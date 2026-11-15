import { createHash, randomUUID } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { ServerConfig } from "./config.js";
import { resolveArchiveSource, digest } from "./archives.js";
import { assertFileReturnScope } from "./file-transfer.js";
import { inspectWritePath } from "./path-guard.js";
import { addBytes, captureFolder, fail, identity, sameIdentity, sourceBytes, StreamingZip64, TRANSFER_LIMITS, writeAll, type CaptureContext } from "./transfer-streams.js";
import { validateTransferZip } from "./transfer-zip-validation.js";
import { initializeBudget, readBudget, reserveBudget } from "./transfer-budget.js";

const ID = /^\d{13}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const OWNED = /^(\d{13}-[a-f0-9-]{36})\.(state\.json|state\.tmp|entries|identities|central|parts|budget|part-\d{6})$/;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const bytes = z.number().int().min(0).max(TRANSFER_LIMITS.bytes);
const stateSchema = z.object({
  version: z.literal(1), taskId: z.string().regex(ID), scope: z.string().max(32), path: z.string().max(512),
  kind: z.enum(["folder", "file", "zip"]), filename: z.string().max(600), binding: sha,
  state: z.enum(["running", "ready", "failed", "canceled", "completed", "expired"]),
  createdAt: z.number(), expiresAt: z.number(), chunkBytes: z.number().int().positive().max(12 * 1024 * 1024),
  sourceBytes: bytes, archiveBytes: bytes, transmittedBytes: bytes, expandedBytes: bytes.nullable(),
  chunkCount: z.number().int().min(0).max(100_000), entryCount: z.number().int().min(0).max(TRANSFER_LIMITS.entries),
  skippedEntries: z.number().int().min(0).max(TRANSFER_LIMITS.entries),
  archiveSha256: sha.nullable(), complete: z.boolean(), cleaned: z.boolean(), error: z.string().max(1000).nullable(),
}).strict();
export type TransferState = z.infer<typeof stateSchema>;
export interface TransferStart { scope: string; path: string; kind: "folder" | "file" | "zip"; chunkBytes?: number }
interface Job { data: TransferState; controller: AbortController; work?: Promise<void>; cleanup?: Promise<void> }
export interface TransferOptions { directory?: string; now?: () => number; ttlMs?: number; workMs?: number; sweepMs?: number; log?: (message: string) => void }
const PART_RECORD = 256;
const PART_SCHEMA = z.object({ index: z.number().int().nonnegative(), offset: bytes, length: bytes, sha256: sha }).strict();
type Part = z.infer<typeof PART_SCHEMA>;
function binding(config: ServerConfig) {
  return digest(Buffer.from(JSON.stringify({
    roots: [...config.roots].map(([id, r]) => [id, r.path, [...r.denyDirs].sort()]).sort(),
    scopes: [...config.assetScopes].sort(), returns: [...config.fileReturnScopeIds].sort(), deny: [...config.denyExtensions].sort(),
  })));
}
function partName(index: number) { return `part-${String(index).padStart(6, "0")}`; }

/** In-process archive extension, shared by MCP sessions. No new listener/lifecycle owner.
 * A fixed server-owned staging namespace is locked across processes. Ready jobs survive
 * restart; unfinished jobs fail closed. Reads reserve durable budget BEFORE SDK delivery. */
export class SegmentedTransferStore {
  private jobs = new Map<string, Job>();
  private orphans = new Set<string>();
  private directory?: { path: string; stat: Stats };
  private initializing?: Promise<void>;
  private lock?: FileHandle;
  private timer?: ReturnType<typeof setInterval>;
  private serial: Promise<unknown> = Promise.resolve();
  private stagingBytes = 0;
  private closed = false;
  private sweeping?: Promise<void>;
  constructor(private options: TransferOptions = {}) {}
  private now() { return this.options.now?.() ?? Date.now(); }
  private log(message: string) { (this.options.log ?? console.error)(message); }
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const operation = this.serial.then(run); this.serial = operation.catch(() => {}); return operation;
  }
  private async file(id: string, suffix: string) {
    if (!ID.test(id) || !OWNED.test(`${id}.${suffix}`)) fail("Invalid transfer staging name.");
    await this.checkDirectory();
    return path.join(this.directory!.path, `${id}.${suffix}`);
  }
  private async checkDirectory() {
    const base = this.directory!;
    const checked = await inspectWritePath(base.path);
    if (!checked.stat?.isDirectory() || checked.stat.dev !== base.stat.dev || checked.stat.ino !== base.stat.ino) fail("Transfer staging directory identity changed.");
  }
  private async open(id: string, suffix: string, create = false, writable = false) {
    const absolute = await this.file(id, suffix);
    if (!create) {
      const checked = await inspectWritePath(absolute);
      if (!checked.stat?.isFile() || checked.stat.nlink !== 1) fail("Unsafe transfer staging file.");
      const handle = await fs.open(absolute, writable ? "r+" : "r");
      if (!sameIdentity(identity(checked.stat), identity(await handle.stat()))) { await handle.close(); fail("Transfer staging file identity changed."); }
      return handle;
    }
    return fs.open(absolute, "wx+", 0o600);
  }
  private async remove(id: string, suffix: string) {
    const absolute = await this.file(id, suffix);
    const checked = await inspectWritePath(absolute);
    if (!checked.stat) return;
    if (!checked.stat.isFile() || checked.stat.nlink !== 1) fail("Unsafe transfer staging cleanup refused.");
    await fs.unlink(absolute);
    if (suffix.startsWith("part-")) this.stagingBytes = Math.max(0, this.stagingBytes - checked.stat.size);
  }
  private async save(job: Job) {
    // Callers serialize saves. The worker only saves at publication/failure, through exclusive().
    const data = Buffer.from(JSON.stringify(stateSchema.parse(job.data)));
    await this.remove(job.data.taskId, "state.tmp");
    const handle = await this.open(job.data.taskId, "state.tmp", true);
    try { await writeAll(handle, data); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(await this.file(job.data.taskId, "state.tmp"), await this.file(job.data.taskId, "state.json"));
  }
  async initialize(): Promise<void> {
    if (this.closed) fail("Transfer store closed.");
    this.initializing ??= this.initializeInternal().catch(async (error) => {
      // A failed acquisition/recovery is not a permanent capability decision. A later
      // real invocation may retry the SAME entry point after the owner/IO condition changes.
      // Never retain partial recovery state or a lock acquired by this failed attempt.
      try { await this.releaseLock(); }
      finally {
        clearInterval(this.timer); this.timer = undefined;
        this.jobs.clear(); this.orphans.clear(); this.stagingBytes = 0; this.directory = undefined;
        this.initializing = undefined;
      }
      throw error;
    });
    return this.initializing;
  }
  private async initializeInternal() {
    const directory = this.options.directory ?? path.join(await fs.realpath(os.tmpdir()), "project-workspace-transfer-v1");
    await fs.mkdir(directory, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
    const checked = await inspectWritePath(directory);
    if (!checked.stat?.isDirectory()) fail("Unsafe transfer staging directory.");
    this.directory = { path: checked.canonicalPath, stat: checked.stat };
    const lockPath = path.join(this.directory.path, "owner.lock");
    try { this.lock = await fs.open(lockPath, "wx+", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const inspected = await inspectWritePath(lockPath);
      if (!inspected.stat?.isFile() || inspected.stat.nlink !== 1 || inspected.stat.size > 256) fail("Unsafe transfer owner lock.");
      const owner = JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid: number };
      if (!Number.isInteger(owner.pid) || owner.pid < 1) fail("Invalid transfer owner lock.");
      let dead = false;
      try { process.kill(owner.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") dead = true; else throw e; }
      if (!dead) fail("TRANSFER_BUSY: staging belongs to a live process.");
      const again = await inspectWritePath(lockPath);
      if (!again.stat || !sameIdentity(identity(inspected.stat), identity(again.stat))) fail("Transfer owner lock changed.");
      await fs.unlink(lockPath);
      this.lock = await fs.open(lockPath, "wx+", 0o600);
    }
    await writeAll(this.lock, Buffer.from(JSON.stringify({ pid: process.pid, nonce: randomUUID() }))); await this.lock.sync();
    try {
      const dir = await fs.opendir(this.directory.path);
      let scanned = 0;
      for await (const entry of dir) {
        if (++scanned > 200_000) fail("Transfer recovery scan limit exceeded.");
        const match = OWNED.exec(entry.name);
        if (!match || !ID.test(match[1])) continue;
        const [_, id, suffix] = match;
        this.orphans.add(id);
        if (this.orphans.size > TRANSFER_LIMITS.jobs) fail("Transfer recovery job capacity exceeded.");
        const inspected = await inspectWritePath(await this.file(id, suffix));
        if (!inspected.stat?.isFile() || inspected.stat.nlink !== 1) fail("Unsafe transfer recovery file.");
        if (suffix.startsWith("part-")) this.stagingBytes = addBytes(this.stagingBytes, inspected.stat.size);
        if (suffix !== "state.json") continue;
        if (inspected.stat.size > 8192) { this.log("Invalid transfer state retained for expiry cleanup."); continue; }
        const handle = await this.open(id, suffix);
        try {
          const data = stateSchema.parse(JSON.parse(await handle.readFile("utf8")));
          if (data.taskId !== id || data.expiresAt !== Number(id.slice(0, 13))) fail("Transfer state identity mismatch.");
          if (data.state === "ready" && (!data.archiveSha256 || data.chunkCount !== Math.max(1, Math.ceil(data.archiveBytes / data.chunkBytes)) ||
              data.complete !== (data.skippedEntries === 0))) fail("Transfer ready state inconsistent.");
          if (data.state === "ready") {
            const budget = await this.open(id, "budget");
            try { data.transmittedBytes = Math.max(data.transmittedBytes, (await readBudget(budget, id)).total); }
            finally { await budget.close(); }
          }
          this.jobs.set(id, { data, controller: new AbortController() });
        } catch { this.log("Invalid transfer state retained for expiry cleanup; no downloads permitted.");
        } finally { await handle.close(); }
      }
      for (const id of this.jobs.keys()) this.orphans.delete(id);
      for (const job of this.jobs.values()) {
        if (job.data.state === "running") { job.data.state = "failed"; job.data.error = "INTERRUPTED: restart; start a new capture."; await this.save(job); }
      }
      this.timer = setInterval(() => { void this.sweep().catch(() => this.log("Transfer cleanup failed; files retained, capacity remains reserved.")); }, this.options.sweepMs ?? 30_000);
      this.timer.unref();
      for (const job of this.jobs.values()) if (job.data.state !== "ready" || job.data.expiresAt <= this.now()) this.queueCleanup(job);
      // Do not await cleanup here: it may enqueue state persistence behind a status call.
      void this.sweep().catch(() => this.log("Transfer recovery cleanup incomplete; retry retained."));
    } catch (error) { await this.releaseLock(); throw error; }
  }
  private async authorized(config: ServerConfig, id: string) {
    await this.initialize();
    const job = this.jobs.get(id); if (!job) fail("Unknown transfer.");
    assertFileReturnScope(config, job.data.scope);
    if (binding(config) !== job.data.binding) fail("Transfer scope or deny policy changed; transfer unavailable.");
    return job;
  }
  private view(job: Job) {
    return { ok: true as const, ...job.data, integrity: job.data.state === "ready" ? "captured_bytes_sha256_verified" : "not_available",
      payloadLimitBytes: TRANSFER_LIMITS.bytes, inputLimitBytes: TRANSFER_LIMITS.inputBytes,
      remainingPayloadBytes: TRANSFER_LIMITS.bytes - job.data.transmittedBytes,
      cleanupPending: !job.data.cleaned && !["running", "ready"].includes(job.data.state),
      downloadAcknowledged: false, retryable: job.data.state === "ready" && job.data.expiresAt > this.now(),
    };
  }
  async start(config: ServerConfig, args: TransferStart) {
    await this.initialize();
    return this.exclusive(async () => {
      assertFileReturnScope(config, args.scope);
      if (!["folder", "file", "zip"].includes(args.kind)) fail("Invalid transfer kind.");
      const chunkBytes = args.chunkBytes ?? Math.min(TRANSFER_LIMITS.chunkBytes, config.maxFetchFileBytes);
      if (!Number.isInteger(chunkBytes) || chunkBytes < TRANSFER_LIMITS.minChunkBytes || chunkBytes > Math.min(config.maxFetchFileBytes, 12 * 1024 * 1024)) fail("Invalid chunkBytes; use 1 MiB through min(maxFetchFileBytes, 12 MiB).");
      if (this.jobs.size + this.orphans.size >= TRANSFER_LIMITS.jobs || [...this.jobs.values()].some((job) => !!job.work)) fail("TRANSFER_BUSY: one capture at a time, at most four retained jobs.");
      const source = await resolveArchiveSource(config, args, args.kind === "folder" ? "directory" : args.kind);
      const expiresAt = this.now() + Math.min(this.options.ttlMs ?? TRANSFER_LIMITS.ttlMs, 14 * 24 * 60 * 60_000);
      const taskId = `${expiresAt}-${randomUUID()}`;
      const job: Job = { controller: new AbortController(), data: {
        version: 1, taskId, scope: source.scope, path: source.scopeRelative, kind: args.kind,
        filename: `${source.scopeRelative === "." ? source.scope : path.posix.basename(source.scopeRelative)}${args.kind === "folder" ? ".zip" : ""}`,
        binding: binding(config), state: "running", createdAt: this.now(), expiresAt, chunkBytes,
        sourceBytes: 0, archiveBytes: 0, transmittedBytes: 0, chunkCount: 0, entryCount: 0, skippedEntries: 0,
        expandedBytes: null, archiveSha256: null, complete: false, cleaned: false, error: null,
      } };
      this.orphans.add(taskId); // Reserve capacity even if publication fails partway through.
      const budget = await this.open(taskId, "budget", true);
      try { await initializeBudget(budget, taskId); } finally { await budget.close(); }
      await this.save(job); this.jobs.set(taskId, job); this.orphans.delete(taskId);
      const initial = this.view(job);
      job.work = this.capture(config, job).finally(() => { job.work = undefined; });
      return initial;
    });
  }
  private async capture(config: ServerConfig, job: Job) {
    const data = job.data, id = data.taskId, hash = createHash("sha256");
    const handles: FileHandle[] = [];
    let part: FileHandle | undefined, partSize = 0, partHash = createHash("sha256"), partOffset = 0;
    const check = () => {
      job.controller.signal.throwIfAborted();
      if (this.now() >= data.expiresAt || this.now() - data.createdAt > (this.options.workMs ?? TRANSFER_LIMITS.workMs)) fail("TRANSFER_TIMEOUT: capture deadline exceeded.");
    };
    try {
      const entries = await this.open(id, "entries", true); handles.push(entries);
      const identities = await this.open(id, "identities", true); handles.push(identities);
      const parts = await this.open(id, "parts", true); handles.push(parts);
      const ctx: CaptureContext = {
        config, signal: job.controller.signal, check,
        input: (bytes) => { data.sourceBytes = addBytes(data.sourceBytes, bytes); },
        record: async (value) => {
          if (++data.entryCount > TRANSFER_LIMITS.entries) fail("TRANSFER_LIMIT: manifest entry count.");
          if (value.disposition === "skipped") data.skippedEntries++;
          await writeAll(entries, Buffer.from(JSON.stringify(value) + "\n"));
        },
        remember: async (value) => { await writeAll(identities, Buffer.from(JSON.stringify(value) + "\n")); },
      };
      const seal = async () => {
        if (!part) return;
        await part.sync(); await part.close(); part = undefined;
        const record: Part = { index: data.chunkCount, offset: partOffset, length: partSize, sha256: partHash.digest("hex") };
        const encoded = Buffer.from(JSON.stringify(record));
        if (encoded.length >= PART_RECORD) fail("Part metadata overflow.");
        const padded = Buffer.alloc(PART_RECORD, 32); encoded.copy(padded); await writeAll(parts, padded);
        data.chunkCount++; partOffset += partSize; partSize = 0; partHash = createHash("sha256");
      };
      const output = async (bytes: Buffer) => {
        check(); addBytes(data.archiveBytes, bytes.length); addBytes(this.stagingBytes, bytes.length);
        for (let at = 0; at < bytes.length;) {
          check();
          if (!part) {
            const disk = await fs.statfs(this.directory!.path);
            if (disk.bavail * disk.bsize < data.chunkBytes + 16 * 1024 * 1024) fail("TRANSFER_DISK_FULL: insufficient staging space.");
            part = await this.open(id, partName(data.chunkCount), true);
          }
          const size = Math.min(data.chunkBytes - partSize, bytes.length - at), piece = bytes.subarray(at, at + size);
          // Reserve before write: failures may leave a short file. Recovery reconciles actual bytes.
          this.stagingBytes = addBytes(this.stagingBytes, size);
          try { await writeAll(part, piece); }
          catch (error) {
            const actual = await part.stat().catch(() => undefined);
            if (actual) this.stagingBytes -= Math.max(0, size - Math.max(0, actual.size - partSize));
            throw error;
          }
          hash.update(piece); partHash.update(piece);
          data.archiveBytes = addBytes(data.archiveBytes, size); partSize += size; at += size;
          if (partSize === data.chunkBytes) await seal();
        }
      };
      const args = { scope: data.scope, path: data.path };
      if (data.kind === "folder") {
        const central = await this.open(id, "central", true); handles.push(central);
        await captureFolder(ctx, args, new StreamingZip64(central, output));
      } else {
        const validated = data.kind === "zip" ? await validateTransferZip(ctx, args) : undefined;
        data.expandedBytes = validated?.expandedBytes ?? null;
        for await (const bytes of sourceBytes(ctx, args, data.kind, validated?.identity)) await output(bytes);
      }
      await seal();
      // Empty raw files still have an independently downloadable, hash-bound zero-byte part.
      if (!data.chunkCount) { part = await this.open(id, partName(0), true); await seal(); }
      for (const handle of handles) await handle.sync();
      for await (const line of this.lines(id, "identities")) {
        check(); const entry = JSON.parse(line);
        const resolved = await resolveArchiveSource(config, entry.args, entry.kind);
        if (!sameIdentity(entry.identity, identity(resolved.stat))) fail("SOURCE_CHANGED: final tree check.");
      }
      check();
      await this.exclusive(async () => {
        check(); data.archiveSha256 = hash.digest("hex"); data.complete = data.skippedEntries === 0;
        data.state = "ready";
        try { await this.save(job); } catch (error) { data.state = "failed"; throw error; }
      });
    } catch (error) {
      await this.exclusive(async () => {
        if (data.state === "running" || data.state === "ready") data.state = "failed";
        data.complete = false; data.archiveSha256 = null;
        // OS messages can include local paths; only controlled access errors are exposed.
        data.error = error instanceof Error && error.name === "WorkspaceAccessError" ? error.message.slice(0, 1000) : "TRANSFER_FAILED: capture interrupted or I/O failed.";
        await this.save(job);
      }).catch(() => this.log("Transfer failure state could not be persisted; not published."));
    } finally {
      await part?.close().catch(() => {});
      for (const handle of handles) await handle.close().catch(() => {});
      if (data.state !== "ready") this.queueCleanup(job);
      else {
        try { await this.remove(id, "central"); await this.remove(id, "identities"); }
        catch { this.log("Transfer capture metadata cleanup deferred until job cleanup."); }
      }
    }
  }
  private async *lines(id: string, suffix: "entries" | "identities") {
    const handle = await this.open(id, suffix);
    const stream = handle.createReadStream({ autoClose: false, highWaterMark: TRANSFER_LIMITS.ioBytes });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try { for await (const line of lines) { if (line.length > 4096) fail("Transfer metadata record too large."); yield line; } }
    finally { lines.close(); stream.destroy(); await handle.close(); }
  }
  async status(config: ServerConfig, id: string) {
    return this.exclusive(async () => {
      const job = await this.authorized(config, id);
      if (job.data.expiresAt <= this.now() && !["expired", "completed", "canceled", "failed"].includes(job.data.state)) {
        job.data.state = "expired"; job.controller.abort(); await this.save(job); if (!job.work) this.queueCleanup(job);
      }
      return this.view(job);
    });
  }
  private async part(job: Job, index: number): Promise<Part> {
    if (!Number.isInteger(index) || index < 0 || index >= job.data.chunkCount) fail("Invalid transfer part index.");
    const handle = await this.open(job.data.taskId, "parts");
    try {
      const buffer = Buffer.alloc(PART_RECORD);
      const read = await handle.read(buffer, 0, PART_RECORD, index * PART_RECORD);
      if (read.bytesRead !== PART_RECORD) fail("Transfer part metadata truncated.");
      const part = PART_SCHEMA.parse(JSON.parse(buffer.toString("utf8")));
      const expectedLength = index === job.data.chunkCount - 1 ? job.data.archiveBytes - index * job.data.chunkBytes : job.data.chunkBytes;
      if (part.index !== index || part.offset !== index * job.data.chunkBytes || part.length !== expectedLength || part.length > job.data.chunkBytes) fail("Transfer part metadata mismatch.");
      return part;
    } finally { await handle.close(); }
  }
  private link(job: Job, part: Part) {
    return { ...part, filename: `${job.data.filename}.part-${String(part.index + 1).padStart(6, "0")}`,
      resourceUri: `workspace-transfer:///${job.data.taskId}/${part.index}?sha256=${part.sha256}`,
      mimeType: "application/octet-stream" as const };
  }
  private ready(job: Job) {
    if (job.data.state !== "ready" || job.data.expiresAt <= this.now()) fail("Transfer is not ready or has expired.");
  }
  async page(config: ServerConfig, id: string, collection: "parts" | "entries", offset = 0, limit = 20) {
    return this.exclusive(async () => {
      const job = await this.authorized(config, id); this.ready(job);
      if (!["parts", "entries"].includes(collection) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > TRANSFER_LIMITS.page) fail("Invalid manifest page.");
      const total = collection === "parts" ? job.data.chunkCount : job.data.entryCount;
      if (offset > total) fail("Manifest offset exceeds count.");
      const records: Record<string, unknown>[] = [];
      if (collection === "parts") {
        for (let index = offset; index < Math.min(total, offset + limit); index++) records.push(this.link(job, await this.part(job, index)));
      } else {
        let index = 0;
        for await (const line of this.lines(id, "entries")) {
          if (index++ >= offset) records.push(JSON.parse(line));
          if (records.length === limit) break;
        }
        if (records.length !== Math.min(limit, total - offset)) fail("Transfer entry manifest truncated.");
      }
      return { ...this.view(job), collection, offset, total, records, nextOffset: offset + records.length < total ? offset + records.length : null };
    });
  }
  async read(config: ServerConfig, uri: string): Promise<Buffer> {
    return this.exclusive(async () => {
      const match = /^workspace-transfer:\/\/\/(\d{13}-[a-f0-9-]{36})\/(0|[1-9]\d*)\?sha256=([a-f0-9]{64})$/.exec(uri);
      if (!match) fail("Invalid transfer URI.");
      const job = await this.authorized(config, match[1]); this.ready(job);
      const part = await this.part(job, Number(match[2]));
      if (this.link(job, part).resourceUri !== uri || part.length > config.maxFetchFileBytes) fail("Transfer URI or fetch cap mismatch.");
      const charged = addBytes(job.data.transmittedBytes, part.length);
      const handle = await this.open(job.data.taskId, partName(part.index));
      let buffer: Buffer;
      try {
        const stat = await handle.stat();
        if (stat.size !== part.length) fail("Transfer part size mismatch.");
        buffer = Buffer.alloc(part.length);
        let at = 0;
        while (at < buffer.length) {
          const read = await handle.read(buffer, at, buffer.length - at, at);
          if (!read.bytesRead) fail("Transfer part truncated."); at += read.bytesRead;
        }
        if (!sameIdentity(identity(stat), identity(await handle.stat())) || digest(buffer) !== part.sha256) fail("Transfer part SHA-256 mismatch.");
      } finally { await handle.close(); }
      this.ready(job);
      job.data.transmittedBytes = charged;
      // Durably charge before handoff. SDK failures/prefetch/crash never refund uncertain delivery.
      const budget = await this.open(job.data.taskId, "budget", false, true);
      try { await reserveBudget(budget, job.data.taskId, charged); } finally { await budget.close(); }
      await this.save(job);
      return buffer;
    });
  }
  async finish(config: ServerConfig, id: string, action: "cancel" | "complete" | "cleanup", archiveSha256?: string) {
    return this.exclusive(async () => {
      const job = await this.authorized(config, id);
      if (action === "complete") {
        this.ready(job);
        if (archiveSha256 !== job.data.archiveSha256) fail("Completion requires the verified archive SHA-256.");
        job.data.state = "completed";
      } else if (action === "cancel" || action === "cleanup") job.data.state = "canceled";
      else fail("Invalid transfer cleanup action.");
      job.controller.abort(); await this.save(job);
      if (!job.work) this.queueCleanup(job);
      return this.view(job);
    });
  }
  private queueCleanup(job: Job) {
    if (job.cleanup || job.data.cleaned) return;
    job.cleanup = (async () => {
      const dir = await fs.opendir(this.directory!.path);
      for await (const entry of dir) {
        const match = OWNED.exec(entry.name);
        if (match?.[1] === job.data.taskId && !match[2].startsWith("state.")) await this.remove(match[1], match[2]);
      }
      await this.exclusive(async () => { job.data.cleaned = true; await this.save(job); });
    })().catch(() => this.log("Transfer cleanup incomplete; retry retained.")).finally(() => { job.cleanup = undefined; });
  }
  async sweep() {
    if (!this.directory || this.closed) return;
    if (this.sweeping) return this.sweeping;
    this.sweeping = this.sweepInternal().finally(() => { this.sweeping = undefined; });
    return this.sweeping;
  }
  private async sweepInternal() {
    try {
      await this.exclusive(async () => {
        for (const job of this.jobs.values()) {
          if (job.data.expiresAt <= this.now()) {
            job.data.state = "expired"; job.controller.abort(); await this.save(job);
            if (!job.work) this.queueCleanup(job);
          } else if (!["ready", "running"].includes(job.data.state) && !job.work) this.queueCleanup(job);
          if (job.data.cleaned && !job.work && !job.cleanup) {
            await this.remove(job.data.taskId, "state.json"); await this.remove(job.data.taskId, "state.tmp"); this.jobs.delete(job.data.taskId);
          }
        }
      });
      // Orphan files from a crash before state publication: exact namespace, expired ID only.
      const dir = await fs.opendir(this.directory!.path);
      let scanned = 0;
      for await (const entry of dir) {
        if (++scanned > 200_000) fail("Transfer cleanup scan limit exceeded.");
        const match = OWNED.exec(entry.name);
        if (match && ID.test(match[1]) && !this.jobs.has(match[1]) && Number(match[1].slice(0, 13)) <= this.now()) await this.remove(match[1], match[2]);
      }
      for (const id of this.orphans) if (Number(id.slice(0, 13)) <= this.now()) this.orphans.delete(id);
    } finally { /* The public single-flight promise also covers callers awaiting cleanup. */ }
  }
  async waitForIdle() { await Promise.all([...this.jobs.values()].map((job) => job.work)); await Promise.all([...this.jobs.values()].map((job) => job.cleanup)); }
  private async releaseLock() {
    if (!this.lock) return;
    const lockPath = path.join(this.directory!.path, "owner.lock");
    const stat = await this.lock.stat(); await this.lock.close(); this.lock = undefined;
    const inspected = await inspectWritePath(lockPath);
    if (inspected.stat?.dev === stat.dev && inspected.stat.ino === stat.ino && inspected.stat.nlink === 1) await fs.unlink(lockPath);
  }
  async close() {
    clearInterval(this.timer);
    if (this.sweeping) await this.sweeping;
    for (const job of this.jobs.values()) if (job.work) job.controller.abort();
    await this.waitForIdle(); await this.serial;
    this.closed = true; await this.releaseLock();
  }
}

let shared: SegmentedTransferStore | undefined;
function duration(name: string, fallback: number) {
  const raw = process.env[name]; if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 60_000 || value > 14 * 24 * 60 * 60_000) fail(`${name} must be milliseconds between one minute and 14 days.`);
  return value;
}
export function segmentedTransfers() {
  return shared ??= new SegmentedTransferStore({
    workMs: duration("WORKSPACE_MCP_TRANSFER_WORK_MS", TRANSFER_LIMITS.workMs),
    ttlMs: duration("WORKSPACE_MCP_TRANSFER_TTL_MS", TRANSFER_LIMITS.ttlMs),
  });
}
