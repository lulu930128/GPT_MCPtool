import { createReadStream, readFileSync } from "node:fs";
import type { RuntimeDiagnostics } from "./runtime-diagnostics.js";
import { jsonLines } from "./jsonl-reader.js";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { MemoryMaintenanceError } from "./memory-maintenance.js";
import { appendFile, copyFile, mkdir, open, readFile, readdir, stat, rename, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type {
  BridgeProject,
  ConversationMessage,
  ConversationPersistenceDiagnostic,
  ConversationPersistenceDiagnosticCode,
  ConversationProjectionPatch,
  ConversationListPage,
  ConversationThreadProjection,
  ApprovalReviewer,
  DataClassification,
  ExecutionMode,
  JobEvent,
  JobArtifactChunk,
  JobArtifactDescriptor,
  JobArtifactKind,
  JobRecord,
  JobResult,
  JobSnapshot,
  JobStatus,
  JobSummary,
  ModelSelectionMetadata,
  PendingApproval,
  ReasoningEffort,
  TurnSpeed,
  MaterializedTextArtifact,
  StagedTextArtifact,
  TextArtifactSummary,
  WorkPackage,
} from "./types.js";
import {
  createConversationProjection,
  hydrateConversationProjection,
  mergeConversationMessages,
  projectCommandFailures,
  reduceConversationNotification,
  type ConversationNotification,
} from "./conversation-projection.js";
import { normalizeTurnSpeed, recordModelSelection, renderRequestMarkdown } from "./work-package.js";
import { sanitizeForStorage } from "./redaction.js";
import { CONVERSATION_DELIVERY, RecentConversationChanges, isCoalescibleConversationNotification } from "./conversation-delivery.js";

const ACTIVE_STATUSES = new Set<JobStatus>(["queued", "preparing", "running", "awaiting_approval"]);
const HANDOFF_EXTENSIONS = new Set([".txt", ".md", ".log", ".json", ".yaml", ".yml", ".diff", ".patch"]);

export interface CreateJobInput {
  dispatchSource?: "app" | "model_direct";
  project: BridgeProject;
  workPackage: WorkPackage;
  previewDigest: string;
  idempotencyKey: string;
  inputArtifacts?: StagedTextArtifact[];
}

export interface AppendUserMessageInput extends ModelSelectionMetadata {
  speed?: TurnSpeed;
  clientMessageId: string;
  content: string;
  context?: string;
  executionMode: ExecutionMode;
  approvalReviewer: ApprovalReviewer;
  dataClassification: DataClassification;
  model?: string;
  effort?: ReasoningEffort;
  inputArtifacts?: StagedTextArtifact[];
}

export interface PrepareTurnInput extends ModelSelectionMetadata {
  speed?: TurnSpeed;
  controlAction?: JobRecord["controlAction"];
  executionMode: ExecutionMode;
  approvalReviewer: ApprovalReviewer;
  dataClassification: DataClassification;
  model?: string;
  effort?: ReasoningEffort;
}

export interface ImportLocalThreadInput {
  project: BridgeProject;
  workPackage: WorkPackage;
  previewDigest: string;
  threadId: string;
  threadResponse: Record<string, unknown>;
  freshness?: import("./types.js").ConversationFreshness;
}

export class ConversationPersistenceError extends Error {
  constructor(
    readonly code: ConversationPersistenceDiagnosticCode,
    message: string,
    readonly diagnostics: ConversationPersistenceDiagnostic[],
  ) {
    super(message);
    this.name = "ConversationPersistenceError";
  }
}

export type ConversationFileRename = (source: string, destination: string) => Promise<void>;

interface ProjectionCandidate {
  state: "valid" | "missing" | "corrupt";
  projection?: ConversationThreadProjection;
}

interface ConversationJournalRead {
  exists: boolean;
  replayed: number;
  latestRevision?: number;
  diagnostics: ConversationPersistenceDiagnostic[];
}

export class JobStore {
  private readonly summaries = new Map<string, JobSummary>();
  private readonly threadOwners = new Map<string, Set<string>>();
  private readonly withResultOutput = new Set<string>();
  private readonly activeIds = new Set<string>();
  private pendingApprovals = 0;
  private awaitingApproval = 0;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly idempotencyIndex = new Map<string, string>();
  private readonly conversations = new Map<string, ConversationThreadProjection>();
  private readonly conversationDiagnostics = new Map<string, ConversationPersistenceDiagnostic[]>();
  private readonly conversationFailures = new Map<string, ConversationPersistenceError>();
  private readonly pendingConversationCheckpoints = new Set<string>();
  private readonly recentConversationChanges = new RecentConversationChanges();
  private readonly conversationLocks = new Map<string, Promise<void>>();
  private readonly pendingConversations = new Map<string, ConversationThreadProjection>();
  private readonly conversationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingDiffs = new Map<string, string>();
  private readonly conversationInputCounts = new Map<string, number>();
  private readonly conversationCommitCounts = new Map<string, number>();
  private readonly conversationFlushFailures = new Set<string>();
  private readonly loads = new Map<string, Promise<ConversationThreadProjection>>();
  private readonly checkpointBytes = new Map<string, number>();
  private readonly observedJournalBytes = new Map<string,number>();
  private readonly replayBytes = new Map<string, number>();
  private readonly eventCursors = new Map<string, { seq: number; offset: number }>();
  private coldBytes = 0;
  private mutations = 0;
  private readonly writingManifests = new Set<string>();
  private readonly uncertainManifests = new Set<string>();
  private readonly detachedManifests = new Set<string>();
  get pendingManifestRepairs() { return new Set([...this.uncertainManifests,...this.detachedManifests]).size; }

  async reconcileManifestWrites() {
    for (const id of new Set([...this.uncertainManifests,...this.detachedManifests])) {
      await this.exclusive(async () => {
        if (!this.uncertainManifests.has(id) && !this.detachedManifests.has(id)) return;
        try {
          const saved = JSON.parse(await readFile(this.manifestPath(id),"utf8")) as JobRecord;
          if (saved.id !== id || saved.schemaVersion !== 1 || (this.uncertainManifests.has(id) && !await fileExists(this.manifestPath(id)+".pending")))
            throw new Error("MANIFEST_EVENT_RECONCILIATION_REQUIRED");
          const recovered = await this.recoverManifestEvent(saved);
          this.uncertainManifests.delete(id);
          if (this.detachedManifests.has(id) && ACTIVE_STATUSES.has(recovered.status)) {
            await this.mutateUnlocked(id, record => {
              record.restartInterruptedTurnId = record.turnId;
              record.status = "interrupted";
              settlePendingApprovals(record,"expired");
              return {type:"job.interrupted",message:"Recovered local writes after restart. Native outcome requires readback."};
            });
          }
          this.detachedManifests.delete(id);
        } catch (error) {
          this.diagnostics?.observe("manifest","reconciliation_failed",{jobId:id},true,error);
        }
      });
    }
  }
  private readonly readers = new Map<string, number>();
  private readonly artifactCache = new Map<string, {stamp:string; descriptor:JobArtifactDescriptor; anchors:Array<{chars:number;bytes:number}>}>();
  private readonly coldReads = new Map<string, number>();
  private readonly companyHistory = new Set<string>();
  private readonly messageIndexBytes = new Map<string, number>();
  private readonly messageTailBytes = new Map<string, number>();
  private readonly messageOffsets = new Map<string, Map<string,{start:number;end:number}>>();
  private readonly messageTails = new Map<string, ConversationMessage[]>();
  private readonly messageLoads = new Map<string, Promise<void>>();
  private readonly lastJournalRecord = new Map<string, {revision:number;offset:number}>();
  private readonly journalAnchors = new Map<string, { revision: number; offset: number }>();
  private lock: Promise<void> = Promise.resolve();
  private selfReloadLease: { requestId: string; expiresAt: string } | undefined;
  private memoryAdmission?: () => unknown;
  private readonly admitted = new AsyncLocalStorage<{ active: boolean }>();
  private admittedOperations = 0;

  get pendingAdmissions() { return this.admittedOperations; }
  get memoryDraining() { return Boolean(this.memoryAdmission); }
  async setMemoryAdmission(snapshot: () => unknown, persist?: () => Promise<void>) {
    await this.exclusive(async () => { this.memoryAdmission = snapshot; await persist?.(); });
  }
  async clearMemoryAdmission() { await this.exclusive(async () => { this.memoryAdmission = undefined; }); }
  async withAdmission<T>(operation: () => Promise<T>): Promise<T> {
    if (this.admitted.getStore()?.active) return operation();
    const token = { active: true };
    await this.exclusive(async () => { this.assertAdmissionOpen(); this.admittedOperations++; });
    try { return await this.admitted.run(token, operation); }
    finally { token.active = false; this.admittedOperations--; }
  }

  get selfReloadDrain() { return this.selfReloadLease ? { ...this.selfReloadLease } : null; }

  async beginSelfReload(requestId: string, expiresAt: string): Promise<void> {
    // Same admission lock as create/append/prepare: health cannot report a lease
    // until every earlier admission has become visible in the complete job map.
    await this.exclusive(async () => {
      if (this.selfReloadLease && this.selfReloadLease.requestId !== requestId) throw new Error("SELF_RELOAD_BUSY");
      this.selfReloadLease = { requestId, expiresAt };
    });
  }

  async endSelfReload(requestId: string, canRelease: () => boolean = () => true): Promise<void> {
    await this.exclusive(async () => {
      // Evaluate inside the admission queue: a delayed refusal must not release
      // a drain whose cooperative shutdown observation already timed out.
      if (this.selfReloadLease?.requestId === requestId && canRelease()) this.selfReloadLease = undefined;
    });
  }

  private assertAdmissionOpen(): void {
    if (this.selfReloadLease) throw new Error("SELF_RELOAD_DRAINING");
    if (this.memoryAdmission && !this.admitted.getStore()?.active) throw new MemoryMaintenanceError(this.memoryAdmission());
  }

  constructor(
    private readonly jobsDir: string,
    private readonly handoffRoot: string = join(jobsDir, "codex-inbox"),
    private readonly conversationRename: ConversationFileRename = rename,
    readonly diagnostics?: RuntimeDiagnostics,
  ) {}

  workload() {
    let estimatedProjectionBytes = 0;
    for (const id of this.conversations.keys()) estimatedProjectionBytes += (this.checkpointBytes.get(id) ?? 0) + (this.replayBytes.get(id) ?? 0);
    let entriesSampled = 0, sampledMetadataBytes = 0, messageIndexEntries = 0, messagePayloadBytes = 0;
    for (const summary of this.summaries.values()) {
      sampledMetadataBytes += Buffer.byteLength(JSON.stringify(summary));
      if (++entriesSampled === 32) break;
    }
    for (const offsets of this.messageOffsets.values()) messageIndexEntries += offsets.size;
    for (const bytes of this.messageTailBytes.values()) messagePayloadBytes += bytes;
    return { metadataEntriesSampled:entriesSampled,
      estimatedMetadataBytes:entriesSampled ? Math.round(sampledMetadataBytes*this.summaries.size/entriesSampled) : 0,
      messageIndexEntries, estimatedMessageIndexBytes:[...this.messageIndexBytes.values()].reduce((sum,bytes)=>sum+bytes,0), messagePayloadBytes, artifactDescriptors:this.artifactCache.size, eventCursors:this.eventCursors.size,
      observedJournalFiles:this.observedJournalBytes.size, observedJournalBytes:[...this.observedJournalBytes.values()].reduce((a,b)=>a+b,0),
      estimatedColdBytes:this.coldBytes,manifestCount: this.summaries.size, hotManifests:this.jobs.size, projectionCount: this.conversations.size, estimatedProjectionBytes,
      messageTailCount: this.messageTails.size, journalAnchors: this.journalAnchors.size,
      pendingConversations: this.pendingConversations.size, pendingLocks: this.conversationLocks.size,
      flushFailures: this.conversationFlushFailures.size, replayBufferBytes: this.recentConversationChanges.serializedBytes };
  }

  async initialize(): Promise<void> {
    await mkdir(this.jobsDir, { recursive: true });
    await mkdir(this.handoffRoot, { recursive: true });
    const entries = await readdir(this.jobsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) {
        continue;
      }
      try {
        let record = JSON.parse(await readFile(this.manifestPath(entry.name), "utf8")) as JobRecord;
        if (record.schemaVersion !== 1 || record.id !== entry.name) {
          continue;
        }
        try { record = await this.recoverManifestEvent(record); }
        catch (error) {
          this.uncertainManifests.add(record.id);
          this.detachedManifests.add(record.id);
          this.diagnostics?.observe("manifest","reconciliation_failed",{jobId:record.id,seq:record.lastEventSeq});
          this.diagnostics?.record("pipeline_fault",{error});
        }
        this.indexRecord(record);
        this.idempotencyIndex.set(record.idempotencyKey, record.id);
      } catch {
        this.diagnostics?.observe("manifest", "unreadable", {jobId:entry.name}, true);
        continue;
      }
    }
    for (const summary of this.summaries.values()) {
      if (this.uncertainManifests.has(summary.id)) continue;
      if (!ACTIVE_STATUSES.has(summary.status) && !summary.pendingApprovalCount) continue;
      const record = this.requireJob(summary.id);
      const approvalState: PendingApproval["state"] = record.status === "cancelled" ? "cancelled" : "expired";
      this.jobs.set(record.id,record);
      const settledApprovals = settlePendingApprovals(record, approvalState);
      if (ACTIVE_STATUSES.has(record.status)) {
        record.restartInterruptedTurnId = record.turnId;
        if (record.nativeRequest) record.nativeRequest = {...record.nativeRequest,state:"unknown"};
        await this.transition(
          record.id,
          "interrupted",
          "Controller restarted before the job reached a terminal state; the turn was not retried automatically.",
        );
      } else if (settledApprovals > 0) {
        await this.mutateUnlocked(record.id, () => ({
          type: "codex.approval.recovered",
          message: `Recovered ${settledApprovals} stale pending approval(s) as ${approvalState}.`,
          data: { count: settledApprovals, state: approvalState },
        }));
      }
    }
  }

  private async loadProjection(jobId: string): Promise<ConversationThreadProjection> {
    const failure = this.conversationFailures.get(jobId);
    if (failure) throw failure;
    const cached = this.conversations.get(jobId);
    if (cached) return cached;
    let loading = this.loads.get(jobId);
    if (!loading) {
      const started = performance.now();
      loading = this.readConversation(this.requireJob(jobId)).then(({ projection, diagnostics }) => {
        this.diagnostics?.observe("replay", "loaded", {jobId, revision:projection.revision, elapsedMs:performance.now()-started});
        this.conversations.set(jobId, projection);
        this.conversationDiagnostics.set(jobId, diagnostics);
        return projection;
      }).catch(error => {
        this.diagnostics?.observe("replay", error instanceof ConversationPersistenceError ? error.code : "io_failed", {jobId}, true);
        if (error instanceof ConversationPersistenceError) this.conversationFailures.set(jobId, error);
        throw error;
      }).finally(() => this.loads.delete(jobId));
      this.loads.set(jobId, loading);
    }
    return loading;
  }

  private trimCold(jobId: string) {
    this.coldBytes -= this.coldReads.get(jobId) ?? 0;
    this.coldReads.delete(jobId);
    if (!this.activeIds.has(jobId)) {
      const projected = (this.checkpointBytes.get(jobId) ?? 0) + (this.replayBytes.get(jobId) ?? 0);
      const messages = this.messageTailBytes.get(jobId) ?? 0;
      const bytes = projected + messages + (this.messageIndexBytes.get(jobId) ?? 0);
      this.coldReads.set(jobId, bytes);
      this.coldBytes += bytes;
    }
    if (this.mutations) return;
    for (const [id, bytes] of this.coldReads) {
      if (this.coldBytes <= CONVERSATION_DELIVERY.totalHotBytes) break;
      if (this.readers.has(id) || this.loads.has(id) || this.messageLoads.has(id) || this.pendingConversations.has(id)
        || this.conversationLocks.has(id) || this.pendingConversationCheckpoints.has(id) || this.activeIds.has(id)) continue;
      this.coldReads.delete(id);
      this.coldBytes -= bytes;
      this.messageTailBytes.delete(id);
      this.conversations.delete(id);
      this.messageTails.delete(id);
      this.messageOffsets.delete(id);
      this.messageIndexBytes.delete(id);
      this.eventCursors.delete(id);
      this.lastJournalRecord.delete(id);
      this.journalAnchors.delete(id);
      for (const path of [this.requestPath(id),this.responsePath(id),this.diffPath(id)]) this.artifactCache.delete(path);
    }
  }

  private async loadMessages(jobId: string) {
    if (this.messageTails.has(jobId)) return;
    let loading = this.messageLoads.get(jobId);
    if (!loading) {
      loading = (async () => {
        await this.ensureMessagesFile(this.requireJob(jobId));
        const file = await open(this.messagesPath(jobId), "r");
        const offsets = new Map<string,{start:number;end:number}>();
        const tail: ConversationMessage[] = [];
        try {
          for await (const line of jsonLines(file)) {
            if (!line.text.trim()) continue;
            const msg = JSON.parse(line.text) as ConversationMessage;
            if (msg.clientMessageId) offsets.set(msg.clientMessageId,{start:line.start,end:line.end});
            if (msg.dataClassification === "company_approved") this.companyHistory.add(jobId);
            tail.push(msg);
            if (tail.length > 200) tail.shift();
          }
        } finally { await file.close(); }
        this.messageTails.set(jobId, tail);
        this.messageOffsets.set(jobId, offsets);
        let indexBytes = 0;
        for (const id of offsets.keys()) indexBytes += Buffer.byteLength(id) + 16;
        this.messageIndexBytes.set(jobId,indexBytes);
        this.messageTailBytes.set(jobId, Buffer.byteLength(JSON.stringify(tail)));
      })().finally(() => this.messageLoads.delete(jobId));
      this.messageLoads.set(jobId, loading);
    }
    await loading;
  }

  private cacheMessage(jobId: string, message: ConversationMessage) {
    const tail = this.messageTails.get(jobId);
    if (tail) {
      tail.push(message);
      const removed = tail.length > 200 ? tail.shift() : undefined;
      this.messageTailBytes.set(jobId, (this.messageTailBytes.get(jobId) ?? 0) + Buffer.byteLength(JSON.stringify(message))
        - (removed ? Buffer.byteLength(JSON.stringify(removed)) : 0));
    }
    if (message.dataClassification === "company_approved") this.companyHistory.add(jobId);
  }

  async create(input: CreateJobInput): Promise<{ record: JobRecord; created: boolean }> {
    return this.exclusive(async () => {
      this.assertAdmissionOpen();
      const existingId = this.idempotencyIndex.get(input.idempotencyKey);
      if (existingId) {
        const existing = this.requireJob(existingId);
        if (existing.previewDigest !== input.previewDigest || existing.project.id !== input.project.id) {
          throw new Error("The idempotency key was already used for a different work package.");
        }
        return { record: structuredClone(existing), created: false };
      }

      const id = randomUUID();
      const now = new Date().toISOString();
      const record: JobRecord = {
        ...recordModelSelection(input.workPackage),
        schemaVersion: 1,
        dispatchSource: input.dispatchSource ?? "app",
        id,
        idempotencyKey: input.idempotencyKey,
        previewDigest: input.previewDigest,
        project: input.project,
        workPackage: input.workPackage,
        status: "queued",
        stateVersion: 1,
        lastEventSeq: 1,
        createdAt: now,
        updatedAt: now,
        currentExecutionMode: input.workPackage.executionMode,
        currentApprovalReviewer: input.workPackage.approvalReviewer,
        currentDataClassification: input.workPackage.dataClassification,
        model: input.workPackage.model,
        effort: input.workPackage.effort,
        speed: normalizeTurnSpeed(input.workPackage.speed),
        approvals: [],
        inputArtifacts: summarizeArtifacts(input.inputArtifacts ?? []),
      };
      await mkdir(this.jobDir(id), { recursive: false });
      await this.materializeInputArtifacts(id, input.inputArtifacts ?? []);
      await writeFile(
        this.requestPath(id),
        renderRequestMarkdown(input.workPackage, id, record.inputArtifacts),
        "utf8",
      );
      const initialMessage: ConversationMessage = {
        ...recordModelSelection(input.workPackage),
        id: randomUUID(),
        clientMessageId: `initial:${id}`,
        role: "user",
        content: input.workPackage.objective,
        context: input.workPackage.context || undefined,
        at: now,
        executionMode: input.workPackage.executionMode,
        approvalReviewer: input.workPackage.approvalReviewer,
        dataClassification: input.workPackage.dataClassification,
        model: input.workPackage.model,
        effort: input.workPackage.effort,
        speed: normalizeTurnSpeed(input.workPackage.speed),
        inputArtifacts: record.inputArtifacts,
      };
      await writeFile(this.messagesPath(id), `${JSON.stringify(initialMessage)}\n`, "utf8");
      const event: JobEvent = { seq: 1, at: now, type: "job.queued", message: "Work package queued.", data: { source: input.dispatchSource ?? "app" } };
      await writeFile(this.eventsPath(id), `${JSON.stringify(event)}\n`, "utf8");
      const conversation = createConversationProjection(undefined, now);
      await this.writeInitialConversation(id, conversation);
      await this.writeManifest(record);
      this.idempotencyIndex.set(input.idempotencyKey, id);
      this.conversations.set(id, conversation);
      this.trimCold(id);
      return { record: structuredClone(record), created: true };
    });
  }

  async importLocalThread(input: ImportLocalThreadInput): Promise<{ record: JobRecord; created: boolean }> {
    return this.exclusive(async () => {
      this.assertAdmissionOpen();
      const owner = this.findByThreadId(input.threadId);
      const existing = owner && this.requireJob(owner.id);
      if (existing) return { record: structuredClone(existing), created: false };

      const id = randomUUID();
      const now = new Date().toISOString();
      const idempotencyKey = `local-thread:${input.threadId}`;
      const record: JobRecord = {
        schemaVersion: 1,
        id,
        idempotencyKey,
        previewDigest: input.previewDigest,
        project: input.project,
        workPackage: input.workPackage,
        status: "completed",
        stateVersion: 1,
        lastEventSeq: 1,
        createdAt: now,
        updatedAt: now,
        threadId: input.threadId,
        currentExecutionMode: input.workPackage.executionMode,
        currentApprovalReviewer: input.workPackage.approvalReviewer,
        currentDataClassification: input.workPackage.dataClassification,
        model: input.workPackage.model,
        effort: input.workPackage.effort,
        approvals: [],
        inputArtifacts: [],
      };
      await mkdir(this.jobDir(id), { recursive: false });
      await writeFile(this.requestPath(id), renderRequestMarkdown(input.workPackage, id, []), "utf8");
      await writeFile(this.messagesPath(id), "", "utf8");
      const event: JobEvent = {
        seq: 1,
        at: now,
        type: "conversation.local_thread.imported",
        message: "Imported an existing local Codex conversation for operator continuation.",
      };
      await writeFile(this.eventsPath(id), `${JSON.stringify(event)}\n`, "utf8");
      const conversation = hydrateConversationProjection(
        createConversationProjection(input.threadId, now),
        input.threadResponse,
        now,
        input.freshness,
      );
      await this.writeInitialConversation(id, conversation);
      await this.writeManifest(record);
      this.idempotencyIndex.set(idempotencyKey, id);
      this.conversations.set(id, conversation);
      this.trimCold(id);
      return { record: structuredClone(record), created: true };
    });
  }

  get(jobId: string): JobRecord | undefined {
    return this.summaries.has(jobId) ? structuredClone(this.requireJob(jobId)) : undefined;
  }

  list(limit = 20): JobSummary[] {
    return this.listPage(limit).data;
  }

  readonly reconciliationJobs = new Set<string>();

  private indexRecord(record: JobRecord) {
    if (record.restartInterruptedTurnId || record.nativeRequest) this.reconciliationJobs.add(record.id);
    else this.reconciliationJobs.delete(record.id);
    const old = this.summaries.get(record.id);
    const summary = toSummary(record);
    const awaiting = (s:JobSummary) => Number(s.status === "awaiting_approval" || s.pendingApprovalCount > 0);
    this.pendingApprovals += summary.pendingApprovalCount - (old?.pendingApprovalCount ?? 0);
    this.awaitingApproval += awaiting(summary) - (old ? awaiting(old) : 0);
    if (old?.threadId && old.threadId !== summary.threadId) this.threadOwners.get(old.threadId)?.delete(record.id);
    if (summary.threadId) {
      const owners = this.threadOwners.get(summary.threadId) ?? new Set();
      owners.add(record.id);
      this.threadOwners.set(summary.threadId, owners);
    }
    if (summary.result?.output !== undefined) {
      this.withResultOutput.add(record.id);
      summary.result = {...summary.result, output:undefined};
    } else this.withResultOutput.delete(record.id);
    this.summaries.set(record.id, summary);
    if (ACTIVE_STATUSES.has(record.status)) {
      this.activeIds.add(record.id);
      this.jobs.set(record.id, record);
    } else {
      this.activeIds.delete(record.id);
      this.jobs.delete(record.id);
      if (this.conversations.has(record.id)) this.trimCold(record.id);
    }
  }

  notificationTarget(id: string) {
    const record = this.jobs.get(id);
    const indexed = this.summaries.get(id);
    if (!indexed || this.uncertainManifests.has(id)) return;
    return {status:indexed.status,threadId:indexed.threadId,turnId:indexed.turnId,priorTurnId:record?.controlAction?.priorTurnId};
  }

  jobCounts() {
    return {total:this.summaries.size, active:this.activeIds.size, approvals:this.pendingApprovals, awaitingApproval:this.awaitingApproval};
  }

  summary(id: string): JobSummary {
    const summary = structuredClone(this.summaries.get(id)!);
    if (this.withResultOutput.has(id)) summary.result = structuredClone(this.requireJob(id).result);
    return summary;
  }

  inventory(): JobSummary[] {
    return Array.from(this.summaries.values())
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
  }

  listAll(): JobSummary[] {
    return this.inventory().map(s => this.summary(s.id));
  }

  findByThreadId(threadId: string): JobSummary | undefined {
    const owners = Array.from(this.threadOwners.get(threadId) ?? [], id => this.summaries.get(id)!);
    const owner = owners.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))[0];
    return owner && this.summary(owner.id);
  }

  listPage(limit = 50, cursor?: string, projectId?: string): ConversationListPage {
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const decodedCursor = cursor ? decodeConversationCursor(cursor) : undefined;
    const records = Array.from(this.summaries.values())
      .filter((record) => !projectId || record.projectId === projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .filter((record) => !decodedCursor || record.createdAt < decodedCursor.createdAt || (
        record.createdAt === decodedCursor.createdAt && record.id < decodedCursor.id
      ));
    const page = records.slice(0, boundedLimit);
    const last = page.at(-1);
    return {
      data: page.map(record => this.summary(record.id)),
      nextCursor: records.length > page.length && last ? encodeConversationCursor(last.createdAt, last.id) : undefined,
    };
  }

  async snapshot(
    jobId: string,
    afterSeq = 0,
    maxEvents = 80,
    afterConversationRevision?: number,
    forceSnapshot = false,
  ): Promise<JobSnapshot> {
    return this.committedRead(jobId, () => this.readSnapshot(jobId, afterSeq, maxEvents, afterConversationRevision, forceSnapshot));
  }

  private committedRead<T>(jobId: string, read: () => Promise<T>): Promise<T> {
    return this.withReader(jobId, async () => {
      const version = this.requireJob(jobId).stateVersion;
      const unchanged = () => !this.writingManifests.has(jobId) && this.requireJob(jobId).stateVersion === version;
      if (unchanged()) {
        try {
          const view = await read();
          if (unchanged()) return view;
        } catch (error) {
          if (unchanged()) throw error;
        }
      }
      return this.exclusive(read);
    });
  }

  private async withReader<T>(jobId: string, read: () => Promise<T>): Promise<T> {
    this.readers.set(jobId, (this.readers.get(jobId) ?? 0) + 1);
    try { return await read(); }
    finally {
      const left = this.readers.get(jobId)! - 1;
      if (left) this.readers.set(jobId,left); else this.readers.delete(jobId);
      if (this.summaries.has(jobId)) this.trimCold(jobId);
    }
  }

  private async readSnapshot(
    jobId: string,
    afterSeq = 0,
    maxEvents = 80,
    afterConversationRevision?: number,
    forceSnapshot = false,
  ): Promise<JobSnapshot> {
    const record = this.requireJob(jobId);
    const persistenceFailure = this.conversationFailures.get(jobId);
    if (persistenceFailure) throw persistenceFailure;
    const storedConversation = await this.loadProjection(jobId);
    await this.loadMessages(jobId);
    const events = await this.readEvents(jobId, afterSeq, maxEvents, record.lastEventSeq);
    const messages = structuredClone(this.messageTails.get(jobId)!);
    const nextEventSeq = events.at(-1)?.seq ?? Math.min(record.lastEventSeq, Math.max(0, afterSeq));

    let conversation = afterConversationRevision === undefined || forceSnapshot
      ? mergeConversationMessages(storedConversation, messages)
      : undefined;
    const recent = afterConversationRevision === undefined || forceSnapshot ? []
      : this.recentConversationChanges.read(jobId, afterConversationRevision, storedConversation.revision);
    let conversationChanges = afterConversationRevision === undefined || forceSnapshot
      ? []
      : recent ?? [];
    let nextConversationRevision = conversation ? storedConversation.revision : afterConversationRevision ?? storedConversation.revision;
    if (conversationChanges.length > 0) {
      const expectedFirst = Math.max(0, afterConversationRevision ?? 0) + 1;
      if (conversationChanges[0]?.revision !== expectedFirst) {
        conversation = mergeConversationMessages(storedConversation, messages);
        conversationChanges = [];
        nextConversationRevision = storedConversation.revision;
      } else {
        nextConversationRevision = conversationChanges.at(-1)?.revision ?? nextConversationRevision;
      }
    } else if (afterConversationRevision !== undefined && afterConversationRevision !== storedConversation.revision) {
      conversation = mergeConversationMessages(storedConversation, messages);
      nextConversationRevision = storedConversation.revision;
    }
    const known = new Set(messages.map(m => m.clientMessageId));
    const missing = new Set<string>();
    for (const turn of conversation?.turns ?? conversationChanges.flatMap(p => p.turns)) {
      for (const item of turn.items) if (item.clientMessageId && !known.has(item.clientMessageId)) missing.add(item.clientMessageId);
    }
    const allMessages = missing.size ? [...messages, ...await this.readMessagesById(jobId, missing)] : messages;
    const directActionHistoryEligible = !record.idempotencyKey.startsWith("local-thread:") && !(await this.hasCompanyHistory(jobId));
    return {
      ...toSummary(record),
      directActionHistoryEligible,
      commandFailureDiagnostics: directActionHistoryEligible
        ? projectCommandFailures(record.id, record.threadId, storedConversation) : undefined,
      messages,
      conversation: conversation ? mergeConversationMessages(conversation, allMessages, true) : undefined,
      conversationChanges: conversationChanges.map((patch) => ({
        ...patch,
        turns: mergeConversationMessages({ ...storedConversation, turns: patch.turns }, allMessages, true).turns,
      })),
      nextConversationRevision,
      serverConversationRevision: storedConversation.revision,
      conversationHasMore: nextConversationRevision < storedConversation.revision,
      conversationDelivery: {
        mode: conversation ? "snapshot" : nextConversationRevision < storedConversation.revision ? "catch_up" : "delta",
        reason: forceSnapshot ? "client_recovery" : recent === undefined ? "cursor_outside_replay_budget" : undefined,
        lag: Math.max(0, storedConversation.revision - nextConversationRevision),
        maxCatchUpMs: CONVERSATION_DELIVERY.maxCatchUpMs,
        maxCatchUpPages: CONVERSATION_DELIVERY.maxCatchUpPages,
        pending: this.pendingConversations.has(jobId),
        flushFailed: this.conversationFlushFailures.has(jobId),
        inputNotifications: this.conversationInputCounts.get(jobId) ?? 0,
        durableCommits: this.conversationCommitCounts.get(jobId) ?? 0,
        ...this.recentConversationChanges.diagnostics(jobId),
      },
      conversationDiagnostics: structuredClone(this.conversationDiagnostics.get(jobId) ?? []),
      events,
      nextEventSeq,
      serverLastEventSeq: record.lastEventSeq,
      hasMore: nextEventSeq < record.lastEventSeq,
      approvals: structuredClone(record.approvals),
      hasDiff: await fileExists(this.diffPath(jobId)),
      hasResult: Boolean(record.result),
      inputArtifacts: structuredClone(record.inputArtifacts ?? []),
      artifacts: await this.artifactDescriptors(jobId),
    };
  }

  async nativeMessageDelivery(jobId: string, clientMessageId: string): Promise<"duplicate" | "failed" | "unknown"> {
    const committed = this.requireJob(jobId).lastEventSeq;
    const file = await open(this.eventsPath(jobId), "r");
    try {
      for await (const line of jsonLines(file)) {
        if (!line.terminated) break;
        const event = JSON.parse(line.text) as JobEvent;
        if (event.seq > committed) break;
        if ((event.type === "operator.steered" || event.type === "codex.turn.started") && event.data?.clientMessageId === clientMessageId) return "duplicate";
        if (event.type === "codex.turn.failed" && event.data?.failedClientMessageId === clientMessageId) return "failed";
        if (event.seq === committed) break;
      }
      return "unknown";
    } finally { await file.close(); }
  }

  async isUserMessageRetry(jobId: string, input: AppendUserMessageInput): Promise<boolean> {
    return this.withReader(jobId, () => this.checkMessageIdentity(jobId, input));
  }

  private async checkMessageIdentity(jobId: string, input: AppendUserMessageInput): Promise<boolean> {
    await this.loadMessages(jobId);
    if (!this.messageOffsets.get(jobId)?.has(input.clientMessageId)) return false;
    const existing = (await this.readMessagesById(jobId, new Set([input.clientMessageId])))[0];
    const fingerprint = (message: AppendUserMessageInput | ConversationMessage) => JSON.stringify([
      message.content, message.context || "", message.executionMode, message.approvalReviewer,
      message.dataClassification, message.model, message.effort, message.speed ?? "standard",
      (message.inputArtifacts ?? []).map(({ id, sha256 }) => [id, sha256]),
    ]);
    if (!existing || fingerprint(existing) !== fingerprint(input)) throw new Error("The client message id was already used for different content or settings.");
    return true;
  }

  async appendUserMessage(
    jobId: string,
    input: AppendUserMessageInput,
  ): Promise<{ record: JobRecord; created: boolean }> {
    return this.exclusive(async () => {
      this.assertAdmissionOpen();
      const record = this.requireJob(jobId);
      await this.loadProjection(jobId);
      const persistenceFailure = this.conversationFailures.get(jobId);
      if (persistenceFailure) throw persistenceFailure;
      await this.loadMessages(jobId);
      if (await this.isUserMessageRetry(jobId, input)) {
        return { record: structuredClone(record), created: false };
      }
      const message: ConversationMessage = {
        selectionRecorded: true,
        selectionKind: input.selectionKind ?? (ACTIVE_STATUSES.has(record.status) ? "steer" : "turn"),
        modelSource: input.modelSource ?? (input.model === undefined ? "default" : "explicit"),
        effortSource: input.effortSource ?? (input.effort === undefined ? "default" : "explicit"),
        id: randomUUID(),
        clientMessageId: input.clientMessageId,
        role: "user",
        content: input.content,
        context: input.context || undefined,
        at: new Date().toISOString(),
        executionMode: input.executionMode,
        approvalReviewer: input.approvalReviewer,
        dataClassification: input.dataClassification,
        model: input.model,
        effort: input.effort,
        speed: input.speed,
        inputArtifacts: summarizeArtifacts(input.inputArtifacts ?? []),
      };
      await this.materializeInputArtifacts(jobId, input.inputArtifacts ?? []);
      const updated = await this.mutateUnlocked(jobId, current => {
        current.inputArtifacts = mergeArtifactSummaries(current.inputArtifacts ?? [], message.inputArtifacts ?? []);
        return {
        type: "conversation.user_message.appended",
        message: "User added a conversation message.",
        data: {
          clientMessageId: input.clientMessageId,
          characterCount: input.content.length,
          inputArtifacts: message.inputArtifacts?.map(({ id, fileName, chars, bytes, sha256 }) => ({ id, fileName, chars, bytes, sha256 })),
        },
        };
      }, message);
      return { record: updated, created: true };
    });
  }

  // A prior pre-start failure can clear manifest.turnId. Use the committed
  // projection for identity without hydrating messages, artifacts or native history.
  async lastProjectedTurnId(jobId: string, threadId: string): Promise<string | undefined> {
    return this.committedRead(jobId, async () => {
      const projection = await this.loadProjection(jobId);
      return projection.threadId === threadId ? projection.turns.at(-1)?.turnId : undefined;
    });
  }

  async prepareTurn(jobId: string, input: PrepareTurnInput): Promise<JobRecord> {
    return this.mutate(jobId, (record) => {
      this.assertAdmissionOpen();
      record.restartInterruptedTurnId = undefined;
      record.controlAction = input.controlAction;
      record.status = "preparing";
      record.turnId = undefined;
      record.currentExecutionMode = input.executionMode;
      record.currentApprovalReviewer = input.approvalReviewer;
      record.currentDataClassification = input.dataClassification;
      record.model = input.model;
      record.effort = input.effort;
      const selection = input.controlAction ? recordModelSelection({}, input) : recordModelSelection(input);
      Object.assign(record, selection, {
        modelSource: input.modelSource ?? selection.modelSource,
        effortSource: input.effortSource ?? selection.effortSource,
      });
      record.speed = input.controlAction ? undefined : normalizeTurnSpeed(input.speed);
      return {
        type: "conversation.turn.preparing",
        message: "Preparing the next Codex turn.",
        data: { executionMode: input.executionMode, approvalReviewer: input.approvalReviewer, model: input.model, effort: input.effort, speed: record.speed,
          selectionRecorded: record.selectionRecorded, selectionKind: record.selectionKind, modelSource: record.modelSource, effortSource: record.effortSource },
      };
    });
  }

  async hasCompanyHistory(jobId: string, messages?: ConversationMessage[]): Promise<boolean> {
    const job = this.requireJob(jobId);
    await this.loadMessages(jobId);
    return this.companyHistory.has(jobId) || job.workPackage.dataClassification === "company_approved" ||
      job.currentDataClassification === "company_approved" ||
      (messages ?? []).some((message) => message.dataClassification === "company_approved");
  }

  async recordDirectRequest(jobId: string, key: string, digest: string, state: "pending" | "completed" | "unknown", inputVersion?: 2 | 3 | 3): Promise<JobRecord> {
    return this.mutate(jobId, (record) => {
      record.directRequests ??= {};
      record.directRequests[key] = { digest, state, ...(inputVersion ? { inputVersion } : {}) };
      return { type: "operator.direct_request", message: "Direct operation receipt updated.", data: { source: "model_direct", requestId: key, state } };
    });
  }

  async markNativeDisconnected(jobId: string): Promise<JobRecord> {
    await this.flushConversation(jobId);
    return this.mutate(jobId, record => {
      record.restartInterruptedTurnId = record.turnId;
      record.status = "interrupted";
      settlePendingApprovals(record, "expired");
      return {type:"codex.transport.disconnected",message:"App Server disconnected. Native turn outcome requires readback."};
    });
  }

  async transition(
    jobId: string,
    status: JobStatus,
    message: string,
    data?: Record<string, unknown>,
  ): Promise<JobRecord> {
    return this.mutate(jobId, (record) => {
      record.status = status;
      return { type: `job.${status}`, message, data };
    });
  }

  async appendEvent(
    jobId: string,
    type: string,
    message: string,
    data?: Record<string, unknown>,
  ): Promise<JobRecord> {
    return this.mutate(jobId, () => ({ type, message, data }));
  }

  async recordNativeRequest(jobId: string, request: NonNullable<JobRecord["nativeRequest"]>) {
    return this.mutate(jobId, record => {
      record.nativeRequest = request;
      return {type: "native.request." + request.state, message: "Native request delivery " + request.state + ".", data: {...request}};
    });
  }

  async setThread(jobId: string, threadId: string): Promise<JobRecord> {
    const record = await this.mutate(jobId, (record) => {
      record.threadId = threadId;
      record.nativeRequest = undefined;
      return { type: "codex.thread.started", message: "Codex thread started.", data: { threadId } };
    });
    await this.updateConversation(jobId, (current) => ({ ...current, threadId }));
    return record;
  }

  async setTurn(jobId: string, turnId: string, detached = false): Promise<JobRecord> {
    return this.mutate(jobId, (record) => {
      const clientMessageId = record.nativeRequest?.clientMessageId;
      record.turnId = turnId;
      record.nativeRequest = undefined;
      record.restartInterruptedTurnId = detached ? turnId : undefined;
      record.status = detached ? "interrupted" : "running";
      return { type: "codex.turn.started", message: "Codex turn started.", data: { turnId, clientMessageId } };
    });
  }

  async addApproval(jobId: string, approval: PendingApproval): Promise<JobRecord> {
    return this.mutate(jobId, (record) => {
      record.approvals.push(approval);
      record.status = "awaiting_approval";
      return {
        type: "codex.approval.requested",
        message: `Codex requested ${approval.kind.replaceAll("_", " ")} approval.`,
        data: { approvalId: approval.id, kind: approval.kind },
      };
    });
  }

  async resolveApproval(jobId: string, approvalId: string, state: PendingApproval["state"]): Promise<JobRecord> {
    return this.mutate(jobId, (record) => {
      const approval = record.approvals.find((item) => item.id === approvalId);
      if (!approval) {
        throw new Error(`Unknown approval id '${approvalId}'.`);
      }
      if (approval.state !== "pending") {
        throw new Error(`Approval '${approvalId}' is already ${approval.state}.`);
      }
      approval.state = state;
      approval.resolvedAt = new Date().toISOString();
      record.status = record.approvals.some((item) => item.state === "pending") ? "awaiting_approval" : "running";
      return {
        type: "codex.approval.resolved",
        message: `Approval ${state}.`,
        data: { approvalId, state },
      };
    });
  }

  async setDiff(jobId: string, diff: string): Promise<JobRecord> {
    const bounded = diff.length > 2_000_000 ? `${diff.slice(0, 2_000_000)}\n[diff truncated]\n` : diff;
    await writeFile(this.diffPath(jobId), bounded, "utf8");
    return this.appendEvent(jobId, "codex.diff.updated", "Codex updated the aggregated diff.", {
      bytes: Buffer.byteLength(bounded),
      truncated: bounded !== diff,
    });
  }

  async applyConversationNotification(jobId: string, notification: ConversationNotification, at?: string, coalesce?: boolean): Promise<ConversationThreadProjection>;
  async applyConversationNotification(jobId: string, notification: ConversationNotification, at: string | undefined, coalesce: boolean, returnProjection: false): Promise<void>;
  async applyConversationNotification(
    jobId: string,
    notification: ConversationNotification,
    at = new Date().toISOString(),
    coalesce = false,
    returnProjection = true,
  ): Promise<ConversationThreadProjection | void> {
    this.conversationInputCounts.set(jobId, (this.conversationInputCounts.get(jobId) ?? 0) + 1);
    if (coalesce && isCoalescibleConversationNotification(notification.method)) {
      return this.withConversationLock(jobId, async () => {
        this.requireJob(jobId);
        const failure = this.conversationFailures.get(jobId);
        if (failure) throw failure;
        const current = this.pendingConversations.get(jobId) ?? await this.loadProjection(jobId);
        const next = reduceConversationNotification(current, notification, at);
        if (next === current) return returnProjection ? structuredClone(current) : undefined;
        // Pending state is never exposed with a durable cursor.
        next.revision = current.revision;
        this.pendingConversations.set(jobId, next);
        if (notification.method === "turn/diff/updated") {
          const diff = notification.params?.diff ?? notification.params?.unifiedDiff;
          if (typeof diff === "string") this.pendingDiffs.set(jobId, diff.length > 2_000_000 ? `${diff.slice(0, 2_000_000)}\n[diff truncated]\n` : diff);
        }
        if (!this.conversationTimers.has(jobId)) {
          const timer = setTimeout(() => {
            this.conversationTimers.delete(jobId);
            void this.flushConversation(jobId).catch((error) => {
              this.diagnostics?.observe("journal","timer_flush_failed",{jobId},true);
              // Expose failure even for a diff IO error; do not retry in a tight loop.
              this.conversationFlushFailures.add(jobId);
            });
          }, CONVERSATION_DELIVERY.coalesceMs);
          timer.unref();
          this.conversationTimers.set(jobId, timer);
        }
        return returnProjection ? structuredClone(next) : undefined;
      });
    }
    const updated = await this.updateConversation(jobId, (current) => reduceConversationNotification(current, notification, at));
    if (returnProjection) return structuredClone(updated);
  }

  async flushConversation(jobId: string): Promise<void> {
    await this.updateConversation(jobId, (current) => current);
  }

  async flushConversations(): Promise<void> {
    await Promise.all([...this.pendingConversations.keys()].map((jobId) => this.flushConversation(jobId)));
  }

  conversationRevision(jobId: string): number {
    return this.conversations.get(jobId)?.revision ?? 0;
  }

  async hydrateConversation(
    jobId: string,
    response: Record<string, unknown>,
    at = new Date().toISOString(),
    freshness?: import("./types.js").ConversationFreshness,
  ): Promise<ConversationThreadProjection> {
    return structuredClone(await this.updateConversation(jobId, (current) => hydrateConversationProjection(current, response, at, freshness)));
  }

  async hydrateCurrentTurn(jobId:string, turnId:string, response: Record<string,unknown>, at:string,
    freshness: import("./types.js").ConversationFreshness) {
    return this.updateConversation(jobId,current => {
      const index = current.turns.findIndex(turn => turn.turnId === turnId);
      const head = hydrateConversationProjection({...current, turns:index < 0 ? [] : [current.turns[index]]},response,at,{...freshness,
        bridgeMessagesMetadataOnly:current.freshness?.synchronized || current.freshness?.bridgeMessagesMetadataOnly});
      if (head.turns.length !== 1 || head.turns[0].turnId !== turnId) throw new Error("NATIVE_TURN_CHANGED");
      if (index >= 0) {
        const nativeItems = new Map(head.turns[0].items.map(item => [item.id, item]));
        for (const live of current.turns[index].items) {
          const item = nativeItems.get(live.id);
          if (!item || (live.text && item.text !== live.text && !item.text?.startsWith(live.text))
            || (live.status === "completed" && item.status !== "completed")) throw new Error("NATIVE_HEAD_BEHIND_COMMIT");
        }
      }
      const turns = current.turns.slice();
      if (index < 0) turns.push(head.turns[0]); else turns[index] = head.turns[0];
      return {...head, turns, createdAt:current.createdAt ?? head.createdAt};
    }).then(projection => structuredClone(projection.turns.find(turn => turn.turnId === turnId)));
  }

  async markConversationFreshness(
    jobId: string,
    freshness: import("./types.js").ConversationFreshness,
  ): Promise<ConversationThreadProjection> {
    return structuredClone(await this.updateConversation(jobId, (current) => ({
      ...current,
      freshness: structuredClone(freshness),
      revision: current.revision + 1,
    })));
  }

  async complete(jobId: string, result: JobResult, failedClientMessageId?: string): Promise<JobRecord> {
    await this.flushConversation(jobId);
    return this.exclusive(async () => {
      let message: ConversationMessage | undefined;
      const record = this.requireJob(jobId);
      const assistantMessageId = `assistant:${result.turnId || record.turnId || record.stateVersion}`;
      await this.loadMessages(jobId);
      if (!this.messageOffsets.get(jobId)!.has(assistantMessageId)) {
        message = {
          id: randomUUID(),
          clientMessageId: assistantMessageId,
          role: "assistant",
          content: result.output || result.message,
          at: result.completedAt,
          turnId: result.turnId || record.turnId,
          model: record.model,
          effort: record.effort,
          selectionRecorded: record.selectionRecorded,
          selectionKind: record.selectionKind,
          modelSource: record.modelSource,
          effortSource: record.effortSource,
          resultStatus: result.status,
        };
      }
      return this.mutateUnlocked(jobId, (current) => {
        settlePendingApprovals(current, result.status === "cancelled" ? "cancelled" : "expired");
        current.restartInterruptedTurnId = undefined;
        current.nativeRequest = undefined;
        current.result = result;
        current.status = result.status;
        return { type: `codex.turn.${result.status}`, message: result.message, ...(failedClientMessageId ? {data:{failedClientMessageId}} : {}) };
      }, message, true);
    });
  }

  async readArtifact(jobId: string, artifact: "request" | "response" | "diff" | "result", maxChars = 100_000): Promise<string> {
    return this.committedRead(jobId, () => this.readArtifactPrefix(jobId,artifact,maxChars));
  }

  private async readArtifactPrefix(jobId: string, artifact: JobArtifactKind | "result", maxChars: number) {
    const record = this.requireJob(jobId);
    if ((artifact === "response" || artifact === "result") && !record.result) throw new Error(`Artifact '${artifact}' is not available for job '${jobId}'.`);
    const path = artifact === "request"
      ? this.requestPath(jobId)
      : artifact === "response"
        ? this.responsePath(jobId)
        : artifact === "diff"
          ? this.diffPath(jobId)
          : this.resultPath(jobId);
    try {
      let content = "";
      for await (const block of createReadStream(path, {encoding:"utf8"})) {
        content += block;
        if (content.length > maxChars) return content.slice(0,maxChars) + "\n[artifact truncated]\n";
      }
      return content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Artifact '${artifact}' is not available for job '${jobId}'.`);
      }
      throw error;
    }
  }

  listArtifacts(jobId: string): Promise<JobArtifactDescriptor[]> {
    return this.committedRead(jobId, () => this.artifactDescriptors(jobId));
  }

  private async artifactDescriptors(jobId: string): Promise<JobArtifactDescriptor[]> {
    const record = this.requireJob(jobId);
    const candidates: Array<{ id: JobArtifactKind; name: string; mimeType: string; path: string }> = [
      { id: "request", name: "request.md", mimeType: "text/markdown", path: this.requestPath(jobId) },
      { id: "response", name: "response.md", mimeType: "text/markdown", path: this.responsePath(jobId) },
      { id: "diff", name: "diff.patch", mimeType: "text/x-patch", path: this.diffPath(jobId) },
    ];
    const output: JobArtifactDescriptor[] = [];
    for (const candidate of candidates) {
      if (candidate.id === "response" && !record.result) continue;
      try {
        const details = await stat(candidate.path,{bigint:true});
        const stamp = [details.ino,details.size,details.mtimeNs,details.ctimeNs].join("/");
        const cached = this.artifactCache.get(candidate.path);
        if (cached?.stamp === stamp) { output.push({...cached.descriptor}); continue; }
        const hash = createHash("sha256");
        const anchors = [{chars:0,bytes:0}];
        let chars = 0, bytes = 0;
        for await (const chunk of createReadStream(candidate.path, {encoding:"utf8"})) {
          const text = String(chunk);
          hash.update(text);
          chars += text.length;
          bytes += Buffer.byteLength(text);
          if (bytes - anchors[anchors.length-1].bytes >= 65536) anchors.push({chars,bytes});
        }
        const after = await stat(candidate.path,{bigint:true});
        if ([after.ino,after.size,after.mtimeNs,after.ctimeNs].join("/") !== stamp || BigInt(bytes) !== after.size)
          throw new Error("ARTIFACT_CHANGED_OR_INVALID_UTF8");
        const descriptor = {id:candidate.id, name:candidate.name, mimeType:candidate.mimeType, chars, bytes, sha256:hash.digest("hex")};
        this.artifactCache.set(candidate.path,{stamp,descriptor,anchors});
        output.push({...descriptor});
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return output;
  }

  async readArtifactChunk(
    jobId: string,
    artifact: JobArtifactKind,
    cursor = 0,
    maxChars = 20_000,
  ): Promise<JobArtifactChunk> {
    return this.committedRead(jobId, () => this.readChunk(jobId, artifact, cursor, maxChars));
  }

  private async readChunk(jobId:string, artifact:JobArtifactKind, cursor:number, maxChars:number): Promise<JobArtifactChunk> {
    const descriptor = (await this.artifactDescriptors(jobId)).find((item) => item.id === artifact);
    if (!descriptor) throw new Error(`Artifact '${artifact}' is not available for job '${jobId}'.`);
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > descriptor.chars) throw new Error("Invalid artifact cursor.");
    if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 20_000) throw new Error("maxChars must be between 1 and 20000.");
    const path = artifact === "request" ? this.requestPath(jobId) : artifact === "response" ? this.responsePath(jobId) : this.diffPath(jobId);
    const cached = this.artifactCache.get(path);
    if (!cached || cached.descriptor.sha256 !== descriptor.sha256) throw new Error("ARTIFACT_CHANGED");
    let anchor = cached.anchors[0];
    for (const entry of cached.anchors) {
      if (entry.chars > cursor) break;
      anchor = entry;
    }
    let pos = anchor.chars, content = "";
    const stop = Math.min(cursor + maxChars,descriptor.chars);
    if (pos < stop) {
      for await (const block of createReadStream(path,{start:anchor.bytes,encoding:"utf8"})) {
        const text = String(block);
        content += text.slice(Math.max(0,cursor-pos),Math.max(0,stop-pos));
        pos += text.length;
        if (pos >= stop) break;
      }
    }
    const after = await stat(path,{bigint:true});
    if ([after.ino,after.size,after.mtimeNs,after.ctimeNs].join("/") !== cached.stamp || content.length !== stop-cursor)
      throw new Error("ARTIFACT_CHANGED");
    const end = cursor + content.length;
    return { ...descriptor, cursor, nextCursor: end < descriptor.chars ? end : undefined, done: end >= descriptor.chars, content };
  }

  async readInputArtifacts(jobId: string, bundleIds?: string[]): Promise<MaterializedTextArtifact[]> {
    const record = this.requireJob(jobId);
    const wanted = new Set(bundleIds ?? (record.inputArtifacts ?? []).map((artifact) => artifact.id));
    const summaries = (record.inputArtifacts ?? []).filter((artifact) => wanted.has(artifact.id));
    if (summaries.length !== wanted.size) throw new Error("One or more staged text artifacts are not attached to this job.");
    const artifacts = await Promise.all(summaries.map(async (artifact) => {
      const content = await readFile(this.inputArtifactPath(jobId, artifact.id), "utf8");
      assertArtifactDigest(artifact, content);
      const localPath = await this.ensureHandoffCopy(jobId, artifact, content);
      return { ...artifact, content, localPath };
    }));
    await this.writeHandoffManifest(jobId, record.inputArtifacts ?? []);
    return artifacts;
  }

  jobDirectory(jobId: string): string {
    this.requireJob(jobId);
    return this.jobDir(jobId);
  }

  requestFile(jobId: string): string {
    this.requireJob(jobId);
    return this.requestPath(jobId);
  }

  private async mutate(
    jobId: string,
    change: (record: JobRecord) => { type: string; message: string; data?: Record<string, unknown> },
  ): Promise<JobRecord> {
    return this.exclusive(() => this.mutateUnlocked(jobId, change));
  }

  private async mutateUnlocked(
    jobId: string,
    change: (record: JobRecord) => { type: string; message: string; data?: Record<string, unknown> },
    message?: ConversationMessage,
    publishResult = false,
  ): Promise<JobRecord> {
    const previous = this.requireJob(jobId);
    const record = structuredClone(previous);
    const nextEvent = change(record);
    const now = new Date().toISOString();
    record.updatedAt = now;
    record.stateVersion += 1;
    record.lastEventSeq += 1;
    const event: JobEvent = {
      seq: record.lastEventSeq,
      at: now,
      type: nextEvent.type,
      message: nextEvent.message,
      data: nextEvent.data ? (sanitizeForStorage(nextEvent.data) as Record<string, unknown>) : undefined,
    };
    // A single owner holds the store lock. Publish the local intent before either
    // file changes so restart can finish this exact event without calling native.
    const path = this.manifestPath(jobId) + ".pending";
    const staged = path + ".tmp";
    const offset = (await stat(this.eventsPath(jobId))).size;
    const effects = {message, messageOffset: message ? (await stat(this.messagesPath(jobId))).size : undefined, publishResult};
    let published = false;
    this.writingManifests.add(jobId);
    try {
      await writeFile(staged, JSON.stringify({record,event,offset, effects}), {encoding:"utf8",flush:true});
      await rename(staged,path);
      published = true;
      await this.applyManifestEffects(record, effects);
      await appendFile(this.eventsPath(jobId), JSON.stringify(event) + "\n", {encoding:"utf8",flush:true});
      await this.writeManifest(record);
      await unlink(path);
    } catch (error) {
      if (!published) throw error;
      try {
        // We still own the writer lock. Finish only the exact durable intent.
        const reconciled = await this.recoverManifestEvent(previous);
        if (reconciled.lastEventSeq === event.seq) return structuredClone(reconciled);
      } catch (recoveryError) {
        this.diagnostics?.observe("manifest", "reconciliation_failed", {jobId, seq:event.seq}, true, recoveryError);
      }
      this.uncertainManifests.add(jobId);
      this.diagnostics?.observe("manifest","persistence_failed",{jobId,threadId:record.threadId,turnId:record.turnId,seq:event.seq});
      this.diagnostics?.record("pipeline_fault",{error});
      throw error;
    } finally { this.writingManifests.delete(jobId); }
    return structuredClone(record);
  }

  private async recoverManifestEvent(current: JobRecord): Promise<JobRecord> {
    const path = this.manifestPath(current.id) + ".pending";
    let saved: string;
    try { saved = await readFile(path,"utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return current; throw error; }
    const {record,event,offset,effects} = JSON.parse(saved);
    if (record?.schemaVersion !== 1 || record.id !== current.id || record.idempotencyKey !== current.idempotencyKey ||
      !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(event?.seq) || record.lastEventSeq !== event.seq ||
      ![0,1].includes(event.seq-current.lastEventSeq) || record.stateVersion-current.stateVersion !== event.seq-current.lastEventSeq) {
      throw new Error("MANIFEST_EVENT_IDENTITY_MISMATCH");
    }
    await reconcileLine(this.eventsPath(current.id), offset, event);
    if (effects) await this.applyManifestEffects(record, effects);
    await this.writeManifest(record);
    await unlink(path);
    this.diagnostics?.observe("manifest","reconciled",{jobId:current.id,seq:event.seq});
    return record;
  }

  private async readEvents(jobId: string, afterSeq: number, maxEvents: number, committedSeq: number): Promise<JobEvent[]> {
    if (afterSeq >= committedSeq) return [];
    const file = await open(this.eventsPath(jobId), "r");
    const cursor = this.eventCursors.get(jobId);
    let start = cursor && cursor.seq <= afterSeq ? cursor.offset : 0;
    const events: JobEvent[] = [];
    try {
      if (afterSeq > (cursor && start ? cursor.seq : 0) + maxEvents) {
        // Binary search on complete event boundaries. The lower bound always
        // points to the start of a record with no earlier unread target.
        let high = (await file.stat()).size;
        while (high - start > 65536) {
          const mid = Math.floor((start + high) / 2);
          let boundary = false;
          let advanced = false;
          for await (const line of jsonLines(file, mid)) {
            if (!boundary) { boundary = true; continue; }
            if (!line.terminated) break;
            if (JSON.parse(line.text).seq <= afterSeq) { start = line.end; advanced = true; }
            break;
          }
          if (!advanced) high = mid;
        }
      }
      for await (const line of jsonLines(file, start)) {
        if (!line.text.trim()) continue;
        const event = JSON.parse(line.text) as JobEvent;
        if (event.seq > committedSeq) break;
        if (event.seq > afterSeq) {
          if (!line.terminated || event.seq !== (events.at(-1)?.seq ?? afterSeq) + 1) throw new Error("EVENT_COMMITTED_GAP");
          events.push(event);
        }
        this.eventCursors.set(jobId, { seq: event.seq, offset: line.end });
        if (event.seq === committedSeq || events.length >= Math.max(1, Math.min(maxEvents, 200))) break;
      }
    } finally { await file.close(); }
    if ((events.at(-1)?.seq ?? afterSeq) < committedSeq && events.length < Math.max(1,Math.min(maxEvents,200))) throw new Error("EVENT_COMMITTED_GAP");
    return events;
  }

  private async readMessagesById(jobId: string, ids: Set<string>): Promise<ConversationMessage[]> {
    const offsets = this.messageOffsets.get(jobId);
    const file = await open(this.messagesPath(jobId), "r");
    const messages: ConversationMessage[] = [];
    try {
      for (const id of ids) {
        const range = offsets?.get(id);
        if (!range) continue;
        for await (const line of jsonLines(file,range.start,range.end)) {
          const msg = JSON.parse(line.text) as ConversationMessage;
          if (msg.clientMessageId !== id) throw new Error("MESSAGE_INDEX_CHANGED");
          messages.push(msg);
        }
      }
    } finally { await file.close(); }
    return messages;
  }

  private async applyManifestEffects(record: JobRecord, effects: { message?: ConversationMessage; messageOffset?: number; publishResult?: boolean }) {
    const jobId = record.id;
    if (effects.message) {
      const message = effects.message;
      const start = effects.messageOffset;
      if (start === undefined || !message.clientMessageId) throw new Error("INVALID_MESSAGE_INTENT");
      await reconcileLine(this.messagesPath(jobId), start, message);
      const offsets = this.messageOffsets.get(jobId);
      if (offsets && !offsets.has(message.clientMessageId)) {
        offsets.set(message.clientMessageId, {start, end:start + Buffer.byteLength(JSON.stringify(message)) + 1});
        this.messageIndexBytes.set(jobId, (this.messageIndexBytes.get(jobId) ?? 0) + Buffer.byteLength(message.clientMessageId) + 16);
        this.cacheMessage(jobId, message);
      }
    }
    if (effects.publishResult) {
      const result = record.result;
      if (!result || result.status !== record.status || (result.turnId && result.turnId !== record.turnId)) throw new Error("INVALID_RESULT_INTENT");
      await replaceDurableText(this.resultPath(jobId), JSON.stringify(result, null, 2) + "\n");
      await replaceDurableText(this.responsePath(jobId), result.output || result.message);
    }
  }

  private async readConversation(
    record: JobRecord,
  ): Promise<{ projection: ConversationThreadProjection; diagnostics: ConversationPersistenceDiagnostic[] }> {
    await this.cleanupConversationTemps(record.id);
    const diagnostics: ConversationPersistenceDiagnostic[] = [];
    const primary = await this.readProjectionCandidate(this.conversationPath(record.id));
    const backup = await this.readProjectionCandidate(this.conversationBackupPath(record.id));
    const baseRevision = (primary.projection ?? backup.projection)?.revision ?? 0;
    let recovered = primary.projection ?? backup.projection;
    const journal = await this.readConversationJournal(record.id, baseRevision, patch => {
      recovered ??= createConversationProjection(record.threadId, record.createdAt);
      if (patch.revision !== recovered.revision + 1) {
        const failure = persistenceDiagnostic("conversation_journal_gap", "The journal cannot continue the checkpoint.", recovered.revision, patch.revision);
        throw new ConversationPersistenceError(failure.code, failure.message, [failure]);
      }
      try { recovered = applyConversationPatch(recovered, patch); }
      catch {
        const failure = persistenceDiagnostic("conversation_replay_failed", "Invalid replayed projection.", baseRevision, patch.revision);
        throw new ConversationPersistenceError(failure.code, failure.message, [failure]);
      }
    });
    diagnostics.push(...journal.diagnostics);

    if (primary.state === "corrupt") {
      diagnostics.push(persistenceDiagnostic(
        "conversation_checkpoint_corrupt",
        "The active conversation checkpoint is malformed or has an unsupported schema.",
        undefined,
        journal.latestRevision,
      ));
    }
    if (backup.state === "corrupt") {
      diagnostics.push(persistenceDiagnostic(
        "conversation_checkpoint_corrupt",
        "The bounded conversation recovery checkpoint is malformed or has an unsupported schema.",
        primary.projection?.revision,
        journal.latestRevision,
      ));
    }

    if (!recovered) {
      if (primary.state === "corrupt" || backup.state === "corrupt") {
        const failure = persistenceDiagnostic("conversation_replay_failed", "No validated baseline or committed revisions.", undefined, journal.latestRevision);
        throw new ConversationPersistenceError(failure.code, failure.message, [...diagnostics, failure]);
      }
      recovered = createConversationProjection(record.threadId, record.updatedAt);
      await this.writeInitialConversation(record.id, recovered);
      return {projection:recovered, diagnostics};
    }

    if (journal.latestRevision !== undefined && recovered.revision > journal.latestRevision) {
      const failure = persistenceDiagnostic(
        "conversation_journal_gap",
        "The conversation checkpoint is ahead of the committed revision journal.",
        recovered.revision,
        journal.latestRevision,
      );
      throw new ConversationPersistenceError(failure.code, failure.message, [...diagnostics, failure]);
    }

    const primaryNeedsRepair = primary.state !== "valid" || journal.replayed > 0;
    if (primaryNeedsRepair) {
      await this.writeConversation(record.id, recovered);
      diagnostics.push(persistenceDiagnostic(
        "conversation_checkpoint_recovered",
        "The active conversation checkpoint was restored from validated local persistence evidence.",
        recovered.revision,
        journal.latestRevision,
      ));
    } else if (backup.state !== "valid") {
      await this.writeConversationBackup(record.id, recovered);
      if (backup.state === "corrupt") {
        diagnostics.push(persistenceDiagnostic(
          "conversation_checkpoint_recovered",
          "The bounded conversation recovery checkpoint was restored from the validated active checkpoint.",
          recovered.revision,
          journal.latestRevision,
        ));
      }
    }

    this.checkpointBytes.set(record.id, (await stat(this.conversationPath(record.id))).size);
    return { projection: recovered, diagnostics: dedupePersistenceDiagnostics(diagnostics) };
  }

  private async updateConversation(
    jobId: string,
    update: (current: ConversationThreadProjection) => ConversationThreadProjection,
  ): Promise<ConversationThreadProjection> {
    return this.withConversationLock(jobId, async () => {
      const record = this.requireJob(jobId);
      const persistenceFailure = this.conversationFailures.get(jobId);
      if (persistenceFailure) throw persistenceFailure;
      const current = await this.loadProjection(jobId);
      if (this.pendingConversationCheckpoints.has(jobId)) {
        await this.writeConversation(jobId, current);
        this.pendingConversationCheckpoints.delete(jobId);
        this.addConversationDiagnostic(jobId, persistenceDiagnostic(
          "conversation_checkpoint_recovered",
          "A previously committed conversation revision was restored to the active checkpoint.",
          current.revision,
          current.revision,
        ));
      }
      const pending = this.pendingConversations.get(jobId);
      const diff = this.pendingDiffs.get(jobId);
      if (diff !== undefined) {
        await this.setDiff(jobId, diff);
        this.pendingDiffs.delete(jobId);
      }
      const base = pending ?? current;
      let next = update(base);
      if (next === current && !pending) {
        this.conversationFlushFailures.delete(jobId);
        return current;
      }
      next = { ...next, revision: current.revision + 1 };
      const patch = conversationPatch(current, next);
      try {
        await this.appendConversationJournal(jobId, patch);
      } catch (cause) {
        this.diagnostics?.observe("journal","conversation_journal_write_failed",{jobId,revision:next.revision},true,cause);
        const failure = persistenceDiagnostic(
          "conversation_journal_write_failed",
          "The conversation revision journal could not be committed.",
          current.revision,
          next.revision,
        );
        this.addConversationDiagnostic(jobId, failure);
        const error = new ConversationPersistenceError(failure.code, failure.message, [failure]);
        this.conversationFailures.set(jobId, error);
        throw error;
      }
      // Journal commit is the cursor publication boundary, even if checkpoint promotion fails.
      this.pendingConversations.delete(jobId);
      clearTimeout(this.conversationTimers.get(jobId));
      this.conversationTimers.delete(jobId);
      this.conversations.set(jobId, next);
      this.recentConversationChanges.add(jobId, patch);
      this.conversationCommitCounts.set(jobId, (this.conversationCommitCounts.get(jobId) ?? 0) + 1);
      try {
        // Checkpoint when replay costs as much IO as the checkpoint. Keep small
        // checkpoints eager and journal publication independent of promotion.
        const size = this.checkpointBytes.get(jobId) ?? 0;
        if (size <= 4096 || (this.replayBytes.get(jobId) ?? 0) >= size) await this.writeConversation(jobId, next);
      } catch (cause) {
        this.diagnostics?.observe("checkpoint","conversation_checkpoint_write_failed",{jobId,revision:next.revision},true,cause);
        this.conversations.set(jobId, next);
        this.pendingConversationCheckpoints.add(jobId);
        const failure = persistenceDiagnostic(
          "conversation_checkpoint_write_failed",
          "The journal revision is committed, but the active conversation checkpoint could not be promoted.",
          current.revision,
          next.revision,
        );
        this.addConversationDiagnostic(jobId, failure);
        throw new ConversationPersistenceError(failure.code, failure.message, [failure]);
      }
      this.conversations.set(jobId, next);
      this.pendingConversationCheckpoints.delete(jobId);
      this.conversationFlushFailures.delete(jobId);
      return next;
    });
  }

  private async writeInitialConversation(jobId: string, projection: ConversationThreadProjection): Promise<void> {
    validateConversationProjection(projection);
    const journal = await open(this.conversationEventsPath(jobId), "a");
    try {
      await journal.sync();
    } finally {
      await journal.close();
    }
    await this.writeConversation(jobId, projection);
  }

  private async writeConversation(jobId: string, projection: ConversationThreadProjection): Promise<void> {
    validateConversationProjection(projection);
    const path = this.conversationPath(jobId);
    const temp = conversationTempPath(path, "tmp");
    const started = performance.now();
    const serialized = serializeConversationProjection(projection);
    await writeDurableText(temp, serialized);
    const staged = await this.readProjectionCandidate(temp);
    if (staged.state !== "valid" || staged.projection?.revision !== projection.revision) {
      await unlink(temp).catch(() => undefined);
      throw new Error("Staged conversation checkpoint failed validation.");
    }
    const current = await this.readProjectionCandidate(path);
    try {
      if (current.state === "valid" && current.projection) {
        await this.writeConversationBackup(jobId, current.projection);
      }
      await this.promoteConversationFile(temp, path, this.conversationRename);
      const promoted = await this.readProjectionCandidate(path);
      if (promoted.state !== "valid" || promoted.projection?.revision !== projection.revision) {
        throw new Error("Promoted conversation checkpoint failed validation.");
      }
      const anchor = this.lastJournalRecord.get(jobId);
      if (anchor?.revision === projection.revision) {
        this.journalAnchors.set(jobId, anchor);
        await this.saveJournalIndex(jobId);
      }
      this.checkpointBytes.set(jobId, Buffer.byteLength(serialized));
      this.replayBytes.set(jobId, 0);
      const backup = await this.readProjectionCandidate(this.conversationBackupPath(jobId));
      if (backup.state !== "valid") await this.writeConversationBackup(jobId, projection);
      this.diagnostics?.observe("checkpoint", "promoted", {jobId,revision:projection.revision,bytes:Buffer.byteLength(serialized),elapsedMs:performance.now()-started});
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }

  private async writeConversationBackup(jobId: string, projection: ConversationThreadProjection): Promise<void> {
    validateConversationProjection(projection);
    const path = this.conversationBackupPath(jobId);
    const temp = conversationTempPath(path, "tmp");
    await writeDurableText(temp, serializeConversationProjection(projection));
    try {
      await this.promoteConversationFile(temp, path, rename);
      const promoted = await this.readProjectionCandidate(path);
      if (promoted.state !== "valid" || promoted.projection?.revision !== projection.revision) {
        throw new Error("Promoted conversation recovery checkpoint failed validation.");
      }
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }

  private async promoteConversationFile(
    temp: string,
    destination: string,
    renameFile: ConversationFileRename,
  ): Promise<void> {
    try {
      await renameFile(temp, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EEXIST") throw error;
    }

    if (!(await fileExists(destination))) {
      throw Object.assign(new Error("Conversation checkpoint promotion was denied."), { code: "EPERM" });
    }
    const swap = conversationTempPath(destination, "swap");
    let movedExisting = false;
    try {
      await renameFile(destination, swap);
      movedExisting = true;
      await renameFile(temp, destination);
      await unlink(swap).catch(() => undefined);
    } catch (error) {
      if (movedExisting && !(await fileExists(destination)) && await fileExists(swap)) {
        await renameFile(swap, destination).catch(() => undefined);
      }
      throw error;
    }
  }

  private async saveJournalIndex(jobId: string) {
    const anchor = this.journalAnchors.get(jobId);
    if (!anchor) return;
    const path = this.conversationEventsPath(jobId);
    const temp = path + ".index.tmp";
    try {
      const f = await stat(path,{bigint:true});
      const stamp = [f.ino,f.size,f.mtimeNs,f.ctimeNs].join("/");
      await writeFile(temp, JSON.stringify({...anchor,stamp,digest:indexDigest(jobId,stamp,anchor.revision,anchor.offset)}));
      await rename(temp, path + ".index");
    } catch { this.diagnostics?.observe("index","hint_write_failed",{jobId},true); }
  }

  private async appendConversationJournal(jobId: string, patch: ConversationProjectionPatch): Promise<void> {
    validateConversationPatch(patch);
    const started = performance.now();
    const handle = await open(this.conversationEventsPath(jobId), "a");
    try {
      const line = JSON.stringify(patch) + "\n";
      await handle.writeFile(line, "utf8");
      await handle.sync();
      const bytes = Buffer.byteLength(line);
      try {
        const size = (await handle.stat()).size;
        this.observedJournalBytes.set(jobId,size);
        this.lastJournalRecord.set(jobId, {revision:patch.revision,offset:size-bytes});
      } catch { this.diagnostics?.observe("index","hint_write_failed",{jobId},true); }
      await this.saveJournalIndex(jobId);
      this.diagnostics?.observe("journal", "committed", {jobId, revision:patch.revision, elapsedMs:performance.now()-started, bytes:Buffer.byteLength(line)});
      this.replayBytes.set(jobId, (this.replayBytes.get(jobId) ?? 0) + Buffer.byteLength(line));
    } finally {
      await handle.close();
    }
  }

  private async readConversationJournal(jobId: string, baseRevision: number, apply: (patch:ConversationProjectionPatch) => void): Promise<ConversationJournalRead> {
    const path = this.conversationEventsPath(jobId);
    let file;
    try { file = await open(path, "r+"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, replayed: 0, diagnostics: [] };
      throw error;
    }
    const diagnostics: ConversationPersistenceDiagnostic[] = [];
    let replayed = 0;
    let previous: ConversationProjectionPatch | undefined;
    let lastValidOffset = 0;
    try {
      const identity = await file.stat({bigint:true});
      this.observedJournalBytes.set(jobId,Number(identity.size));
      const stamp = [identity.ino,identity.size,identity.mtimeNs,identity.ctimeNs].join("/");
      const indexPath = path + ".index";
      let from = 0;
      try {
        const hint = JSON.parse(await readFile(indexPath, "utf8"));
        if (hint.stamp === stamp && hint.revision === baseRevision && Number.isSafeInteger(hint.offset) &&
          hint.offset >= 0 && hint.offset < Number(identity.size) &&
          hint.digest === indexDigest(jobId, hint.stamp, hint.revision, hint.offset)) from = hint.offset;
      } catch { /* Disposable hint. Always validate the original journal on a miss. */ }
      this.diagnostics?.observe("index", from ? "verified_offset" : "full_validation", {jobId, revision:baseRevision,bytes:Number(identity.size)-from});
      for await (const {text: line, start, end, terminated} of jsonLines(file, from)) {
        if (line.length === 0) {
          const failure = persistenceDiagnostic(
            "conversation_journal_corrupt",
            "The conversation revision journal contains an empty record before its final boundary.",
            undefined,
            previous?.revision,
          );
          throw new ConversationPersistenceError(failure.code, failure.message, [...diagnostics, failure]);
        }

        let patch: ConversationProjectionPatch;
        try {
          patch = JSON.parse(line) as ConversationProjectionPatch;
          validateConversationPatch(patch);
        } catch {
          if (!terminated) {
            diagnostics.push(persistenceDiagnostic(
              "conversation_journal_tail_truncated",
              "An incomplete final conversation journal record was removed after preserving all prior revisions.",
              undefined,
              previous?.revision,
            ));
            await truncateDurableFile(path, lastValidOffset);
            break;
          }
          const failure = persistenceDiagnostic(
            "conversation_journal_corrupt",
            "The conversation revision journal contains a malformed committed record.",
            undefined,
            previous?.revision,
          );
          throw new ConversationPersistenceError(failure.code, failure.message, [...diagnostics, failure]);
        }


        if (previous && patch.revision === previous.revision) {
          if (JSON.stringify(previous) !== JSON.stringify(patch)) {
            const failure = persistenceDiagnostic(
              "conversation_journal_corrupt",
              "The conversation revision journal contains conflicting duplicate revisions.",
              undefined,
              patch.revision,
            );
            throw new ConversationPersistenceError(failure.code, failure.message, [...diagnostics, failure]);
          }
          diagnostics.push(persistenceDiagnostic(
            "conversation_journal_duplicate",
            "An identical duplicate conversation journal revision was ignored.",
            undefined,
            patch.revision,
          ));
        } else {
          if (previous && patch.revision !== previous.revision + 1) {
            const failure = persistenceDiagnostic(
              "conversation_journal_gap",
              "The conversation revision journal is not monotonic and contiguous.",
              undefined,
              patch.revision,
            );
            throw new ConversationPersistenceError(failure.code, failure.message, [...diagnostics, failure]);
          }
          if (!previous && from && patch.revision !== baseRevision) {
            const failure = persistenceDiagnostic("conversation_journal_gap", "Checkpoint anchor revision mismatch.", baseRevision, patch.revision);
            throw new ConversationPersistenceError(failure.code, failure.message, [failure]);
          }
          if (patch.revision > baseRevision) { apply(patch); replayed++; }
          this.lastJournalRecord.set(jobId, {revision:patch.revision,offset:start});
          previous = patch;
          if (patch.revision === baseRevision) this.journalAnchors.set(jobId, {revision: baseRevision, offset: start});
        }
        lastValidOffset = end;
        if (!terminated) {
          await file.write(Buffer.from("\n"), 0, 1, end);
          await file.sync();
        }
      }

      await this.saveJournalIndex(jobId);
    } finally { await file.close(); }

    return {
      exists: true,
      replayed,
      latestRevision: previous?.revision,
      diagnostics: dedupePersistenceDiagnostics(diagnostics),
    };
  }

  private async readProjectionCandidate(path: string): Promise<ProjectionCandidate> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as ConversationThreadProjection;
      validateConversationProjection(parsed);
      return { state: "valid", projection: parsed };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
      if (error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError) {
        return { state: "corrupt" };
      }
      throw error;
    }
  }

  private async cleanupConversationTemps(jobId: string): Promise<void> {
    const entries = await readdir(this.jobDir(jobId), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/^conversation\.json(?:\.bak)?\.\d+\.[0-9a-f-]{36}\.(?:tmp|swap)$/i.test(entry.name)) continue;
      await unlink(join(this.jobDir(jobId), entry.name)).catch(() => undefined);
    }
  }

  private addConversationDiagnostic(jobId: string, diagnostic: ConversationPersistenceDiagnostic): void {
    this.diagnostics?.observe("checkpoint", diagnostic.code, {jobId, revision:diagnostic.journalRevision}, true);
    const current = this.conversationDiagnostics.get(jobId) ?? [];
    this.conversationDiagnostics.set(jobId, dedupePersistenceDiagnostics([...current, diagnostic]).slice(-20));
  }

  private async ensureMessagesFile(record: JobRecord): Promise<void> {
    if (await fileExists(this.messagesPath(record.id))) {
      return;
    }
    const messages: ConversationMessage[] = [
      {
        id: randomUUID(),
        clientMessageId: `initial:${record.id}`,
        role: "user",
        content: record.workPackage.objective,
        context: record.workPackage.context || undefined,
        at: record.createdAt,
        executionMode: record.workPackage.executionMode,
        approvalReviewer: record.workPackage.approvalReviewer ?? "user",
        dataClassification: record.workPackage.dataClassification,
        model: record.workPackage.model,
        effort: record.workPackage.effort,
        speed: record.workPackage.speed,
        inputArtifacts: record.inputArtifacts,
      },
    ];
    if (record.result) {
      messages.push({
        id: randomUUID(),
        clientMessageId: `assistant:${record.result.turnId || record.turnId || "legacy"}`,
        role: "assistant",
        content: record.result.output || record.result.message,
        at: record.result.completedAt,
        turnId: record.result.turnId || record.turnId,
        model: record.model || record.workPackage.model,
        effort: record.effort || record.workPackage.effort,
        resultStatus: record.result.status,
      });
    }
    await writeFile(this.messagesPath(record.id), `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`, "utf8");
  }

  private requireJob(jobId: string): JobRecord {
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
      throw new Error("Invalid job id.");
    }
    if (this.uncertainManifests.has(jobId)) throw new Error("MANIFEST_EVENT_RECONCILIATION_REQUIRED");
    const record = this.jobs.get(jobId);
    if (!record && this.summaries.has(jobId)) {
      // Legacy synchronous get() contract. Only a selected cold manifest is read.
      const saved = JSON.parse(readFileSync(this.manifestPath(jobId), "utf8")) as JobRecord;
      if (saved.id !== jobId || saved.schemaVersion !== 1) throw new Error("JOB_MANIFEST_CHANGED");
      return saved;
    }
    if (!record) {
      throw new Error(`Unknown job id '${jobId}'.`);
    }
    return record;
  }

  private async writeManifest(record: JobRecord): Promise<void> {
    const path = this.manifestPath(record.id);
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeDurableText(temp, `${JSON.stringify(record, null, 2)}\n`);
    try { await rename(temp, path); }
    catch (error) { await unlink(temp).catch(() => undefined); throw error; }
    this.indexRecord(record);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const execute = async () => {
      this.mutations++;
      try { return await operation(); } finally { this.mutations--;
        if (this.coldBytes > CONVERSATION_DELIVERY.totalHotBytes && this.coldReads.size) this.trimCold(this.coldReads.keys().next().value!);
      }
    };
    const run = this.lock.then(execute, execute);
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async withConversationLock<T>(jobId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.conversationLocks.get(jobId) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const settled = run.then(() => undefined, () => undefined);
    this.conversationLocks.set(jobId, settled);
    try { return await run; }
    finally { if (this.conversationLocks.get(jobId) === settled) this.conversationLocks.delete(jobId); }
  }

  private jobDir(jobId: string): string {
    return join(this.jobsDir, jobId);
  }

  private manifestPath(jobId: string): string {
    return join(this.jobDir(jobId), "manifest.json");
  }

  private requestPath(jobId: string): string {
    return join(this.jobDir(jobId), "request.md");
  }

  private eventsPath(jobId: string): string {
    return join(this.jobDir(jobId), "events.jsonl");
  }

  private messagesPath(jobId: string): string {
    return join(this.jobDir(jobId), "messages.jsonl");
  }

  private conversationPath(jobId: string): string {
    return join(this.jobDir(jobId), "conversation.json");
  }

  private conversationBackupPath(jobId: string): string {
    return `${this.conversationPath(jobId)}.bak`;
  }

  private conversationEventsPath(jobId: string): string {
    return join(this.jobDir(jobId), "conversation-events.jsonl");
  }

  private diffPath(jobId: string): string {
    return join(this.jobDir(jobId), "diff.patch");
  }

  private resultPath(jobId: string): string {
    return join(this.jobDir(jobId), "result.json");
  }

  private responsePath(jobId: string): string {
    return join(this.jobDir(jobId), "response.md");
  }

  private inboxDir(jobId: string): string {
    return join(this.jobDir(jobId), "inbox");
  }

  private handoffJobDir(jobId: string): string {
    assertUuid(jobId, "job id");
    return join(this.handoffRoot, jobId);
  }

  private handoffArtifactPath(jobId: string, artifact: TextArtifactSummary): string {
    assertUuid(artifact.id, "staged text artifact id");
    const extension = allowedHandoffExtension(artifact.fileName);
    return join(this.handoffJobDir(jobId), `${artifact.id}${extension}`);
  }

  private inputArtifactPath(jobId: string, artifactId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(artifactId)) throw new Error("Invalid staged text artifact id.");
    return join(this.inboxDir(jobId), `${artifactId}.txt`);
  }

  private async materializeInputArtifacts(jobId: string, artifacts: StagedTextArtifact[]): Promise<void> {
    if (artifacts.length === 0) return;
    await mkdir(this.inboxDir(jobId), { recursive: true });
    await mkdir(this.handoffJobDir(jobId), { recursive: true });
    for (const artifact of artifacts) {
      assertArtifactDigest(artifact, artifact.content);
      await writeFile(this.inputArtifactPath(jobId, artifact.id), artifact.content, "utf8");
      await writeFile(this.handoffArtifactPath(jobId, artifact), artifact.content, "utf8");
    }
    const all = mergeArtifactSummaries(this.requireJobOrPending(jobId)?.inputArtifacts ?? [], summarizeArtifacts(artifacts));
    await writeFile(join(this.inboxDir(jobId), "manifest.json"), `${JSON.stringify({ schemaVersion: 1, artifacts: all }, null, 2)}\n`, "utf8");
    await this.writeHandoffManifest(jobId, all);
  }

  private async ensureHandoffCopy(jobId: string, artifact: TextArtifactSummary, content: string): Promise<string> {
    const path = this.handoffArtifactPath(jobId, artifact);
    try {
      const existing = await readFile(path, "utf8");
      if (createHash("sha256").update(existing, "utf8").digest("hex") === artifact.sha256) return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(this.handoffJobDir(jobId), { recursive: true });
    await writeFile(path, content, "utf8");
    return path;
  }

  private async writeHandoffManifest(jobId: string, artifacts: TextArtifactSummary[]): Promise<void> {
    if (artifacts.length === 0) return;
    await mkdir(this.handoffJobDir(jobId), { recursive: true });
    const manifest = {
      schemaVersion: 1,
      jobId,
      access: "read-only",
      artifacts: artifacts.map((artifact) => ({
        ...artifact,
        localPath: this.handoffArtifactPath(jobId, artifact),
      })),
    };
    await writeFile(join(this.handoffJobDir(jobId), "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  private requireJobOrPending(jobId: string): JobRecord | undefined {
    return this.summaries.has(jobId) ? this.requireJob(jobId) : undefined;
  }
}

function validateConversationProjection(value: unknown): asserts value is ConversationThreadProjection {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new TypeError("Invalid conversation projection schema.");
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) {
    throw new TypeError("Invalid conversation projection revision.");
  }
  if ((value.updatedAt !== undefined && typeof value.updatedAt !== "string") || !Array.isArray(value.turns)) {
    throw new TypeError("Invalid conversation projection shape.");
  }
  if (!new Set(["unknown", "notLoaded", "idle", "active", "systemError"]).has(String(value.status))) {
    throw new TypeError("Invalid conversation projection status.");
  }
  if (value.threadId !== undefined && typeof value.threadId !== "string") {
    throw new TypeError("Invalid conversation projection thread id.");
  }
  for (const turn of value.turns) {
    if (!isRecord(turn) || typeof turn.turnId !== "string" || typeof turn.status !== "string" || !Array.isArray(turn.items)) {
      throw new TypeError("Invalid conversation projection turn.");
    }
  }
}

function validateConversationPatch(value: unknown): asserts value is ConversationProjectionPatch {
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1) {
    throw new TypeError("Invalid conversation journal revision.");
  }
  if (typeof value.at !== "string" || !Array.isArray(value.turns)) {
    throw new TypeError("Invalid conversation journal record.");
  }
  if (value.replaceAll !== undefined && typeof value.replaceAll !== "boolean") {
    throw new TypeError("Invalid conversation journal replacement marker.");
  }
  for (const turn of value.turns) {
    if (!isRecord(turn) || typeof turn.turnId !== "string" || !Array.isArray(turn.items)) {
      throw new TypeError("Invalid conversation journal turn patch.");
    }
  }
}

function applyConversationPatch(
  current: ConversationThreadProjection,
  patch: ConversationProjectionPatch,
): ConversationThreadProjection {
  validateConversationProjection(current);
  validateConversationPatch(patch);
  if (patch.revision !== current.revision + 1) throw new TypeError("Conversation patch revision is not contiguous.");
  // The recovery projection is exclusively owned until complete validation.
  const next = current;
  if (patch.replaceAll) next.turns = structuredClone(patch.turns);
  if (patch.threadId !== undefined) next.threadId = patch.threadId;
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.hydratedAt !== undefined) next.hydratedAt = patch.hydratedAt;
  if (patch.freshness !== undefined) next.freshness = structuredClone(patch.freshness);
  if (patch.tokenUsage !== undefined) next.tokenUsage = structuredClone(patch.tokenUsage);
  if (patch.modelRouting !== undefined) next.modelRouting = structuredClone(patch.modelRouting);
  if (!patch.replaceAll) {
    for (const turnPatch of patch.turns) {
      let turn = next.turns.find((candidate) => candidate.turnId === turnPatch.turnId);
      if (!turn) {
        turn = { ...structuredClone(turnPatch), items: [] };
        next.turns.push(turn);
      }
      if (turnPatch.status !== undefined) turn.status = turnPatch.status;
      if (turnPatch.startedAt !== undefined) turn.startedAt = turnPatch.startedAt;
      if (turnPatch.completedAt !== undefined) turn.completedAt = turnPatch.completedAt;
      if (turnPatch.durationMs !== undefined) turn.durationMs = turnPatch.durationMs;
      if (turnPatch.tokenUsage !== undefined) turn.tokenUsage = structuredClone(turnPatch.tokenUsage);
      if (turnPatch.modelRouting !== undefined) turn.modelRouting = structuredClone(turnPatch.modelRouting);
      for (const itemPatch of turnPatch.items) {
        if (itemPatch.clientMessageId) {
          turn.items = turn.items.filter((candidate) => !(
            candidate.id.startsWith("bridge-message:") && candidate.clientMessageId === itemPatch.clientMessageId
          ));
        }
        const index = turn.items.findIndex((candidate) => candidate.id === itemPatch.id);
        if (index < 0) turn.items.push(structuredClone(itemPatch));
        else turn.items[index] = structuredClone(itemPatch);
      }
    }
  }
  next.revision = patch.revision;
  if (patch.createdAt !== undefined) next.createdAt = patch.createdAt ?? undefined;
  // Legacy journal records used at for the revision clock. New records always
  // carry activity time explicitly, including null when native time is unknown.
  next.updatedAt = patch.updatedAt === undefined ? patch.at : patch.updatedAt ?? undefined;
  validateConversationProjection(next);
  return next;
}

function indexDigest(jobId: string, stamp: string, revision: number, offset: number) {
  return createHash("sha256").update(JSON.stringify([jobId,stamp,revision,offset])).digest("hex");
}

function persistenceDiagnostic(
  code: ConversationPersistenceDiagnosticCode,
  message: string,
  checkpointRevision?: number,
  journalRevision?: number,
): ConversationPersistenceDiagnostic {
  return {
    code,
    message,
    at: new Date().toISOString(),
    checkpointRevision,
    journalRevision,
  };
}

function dedupePersistenceDiagnostics(
  diagnostics: ConversationPersistenceDiagnostic[],
): ConversationPersistenceDiagnostic[] {
  const unique = new Map<string, ConversationPersistenceDiagnostic>();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}:${diagnostic.checkpointRevision ?? ""}:${diagnostic.journalRevision ?? ""}`;
    unique.set(key, structuredClone(diagnostic));
  }
  return Array.from(unique.values()).slice(-20);
}

function serializeConversationProjection(projection: ConversationThreadProjection): string {
  return `${JSON.stringify(projection, null, 2)}\n`;
}

function conversationTempPath(path: string, suffix: "tmp" | "swap"): string {
  return `${path}.${process.pid}.${randomUUID()}.${suffix}`;
}

async function reconcileLine(path: string, offset: number, value: unknown) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("INVALID_APPEND_OFFSET");
    const expected = Buffer.from(JSON.stringify(value) + "\n");
    const file = await open(path,"r+");
    try {
      const length = (await file.stat()).size-offset;
      if (length < 0 || length > expected.length) throw new Error("MANIFEST_EVENT_CURSOR_MISMATCH");
      const prefix = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const {bytesRead} = await file.read(prefix,read,length-read,offset+read);
        if (!bytesRead) throw new Error("MANIFEST_EVENT_SHORT_READ");
        read += bytesRead;
      }
      if (!expected.subarray(0,length).equals(prefix)) throw new Error("MANIFEST_EVENT_PREFIX_MISMATCH");
      let written = length;
      while (written < expected.length) {
        const {bytesWritten} = await file.write(expected,written,expected.length-written,offset+written);
        if (!bytesWritten) throw new Error("MANIFEST_EVENT_SHORT_WRITE");
        written += bytesWritten;
      }
      await file.sync();
    } finally { await file.close(); }
}

