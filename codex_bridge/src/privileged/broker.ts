import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  BrokerError, decisionSchema, deploymentPreflight, lookupSchema, operationIds, operationPolicy,
  parse, previewSchema, requestDigest, requestSchema, resultSchema, TTL_MS, type BrokerReceipt,
} from "./contract.js";
import { SyntheticReceiptStore } from "./receipt-store.js";

export interface SyntheticDelivery {
  readonly evidence: "SYNTHETIC_ONLY";
  readonly requestId: string;
  readonly approvalId: string;
  readonly bootId: string;
  readonly digest: string;
  readonly operationId: BrokerReceipt["operationId"];
  readonly targetId: "local_machine";
  readonly requiredPrivilege: "standard_user";
}
export type SyntheticWorker = (delivery: Readonly<SyntheticDelivery>) => Promise<unknown>;
const workerEnvelope = z.object({
  evidence: z.literal("SYNTHETIC_ONLY"), requestId: z.string().uuid(), approvalId: z.string().uuid(),
  bootId: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/), result: resultSchema,
}).strict();

/** Independent broker owner. No Controller, App Server, JobStore, shell or OS executor.
 * The only worker seam is explicitly synthetic; production cannot be enabled by env or MCP input.
 */
export class RemotePrivilegedBroker {
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;
  #closing?: Promise<void>;
  #lastTime = 0;
  readonly #bootId = randomUUID();

  private constructor(
    private readonly store?: SyntheticReceiptStore,
    private readonly worker?: SyntheticWorker,
    private readonly clock: () => number = Date.now,
    private readonly timeoutMs = 1_000,
  ) {}

  static notConfigured(): RemotePrivilegedBroker { return new RemotePrivilegedBroker(); }

