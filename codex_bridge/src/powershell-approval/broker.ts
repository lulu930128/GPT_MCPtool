import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { z } from "zod";
import { ApprovalError, CHALLENGE_TTL_MS, deploymentStatus, digest, failureSchema, MARKER_SCRIPT, OUTPUT_LIMIT,
  parse, POLICY, proposalInputSchema, requestSchema, requireProductionHost, resultSchema, RUN_TIMEOUT_MS, sha256, TTL_MS,
  type FailureEvidence, type ProposalInput, type Receipt } from "./contract.js";
import { ApprovalStore } from "./store.js";
import { offlinePasswordVerifier } from "./password.js";
import { validateDelivery, type OfflineRunner } from "./runner.js";

const bindingSchema = z.object({ requestId: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/),
  executionMode: z.enum(["NORMAL", "ADMIN"]), jobId: z.string().uuid(), turnId: z.string().min(1).max(128),
  executorId: z.literal("offline-normal-marker"), challenge: z.string().uuid(),
}).strict();
export type ReviewBinding = z.infer<typeof bindingSchema>;
export interface LocalReview {
  open(requestId: string): Promise<{ receipt: Receipt; binding: ReviewBinding }>;
  decide(binding: unknown, decision: "approve" | "deny", secret?: Buffer): Promise<Receipt>;
}
type Challenge = { binding: ReviewBinding; expiresAt: number; attempts: number };

/** Canonical proposal owner. Only status/preview are wired to MCP.
 * Production remains unavailable until a protected OS authority is implemented and accepted. */
export class PowerShellApprovalBroker {
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;
  #bootId = randomUUID();
  #lastTime = 0;
  #challenges = new Map<string, Challenge>();
  private constructor(private store: ApprovalStore, private projects: ReadonlyMap<string, string>,
    private expectedSid: string, private evidence: (input: ProposalInput) => Promise<FailureEvidence>,
    private verify: (secret: Buffer) => Promise<boolean>, private runner: OfflineRunner, private clock: () => number) {}

  static status() { return deploymentStatus(); }
  static production(): never { return requireProductionHost(); }
  static async offlineFixture(options: {
    directory: string; projects: ReadonlyMap<string, string>; expectedSid: string;
    evidence: (input: ProposalInput) => Promise<FailureEvidence>;
    enrollment: Buffer; runner: OfflineRunner; clock?: () => number;
  }): Promise<{ broker: PowerShellApprovalBroker; localReview: LocalReview }> {
    // In-memory verifier cannot be promoted to a host authority via options, environment or MCP.
    const verify = await offlinePasswordVerifier(options.enrollment);
    const projects = new Map<string, string>();
    for (const [id, path] of options.projects) {
      const resolved = await realpath(path);
      if (!(await lstat(resolved)).isDirectory() || (await lstat(path)).isSymbolicLink()) throw new ApprovalError("SCOPE_REJECTED");
      projects.set(id, resolved);
    }
    if (!/^S-1-5-(?:\d+-)*\d+$/.test(options.expectedSid)) throw new ApprovalError("IDENTITY_REJECTED");
    const store = await ApprovalStore.open(options.directory);
    const broker = new PowerShellApprovalBroker(store, projects, options.expectedSid, options.evidence, verify, options.runner, options.clock ?? Date.now);
    try {
      for (const receipt of store.list()) {
        if (["DISPATCHING", "RUNNING"].includes(receipt.state)) await broker.change(receipt, "UNKNOWN", "RESTART_UNCERTAIN");
        else if (["PROPOSED", "REVIEW_PENDING", "APPROVED"].includes(receipt.state)) await broker.change(receipt, "EXPIRED", "RESTART_EXPIRED");
      }
    } catch (error) { await store.close(); throw error; }
    return { broker, localReview: Object.freeze({
      open: (requestId: string) => broker.serial(() => broker.openReview(requestId)),
      decide: (binding: unknown, decision: "approve" | "deny", secret?: Buffer) =>
        broker.serial(() => broker.decide(binding, decision, secret)).finally(() => secret?.fill(0)),
    }) };
  }