async function replaceDurableText(path: string, content: string) {
  const temp = conversationTempPath(path, "tmp");
  await writeDurableText(temp, content);
  try { await rename(temp, path); }
  catch (error) { await unlink(temp).catch(() => undefined); throw error; }
}

async function writeDurableText(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function truncateDurableFile(path: string, length: number): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.truncate(length);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarizeArtifacts(artifacts: StagedTextArtifact[]): TextArtifactSummary[] {
  return artifacts.map(({ content: _content, ...summary }) => structuredClone(summary));
}

function mergeArtifactSummaries(left: TextArtifactSummary[], right: TextArtifactSummary[]): TextArtifactSummary[] {
  const merged = new Map(left.map((artifact) => [artifact.id, artifact]));
  for (const artifact of right) merged.set(artifact.id, artifact);
  return Array.from(merged.values()).map((artifact) => structuredClone(artifact));
}

function assertArtifactDigest(artifact: TextArtifactSummary, content: string): void {
  if (createHash("sha256").update(content, "utf8").digest("hex") !== artifact.sha256) {
    throw new Error(`Staged text artifact '${artifact.fileName}' failed SHA-256 validation.`);
  }
}

function settlePendingApprovals(record: JobRecord, state: PendingApproval["state"]): number {
  const resolvedAt = new Date().toISOString();
  let count = 0;
  for (const approval of record.approvals) {
    if (approval.state !== "pending") continue;
    approval.state = state;
    approval.resolvedAt = resolvedAt;
    count += 1;
  }
  return count;
}

function conversationPatch(
  previous: ConversationThreadProjection,
  next: ConversationThreadProjection,
): ConversationProjectionPatch {
  const oldTurns = new Map(previous.turns.map(turn => [turn.turnId, turn]));
  const newTurns = new Map(next.turns.map(turn => [turn.turnId, turn]));
  const removedTurn = previous.turns.some(turn => !newTurns.has(turn.turnId));
  const removedItem = previous.turns.some(turn => {
    const other = newTurns.get(turn.turnId);
    if (!other || turn === other) return false;
    const ids = new Set(other.items.map(item => item.id));
    return turn.items.some(item => !ids.has(item.id));
  });
  const replaceAll = removedTurn || removedItem;
  const turns: ConversationProjectionPatch["turns"] = [];
  if (replaceAll) turns.push(...structuredClone(next.turns));
  else {
  for (const nextTurn of next.turns) {
    const previousTurn = oldTurns.get(nextTurn.turnId);
    if (previousTurn === nextTurn) continue;
    if (!previousTurn) {
      turns.push(structuredClone(nextTurn));
      continue;
    }
    const previousItems = new Map(previousTurn.items.map(item => [item.id, item]));
    const items = nextTurn.items.filter((item) => {
      const previousItem = previousItems.get(item.id);
      return previousItem !== item && (!previousItem || JSON.stringify(previousItem) !== JSON.stringify(item));
    });
    const metadataChanged = JSON.stringify({
      status: previousTurn.status,
      startedAt: previousTurn.startedAt,
      completedAt: previousTurn.completedAt,
      durationMs: previousTurn.durationMs,
      tokenUsage: previousTurn.tokenUsage,
      modelRouting: previousTurn.modelRouting,
    }) !== JSON.stringify({
      status: nextTurn.status,
      startedAt: nextTurn.startedAt,
      completedAt: nextTurn.completedAt,
      durationMs: nextTurn.durationMs,
      tokenUsage: nextTurn.tokenUsage,
      modelRouting: nextTurn.modelRouting,
    });
    if (items.length || metadataChanged) {
      turns.push(structuredClone({ ...nextTurn, items }));
    }
  }
  }
  return {
    revision: next.revision,
    at: new Date().toISOString(),
    createdAt: next.createdAt ?? null,
    updatedAt: next.updatedAt ?? null,
    threadId: previous.threadId !== next.threadId ? next.threadId : undefined,
    status: previous.status !== next.status ? next.status : undefined,
    hydratedAt: previous.hydratedAt !== next.hydratedAt ? next.hydratedAt : undefined,
    freshness: JSON.stringify(previous.freshness) !== JSON.stringify(next.freshness)
      ? structuredClone(next.freshness)
      : undefined,
    replaceAll: replaceAll || undefined,
    tokenUsage: JSON.stringify(previous.tokenUsage) !== JSON.stringify(next.tokenUsage) ? next.tokenUsage : undefined,
    modelRouting: JSON.stringify(previous.modelRouting) !== JSON.stringify(next.modelRouting) ? next.modelRouting : undefined,
    turns,
  };
}

function assertUuid(value: string, field: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error(`Invalid ${field}.`);
}

function allowedHandoffExtension(fileName: string): string {
  const extension = extname(fileName).toLowerCase();
  return HANDOFF_EXTENSIONS.has(extension) ? extension : ".txt";
}

function encodeConversationCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id }), "utf8").toString("base64url");
}

