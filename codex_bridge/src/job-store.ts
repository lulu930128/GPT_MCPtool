import { createHash, randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
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
  PendingApproval,
  ReasoningEffort,
  MaterializedTextArtifact,
  StagedTextArtifact,
  TextArtifactSummary,
  WorkPackage,
} from "./types.js";
import {
  createConversationProjection,
  hydrateConversationProjection,
  mergeConversationMessages,
  reduceConversationNotification,
  type ConversationNotification,
} from "./conversation-projection.js";
import { renderRequestMarkdown } from "./work-package.js";
import { sanitizeForStorage } from "./redaction.js";

const ACTIVE_STATUSES = new Set<JobStatus>(["queued", "preparing", "running", "awaiting_approval"]);
const HANDOFF_EXTENSIONS = new Set([".txt", ".md", ".log", ".json", ".yaml", ".yml", ".diff", ".patch"]);

export interface CreateJobInput {
  project: BridgeProject;
  workPackage: WorkPackage;
  previewDigest: string;
  idempotencyKey: string;
  inputArtifacts?: StagedTextArtifact[];
}

export interface AppendUserMessageInput {
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

export interface PrepareTurnInput {
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
  patches: ConversationProjectionPatch[];
  latestRevision?: number;
  diagnostics: ConversationPersistenceDiagnostic[];
}

export class JobStore {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly idempotencyIndex = new Map<string, string>();
  private readonly messageClientIds = new Map<string, Set<string>>();
  private readonly conversations = new Map<string, ConversationThreadProjection>();
  private readonly conversationDiagnostics = new Map<string, ConversationPersistenceDiagnostic[]>();
  private readonly conversationFailures = new Map<string, ConversationPersistenceError>();
  private readonly pendingConversationCheckpoints = new Set<string>();
  private lock: Promise<void> = Promise.resolve();

  constructor(
    private readonly jobsDir: string,
    private readonly handoffRoot: string = join(jobsDir, "codex-inbox"),
    private readonly conversationRename: ConversationFileRename = rename,
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.jobsDir, { recursive: true });
    await mkdir(this.handoffRoot, { recursive: true });
    const entries = await readdir(this.jobsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) {
        continue;
      }
      try {
        const record = JSON.parse(await readFile(this.manifestPath(entry.name), "utf8")) as JobRecord;
        if (record.schemaVersion !== 1 || record.id !== entry.name) {
          continue;
        }
        this.jobs.set(record.id, record);
        this.idempotencyIndex.set(record.idempotencyKey, record.id);
        try {
          await this.ensureMessagesFile(record);
          const messages = await this.readMessages(record.id);
          const recovered = await this.readConversation(record);
          this.conversations.set(record.id, recovered.projection);
          this.conversationDiagnostics.set(record.id, recovered.diagnostics);
          this.messageClientIds.set(
            record.id,
            new Set(messages.flatMap((message) => message.clientMessageId ? [message.clientMessageId] : [])),
          );
        } catch (error) {
          if (!(error instanceof ConversationPersistenceError)) throw error;
          this.conversationFailures.set(record.id, error);
          this.conversationDiagnostics.set(record.id, error.diagnostics);
          this.messageClientIds.set(record.id, new Set());
        }
      } catch {
        // A malformed runtime job is isolated to its own directory and never blocks startup.
      }
    }
    for (const record of this.jobs.values()) {
      const approvalState: PendingApproval["state"] = record.status === "cancelled" ? "cancelled" : "expired";
      const settledApprovals = settlePendingApprovals(record, approvalState);
      if (ACTIVE_STATUSES.has(record.status)) {
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

  async create(input: CreateJobInput): Promise<{ record: JobRecord; created: boolean }> {
    return this.exclusive(async () => {
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
        schemaVersion: 1,
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
        inputArtifacts: record.inputArtifacts,
      };
      await writeFile(this.messagesPath(id), `${JSON.stringify(initialMessage)}\n`, "utf8");
      const event: JobEvent = { seq: 1, at: now, type: "job.queued", message: "Work package queued." };
      await writeFile(this.eventsPath(id), `${JSON.stringify(event)}\n`, "utf8");
      const conversation = createConversationProjection(undefined, now);
      await this.writeInitialConversation(id, conversation);
      await this.writeManifest(record);
      this.jobs.set(id, record);
      this.idempotencyIndex.set(input.idempotencyKey, id);
      this.messageClientIds.set(id, new Set([initialMessage.clientMessageId!]));
      this.conversations.set(id, conversation);
      return { record: structuredClone(record), created: true };
    });
  }

  async importLocalThread(input: ImportLocalThreadInput): Promise<{ record: JobRecord; created: boolean }> {
    return this.exclusive(async () => {
      const existing = Array.from(this.jobs.values()).find((record) => record.threadId === input.threadId);
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
      this.jobs.set(id, record);
      this.idempotencyIndex.set(idempotencyKey, id);
      this.messageClientIds.set(id, new Set());
      this.conversations.set(id, conversation);
      return { record: structuredClone(record), created: true };
    });
  }

  get(jobId: string): JobRecord | undefined {
    const record = this.jobs.get(jobId);
    return record ? structuredClone(record) : undefined;
  }

  list(limit = 20): JobSummary[] {
    return this.listPage(limit).data;
  }

  listAll(): JobSummary[] {
    return Array.from(this.jobs.values())
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
      .map(toSummary);
  }

  findByThreadId(threadId: string): JobSummary | undefined {
    const record = Array.from(this.jobs.values())
      .filter((candidate) => candidate.threadId === threadId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))[0];
    return record ? toSummary(record) : undefined;
  }