  propose(value: unknown): Promise<Receipt> {
    return this.serial(async () => {
      const input = parse(proposalInputSchema, value);
      const prior = this.store.list().find(r => r.request.idempotencyKey === input.idempotencyKey);
      if (prior) {
        const previousInput = Object.fromEntries(Object.keys(input).map(key => [key, prior.request[key as keyof ProposalInput]]));
        if (digest(previousInput) !== digest(input)) throw new ApprovalError("IDEMPOTENCY_CONFLICT");
        return this.lookup(prior.request.requestId);
      }
      const cwd = this.projects.get(input.projectId);
      if (!cwd) throw new ApprovalError("PROJECT_NOT_ALLOWED");
      const failureEvidence = parse(failureSchema, await this.evidence(structuredClone(input)));
      const createdAt = this.now();
      const request = parse(requestSchema, { ...input, version: 1, evidence: "OFFLINE_ONLY", policy: POLICY,
        requestId: randomUUID(), receiptId: randomUUID(), bootId: this.#bootId, createdAt, expiresAt: createdAt + TTL_MS,
        failureEvidence, executorId: "offline-normal-marker", expectedSid: this.expectedSid,
        cwd, target: "isolated-fixture-process", scriptSnapshot: MARKER_SCRIPT, scriptSha256: sha256(MARKER_SCRIPT),
        args: [], environmentPolicy: "WINDOWS_SYSTEM_ONLY", sideEffects: "stdout marker only; no file/network/system mutation",
        risk: "offline fixture; no host authorization", timeoutMs: RUN_TIMEOUT_MS, outputLimitBytes: OUTPUT_LIMIT });
      const receipt: Receipt = { request, digest: digest(request), state: "PROPOSED", revision: 1, updatedAt: createdAt, reason: "CREATED" };
      await this.store.append(receipt);
      return structuredClone(receipt);
    });
  }
  get(requestId: string): Promise<Receipt> { return this.serial(() => this.lookup(requestId)); }
  execute(requestId: string): Promise<Receipt> {
    return this.serial(async () => {
      let receipt = await this.lookup(requestId);
      if (["SUCCEEDED", "FAILED", "UNKNOWN"].includes(receipt.state)) return receipt; // Never replay.
      if (receipt.request.executionMode === "ADMIN") throw new ApprovalError("BLOCKED_AWAITING_LOCAL_UAC");
      if (receipt.state !== "APPROVED" || receipt.request.bootId !== this.#bootId) throw new ApprovalError("NOT_APPROVED");
      if (this.projects.get(receipt.request.projectId) !== receipt.request.cwd) throw new ApprovalError("SCOPE_REJECTED");
      receipt = await this.change(receipt, "DISPATCHING", "DELIVERY_INTENT"); // fsync before dispatch.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (this.now() >= receipt.request.expiresAt) throw new ApprovalError("TTL_EXPIRED");
        receipt = await this.change(receipt, "RUNNING", "RUNNER_ENTERED");
        if (this.now() >= receipt.request.expiresAt) throw new ApprovalError("TTL_EXPIRED");
        validateDelivery(receipt);
        const raw = await Promise.race([
          Promise.resolve().then(() => this.runner(structuredClone(receipt))),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ApprovalError("TIMEOUT")), RUN_TIMEOUT_MS + 1500); }),
        ]);
        const result = parse(resultSchema, raw);
        if (result.requestId !== receipt.request.requestId || result.digest !== receipt.digest
          || result.sid !== receipt.request.expectedSid || result.executorId !== receipt.request.executorId
          || result.executionMode !== receipt.request.executionMode || result.stdoutBytes + result.stderrBytes > OUTPUT_LIMIT
          || (result.outcome === "SUCCEEDED" && (result.exitCode !== 0 || result.marker !== "CODEX_NORMAL_SYNTHETIC_V1" || result.code !== "MARKER_CONFIRMED"))) throw new ApprovalError("RESULT_REJECTED");
        receipt = await this.change(receipt, result.outcome, "RESULT_RETURNED", { result });
      } catch (error) {
        // No raw exceptions/output cross the boundary. A persistence fault also leaves the store locked.
        const code = error instanceof ApprovalError ? error.code : "RUNNER_UNCERTAIN";
        const runnerError = ["TIMEOUT", "OUTPUT_LIMIT", "IDENTITY_REJECTED", "RESULT_REJECTED", "SPAWN_FAILED", "NONZERO_EXIT", "TTL_EXPIRED", "FAILURE_NOT_QUALIFIED", "SCOPE_REJECTED", "EXECUTABLE_REJECTED"].includes(code)
          ? code as NonNullable<Receipt["runnerError"]> : "RUNNER_UNCERTAIN";
        receipt = await this.change(receipt, "UNKNOWN", "RUNNER_UNCERTAIN", { runnerError });
      } finally { if (timer) clearTimeout(timer); }
      return receipt;
    });
  }
  close(): Promise<void> { return this.serial(async () => { this.#closed = true; this.#challenges.clear(); await this.store.close(); }); }

  private async openReview(requestId: string) {
    let receipt = await this.lookup(requestId);
    if (receipt.state !== "PROPOSED") throw new ApprovalError("REVIEW_CLOSED");
    receipt = await this.change(receipt, "REVIEW_PENDING", "REVIEW_OPENED");
    const binding: ReviewBinding = { requestId, digest: receipt.digest, executionMode: receipt.request.executionMode,
      jobId: receipt.request.jobId, turnId: receipt.request.turnId, executorId: receipt.request.executorId, challenge: randomUUID() };
    this.#challenges.set(requestId, { binding, expiresAt: Math.min(receipt.request.expiresAt, this.now() + CHALLENGE_TTL_MS), attempts: 0 });
    return { receipt, binding: structuredClone(binding) };
  }
  private async decide(value: unknown, decision: "approve" | "deny", secret?: Buffer): Promise<Receipt> {
    const binding = parse(bindingSchema, value);
    const receipt = await this.lookup(binding.requestId);
    const challenge = this.#challenges.get(binding.requestId);
    if (receipt.state !== "REVIEW_PENDING" || !challenge || digest(binding) !== digest(challenge.binding)) throw new ApprovalError("REVIEW_BINDING_REJECTED");
    if (this.now() >= challenge.expiresAt) {
      this.#challenges.delete(binding.requestId);
      return this.change(receipt, "EXPIRED", "TTL_EXPIRED");
    }
    if (decision === "deny") {
      this.#challenges.delete(binding.requestId);
      return this.change(receipt, "DENIED", "HUMAN_DENIED");
    }
    if (decision !== "approve") throw new ApprovalError("INVALID_INPUT");
    if (receipt.request.executionMode === "ADMIN") throw new ApprovalError("BLOCKED_AWAITING_LOCAL_UAC");
    if (!["SANDBOX_POLICY", "JOB_OBJECT"].includes(receipt.request.failureEvidence.classification)) throw new ApprovalError("FAILURE_NOT_QUALIFIED");
    if (!secret || challenge.attempts >= 3) throw new ApprovalError("PASSWORD_REQUIRED");
    challenge.attempts++;
    if (!await this.verify(secret)) {
      if (challenge.attempts === 3) {
        this.#challenges.delete(binding.requestId);
        return this.change(receipt, "DENIED", "AUTH_ATTEMPTS_EXHAUSTED");
      }
      throw new ApprovalError("PASSWORD_REJECTED");
    }
    // Slow KDF cannot extend the challenge; no grant is returned to the caller.
    this.#challenges.delete(binding.requestId);
    if (this.now() >= challenge.expiresAt) return this.change(receipt, "EXPIRED", "TTL_EXPIRED");
    return this.change(receipt, "APPROVED", "PASSWORD_VERIFIED_OFFLINE", { approvalEventId: randomUUID() });
  }
  private async lookup(requestId: string): Promise<Receipt> {
    parse(z.string().uuid(), requestId);
    const receipt = this.store.get(requestId);
    if (!receipt) throw new ApprovalError("REQUEST_UNKNOWN");
    if (["PROPOSED", "REVIEW_PENDING", "APPROVED"].includes(receipt.state) && this.now() >= receipt.request.expiresAt) {
      this.#challenges.delete(requestId);
      return this.change(receipt, "EXPIRED", "TTL_EXPIRED");
    }
    return receipt;
  }
  private async change(receipt: Receipt, state: Receipt["state"], reason: Receipt["reason"], extra: Partial<Pick<Receipt, "approvalEventId" | "result" | "runnerError">> = {}): Promise<Receipt> {
    const updated = { ...receipt, ...extra, state, reason, revision: receipt.revision + 1, updatedAt: this.now() };
    await this.store.append(updated);
    return structuredClone(updated);
  }
  private now(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < this.#lastTime || now < 0 || now > Number.MAX_SAFE_INTEGER - TTL_MS) throw new ApprovalError("CLOCK_UNTRUSTED");
    this.#lastTime = now; return now;
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#queue.then(() => { if (this.#closed) throw new ApprovalError("BROKER_CLOSED"); return operation(); });
    this.#queue = pending.catch(() => undefined);
    return pending;
  }
}
