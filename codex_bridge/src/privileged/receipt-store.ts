import { open, mkdir, lstat, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { BrokerError, digest, MAX_REQUESTS, receiptSchema, type BrokerReceipt } from "./contract.js";

const MAX_BYTES = 8_388_608;
const MAX_ENTRIES = 10_000;
const entrySchema = z.object({ seq: z.number().int().positive(), previous: z.string(), receipt: receiptSchema, hash: z.string() }).strict();

/** Synthetic data-plane journal only. Not an elevated authority or a production ACL boundary.
 * Exclusive lifetime lock; incomplete/corrupt journals and abandoned locks fail closed.
 * A hash chain detects damage, NOT malicious rewriting by a filesystem writer.
 */
export class SyntheticReceiptStore {
  #records = new Map<string, BrokerReceipt>();
  #tail = "GENESIS";
  #sequence = 0;
  #bytes = 0;
  #faulted = false;
  #closed = false;
  private constructor(private readonly journal: FileHandle, private readonly lock: FileHandle, private readonly lockPath: string) {}

  static async open(directory: string): Promise<SyntheticReceiptStore> {
    let lock: FileHandle | undefined;
    let journal: FileHandle | undefined;
    const lockPath = join(directory, "synthetic-broker.lock");
    try {
      await mkdir(directory, { recursive: true });
      if ((await lstat(directory)).isSymbolicLink()) throw new BrokerError("BROKER_STORE_UNSAFE");
      lock = await open(lockPath, "wx");
      const journalPath = join(directory, "synthetic-receipts.jsonl");
      const existing = await lstat(journalPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new BrokerError("BROKER_STORE_UNSAFE");
      journal = await open(journalPath, "a+");
      if ((await journal.stat()).size > MAX_BYTES) throw new BrokerError("BROKER_STORE_CAPACITY");
      const content = await journal.readFile("utf8");
      const store = new SyntheticReceiptStore(journal, lock, lockPath);
      store.#bytes = Buffer.byteLength(content);
      if (content && !content.endsWith("\n")) throw new BrokerError("BROKER_STORE_CORRUPT");
      for (const line of content.split("\n").slice(0, -1)) {
        const entry = entrySchema.parse(JSON.parse(line));
        const { hash, ...unsigned } = entry;
        if (entry.seq !== store.#sequence + 1 || entry.previous !== store.#tail || hash !== digest(unsigned)) throw new BrokerError("BROKER_STORE_CORRUPT");
        store.validateTransition(entry.receipt);
        store.#records.set(entry.receipt.requestId, entry.receipt);
        store.#sequence = entry.seq;
        store.#tail = hash;
      }
      if (store.#sequence > MAX_ENTRIES || store.#records.size > MAX_REQUESTS) throw new BrokerError("BROKER_STORE_CAPACITY");
      return store;
    } catch (error) {
      await journal?.close();
      if (lock) { await lock.close(); await unlink(lockPath); }
      if (error instanceof BrokerError) throw error;
      throw new BrokerError((error as NodeJS.ErrnoException).code === "EEXIST" ? "BROKER_STORE_LOCKED" : "BROKER_STORE_UNAVAILABLE");
    }
  }

  list(): BrokerReceipt[] { this.requireReady(); return structuredClone([...this.#records.values()]); }
  get(id: string): BrokerReceipt | undefined { this.requireReady(); return structuredClone(this.#records.get(id)); }

  // The broker serializes every call, including reads, so no observer sees undurable state.
  async append(receipt: BrokerReceipt): Promise<void> {
    this.requireReady();
    const parsed = receiptSchema.safeParse(receipt);
    if (!parsed.success) throw new BrokerError("BROKER_INVALID_RECEIPT");
    this.validateTransition(parsed.data);
    const entry = { seq: this.#sequence + 1, previous: this.#tail, receipt: parsed.data };
    const hash = digest(entry);
    const line = JSON.stringify({ ...entry, hash }) + "\n";
    if (this.#sequence >= MAX_ENTRIES || this.#bytes + Buffer.byteLength(line) > MAX_BYTES
      || (!this.#records.has(receipt.requestId) && this.#records.size >= MAX_REQUESTS)) throw new BrokerError("BROKER_STORE_CAPACITY");
    try {
      await this.journal.writeFile(line, "utf8");
      await this.journal.sync();
    } catch {
      this.#faulted = true;
      throw new BrokerError("BROKER_PERSISTENCE_UNCERTAIN");
    }
    this.#records.set(receipt.requestId, parsed.data);
    this.#sequence++;
    this.#tail = hash;
    this.#bytes += Buffer.byteLength(line);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.journal.close();
    await this.lock.close();
    // A failed write retains its lock for explicit offline investigation, never automatic repair.
    if (!this.#faulted) await unlink(this.lockPath);
  }

  private requireReady(): void {
    if (this.#closed || this.#faulted) throw new BrokerError("BROKER_STORE_UNAVAILABLE");
  }

  private validateTransition(next: BrokerReceipt): void {
    const previous = this.#records.get(next.requestId);
    if (!previous) {
      if (next.approval !== "pending" || next.execution !== "not_executed" || next.reason !== "REQUESTED") throw new BrokerError("BROKER_STORE_CORRUPT");
      return;
    }
    if (previous.digest !== next.digest) throw new BrokerError("BROKER_REQUEST_CONFLICT");
    const allowed = previous.approval === "pending"
      ? next.execution === "not_executed" && ["approved", "denied", "expired"].includes(next.approval)
      : previous.approval === "approved" && previous.execution === "not_executed"
        ? (next.approval === "expired" && next.execution === "not_executed") || (next.approval === "approved" && next.execution === "executing")
        : previous.execution === "executing" && next.approval === "approved" && ["executed", "unknown"].includes(next.execution);
    if (!allowed) throw new BrokerError("BROKER_INVALID_TRANSITION");
  }
}
