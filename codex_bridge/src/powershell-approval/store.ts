import { open, mkdir, lstat, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { closeResources } from "../close-resources.js";
import { observedCurrentProcessIdentity } from "../process-identity.js";
import { verifyNativeHostTransition } from "./host-transport.js";
import { normalOutputSchema, validateNormalOutput, pageNormalOutput, type NormalOutput } from "./normal-output.js";
import { REVIEW_KIND, REVIEW_TTL_MS, reviewInputSchema, reviewRequestSchema, reviewReceiptSchema,
  reviewReasons, validateReviewOrigin, validateReviewTransition, type ReviewReceipt } from "./review-contract.js";
import { sha256 } from "./contract.js";
import type { SavedFailureEvidence } from "./failure-evidence.js";
import { ApprovalError, digest, MAX_REQUESTS, parse, productionBindingOf, productionRequestSchema, RECEIPT_TTL_MS, hostPeerEvidenceSchema, productionConsumptionSchema, productionReceiptSchema, productionJournalReceiptSchema, productionResultSchema, receiptSchema,
  transitions, TTL_MS, validateProductionJournalTransition, type ProductionReceipt, type ProductionJournalReceipt, type Receipt, type TrustedProductionHost } from "./contract.js";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 1000;
const entrySchema = z.object({ seq: z.number().int().positive(), previous: z.string(),
  receipt: z.union([receiptSchema, productionJournalReceiptSchema, reviewReceiptSchema]), hash: z.string() }).strict();
type JournalReceipt = Receipt | ProductionJournalReceipt | ReviewReceipt;
const isProduction = (r: JournalReceipt): r is ProductionJournalReceipt => r.request.evidence === "PRODUCTION";
const isReview = (r: JournalReceipt): r is ReviewReceipt => r.request.evidence === REVIEW_KIND;
const isOffline = (r: JournalReceipt): r is Receipt => r.request.evidence === "OFFLINE_ONLY";
// Deliberately no setter, factory parameter, environment flag or caller-supplied verifier.
const productionHost: TrustedProductionHost = Object.freeze({
  async verifyTransition(receipt: ProductionReceipt, evidence: unknown): Promise<void> {
    verifyNativeHostTransition(receipt, evidence);
  },
});

function validateJournalReceipt(records: ReadonlyMap<string, JournalReceipt>, next: JournalReceipt): void {
  const prior = records.get(next.request.requestId);
  if (prior && prior.request.evidence !== next.request.evidence) throw new ApprovalError("CONTRACT_MISMATCH");
  if (!prior && [...records.values()].some(r => (isProduction(next) || isProduction(r) || isReview(next) || isReview(r))
    && (r.request.idempotencyKey === next.request.idempotencyKey || r.request.receiptId === next.request.receiptId))) throw new ApprovalError("IDENTITY_REPLAY");
  if (isReview(next)) {
    validateReviewTransition(prior as ReviewReceipt | undefined, next);
    return;
  }
  if (isProduction(next)) {
    validateProductionJournalTransition(prior as ProductionJournalReceipt | undefined, next);
    if ("origin" in next.request && next.request.sourceReview) {
      const link = next.request.sourceReview;
      const source = records.get(link.requestId);
      if (!source || !isReview(source) || source.digest !== link.digest || link.requestId === next.request.requestId)
        throw new ApprovalError("HOST_REQUEST_MISMATCH");
      for (const field of ["origin", "projectId", "executionMode", "target", "cwd", "scriptSnapshot", "scriptSha256",
        "scriptEncoding", "args", "risk", "sideEffects"] as const) {
        if (digest(source.request[field]) !== digest(next.request[field])) throw new ApprovalError("HOST_REQUEST_MISMATCH");
      }
      if (next.request.createdAt < source.request.createdAt || next.request.expiresAt > source.request.expiresAt
        || (next.request.origin === "CODEX_DERIVED" && (next.request.jobId !== source.request.jobId
          || next.request.turnId !== source.request.turnId || next.request.failureEvidence.itemId !== source.request.sourceFailure?.itemId
          || next.request.failureEvidence.threadId !== source.request.sourceFailure?.threadId))) throw new ApprovalError("HOST_REQUEST_MISMATCH");
      if ([...records.values()].filter(isProduction).some(r => r.request.requestId !== next.request.requestId
        && "origin" in r.request && r.request.sourceReview?.requestId === link.requestId)) throw new ApprovalError("IDENTITY_REPLAY");
    }
    const addedEvidence = (r: ProductionJournalReceipt) => [r.request.admission, r.grant?.approval, r.consumption?.executor, r.result?.executor, r.denial]
      .filter(e => e !== undefined).map(e => e.observationId);
    const nextEvidence = addedEvidence(next);
    if (new Set(nextEvidence).size !== nextEvidence.length) throw new ApprovalError("EVIDENCE_REPLAY");
    for (const r of records.values()) {
      if (!isProduction(r) || r.request.requestId === next.request.requestId) continue;
      if (r.request.nonce === next.request.nonce || r.request.approvalIdentity.ceremonyId === next.request.approvalIdentity.ceremonyId
        || (next.grant && r.grant?.grantId === next.grant.grantId)
        || (next.consumption && r.consumption?.consumptionId === next.consumption.consumptionId)
        || addedEvidence(r).some(e => nextEvidence.includes(e))) throw new ApprovalError("IDENTITY_REPLAY");
    }
    return;
  }
  if (prior && !isOffline(prior)) throw new ApprovalError("CONTRACT_MISMATCH");
  if (!prior) {
    if (next.state !== "PROPOSED" || next.revision !== 1 || next.reason !== "CREATED" || next.approvalEventId || next.result
      || [...records.values()].some(r => r.request.idempotencyKey === next.request.idempotencyKey)) throw new ApprovalError("STORE_CORRUPT");
  } else if (prior.digest !== next.digest || next.revision !== prior.revision + 1 || next.updatedAt < prior.updatedAt
    || !transitions[prior.state].includes(next.state)
    || (prior.approvalEventId && prior.approvalEventId !== next.approvalEventId)) throw new ApprovalError("INVALID_TRANSITION");
}

/** Read-only replay of the existing journal contract; never opens a Store or writes recovery. */
export function inspectApprovalJournal(content: string): { entries: number; receipts: JournalReceipt[] } {
  if (Buffer.byteLength(content) > MAX_BYTES) throw new ApprovalError("STORE_CAPACITY");
  if (content && !content.endsWith("\n")) throw new ApprovalError("STORE_CORRUPT");
  const records = new Map<string, JournalReceipt>();
  let sequence = 0, tail = "GENESIS";
  for (const line of content.split("\n").slice(0, -1)) {
    const entry = entrySchema.parse(JSON.parse(line));
    const { hash, ...unsigned } = entry;
    if (entry.seq !== sequence + 1 || entry.previous !== tail || hash !== digest(unsigned)) throw new ApprovalError("STORE_CORRUPT");
    validateJournalReceipt(records, entry.receipt);
    records.set(entry.receipt.request.requestId, entry.receipt);
    sequence = entry.seq; tail = hash;
    if (sequence > MAX_ENTRIES || records.size > MAX_REQUESTS) throw new ApprovalError("STORE_CAPACITY");
  }
  return { entries: sequence, receipts: [...records.values()] };
}

/** Single journal for all contracts; a hash chain is NOT Host/OS authority or ACL proof.
 * Abandoned lock/corrupt tail must be investigated, never repaired automatically. */
export class ApprovalStore {
  #records = new Map<string, JournalReceipt>();
  // Bounded transient result return in this same owner, not a second journal/store.
  #outputs = new Map<string, { createdAt: number; expiresAt: number; timer: ReturnType<typeof setTimeout>; text: ReturnType<typeof validateNormalOutput> }>();
  #tail = "GENESIS";
  #seq = 0;
  #bytes = 0;
  #faulted = false;
  #closed = false;
  #queue: Promise<unknown> = Promise.resolve();
  #lastTime = 0;
  #journal: FileHandle;
  #lock: FileHandle;
  #lockPath: string;
  #closing?: Promise<void>;
  #closeState: "OPEN" | "CLOSING" | "CLOSED" | "CLOSE_FAILED" = "OPEN";
  private constructor(journal: FileHandle, lock: FileHandle, lockPath: string) {
    this.#journal = journal; this.#lock = lock; this.#lockPath = lockPath;
  }
  static async open(directory: string): Promise<ApprovalStore> {
    let lock: FileHandle | undefined;
    let journal: FileHandle | undefined;
    let store: ApprovalStore | undefined;
    const lockPath = join(directory, "approval.lock");
    try {
      await mkdir(directory, { recursive: true });
      if ((await lstat(directory)).isSymbolicLink()) throw new ApprovalError("STORE_UNSAFE");
      try { lock = await open(lockPath, "wx"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ApprovalError("STORE_LOCKED");
        throw error;
      }
      const identity = observedCurrentProcessIdentity();
      await lock.writeFile(JSON.stringify({ contract: "approval-lock-owner-v1", instance: randomUUID(),
        identity: identity ?? null, identityStatus: identity ? "OS_OBSERVED" : "UNVERIFIED" }) + "\n", "utf8");
      await lock.sync();
      const path = join(directory, "receipts.jsonl");
      const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new ApprovalError("STORE_UNSAFE");
      journal = await open(path, "a+");
      if ((await journal.stat()).size > MAX_BYTES) throw new ApprovalError("STORE_CAPACITY");
      const content = await journal.readFile("utf8");
      store = new ApprovalStore(journal, lock, lockPath);
      store.#bytes = Buffer.byteLength(content);
      if (content && !content.endsWith("\n")) throw new ApprovalError("STORE_CORRUPT");
      for (const line of content.split("\n").slice(0, -1)) {
        const entry = entrySchema.parse(JSON.parse(line));
        const { hash, ...unsigned } = entry;
        if (entry.seq !== store.#seq + 1 || entry.previous !== store.#tail || hash !== digest(unsigned)) throw new ApprovalError("STORE_CORRUPT");
        store.#validate(entry.receipt);
        store.#records.set(entry.receipt.request.requestId, entry.receipt);
        store.#seq = entry.seq;
        store.#tail = hash;
      }
      if (store.#seq > MAX_ENTRIES || store.#records.size > MAX_REQUESTS) throw new ApprovalError("STORE_CAPACITY");
      // Recovery never authorizes, consumes, retries or resolves an uncertain operation.
      // Persist fail-closed recovery in this SAME sequence before exposing the store.
      for (const receipt of store.listProduction()) {
        const consumed = receipt.state === "CONSUMED";
        if (consumed || ["PROPOSED", "APPROVED"].includes(receipt.state)) {
          await store.#persist(parse(productionJournalReceiptSchema, { ...receipt, revision: receipt.revision + 1,
            updatedAt: Math.max(Date.now(), receipt.updatedAt), state: consumed ? "UNKNOWN" : "EXPIRED",
            reason: consumed ? "RESTART_UNCERTAIN" : "RESTART_EXPIRED" }));
        }
      }
      for (const receipt of store.#records.values()) {
        if (isReview(receipt)) await store.#expireReview(receipt);
      }
      return store;
    } catch (error) {
      const failure = error instanceof ApprovalError ? error : new ApprovalError("STORE_UNAVAILABLE");
      // A failed close leaves the lock for independent investigation. Never remove
      // a lock unless this open acquired it and both owned handles closed cleanly.
      let cleanupFailed = false;
      try { await journal?.close(); } catch { cleanupFailed = true; }
      if (lock) {
        let same = false;
        try { same = await sameLock(lock, lockPath); if (!same) cleanupFailed = true; } catch { cleanupFailed = true; }
        try { await lock.close(); } catch { cleanupFailed = true; }
        if (same && !cleanupFailed && (!store || !store.#faulted)) {
          try { await unlink(lockPath); } catch { cleanupFailed = true; }
        }
      }
      if (cleanupFailed) throw new ApprovalError("STORE_CLEANUP_UNCERTAIN");
      throw failure;
    }
  }
  // Legacy API sees ONLY OFFLINE fixtures; a production receipt cannot reach its runner.
  list(): Receipt[] { this.ready(); return structuredClone([...this.#records.values()].filter(isOffline)); }
  get(id: string): Receipt | undefined {
    this.ready(); const r = this.#records.get(id); return r && isOffline(r) ? structuredClone(r) : undefined;
  }
  listProduction(): ProductionJournalReceipt[] { this.ready(); return structuredClone([...this.#records.values()].filter(isProduction)); }
  getProduction(id: string): ProductionJournalReceipt | undefined {
    this.ready(); const r = this.#records.get(id); return r && isProduction(r) ? structuredClone(r) : undefined;
  }
  /** Request-first read, serialized behind writes. Never opens/recovers another Store,
   * expires a record, or includes OFFLINE_ONLY data in the production-facing surface. */
  async readRequestReceipt(id: string): Promise<ProductionJournalReceipt | ReviewReceipt | undefined> {
    parse(z.string().uuid(), id);
    return this.serial(async () => {
      const r = this.#records.get(id);
      return r && (isProduction(r) || isReview(r)) ? structuredClone(r) : undefined;
    });
  }
  /** Derived index over the same journal, not another grant store. */
  async readReviewExecution(id: string): Promise<ProductionReceipt | undefined> {
    parse(z.string().uuid(), id);
    return this.serial(async () => {
      this.#requireReview(id);
      const linked = [...this.#records.values()].filter(isProduction).filter(r =>
        "origin" in r.request && r.request.sourceReview?.requestId === id);
      if (linked.length > 1) throw new ApprovalError("IDENTITY_REPLAY");
      return linked.length ? parse(productionReceiptSchema, structuredClone(linked[0])) : undefined;
    });
  }
  async append(value: Receipt): Promise<void> {
    const receipt = parse(receiptSchema, value); // Detach caller data before awaiting the queue.
    return this.serial(() => this.#persist(receipt));
  }
  /** Nonexecuting review uses this same queue, lock, limits and journal. No grant API. */
  async createReview(value: unknown, sourceFailure?: SavedFailureEvidence): Promise<ReviewReceipt> {
    const input = parse(reviewInputSchema, value);
    validateReviewOrigin(input);
    // Detach server-resolved provenance before awaiting the write queue.
    const savedFailure = sourceFailure && structuredClone(sourceFailure);
    return this.serial(async () => {
      const existing = [...this.#records.values()].find(r => r.request.idempotencyKey === input.idempotencyKey);
      if (existing) {
        if (!isReview(existing)) throw new ApprovalError("IDENTITY_REPLAY");
        const original = reviewInputSchema.parse(Object.fromEntries(Object.keys(reviewInputSchema.shape)
          .filter(key => key in existing.request).map(key => [key, existing.request[key as keyof typeof existing.request]])));
        if (digest(original) !== digest(input)) throw new ApprovalError("IDEMPOTENCY_CONFLICT");
        if (digest(existing.request.sourceFailure ?? null) !== digest(savedFailure ?? null)) throw new ApprovalError("IDEMPOTENCY_CONFLICT");
        return structuredClone(await this.#expireReview(existing));
      }
      const now = this.now();
      const request = parse(reviewRequestSchema, { ...input, version: 1, evidence: REVIEW_KIND,
        requestId: randomUUID(), receiptId: randomUUID(), createdAt: now, ttlMs: REVIEW_TTL_MS, expiresAt: now + REVIEW_TTL_MS,
        scriptSha256: sha256(input.scriptSnapshot), scriptEncoding: "UTF8_EXACT", cause: "UNKNOWN", permissionAttribution: "UNVERIFIED",
        ...(savedFailure ? { sourceFailure: savedFailure } : {}) });
      const receipt = parse(reviewReceiptSchema, { kind: REVIEW_KIND, request, digest: digest(request), state: "PENDING",
        reason: reviewReasons.PENDING, revision: 1, updatedAt: now, executionDispatched: false, productionAuthorized: false,
        executionPolicy: { NORMAL: "OFF", ADMIN: "OFF" } });
      await this.#persist(receipt);
      return structuredClone(receipt);
    });
  }
  async readReview(requestId: string): Promise<ReviewReceipt> {
    // Read-only even after TTL. Effective expiry is a projection; only admission,
    // decision and startup recovery may persist the lowering transition.
    return this.serial(async () => structuredClone(this.#requireReview(requestId)));
  }
  async decideReview(requestId: string, exactDigest: string, decision: "ACCEPTED" | "DECLINED"): Promise<ReviewReceipt> {
    return this.serial(async () => {
      const stored = this.#requireReview(requestId);
      if (stored.digest !== exactDigest) throw new ApprovalError("DIGEST_MISMATCH");
      const prior = await this.#expireReview(stored);
      if (prior.state === "EXPIRED") throw new ApprovalError("TTL_EXPIRED");
      if (prior.state === decision) return structuredClone(prior); // Exact retry; never a new decision.
      if (prior.state !== "PENDING") throw new ApprovalError("REVIEW_ALREADY_DECIDED");
      const receipt = parse(reviewReceiptSchema, { ...prior, state: decision, reason: reviewReasons[decision],
        revision: 2, updatedAt: this.now() });
      await this.#persist(receipt);
      return structuredClone(receipt);
    });
  }
  #requireReview(id: string): ReviewReceipt {
    const r = this.#records.get(id);
    if (!r || !isReview(r)) throw new ApprovalError("REQUEST_UNKNOWN");
    return r;
  }
  async #expireReview(prior: ReviewReceipt): Promise<ReviewReceipt> {
    if (prior.state !== "PENDING") return prior;
    const now = this.now();
    if (now < prior.request.expiresAt) return prior;
    const expired = parse(reviewReceiptSchema, { ...prior, state: "EXPIRED", reason: reviewReasons.EXPIRED, revision: 2, updatedAt: now });
    await this.#persist(expired);
    return expired;
  }
  /** State-only Host ingest. A CONSUMED append is the durable one-time intent, not a dispatch.
   * No operational Host is installed: even perfectly shaped/signed caller data is rejected. */
  async appendProduction(value: ProductionReceipt, transportEvidence: unknown): Promise<void> {
    const receipt = parse(productionReceiptSchema, value);
    return this.serial(() => this.#commitProduction(receipt, transportEvidence));
  }
  /** Host-only admission. State, sequence and digest are constructed here, never
   * accepted from a tool. Same Journal/queue/fsync as Review. The verifier remains
   * mandatory even for an exact replay; disk data is not a fresh Host capability. */
  async admitProduction(value: unknown, transportEvidence: unknown): Promise<ProductionReceipt> {
    const request = parse(productionRequestSchema, value);
    return this.serial(async () => {
      this.#assertProductionSource(request);
      if ([...this.#records.values()].filter(isProduction).some(r => "origin" in r.request
        && r.request.sourceReview?.requestId === request.sourceReview!.requestId)) throw new ApprovalError("IDENTITY_REPLAY");
      const receipt = parse(productionReceiptSchema, { request, digest: digest(request), state: "PROPOSED",
        revision: 1, updatedAt: request.createdAt, reason: "CREATED" });
      await this.#commitProduction(receipt, transportEvidence);
      return structuredClone(receipt);
    });
  }
  /** Only an independently authenticated Host can decide. Review ACCEPTED is
   * deliberately not consulted. No caller-selected grant/consumption identity. */
  async decideProduction(requestId: string, exactDigest: string, decision: "APPROVED" | "DENIED",
    observation: unknown, transportEvidence: unknown): Promise<ProductionReceipt> {
    const peer = parse(hostPeerEvidenceSchema, observation);
    if (decision !== "APPROVED" && decision !== "DENIED") throw new ApprovalError("INVALID_INPUT");
    return this.serial(async () => {
      const prior = this.#requireCurrentProduction(requestId, exactDigest, "PROPOSED");
      this.#assertProductionSource(prior.request);
      const now = peer.observedAt;
      const receipt = parse(productionReceiptSchema, { ...prior, state: decision, revision: prior.revision + 1,
        updatedAt: now, reason: decision === "APPROVED" ? "HOST_APPROVED" : "HOST_DENIED",
        ...(decision === "APPROVED" ? { grant: { grantId: randomUUID(), binding: productionBindingOf(prior.request),
          approvedAt: now, approval: peer, osAuthorization: prior.request.executionMode === "ADMIN"
            ? "WINDOWS_UAC_ELEVATED_TOKEN" : "WINDOWS_STANDARD_TOKEN" } } : { denial: peer }) });
      await this.#commitProduction(receipt, transportEvidence);
      return structuredClone(receipt);
    });
  }
  /** A delivery can be returned only AFTER durable consume. Lost response is
   * never retried: the next claim fails on CONSUMED, including after timeout. */
  async claimProduction(requestId: string, exactDigest: string, observation: unknown,
    transportEvidence: unknown): Promise<ProductionReceipt> {
    const peer = parse(hostPeerEvidenceSchema, observation);
    return this.serial(async () => {
      const prior = this.#requireCurrentProduction(requestId, exactDigest, "APPROVED");
      this.#assertProductionSource(prior.request);
      const now = peer.observedAt;
      const receipt = parse(productionReceiptSchema, { ...prior, state: "CONSUMED", reason: "GRANT_CONSUMED",
        revision: prior.revision + 1, updatedAt: now, consumption: { consumptionId: randomUUID(),
          grantId: prior.grant!.grantId, binding: productionBindingOf(prior.request), consumedAt: now,
          receiptDeadline: now + RECEIPT_TTL_MS, executor: peer } });
      await this.#commitProduction(receipt, transportEvidence);
      return structuredClone(receipt);
    });
  }
  #requireCurrentProduction(id: string, exactDigest: string, state: ProductionReceipt["state"]): ProductionReceipt {
    parse(z.string().uuid(), id);
    const saved = this.getProduction(id);
    if (!saved) throw new ApprovalError("REQUEST_UNKNOWN");
    if (!("origin" in saved.request)) throw new ApprovalError("LEGACY_ORIGIN_UNVERIFIED");
    const prior = parse(productionReceiptSchema, saved);
    if (prior.digest !== exactDigest) throw new ApprovalError("DIGEST_MISMATCH");
    if (prior.state !== state) throw new ApprovalError("INVALID_TRANSITION");
    if (this.now() >= prior.request.expiresAt) throw new ApprovalError("TTL_EXPIRED");
    return prior;
  }
  #assertProductionSource(request: ProductionReceipt["request"]): void {
    if (!request.sourceReview) throw new ApprovalError("SOURCE_REVIEW_REQUIRED");
    const source = this.#requireReview(request.sourceReview.requestId);
    if (source.digest !== request.sourceReview.digest || source.request.requestId === request.requestId)
      throw new ApprovalError("HOST_REQUEST_MISMATCH");
    if (source.state === "DECLINED") throw new ApprovalError("REVIEW_DECLINED");
    if (source.state === "EXPIRED" || this.now() >= source.request.expiresAt) throw new ApprovalError("TTL_EXPIRED");
    for (const field of ["origin", "projectId", "executionMode", "target", "cwd", "scriptSnapshot", "scriptSha256",
      "scriptEncoding", "args", "risk", "sideEffects"] as const) {
      if (digest(source.request[field]) !== digest(request[field])) throw new ApprovalError("HOST_REQUEST_MISMATCH");
    }
    if (request.expiresAt > source.request.expiresAt) throw new ApprovalError("HOST_REQUEST_MISMATCH");
    if (request.origin === "CODEX_DERIVED" && (request.jobId !== source.request.jobId
      || request.turnId !== source.request.turnId || request.failureEvidence.itemId !== source.request.sourceFailure?.itemId
      || request.failureEvidence.threadId !== source.request.sourceFailure?.threadId)) throw new ApprovalError("HOST_REQUEST_MISMATCH");
  }
  async consumeProduction(value: NonNullable<ProductionReceipt["consumption"]>, transportEvidence: unknown): Promise<void> {
    const consumption = parse(productionConsumptionSchema, value);
    return this.serial(async () => {
      const prior = this.getProduction(consumption.binding.requestId);
      if (!prior) throw new ApprovalError("REQUEST_UNKNOWN");
      await this.#commitProduction(parse(productionReceiptSchema, { ...prior, consumption, state: "CONSUMED",
        reason: "GRANT_CONSUMED", revision: prior.revision + 1, updatedAt: this.now() }), transportEvidence);
    });
  }
  async ingestProductionReceipt(value: NonNullable<ProductionReceipt["result"]>, transportEvidence: unknown, rawOutput?: NormalOutput): Promise<void> {
    const result = parse(productionResultSchema, value);
    const text = rawOutput === undefined ? undefined : validateNormalOutput(parse(normalOutputSchema, rawOutput), result.outputSha256);
    return this.serial(async () => {
      const prior = this.getProduction(result.binding.requestId);
      if (!prior) throw new ApprovalError("REQUEST_UNKNOWN");
      await this.#commitProduction(parse(productionReceiptSchema, { ...prior, result, state: result.outcome,
        reason: "RECEIPT_INGESTED", revision: prior.revision + 1, updatedAt: this.now() }), transportEvidence);
      if (text) {
        const now = this.now();
        for (const [id, output] of this.#outputs) if (output.expiresAt <= now) {
          clearTimeout(output.timer); this.#outputs.delete(id);
        }
        while (this.#outputs.size >= 32) {
          const id = this.#outputs.keys().next().value!;
          clearTimeout(this.#outputs.get(id)!.timer); this.#outputs.delete(id);
        }
        const id = result.binding.requestId;
        const timer = setTimeout(() => this.#outputs.delete(id), 600_000).unref();
        this.#outputs.set(id, { createdAt: now, expiresAt: now + 600_000, timer, text });
      }
    });
  }
  readProductionOutput(requestId: string, outputOffset = 0) {
    this.ready();
    const output = this.#outputs.get(requestId);
    return output && Date.now() >= output.createdAt && Date.now() < output.expiresAt
      ? { availability: "AVAILABLE" as const, expiresAt: output.expiresAt, ...pageNormalOutput(output.text, outputOffset) }
      : { availability: "UNAVAILABLE_OR_EXPIRED" as const };
  }
  async #commitProduction(receipt: ProductionReceipt, transportEvidence: unknown): Promise<void> {
    this.#validate(receipt);
    if (receipt.state === "EXPIRED" || (receipt.state === "UNKNOWN" && !receipt.result)) throw new ApprovalError("INVALID_TRANSITION");
    await productionHost.verifyTransition(structuredClone(receipt), transportEvidence);
    // Time is checked again AFTER Host verification; a slow ceremony cannot extend TTL.
    const now = this.now();
    const deadline = receipt.result ? receipt.consumption!.receiptDeadline : receipt.request.expiresAt;
    if (now < receipt.updatedAt || now >= deadline) throw new ApprovalError("TTL_EXPIRED");
    await this.#persist(receipt);
  }
  /** Reducing authority needs no external proof. UNKNOWN is permanent, including for late receipts. */
  async markProductionUnknown(requestId: string): Promise<void> {
    return this.serial(async () => {
      const prior = this.getProduction(requestId);
      if (!prior) throw new ApprovalError("REQUEST_UNKNOWN");
      if (prior.state !== "CONSUMED") throw new ApprovalError("INVALID_TRANSITION");
      await this.#persist(parse(productionJournalReceiptSchema, { ...prior, state: "UNKNOWN", reason: "DELIVERY_UNCERTAIN",
        revision: prior.revision + 1, updatedAt: this.now() }));
    });
  }
  async #persist(receipt: JournalReceipt): Promise<void> {
    this.ready();
    this.#validate(receipt);
    const entry = { seq: this.#seq + 1, previous: this.#tail, receipt };
    const hash = digest(entry);
    const line = JSON.stringify({ ...entry, hash }) + "\n";
    if (this.#seq >= MAX_ENTRIES || this.#bytes + Buffer.byteLength(line) > MAX_BYTES
      || (!this.#records.has(receipt.request.requestId) && this.#records.size >= MAX_REQUESTS)) throw new ApprovalError("STORE_CAPACITY");
    try { await this.#journal.writeFile(line, "utf8"); await this.#journal.sync(); }
    catch { this.#faulted = true; throw new ApprovalError("PERSISTENCE_UNCERTAIN"); }
    this.#records.set(receipt.request.requestId, receipt);
    this.#seq++; this.#tail = hash; this.#bytes += Buffer.byteLength(line);
  }
  #validate(next: JournalReceipt): void {
    validateJournalReceipt(this.#records, next);
  }
  private ready() { if (this.#closed || this.#faulted) throw new ApprovalError("STORE_UNAVAILABLE"); }
  private now(): number {
    const now = Date.now();
    const floor = Math.max(this.#lastTime, ...[...this.#records.values()].filter(r => isProduction(r) || isReview(r)).map(r => r.updatedAt));
    if (!Number.isSafeInteger(now) || now < floor || now > Number.MAX_SAFE_INTEGER - Math.max(TTL_MS, REVIEW_TTL_MS)) throw new ApprovalError("CLOCK_UNTRUSTED");
    this.#lastTime = now;
    return now;
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#queue.then(() => { this.ready(); return operation(); });
    this.#queue = pending.catch(() => undefined);
    return pending;
  }
  async close(): Promise<void> {
    // Queue close behind pending fsync, including failed writes; close remains idempotent.
    if (this.#closing) return this.#closing;
    this.#closeState = "CLOSING";
    const pending = this.#queue.then(async () => {
      if (this.#closed) return;
      this.#closed = true;
      for (const output of this.#outputs.values()) clearTimeout(output.timer);
      this.#outputs.clear();
      let same = false;
      let identity: { ino: bigint; dev: bigint } | undefined;
      await closeResources([
        async () => { identity = await this.#lock.stat({ bigint: true }); same = await matchesLock(identity, this.#lockPath); },
        () => this.#journal.close(), () => this.#lock.close(),
      ]);
      // Closing the journal can yield. Recheck after both closes so a replacement
      // observed during cleanup is preserved instead of unlinking another owner.
      if (!same || !identity || !await matchesLock(identity, this.#lockPath)) throw new ApprovalError("STORE_LOCK_OWNER_CHANGED");
      if (!this.#faulted) await unlink(this.#lockPath);
    });
    this.#queue = pending.catch(() => undefined);
    this.#closing = pending.then(() => { this.#closeState = "CLOSED"; }, error => {
      this.#closeState = "CLOSE_FAILED"; throw error;
    });
    return this.#closing;
  }

  async lockDiagnostics(): Promise<LockDiagnostics> {
    const state = await ApprovalStore.inspectLock(this.#lockPath, true);
    const lifecycle = this.#faulted ? "FAULTED" : this.#closeState;
    if (state.presence !== "PRESENT") return { ...state, lifecycle };
    try {
      if (!this.#closed && await sameLock(this.#lock, this.#lockPath))
        return { ...state, lifecycle, owner: "THIS_INSTANCE", recovery: this.#faulted ? "INDEPENDENT_REVIEW_REQUIRED" : "CLOSE_OWNER_NORMALLY" };
    } catch { /* Closed/unreadable/replaced handle is never ownership proof. */ }
    return { ...state, lifecycle };
  }

  /** Only lstat: no Journal or lock bytes, process probes, retry/open, or repair. */
  static async inspectLock(directory: string, isLockPath = false): Promise<LockDiagnostics> {
    const observedAt = new Date().toISOString();
    try {
      const stat = await lstat(isLockPath ? directory : join(directory, "approval.lock"));
      return { observation: "LIVE_METADATA_ONLY", observedAt, lifecycle: "UNVERIFIED", presence: stat.isFile() && !stat.isSymbolicLink() ? "PRESENT" : "UNSAFE",
        owner: "UNVERIFIED", recovery: "INDEPENDENT_REVIEW_REQUIRED" };
    } catch (error) {
      return { observation: "LIVE_METADATA_ONLY", observedAt, lifecycle: "UNVERIFIED", presence: (error as NodeJS.ErrnoException).code === "ENOENT" ? "ABSENT" : "UNKNOWN",
        owner: "UNVERIFIED", recovery: "INDEPENDENT_REVIEW_REQUIRED" };
    }
  }
}

export interface LockDiagnostics {
  observation: "LIVE_METADATA_ONLY";
  observedAt: string;
  lifecycle: "OPEN" | "CLOSING" | "CLOSED" | "CLOSE_FAILED" | "FAULTED" | "UNVERIFIED";
  presence: "PRESENT" | "ABSENT" | "UNKNOWN" | "UNSAFE";
  owner: "THIS_INSTANCE" | "UNVERIFIED";
  recovery: "CLOSE_OWNER_NORMALLY" | "INDEPENDENT_REVIEW_REQUIRED";
}

async function sameLock(handle: FileHandle, path: string): Promise<boolean> {
  return matchesLock(await handle.stat({ bigint: true }), path);
}

async function matchesLock(owned: { ino: bigint; dev: bigint }, path: string): Promise<boolean> {
  const current = await lstat(path, { bigint: true });
  return current.isFile() && !current.isSymbolicLink() && owned.ino !== 0n && owned.ino === current.ino && owned.dev === current.dev;
}