  listPage(limit = 50, cursor?: string, projectId?: string): ConversationListPage {
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const decodedCursor = cursor ? decodeConversationCursor(cursor) : undefined;
    const records = Array.from(this.jobs.values())
      .filter((record) => !projectId || record.project.id === projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .filter((record) => !decodedCursor || record.createdAt < decodedCursor.createdAt || (
        record.createdAt === decodedCursor.createdAt && record.id < decodedCursor.id
      ));
    const page = records.slice(0, boundedLimit);
    const last = page.at(-1);
    return {
      data: page.map(toSummary),
      nextCursor: records.length > page.length && last ? encodeConversationCursor(last.createdAt, last.id) : undefined,
    };
  }

  async snapshot(
    jobId: string,
    afterSeq = 0,
    maxEvents = 80,
    afterConversationRevision?: number,
  ): Promise<JobSnapshot> {
    const record = this.requireJob(jobId);
    const persistenceFailure = this.conversationFailures.get(jobId);
    if (persistenceFailure) throw persistenceFailure;
    const events = await this.readEvents(jobId, afterSeq, maxEvents);
    const messages = await this.readMessages(jobId);
    const nextEventSeq = events.at(-1)?.seq ?? Math.max(0, afterSeq);
    const storedConversation = this.conversations.get(jobId) ?? createConversationProjection(record.threadId, record.updatedAt);
    let conversation = afterConversationRevision === undefined
      ? mergeConversationMessages(storedConversation, messages)
      : undefined;
    let conversationChanges = afterConversationRevision === undefined
      ? []
      : await this.readConversationChanges(jobId, afterConversationRevision, 40);
    let nextConversationRevision = afterConversationRevision ?? storedConversation.revision;
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
    return {
      ...toSummary(record),
      messages,
      conversation,
      conversationChanges,
      nextConversationRevision,
      serverConversationRevision: storedConversation.revision,
      conversationHasMore: nextConversationRevision < storedConversation.revision,
      conversationDiagnostics: structuredClone(this.conversationDiagnostics.get(jobId) ?? []),
      events,
      nextEventSeq,
      serverLastEventSeq: record.lastEventSeq,
      hasMore: nextEventSeq < record.lastEventSeq,
      approvals: structuredClone(record.approvals),
      hasDiff: await fileExists(this.diffPath(jobId)),
      hasResult: await fileExists(this.resultPath(jobId)),
      inputArtifacts: structuredClone(record.inputArtifacts ?? []),
      artifacts: await this.listArtifacts(jobId),
    };
  }

  async appendUserMessage(
    jobId: string,
    input: AppendUserMessageInput,
  ): Promise<{ record: JobRecord; created: boolean }> {
    return this.exclusive(async () => {
      const record = this.requireJob(jobId);
      const persistenceFailure = this.conversationFailures.get(jobId);
      if (persistenceFailure) throw persistenceFailure;
      const ids = this.messageClientIds.get(jobId) ?? new Set<string>();
      if (ids.has(input.clientMessageId)) {
        return { record: structuredClone(record), created: false };
      }
      const message: ConversationMessage = {
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
        inputArtifacts: summarizeArtifacts(input.inputArtifacts ?? []),
      };
      await this.materializeInputArtifacts(jobId, input.inputArtifacts ?? []);
      await appendFile(this.messagesPath(jobId), `${JSON.stringify(message)}\n`, "utf8");
      ids.add(input.clientMessageId);
      this.messageClientIds.set(jobId, ids);
      const updated = await this.mutateUnlocked(jobId, () => ({
        type: "conversation.user_message.appended",
        message: "User added a conversation message.",
        data: {
          clientMessageId: input.clientMessageId,
          characterCount: input.content.length,
          inputArtifacts: message.inputArtifacts?.map(({ id, fileName, chars, bytes, sha256 }) => ({ id, fileName, chars, bytes, sha256 })),
        },
      }));
      updated.inputArtifacts = mergeArtifactSummaries(updated.inputArtifacts ?? [], message.inputArtifacts ?? []);
      const stored = this.requireJob(jobId);
      stored.inputArtifacts = structuredClone(updated.inputArtifacts);
      await this.writeManifest(stored);
      return { record: updated, created: true };
    });
  }

  async prepareTurn(jobId: string, input: PrepareTurnInput): Promise<JobRecord> {
    return this.mutate(jobId, (record) => {
      record.status = "preparing";
      record.turnId = undefined;
      record.currentExecutionMode = input.executionMode;
      record.currentApprovalReviewer = input.approvalReviewer;
      record.currentDataClassification = input.dataClassification;
      record.model = input.model;
      record.effort = input.effort;
      return {
        type: "conversation.turn.preparing",
        message: "Preparing the next Codex turn.",
        data: { executionMode: input.executionMode, approvalReviewer: input.approvalReviewer, model: input.model, effort: input.effort },
      };
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

  async setThread(jobId: string, threadId: string): Promise<JobRecord> {
    const record = await this.mutate(jobId, (record) => {
      record.threadId = threadId;
      return { type: "codex.thread.started", message: "Codex thread started.", data: { threadId } };
    });
    await this.updateConversation(jobId, (current) => ({ ...current, threadId }));
    return record;
  }

  async setTurn(jobId: string, turnId: string): Promise<JobRecord> {
    return this.mutate(jobId, (record) => {
      record.turnId = turnId;
      record.status = "running";
      return { type: "codex.turn.started", message: "Codex turn started.", data: { turnId } };
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

  async applyConversationNotification(
    jobId: string,
    notification: ConversationNotification,
    at = new Date().toISOString(),
  ): Promise<ConversationThreadProjection> {
    return this.updateConversation(jobId, (current) => reduceConversationNotification(current, notification, at));
  }

  async hydrateConversation(
    jobId: string,
    response: Record<string, unknown>,
    at = new Date().toISOString(),
    freshness?: import("./types.js").ConversationFreshness,
  ): Promise<ConversationThreadProjection> {
    return this.updateConversation(jobId, (current) => hydrateConversationProjection(current, response, at, freshness));
  }

  async markConversationFreshness(
    jobId: string,
    freshness: import("./types.js").ConversationFreshness,
  ): Promise<ConversationThreadProjection> {
    return this.updateConversation(jobId, (current) => ({
      ...current,
      freshness: structuredClone(freshness),
      revision: current.revision + 1,
      updatedAt: freshness.lastMetadataCheckedAt,
    }));
  }

  async complete(jobId: string, result: JobResult): Promise<JobRecord> {
    return this.exclusive(async () => {
      await writeFile(this.resultPath(jobId), `${JSON.stringify(result, null, 2)}\n`, "utf8");
      await writeFile(this.responsePath(jobId), result.output || result.message, "utf8");
      const record = this.requireJob(jobId);
      const assistantMessageId = `assistant:${result.turnId || record.turnId || record.stateVersion}`;
      const ids = this.messageClientIds.get(jobId) ?? new Set<string>();
      if (!ids.has(assistantMessageId)) {
        const message: ConversationMessage = {
          id: randomUUID(),
          clientMessageId: assistantMessageId,
          role: "assistant",
          content: result.output || result.message,
          at: result.completedAt,
          turnId: result.turnId || record.turnId,
          model: record.model,
          effort: record.effort,
          resultStatus: result.status,
        };
        await appendFile(this.messagesPath(jobId), `${JSON.stringify(message)}\n`, "utf8");
        ids.add(assistantMessageId);
        this.messageClientIds.set(jobId, ids);
      }
      return this.mutateUnlocked(jobId, (current) => {
        settlePendingApprovals(current, result.status === "cancelled" ? "cancelled" : "expired");
        current.result = result;
        current.status = result.status;
        return { type: `codex.turn.${result.status}`, message: result.message };
      });
    });
  }

  async readArtifact(jobId: string, artifact: "request" | "response" | "diff" | "result", maxChars = 100_000): Promise<string> {
    this.requireJob(jobId);
    const path = artifact === "request"
      ? this.requestPath(jobId)
      : artifact === "response"
        ? this.responsePath(jobId)
        : artifact === "diff"
          ? this.diffPath(jobId)
          : this.resultPath(jobId);
    try {
      const content = await readFile(path, "utf8");
      return content.length > maxChars ? `${content.slice(0, maxChars)}\n[artifact truncated]\n` : content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Artifact '${artifact}' is not available for job '${jobId}'.`);
      }
      throw error;
    }
  }

  async listArtifacts(jobId: string): Promise<JobArtifactDescriptor[]> {
    this.requireJob(jobId);
    const candidates: Array<{ id: JobArtifactKind; name: string; mimeType: string; path: string }> = [
      { id: "request", name: "request.md", mimeType: "text/markdown", path: this.requestPath(jobId) },
      { id: "response", name: "response.md", mimeType: "text/markdown", path: this.responsePath(jobId) },
      { id: "diff", name: "diff.patch", mimeType: "text/x-patch", path: this.diffPath(jobId) },
    ];
    const output: JobArtifactDescriptor[] = [];
    for (const candidate of candidates) {
      try {
        const content = await readFile(candidate.path, "utf8");
        output.push({
          id: candidate.id,
          name: candidate.name,
          mimeType: candidate.mimeType,
          chars: content.length,
          bytes: Buffer.byteLength(content, "utf8"),
          sha256: createHash("sha256").update(content, "utf8").digest("hex"),
        });
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
    const descriptor = (await this.listArtifacts(jobId)).find((item) => item.id === artifact);
    if (!descriptor) throw new Error(`Artifact '${artifact}' is not available for job '${jobId}'.`);
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > descriptor.chars) throw new Error("Invalid artifact cursor.");
    if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 20_000) throw new Error("maxChars must be between 1 and 20000.");
    const path = artifact === "request" ? this.requestPath(jobId) : artifact === "response" ? this.responsePath(jobId) : this.diffPath(jobId);
    const full = await readFile(path, "utf8");
    const content = full.slice(cursor, cursor + maxChars);
    const end = cursor + content.length;
    return { ...descriptor, cursor, nextCursor: end < full.length ? end : undefined, done: end >= full.length, content };
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
  ): Promise<JobRecord> {
    const record = this.requireJob(jobId);
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
    await appendFile(this.eventsPath(jobId), `${JSON.stringify(event)}\n`, "utf8");
    await this.writeManifest(record);
    return structuredClone(record);
  }

  private async readEvents(jobId: string, afterSeq: number, maxEvents: number): Promise<JobEvent[]> {
    const content = await readFile(this.eventsPath(jobId), "utf8");
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JobEvent)
      .filter((event) => event.seq > Math.max(0, afterSeq))
      .slice(0, Math.max(1, Math.min(maxEvents, 200)));
  }

  private async readMessages(jobId: string, maxMessages = 200): Promise<ConversationMessage[]> {
    const content = await readFile(this.messagesPath(jobId), "utf8");
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ConversationMessage)
      .slice(-Math.max(1, Math.min(maxMessages, 500)));
  }

  private async readConversation(
    record: JobRecord,
  ): Promise<{ projection: ConversationThreadProjection; diagnostics: ConversationPersistenceDiagnostic[] }> {
    await this.cleanupConversationTemps(record.id);
    const diagnostics: ConversationPersistenceDiagnostic[] = [];
    const primary = await this.readProjectionCandidate(this.conversationPath(record.id));
    const backup = await this.readProjectionCandidate(this.conversationBackupPath(record.id));
    const journal = await this.readConversationJournal(record.id);
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

    let recovered = primary.projection ?? backup.projection;
    const hasCorruptCheckpoint = primary.state === "corrupt" || backup.state === "corrupt";
    if (!recovered) {
      if (journal.patches.length > 0 && journal.patches[0]?.revision === 1) {
        recovered = createConversationProjection(record.threadId, record.createdAt);
      } else if (!hasCorruptCheckpoint && journal.patches.length === 0) {
        recovered = createConversationProjection(record.threadId, record.updatedAt);
        await this.writeInitialConversation(record.id, recovered);
        return { projection: recovered, diagnostics };
      } else {
        const failure = persistenceDiagnostic(
          "conversation_replay_failed",
          "Conversation recovery has no validated checkpoint or replayable revision-zero baseline.",
          undefined,
          journal.latestRevision,
        );
        throw new ConversationPersistenceError(failure.code, failure.message, [...diagnostics, failure]);
      }
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

    const missing = journal.patches.filter((patch) => patch.revision > recovered!.revision);
    if (missing.length > 0 && missing[0]?.revision !== recovered.revision + 1) {
      const failure = persistenceDiagnostic(
        "conversation_journal_gap",
        "The committed conversation journal cannot continue from the validated checkpoint revision.",
        recovered.revision,
        journal.latestRevision,
      );
      throw new ConversationPersistenceError(failure.code, failure.message, [...diagnostics, failure]);
    }

    const startingRevision = recovered.revision;
    try {
      for (const patch of missing) recovered = applyConversationPatch(recovered, patch);
    } catch {
      const failure = persistenceDiagnostic(
        "conversation_replay_failed",
        "The committed conversation journal could not be replayed into a valid projection.",
        startingRevision,
        journal.latestRevision,
      );
      throw new ConversationPersistenceError(failure.code, failure.message, [...diagnostics, failure]);
    }

    const primaryNeedsRepair = primary.state !== "valid" || primary.projection?.revision !== recovered.revision;
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

    return { projection: recovered, diagnostics: dedupePersistenceDiagnostics(diagnostics) };
  }

  private async updateConversation(
    jobId: string,
    update: (current: ConversationThreadProjection) => ConversationThreadProjection,
  ): Promise<ConversationThreadProjection> {
    return this.exclusive(async () => {
      const record = this.requireJob(jobId);
      const persistenceFailure = this.conversationFailures.get(jobId);
      if (persistenceFailure) throw persistenceFailure;
      const current = this.conversations.get(jobId) ?? createConversationProjection(record.threadId, record.updatedAt);
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
      let next = update(structuredClone(current));
      if (next.revision <= current.revision) {
        next = { ...next, revision: current.revision + 1, updatedAt: new Date().toISOString() };
      }
      const patch = conversationPatch(current, next);
      try {
        await this.appendConversationJournal(jobId, patch);
      } catch {
        const failure = persistenceDiagnostic(
          "conversation_journal_write_failed",
          "The conversation revision journal could not be committed.",
          current.revision,
          next.revision,
        );
        this.addConversationDiagnostic(jobId, failure);
        throw new ConversationPersistenceError(failure.code, failure.message, [failure]);
      }
      try {
        await this.writeConversation(jobId, next);
      } catch {
        this.conversations.set(jobId, structuredClone(next));
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
      this.conversations.set(jobId, structuredClone(next));
      this.pendingConversationCheckpoints.delete(jobId);
      return structuredClone(next);
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
    await writeDurableText(temp, serializeConversationProjection(projection));
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
      const backup = await this.readProjectionCandidate(this.conversationBackupPath(jobId));
      if (backup.state !== "valid") await this.writeConversationBackup(jobId, projection);
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

  private async appendConversationJournal(jobId: string, patch: ConversationProjectionPatch): Promise<void> {
    validateConversationPatch(patch);
    const handle = await open(this.conversationEventsPath(jobId), "a");
    try {
      await handle.writeFile(`${JSON.stringify(patch)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async readConversationChanges(
    jobId: string,
    afterRevision: number,
    maxChanges: number,
  ): Promise<ConversationProjectionPatch[]> {
    try {
      const journal = await this.readConversationJournal(jobId);
      for (const diagnostic of journal.diagnostics) this.addConversationDiagnostic(jobId, diagnostic);
      return journal.patches
        .filter((change) => change.revision > Math.max(0, afterRevision))
        .slice(0, Math.max(1, Math.min(maxChanges, 100)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      if (error instanceof ConversationPersistenceError) {
        this.conversationFailures.set(jobId, error);
        this.conversationDiagnostics.set(jobId, dedupePersistenceDiagnostics(error.diagnostics));
      }
      throw error;
    }
  }

  private async readConversationJournal(jobId: string): Promise<ConversationJournalRead> {
    const path = this.conversationEventsPath(jobId);
    let content: Buffer;
    try {
      content = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { exists: false, patches: [], diagnostics: [] };
      }
      throw error;
    }
    if (content.length === 0) return { exists: true, patches: [], diagnostics: [] };

    const diagnostics: ConversationPersistenceDiagnostic[] = [];
    const patches: ConversationProjectionPatch[] = [];
    let offset = 0;
    let lastValidOffset = 0;
    while (offset < content.length) {
      const newline = content.indexOf(0x0a, offset);
      const terminated = newline >= 0;
      const end = terminated ? newline : content.length;
      let line = content.subarray(offset, end);
      if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
      const nextOffset = terminated ? end + 1 : end;

      if (line.length === 0) {
        const failure = persistenceDiagnostic(
          "conversation_journal_corrupt",
          "The conversation revision journal contains an empty record before its final boundary.",
          undefined,
          patches.at(-1)?.revision,
        );
        throw new ConversationPersistenceError(failure.code, failure.message, [...diagnostics, failure]);
      }

      let patch: ConversationProjectionPatch;
      try {
        patch = JSON.parse(line.toString("utf8")) as ConversationProjectionPatch;
        validateConversationPatch(patch);
      } catch {
        if (!terminated) {
          diagnostics.push(persistenceDiagnostic(
            "conversation_journal_tail_truncated",
            "An incomplete final conversation journal record was removed after preserving all prior revisions.",
            undefined,
            patches.at(-1)?.revision,
          ));
          await truncateDurableFile(path, lastValidOffset);
          break;
        }
        const failure = persistenceDiagnostic(
          "conversation_journal_corrupt",
          "The conversation revision journal contains a malformed committed record.",
          undefined,
          patches.at(-1)?.revision,
        );
        throw new ConversationPersistenceError(failure.code, failure.message, [...diagnostics, failure]);
      }

      const previous = patches.at(-1);
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
        patches.push(patch);
      }
      lastValidOffset = nextOffset;
      offset = nextOffset;
    }

    return {
      exists: true,
      patches,
      latestRevision: patches.at(-1)?.revision,
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
    const record = this.jobs.get(jobId);
    if (!record) {
      throw new Error(`Unknown job id '${jobId}'.`);
    }
    return record;
  }

  private async writeManifest(record: JobRecord): Promise<void> {
    const path = this.manifestPath(record.id);
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    try {
      await rename(temp, path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EEXIST") {
        throw error;
      }
      await copyFile(temp, path);
      await unlink(temp).catch(() => undefined);
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.lock.then(operation, operation);
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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
    return this.jobs.get(jobId);
  }
}

function validateConversationProjection(value: unknown): asserts value is ConversationThreadProjection {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new TypeError("Invalid conversation projection schema.");
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) {
    throw new TypeError("Invalid conversation projection revision.");
  }
  if (typeof value.updatedAt !== "string" || !Array.isArray(value.turns)) {
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
  const next = structuredClone(current);
  if (patch.replaceAll) next.turns = structuredClone(patch.turns);
  if (patch.threadId !== undefined) next.threadId = patch.threadId;
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.hydratedAt !== undefined) next.hydratedAt = patch.hydratedAt;
  if (patch.freshness !== undefined) next.freshness = structuredClone(patch.freshness);
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
      for (const itemPatch of turnPatch.items) {
        if (itemPatch.clientMessageId) {
          turn.items = turn.items.filter((candidate) => !(
            candidate.id.startsWith("bridge-message:") && candidate.clientMessageId === itemPatch.clientMessageId
          ));
        }
        const index = turn.items.findIndex((candidate) => candidate.id === itemPatch.id);
        if (index < 0) turn.items.push(structuredClone(itemPatch));
        else turn.items[index] = { ...turn.items[index], ...structuredClone(itemPatch) };
      }
    }
  }
  next.revision = patch.revision;
  next.updatedAt = patch.at;
  validateConversationProjection(next);
  return next;
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
  const removedTurn = previous.turns.some(
    (turn) => !next.turns.some((candidate) => candidate.turnId === turn.turnId),
  );
  const removedItem = previous.turns.some((turn) => {
    const nextTurn = next.turns.find((candidate) => candidate.turnId === turn.turnId);
    return Boolean(nextTurn && turn.items.some(
      (item) => !nextTurn.items.some((candidate) => candidate.id === item.id),
    ));
  });
  const replaceAll = removedTurn || removedItem;
  const turns: ConversationProjectionPatch["turns"] = [];
  if (replaceAll) turns.push(...structuredClone(next.turns));
  else {
  for (const nextTurn of next.turns) {
    const previousTurn = previous.turns.find((turn) => turn.turnId === nextTurn.turnId);
    if (!previousTurn) {
      turns.push(structuredClone(nextTurn));
      continue;
    }
    const items = nextTurn.items.filter((item) => {
      const previousItem = previousTurn.items.find((candidate) => candidate.id === item.id);
      return !previousItem || JSON.stringify(previousItem) !== JSON.stringify(item);
    });
    const metadataChanged = JSON.stringify({
      status: previousTurn.status,
      startedAt: previousTurn.startedAt,
      completedAt: previousTurn.completedAt,
      durationMs: previousTurn.durationMs,
    }) !== JSON.stringify({
      status: nextTurn.status,
      startedAt: nextTurn.startedAt,
      completedAt: nextTurn.completedAt,
      durationMs: nextTurn.durationMs,
    });
    if (items.length || metadataChanged) {
      turns.push({ ...structuredClone(nextTurn), items: structuredClone(items) });
    }
  }
  }
  return {
    revision: next.revision,
    at: next.updatedAt,
    threadId: previous.threadId !== next.threadId ? next.threadId : undefined,
    status: previous.status !== next.status ? next.status : undefined,
    hydratedAt: previous.hydratedAt !== next.hydratedAt ? next.hydratedAt : undefined,
    freshness: JSON.stringify(previous.freshness) !== JSON.stringify(next.freshness)
      ? structuredClone(next.freshness)
      : undefined,
    replaceAll: replaceAll || undefined,
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
    model: record.model ?? record.workPackage.model,
    effort: record.effort ?? record.workPackage.effort,
    pendingApprovalCount: record.approvals.filter((approval) => approval.state === "pending").length,
    result: record.result,
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