function decodeConversationCursor(cursor: string): { createdAt: string; id: string } {
  if (!/^[A-Za-z0-9_-]{8,512}$/.test(cursor)) throw new Error("Invalid conversation cursor.");
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string" || !/^[0-9a-f-]{36}$/i.test(parsed.id)) {
      throw new Error("Invalid conversation cursor.");
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new Error("Invalid conversation cursor.");
  }
}

export function toSummary(record: JobRecord): JobSummary {
  return {
    nativeRequest: record.nativeRequest,
    selectionRecorded: record.selectionRecorded,
    selectionKind: record.selectionKind,
    modelSource: record.modelSource,
    effortSource: record.effortSource,
    speed: record.speed,
    id: record.id,
    projectId: record.project.id,
    projectName: record.project.name,
    title: record.workPackage.title,
    objective: record.workPackage.objective,
    executionMode: record.currentExecutionMode ?? record.workPackage.executionMode,
    approvalReviewer: record.currentApprovalReviewer ?? record.workPackage.approvalReviewer ?? "user",
    dataClassification: record.currentDataClassification ?? record.workPackage.dataClassification,
    status: record.status,
    stateVersion: record.stateVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    threadId: record.threadId,
    turnId: record.turnId,
    model: record.selectionRecorded ? record.model : record.model ?? record.workPackage.model,
    effort: record.selectionRecorded ? record.effort : record.effort ?? record.workPackage.effort,
    pendingApprovalCount: record.approvals.filter((approval) => approval.state === "pending").length,
    result: record.result,
    resultScope: !record.result ? undefined : !record.result.turnId ? "unknown_turn" :
      record.result.turnId === record.turnId ? "current_turn" : "previous_turn",
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
