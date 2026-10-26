import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { inspectWritePath, inspectOperatorStatePath } from "./path-guard.js";
import { errorCode, WorkspaceWriteError } from "./write-errors.js";
import { assertWriteStateOutsideRoots, type WritePolicy } from "./write-policy.js";
import { readUtf8Snapshot } from "./text-snapshot.js";

export type WriteResult = Record<string, unknown> & { ok: boolean; operation_id: string };
export interface WriteReceipt {
  version: 1;
  operation_id: string;
  request_digest: string;
  policy_digest: string;
  status: "pending" | "complete";
  charged_bytes: number;
  result?: WriteResult;
}

/** Operator-owned storage. This is not a workspace or an MCP-readable file root. */
export class WriteJournal {
  private directory: string;
  private get operations(): string { return path.join(this.directory, "operations"); }
  private get auditPath(): string { return path.join(this.directory, "write-audit.jsonl"); }
  private get lockPath(): string { return path.join(this.directory, "writer.lock"); }

  constructor(private readonly policy: WritePolicy) {
    if (!policy.stateDirectory || !policy.document) throw new WorkspaceWriteError("WRITE_DISABLED");
    this.directory = policy.stateDirectory;
  }

  async lock(): Promise<() => Promise<void>> {
    await this.bindStateDirectory();
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    // A previously absent AppData folder can first acquire its virtualized
    // identity when created. Rebind before creating any lock, receipt or audit.
    await this.bindStateDirectory();
    await inspectWritePath(this.operations);
    await fs.mkdir(this.operations, { recursive: true, mode: 0o700 });
    await inspectWritePath(this.operations);
    let handle: FileHandle;
    try {
      handle = await fs.open(this.lockPath, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) === "EEXIST") throw new WorkspaceWriteError("WRITE_BUSY", "Writer lock is held. Retry the same operation ID; a crash lock requires operator inspection.");
      throw new WorkspaceWriteError("AUDIT_UNAVAILABLE");
    }
    try {
      await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, started_at: new Date().toISOString() }));
      await handle.sync();
    } catch {
      await handle.close();
      await fs.unlink(this.lockPath);
      throw new WorkspaceWriteError("AUDIT_UNAVAILABLE");
    }
    return async () => {
      await handle.close();
      await fs.unlink(this.lockPath);
    };
  }

  async read(operationId: string): Promise<WriteReceipt | undefined> {
    await this.bindStateDirectory();
    const filename = this.receiptPath(operationId);
    await inspectWritePath(filename);
    try {
      const snapshot = await readUtf8Snapshot(filename, 65536);
      const receipt = JSON.parse(snapshot.text) as WriteReceipt;
      if (receipt.version !== 1 || receipt.operation_id !== operationId ||
          !["pending", "complete"].includes(receipt.status) ||
          !/^[a-f0-9]{64}$/.test(receipt.request_digest) || !/^[a-f0-9]{64}$/.test(receipt.policy_digest) ||
          !Number.isSafeInteger(receipt.charged_bytes) || receipt.charged_bytes < 0 ||
          (receipt.status === "complete" && (!receipt.result || typeof receipt.result.ok !== "boolean" || receipt.result.operation_id !== operationId))) {
        throw new Error("Invalid receipt.");
      }
      return receipt;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw new WorkspaceWriteError("JOURNAL_INVALID");
    }
  }

  async ensureCapacity(chargedBytes: number): Promise<void> {
    const limits = this.policy.document!.limits;
    const entries = await fs.readdir(this.operations, { withFileTypes: true });
    if (entries.length >= limits.maxOperations) throw new WorkspaceWriteError("WRITE_QUOTA_EXCEEDED");
    let writtenBytes = 0;
    let stateBytes = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9-]{36}\.json$/.test(entry.name)) throw new WorkspaceWriteError("JOURNAL_INVALID");
      const receipt = await this.read(entry.name.slice(0, -5));
      if (!receipt) throw new WorkspaceWriteError("JOURNAL_INVALID");
      writtenBytes += receipt.charged_bytes;
      stateBytes += (await fs.stat(path.join(this.operations, entry.name))).size;
    }
    const audit = await inspectWritePath(this.auditPath);
    stateBytes += audit.stat?.size ?? 0;
    // Reserve bounded receipt and audit space before permitting another operation.
    if (writtenBytes + chargedBytes > limits.maxWrittenBytes || stateBytes + 65536 > limits.maxStateBytes) {
      throw new WorkspaceWriteError("WRITE_QUOTA_EXCEEDED");
    }
  }

  async begin(receipt: WriteReceipt): Promise<void> {
    await this.save(receipt, true);
  }

  async complete(receipt: WriteReceipt, result: WriteResult): Promise<void> {
    await this.save({ ...receipt, status: "complete", result }, false);
  }

  async audit(record: Record<string, unknown>): Promise<void> {
    await inspectWritePath(this.auditPath);
    const line = Buffer.from(`${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
    const handle = await fs.open(this.auditPath, "a+", 0o600);
    try {
      const stat = await handle.stat();
      if (stat.size + line.length > this.policy.document!.limits.maxStateBytes) throw new Error("Audit limit.");
      if (stat.size) {
        const last = Buffer.alloc(1);
        await handle.read(last, 0, 1, stat.size - 1);
        if (last[0] !== 10) throw new Error("Incomplete audit tail.");
      }
      await handle.writeFile(line);
      await handle.sync();
    } catch {
      throw new WorkspaceWriteError("AUDIT_UNAVAILABLE");
    } finally {
      await handle.close();
    }
  }

  private receiptPath(operationId: string): string {
    if (!/^[a-f0-9-]{36}$/.test(operationId)) throw new WorkspaceWriteError("VALIDATION_FAILED");
    return path.join(this.operations, `${operationId}.json`);
  }

  private async bindStateDirectory(): Promise<void> {
    assertWriteStateOutsideRoots(this.directory, this.policy.rootPaths?.values() ?? []);
    const physical = (await inspectOperatorStatePath(this.directory)).canonicalPath;
    assertWriteStateOutsideRoots(physical, this.policy.rootPaths?.values() ?? []);
    this.directory = physical;
    this.policy.stateDirectory = physical;
    if (!this.policy.protectedPaths.includes(physical)) this.policy.protectedPaths.push(physical);
  }

  private async save(receipt: WriteReceipt, create: boolean): Promise<void> {
    const target = this.receiptPath(receipt.operation_id);
    const temporary = path.join(this.directory, `receipt-${randomUUID()}.tmp`);
    await inspectWritePath(target);
    const data = JSON.stringify(receipt);
    if (Buffer.byteLength(data) > 65536) throw new WorkspaceWriteError("AUDIT_UNAVAILABLE");
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (create) await fs.link(temporary, target);
      else await fs.rename(temporary, target);
    } finally {
      await fs.unlink(temporary).catch((error: unknown) => {
        if (errorCode(error) !== "ENOENT") throw error;
      });
    }
  }
}