  /** Offline fixture only. Never wired to HTTP/MCP or selected by runtime configuration.
   * The separate reviewer closure simulates a trusted UI principal, NOT proof of a human.
   */
  static async syntheticFixture(options: { directory: string; worker?: SyntheticWorker; clock?: () => number; timeoutMs?: number }) {
    if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 5_000)) throw new BrokerError("BROKER_INVALID_INPUT");
    const store = await SyntheticReceiptStore.open(options.directory);
    const broker = new RemotePrivilegedBroker(store, options.worker, options.clock, options.timeoutMs);
    try {
      for (const receipt of store.list()) {
        if (receipt.execution === "executing") {
          await store.append({ ...receipt, execution: "unknown", reason: "RESTART_UNCERTAIN" });
        } else if (["pending", "approved"].includes(receipt.approval) && receipt.execution === "not_executed") {
          await store.append({ ...receipt, approval: "expired", reason: "RESTART_EXPIRED" });
        }
      }
    } catch (error) { await store.close(); throw error; }
    return { broker, reviewer: Object.freeze({ decide: (input: unknown) => broker.#decide(input) }) };
  }

  status(input: unknown = {}) {
    parse(z.object({}).strict(), input);
    return {
      contract: "remote-privileged-broker-v1", ...deploymentPreflight(),
      dataPlane: this.store ? "SYNTHETIC_ONLY" : "disabled",
      humanApprovalUi: "NOT IMPLEMENTED", operations: operationIds.map(operationPolicy),
      remoteTools: ["codex_privileged_status", "codex_privileged_preview"],
    };
  }

  preview(input: unknown) {
    const { operationId } = parse(previewSchema, input);
    return { ...deploymentPreflight(), mode: "dry_run", policy: operationPolicy(operationId),
      createsRequest: false, approval: "not_requested", execution: "not_executed" };
  }

  request(input: unknown): Promise<BrokerReceipt> {
    return this.#serial(async () => {
      const request = parse(requestSchema, input);
      const store = this.#requireStore();
      const previous = store.get(request.requestId);
      if (previous) {
        if (previous.operationId !== request.operationId) throw new BrokerError("BROKER_REQUEST_CONFLICT");
        return this.#expire(previous); // Idempotent retry, never re-approve or re-deliver.
      }
      const createdAt = this.#now();
      const identity = { ...request, bootId: this.#bootId, approvalId: randomUUID(), createdAt, expiresAt: createdAt + TTL_MS };
      const receipt: BrokerReceipt = { ...identity, version: 1, evidence: "SYNTHETIC_ONLY", digest: requestDigest(identity),
        approval: "pending", execution: "not_executed", reason: "REQUESTED" };
      await store.append(receipt);
      return structuredClone(receipt);
    });
  }

  get(input: unknown): Promise<BrokerReceipt> {
    return this.#serial(async () => this.#lookup(input));
  }

  execute(input: unknown): Promise<BrokerReceipt> {
    return this.#serial(async () => {
      let receipt = await this.#lookup(input);
      if (receipt.execution !== "not_executed") return receipt; // Includes unknown; no automatic resend.
      if (receipt.approval !== "approved") throw new BrokerError("BROKER_NOT_APPROVED");
      if (receipt.bootId !== this.#bootId) throw new BrokerError("BROKER_STALE_APPROVAL");
      if (!this.worker) throw new BrokerError("BROKER_WORKER_NOT_CONFIGURED");
      const store = this.#requireStore();
      receipt = { ...receipt, execution: "executing", reason: "DELIVERY_STARTED" };
      await store.append(receipt); // Durable at-most-once intent BEFORE calling the worker.
      const delivery: SyntheticDelivery = Object.freeze({ evidence: "SYNTHETIC_ONLY", requestId: receipt.requestId,
        approvalId: receipt.approvalId, bootId: receipt.bootId, digest: receipt.digest, operationId: receipt.operationId,
        targetId: "local_machine", requiredPrivilege: "standard_user" });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Recheck after durable IO; an approval can expire while fsync is pending.
        if (this.#now() >= receipt.expiresAt) throw new BrokerError("BROKER_TTL_EXPIRED");
        const raw = await Promise.race([
          Promise.resolve().then(() => this.worker!(delivery)),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new BrokerError("BROKER_WORKER_TIMEOUT")), this.timeoutMs); }),
        ]);
        const result = workerEnvelope.safeParse(raw);
        if (!result.success || result.data.requestId !== receipt.requestId || result.data.approvalId !== receipt.approvalId
          || result.data.bootId !== receipt.bootId || result.data.digest !== receipt.digest || result.data.result.operationId !== receipt.operationId) {
          receipt = { ...receipt, execution: "unknown", reason: "RESULT_REJECTED" };
        } else {
          receipt = { ...receipt, execution: "executed", reason: "SYNTHETIC_COMPLETED", result: result.data.result };
        }
      } catch {
        receipt = { ...receipt, execution: "unknown", reason: "WORKER_UNCERTAIN" };
      } finally { if (timer) clearTimeout(timer); }
      await store.append(receipt);
      return structuredClone(receipt);
    });
  }

  close(): Promise<void> {
    return this.#closing ??= this.#serial(async () => { this.#closed = true; await this.store?.close(); });
  }

  #decide(input: unknown): Promise<BrokerReceipt> {
    return this.#serial(async () => {
      const decision = parse(decisionSchema, input);
      const receipt = await this.#lookup({ requestId: decision.requestId });
      if (receipt.approvalId !== decision.approvalId || receipt.digest !== decision.digest || receipt.bootId !== this.#bootId) throw new BrokerError("BROKER_APPROVAL_MISMATCH");
      const desired = decision.decision === "approve" ? "approved" : "denied";
      if (receipt.approval === desired) return receipt;
      if (receipt.approval !== "pending" || receipt.execution !== "not_executed") throw new BrokerError("BROKER_APPROVAL_CLOSED");
      const updated: BrokerReceipt = { ...receipt, approval: desired,
        reason: desired === "approved" ? "HUMAN_FIXTURE_APPROVED" : "HUMAN_FIXTURE_DENIED" };
      await this.#requireStore().append(updated);
      return updated;
    });
  }

  async #lookup(input: unknown): Promise<BrokerReceipt> {
    const { requestId } = parse(lookupSchema, input);
    const receipt = this.#requireStore().get(requestId);
    if (!receipt) throw new BrokerError("BROKER_REQUEST_UNKNOWN");
    return this.#expire(receipt);
  }

  async #expire(receipt: BrokerReceipt): Promise<BrokerReceipt> {
    if (["pending", "approved"].includes(receipt.approval) && receipt.execution === "not_executed" && this.#now() >= receipt.expiresAt) {
      receipt = { ...receipt, approval: "expired", reason: "TTL_EXPIRED" };
      await this.#requireStore().append(receipt);
    }
    return receipt;
  }

  #now(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < this.#lastTime || now < 0 || now > Number.MAX_SAFE_INTEGER - TTL_MS) throw new BrokerError("BROKER_CLOCK_UNTRUSTED");
    this.#lastTime = now;
    return now;
  }

  #requireStore(): SyntheticReceiptStore {
    if (!this.store) throw new BrokerError("BROKER_NOT_CONFIGURED");
    return this.store;
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#queue.then(() => {
      if (this.#closed) throw new BrokerError("BROKER_CLOSED");
      return operation();
    });
    this.#queue = pending.catch(() => undefined);
    return pending;
  }
}
