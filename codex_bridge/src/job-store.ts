import { createHash, randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type {
  BridgeProject,
  ConversationMessage,
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
  dataClassification: DataClassification;
  model?: string;
  effort?: ReasoningEffort;
  inputArtifacts?: StagedTextArtifact[];
}

export interface PrepareTurnInput {
  executionMode: ExecutionMode;
  dataClassification: DataClassification;
  model?: string;
  effort?: ReasoningEffort;
}

export class JobStore {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly idempotencyIndex = new Map<string, string>();
  private readonly messageClientIds = new Map<string, Set<string>>();
  private lock: Promise<void> = Promise.resolve();

  constructor(
    private readonly jobsDir: string,
    private readonly handoffRoot: string = join(jobsDir, "codex-inbox"),
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
        await this.ensureMessagesFile(record);
        const messages = await this.readMessages(record.id);
        this.messageClientIds.set(
          record.id,
          new Set(messages.flatMap((message) => message.clientMessageId ? [message.clientMessageId] : [])),
        );
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
        dataClassification: input.workPackage.dataClassification,
        model: input.workPackage.model,
        effort: input.workPackage.effort,
        inputArtifacts: record.inputArtifacts,
      };
      await writeFile(this.messagesPath(id), `${JSON.stringify(initialMessage)}\n`, "utf8");
      const event: JobEvent = { seq: 1, at: now, type: "job.queued", message: "Work package queued." };
      await writeFile(this.eventsPath(id), `${JSON.stringify(event)}\n`, "utf8");
      await this.writeManifest(record);
      this.jobs.set(id, record);
      this.idempotencyIndex.set(input.idempotencyKey, id);
      this.messageClientIds.set(id, new Set([initialMessage.clientMessageId!]));
      return { record: structuredClone(record), created: true };
    });
  }

  get(jobId: string): JobRecord | undefined {
    const record = this.jobs.get(jobId);
    return record ? structuredClone(record) : undefined;
  }

  list(limit = 20): JobSummary[] {
    return Array.from(this.jobs.values())
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.max(1, Math.min(limit, 100)))
      .map(toSummary);
  }

  async snapshot(jobId: string, afterSeq = 0, maxEvents = 80): Promise<JobSnapshot> {
    const record = this.requireJob(jobId);
    const events = await this.readEvents(jobId, afterSeq, maxEvents);
    return {
      ...toSummary(record),
      messages: await this.readMessages(jobId),
      events,
      nextEventSeq: record.lastEventSeq,
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
      record.currentDataClassification = input.dataClassification;
      record.model = input.model;
      record.effort = input.effort;
      return {
        type: "conversation.turn.preparing",
        message: "Preparing the next Codex turn.",
        data: { executionMode: input.executionMode, model: input.model, effort: input.effort },
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
    return this.mutate(jobId, (record) => {
      record.threadId = threadId;
      return { type: "codex.thread.started", message: "Codex thread started.", data: { threadId } };
    });
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

function assertUuid(value: string, field: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error(`Invalid ${field}.`);
}

function allowedHandoffExtension(fileName: string): string {
  const extension = extname(fileName).toLowerCase();
  return HANDOFF_EXTENSIONS.has(extension) ? extension : ".txt";
}

export function toSummary(record: JobRecord): JobSummary {
  return {
    id: record.id,
    projectId: record.project.id,
    projectName: record.project.name,
    title: record.workPackage.title,
    objective: record.workPackage.objective,
    executionMode: record.currentExecutionMode ?? record.workPackage.executionMode,
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
