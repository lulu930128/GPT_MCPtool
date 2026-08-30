import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, normalize, parse, relative } from "node:path";
import type { BridgeConfig } from "./config.js";
import type {
  AppServerTransport,
  JsonRpcNotification,
  JsonRpcServerRequest,
} from "./app-server-client.js";
import type { AppendUserMessageInput, JobStore } from "./job-store.js";
import type { TextBundleStore } from "./text-bundle-store.js";
import { buildCodexUserInput, buildInitialTurnUserInput } from "./conversation-input.js";
import { createConversationProjection, hydrateConversationProjection } from "./conversation-projection.js";
import { ThreadHistoryReader } from "./thread-history-reader.js";
import { redactString, sanitizeForStorage } from "./redaction.js";
import type {
  ApprovalKind,
  ApprovalState,
  BridgeProject,
  CodexModelOption,
  JobRecord,
  JobResult,
  LocalThreadFreshRead,
  LocalThreadListPage,
  LocalThreadSnapshot,
  LocalThreadSummary,
  MaterializedTextArtifact,
  PendingApproval,
  WorkPackage,
} from "./types.js";
import { digestWorkPackage, type WorkPackagePreview } from "./work-package.js";

const MAX_LOCAL_THREAD_INVENTORY = 10_000;

export interface DispatchInput {
  preview: WorkPackagePreview;
  previewDigest: string;
  idempotencyKey: string;
}

export interface ConversationSendInput extends AppendUserMessageInput {
  jobId: string;
  inputBundleIds?: string[];
}

export interface LocalConversationSendInput extends AppendUserMessageInput {
  localThreadId: string;
  inputBundleIds?: string[];
}

export interface ConversationSendResult {
  record: JobRecord;
  accepted: boolean;
  delivery: "steer" | "turn" | "duplicate";
}

type ResolvedConversationSendInput = Omit<ConversationSendInput, "inputArtifacts"> & {
  inputArtifacts: MaterializedTextArtifact[];
};

interface LiveApproval {
  jobId: string;
  requestId: string | number;
}

export class CodexBridgeController {
  private readonly jobsByThread = new Map<string, string>();
  private readonly jobsByTurn = new Map<string, string>();
  private readonly liveApprovals = new Map<string, LiveApproval>();
  private readonly finalOutputByJob = new Map<string, string>();
  private readonly diagnosticSignaturesByJob = new Map<string, Set<string>>();
  private readonly jobLocks = new Map<string, Promise<void>>();
  private readonly historyReader: ThreadHistoryReader;
  private readonly threadSyncStates = new Map<string, {
    fingerprint: string;
    lastFullReadAt: number;
    historyMode: "legacy" | "paginated";
  }>();
  private readonly hydrationRetryAfter = new Map<string, number>();
  private readonly discoveredProjects = new Map<string, BridgeProject>();
  private modelCache?: { expiresAt: number; models: CodexModelOption[] };

  constructor(
    private readonly config: BridgeConfig,
    private readonly store: JobStore,
    private readonly textBundles: TextBundleStore,
    private readonly appServer: AppServerTransport,
  ) {
    this.historyReader = new ThreadHistoryReader(appServer);
    this.appServer.on("notification", (message) => void this.handleNotification(message));
    this.appServer.on("serverRequest", (message) => void this.handleServerRequest(message));
    this.appServer.on("stderr", (line) => void this.handleStderr(line));
    this.appServer.on("exit", (error) => void this.handleExit(error));
  }

  get status(): AppServerTransport["status"] {
    return this.appServer.status;
  }

  async close(): Promise<void> {
    await this.appServer.close();
  }

  async hydrateConversation(jobId: string, force = false): Promise<boolean> {
    return this.withJobLock(jobId, async () => {
      const job = requireJob(this.store, jobId);
      if (!job.threadId) return false;
      if (!force && this.jobsByThread.get(job.threadId) === jobId && ["preparing", "running", "awaiting_approval"].includes(job.status)) {
        return false;
      }
      if (!force && (this.hydrationRetryAfter.get(job.threadId) ?? 0) > Date.now()) return false;
      const checkedAt = new Date().toISOString();
      try {
        const metadata = await this.historyReader.readMetadata(job.threadId);
        const fingerprint = await this.historyReader.freshnessFingerprint(metadata);
        const previous = this.threadSyncStates.get(job.threadId);
        const periodicFullReadDue = !previous || Date.now() - previous.lastFullReadAt >= 60_000;
        if (!force && previous?.fingerprint === fingerprint && !periodicFullReadDue) {
          return false;
        }
        const history = await this.historyReader.read(job.threadId, metadata, fingerprint);
        await this.store.hydrateConversation(jobId, history.response, checkedAt, {
          historyMode: history.metadata.historyMode,
          synchronized: true,
          sourceAvailability: "available",
          lastMetadataCheckedAt: checkedAt,
          lastHydratedAt: checkedAt,
          sourceUpdatedAt: history.metadata.updatedAt,
          sourceRecencyAt: history.metadata.recencyAt,
          sourceFingerprint: history.sourceFingerprint,
        });
        this.threadSyncStates.set(job.threadId, {
          fingerprint,
          lastFullReadAt: Date.now(),
          historyMode: history.metadata.historyMode,
        });
        this.hydrationRetryAfter.delete(job.threadId);
        return true;
      } catch (error) {
        this.hydrationRetryAfter.set(job.threadId, Date.now() + 30_000);
        const previous = this.threadSyncStates.get(job.threadId);
        await this.store.markConversationFreshness(jobId, {
          historyMode: previous?.historyMode ?? "legacy",
          synchronized: false,
          sourceAvailability: "unavailable",
          lastMetadataCheckedAt: checkedAt,
          sourceFingerprint: previous?.fingerprint,
          staleReason: errorMessage(error).slice(0, 2_000),
        }).catch(() => undefined);
        await this.store.appendEvent(jobId, "conversation.hydration.failed", "Codex thread history synchronization failed; the last verified projection remains available.", {
          error: errorMessage(error),
        }).catch(() => undefined);
        return false;
      }
    });
  }

  async listModels(force = false): Promise<CodexModelOption[]> {
    if (!force && this.modelCache && this.modelCache.expiresAt > Date.now()) {
      return structuredClone(this.modelCache.models);
    }
    const response = await this.appServer.request<Record<string, unknown>>("model/list", {
      limit: 100,
      includeHidden: false,
    });
    const models = (Array.isArray(response.data) ? response.data : [])
      .flatMap((value) => {
        if (!isObject(value)) return [];
        const id = stringValue(value.id) ?? stringValue(value.model);
        if (!id || value.hidden === true) return [];
        const supportedReasoningEfforts = (Array.isArray(value.supportedReasoningEfforts)
          ? value.supportedReasoningEfforts
          : [])
          .flatMap((option) => {
            if (!isObject(option)) return [];
            const reasoningEffort = stringValue(option.reasoningEffort);
            if (!isReasoningEffort(reasoningEffort)) return [];
            return [{ reasoningEffort, description: stringValue(option.description) }];
          });
        const defaultReasoningEffort = stringValue(value.defaultReasoningEffort);
        return [{
          id,
          displayName: stringValue(value.displayName) ?? id,
          isDefault: value.isDefault === true,
          defaultReasoningEffort: isReasoningEffort(defaultReasoningEffort) ? defaultReasoningEffort : undefined,
          supportedReasoningEfforts,
        } satisfies CodexModelOption];
      });
    this.modelCache = { expiresAt: Date.now() + 5 * 60_000, models };
    return structuredClone(models);
  }

  async listLocalThreads(cursor?: string, maxThreads = MAX_LOCAL_THREAD_INVENTORY): Promise<LocalThreadListPage> {
    const boundedLimit = Number.isFinite(maxThreads)
      ? Math.max(1, Math.min(MAX_LOCAL_THREAD_INVENTORY, Math.trunc(maxThreads)))
      : MAX_LOCAL_THREAD_INVENTORY;
    const threads: LocalThreadSummary[] = [];
    const seenThreadIds = new Set<string>();
    const seenCursors = new Set<string>();
    let nextCursor = cursor;
    let firstPage = true;

    while (threads.length < boundedLimit && (firstPage || nextCursor)) {
      firstPage = false;
      if (nextCursor) {
        if (seenCursors.has(nextCursor)) {
          return { threads, nextCursor, complete: false };
        }
        seenCursors.add(nextCursor);
      }
      const response = await this.appServer.request<Record<string, unknown>>("thread/list", {
        limit: Math.min(100, boundedLimit - threads.length),
        archived: false,
        sortKey: "recency_at",
        sortDirection: "desc",
        ...(nextCursor ? { cursor: nextCursor } : {}),
      });
      const data = Array.isArray(response.data) ? response.data : [];
      for (const rawThread of data) {
        if (!isObject(rawThread)) continue;
        const thread = await this.normalizeLocalThread(rawThread);
        if (!thread || seenThreadIds.has(thread.threadId)) continue;
        seenThreadIds.add(thread.threadId);
        threads.push(thread);
        if (threads.length >= boundedLimit) break;
      }
      const returnedCursor = stringValue(response.nextCursor);
      nextCursor = returnedCursor || undefined;
      if (!nextCursor) break;
    }

    return {
      threads,
      nextCursor,
      complete: !nextCursor,
    };
  }

  async readLocalThread(threadId: string): Promise<LocalThreadSnapshot> {
    const result = await this.readLocalThreadFresh(threadId);
    if (!result.snapshot) throw new Error("Codex App Server did not return a refreshed local thread snapshot.");
    return result.snapshot;
  }

  async readLocalThreadSummary(threadId: string): Promise<LocalThreadSummary> {
    const metadata = await this.historyReader.readMetadata(threadId);
    const summary = await this.normalizeLocalThread(metadata.rawThread);
    if (!summary) throw new Error("The requested Codex thread is not a persisted local conversation.");
    return summary;
  }

  async readLocalThreadFresh(threadId: string, knownFingerprint?: string): Promise<LocalThreadFreshRead> {
    const metadata = await this.historyReader.readMetadata(threadId);
    const summary = await this.normalizeLocalThread(metadata.rawThread);
    if (!summary) throw new Error("The requested Codex thread is not a persisted local conversation.");
    const sourceFingerprint = await this.historyReader.freshnessFingerprint(metadata);
    if (knownFingerprint === sourceFingerprint) return { summary, sourceFingerprint };
    const history = await this.historyReader.read(threadId, metadata, sourceFingerprint);
    return {
      summary,
      sourceFingerprint,
      snapshot: this.localThreadSnapshot(summary, history),
    };
  }

  private localThreadSnapshot(
    summary: LocalThreadSummary,
    history: Awaited<ReturnType<ThreadHistoryReader["read"]>>,
  ): LocalThreadSnapshot {
    const threadId = summary.threadId;
    const response = history.response;
    const rawThread = isObject(response.thread) ? response.thread : undefined;
    if (!rawThread || stringValue(rawThread.id) !== threadId) {
      throw new Error("Codex App Server did not return the requested local thread.");
    }
    const checkedAt = new Date().toISOString();
    const conversation = hydrateConversationProjection(createConversationProjection(threadId), response, checkedAt, {
      historyMode: history.metadata.historyMode,
      synchronized: true,
      sourceAvailability: "available",
      lastMetadataCheckedAt: checkedAt,
      lastHydratedAt: checkedAt,
      sourceUpdatedAt: history.metadata.updatedAt,
      sourceRecencyAt: history.metadata.recencyAt,
      sourceFingerprint: history.sourceFingerprint,
    });
    return {
      id: `local:${threadId}`,
      source: "local",
      readOnly: summary.historyOnly,
      localThreadId: threadId,
      threadId,
      projectId: summary.projectId,
      projectName: summary.projectName,
      title: summary.title,
      objective: summary.preview,
      executionMode: summary.historyOnly ? "plan" : "workspace_write",
      approvalReviewer: "user",
      dataClassification: "personal",
      status: "completed",
      stateVersion: unixSeconds(summary.updatedAt),
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      pendingApprovalCount: 0,
      threadStatus: summary.threadStatus,
      messages: [],
      conversation,
      conversationChanges: [],
      nextConversationRevision: conversation.revision,
      serverConversationRevision: conversation.revision,
      conversationHasMore: false,
      conversationDiagnostics: [],
      events: [],
      nextEventSeq: 0,
      serverLastEventSeq: 0,
      hasMore: false,
      approvals: [],
      hasDiff: false,
      hasResult: false,
      inputArtifacts: [],
      artifacts: [],
    };
  }

  requireOperableProject(projectId: string): BridgeProject {
    const project = this.config.projects.get(projectId) ?? this.discoveredProjects.get(projectId);
    if (!project) throw new Error(`Unknown or protected project id '${projectId}'.`);
    return structuredClone(project);
  }

  private async normalizeLocalThread(rawThread: Record<string, unknown>): Promise<LocalThreadSummary | undefined> {
    const threadId = stringValue(rawThread.id);
    const cwd = stringValue(rawThread.cwd);
    if (!threadId || !cwd || rawThread.ephemeral === true) return undefined;
    const project = await this.localProjectForPath(cwd);
    const preview = boundedMetadata(stringValue(rawThread.preview) ?? "", 1_000);
    const title = boundedMetadata(stringValue(rawThread.name) ?? firstLine(preview) ?? "未命名對話", 240);
    return {
      source: "local",
      threadId,
      projectId: project.id,
      projectName: project.name,
      title,
      preview,
      createdAt: timestampValue(rawThread.createdAt),
      updatedAt: timestampValue(rawThread.recencyAt ?? rawThread.updatedAt ?? rawThread.createdAt),
      threadStatus: localThreadStatus(rawThread.status),
      historyMode: stringValue(rawThread.historyMode) === "paginated" ? "paginated" : "legacy",
      isPinned: rawThread.isPinned === true,
      historyOnly: project.historyOnly,
    };
  }

  private async localProjectForPath(cwd: string): Promise<{ id: string; name: string; historyOnly: boolean }> {
    let resolvedCwd: string;
    try {
      resolvedCwd = await realpath(cwd);
      const info = await stat(resolvedCwd);
      if (!info.isDirectory()) throw new Error("not a directory");
    } catch {
      const normalizedCwd = comparablePath(cwd);
      const name = basename(cwd) || parse(cwd).root || "本機專案";
      const digest = createHash("sha256").update(normalizedCwd).digest("hex").slice(0, 16);
      return { id: `local:${digest}`, name: boundedMetadata(name, 120), historyOnly: true };
    }
    const normalizedCwd = comparablePath(resolvedCwd);
    for (const project of this.config.projects.values()) {
      if (comparablePath(project.path) === normalizedCwd) {
        return { id: project.id, name: project.name, historyOnly: false };
      }
    }
    const name = basename(resolvedCwd) || parse(resolvedCwd).root || "本機專案";
    const digest = createHash("sha256").update(normalizedCwd).digest("hex").slice(0, 16);
    const project = { id: `local:${digest}`, name: boundedMetadata(name, 120), path: resolvedCwd };
    const historyOnly = !isSafeDiscoveredProjectPath(resolvedCwd, this.config);
    if (!historyOnly) this.discoveredProjects.set(project.id, project);
    else this.discoveredProjects.delete(project.id);
    return { id: project.id, name: project.name, historyOnly };
  }

  async dispatch(input: DispatchInput): Promise<{ record: JobRecord; created: boolean }> {
    const actualDigest = digestWorkPackage(input.preview.workPackage);
    if (input.previewDigest !== input.preview.previewDigest || input.previewDigest !== actualDigest) {
      throw new Error("The work package changed after preview; preview it again before dispatch.");
    }
    const project = this.requireOperableProject(input.preview.workPackage.projectId);
    await this.assertProjectStillOperable(project);
    await this.validateModelSelection(input.preview.workPackage.model, input.preview.workPackage.effort);
    const inputArtifacts = await this.textBundles.resolveMany(
      input.preview.workPackage.inputBundleIds,
      project.id,
      input.preview.workPackage.dataClassification,
    );
    const created = await this.store.create({
      project,
      workPackage: input.preview.workPackage,
      previewDigest: input.previewDigest,
      idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
      inputArtifacts,
    });
    if (created.created) {
      void this.execute(created.record.id);
    }
    return created;
  }

  async sendMessage(input: ConversationSendInput): Promise<ConversationSendResult> {
    return this.withJobLock(input.jobId, async () => {
      let job = requireJob(this.store, input.jobId);
      await this.assertProjectStillOperable(job.project);
      const active = ["running", "awaiting_approval"].includes(job.status);
      if (!active && !isTerminal(job.status)) {
        throw new Error("Wait for the current conversation turn to start before sending another message.");
      }
      if (active) {
        const currentMode = job.currentExecutionMode ?? job.workPackage.executionMode;
        const currentReviewer = job.currentApprovalReviewer ?? job.workPackage.approvalReviewer ?? "user";
        const currentModel = job.model ?? job.workPackage.model;
        const currentEffort = job.effort ?? job.workPackage.effort;
        if (
          input.executionMode !== currentMode ||
          input.approvalReviewer !== currentReviewer ||
          input.model !== currentModel ||
          input.effort !== currentEffort
        ) {
          throw new Error("Execution mode, approval reviewer, model, and reasoning effort cannot change while a turn is running.");
        }
      }
      await this.validateModelSelection(input.model, input.effort);
      const stagedInputArtifacts = await this.textBundles.resolveMany(
        input.inputBundleIds ?? [],
        job.project.id,
        input.dataClassification,
      );
      const appended = await this.store.appendUserMessage(input.jobId, { ...input, inputArtifacts: stagedInputArtifacts });
      if (!appended.created) {
        return { record: appended.record, accepted: false, delivery: "duplicate" };
      }
      const inputArtifacts = await this.store.readInputArtifacts(
        input.jobId,
        stagedInputArtifacts.map((artifact) => artifact.id),
      );
      const resolvedInput: ResolvedConversationSendInput = { ...input, inputArtifacts };
      job = appended.record;

      if (active) {
        if (!job.threadId || !job.turnId) {
          throw new Error("The active conversation does not have a live Codex turn.");
        }
        await this.appServer.request("turn/steer", {
          threadId: job.threadId,
          expectedTurnId: job.turnId,
          clientUserMessageId: resolvedInput.clientMessageId,
          input: [{ type: "text", text: buildCodexUserInput({
            message: resolvedInput.content,
            context: resolvedInput.context,
            artifacts: resolvedInput.inputArtifacts,
          }) }],
        });
        const record = await this.store.appendEvent(job.id, "operator.steered", "Operator sent a conversation message.", {
          characterCount: input.content.length,
        });
        return { record, accepted: true, delivery: "steer" };
      }
      if (!job.threadId) {
        throw new Error("This legacy conversation has no Codex thread id and cannot be resumed.");
      }
      const prepared = await this.store.prepareTurn(job.id, input);
      void this.resumeAndExecute(prepared.id, resolvedInput);
      return { record: prepared, accepted: true, delivery: "turn" };
    });
  }

  async sendLocalThreadMessage(input: LocalConversationSendInput): Promise<ConversationSendResult> {
    const history = await this.historyReader.read(input.localThreadId);
    const response = history.response;
    const rawThread = isObject(response.thread) ? response.thread : undefined;
    if (!rawThread || stringValue(rawThread.id) !== input.localThreadId) {
      throw new Error("Codex App Server did not return the requested local thread.");
    }
    const summary = await this.normalizeLocalThread(rawThread);
    if (!summary || summary.historyOnly) {
      throw new Error("This local conversation belongs to a protected or unavailable workspace.");
    }
    const project = this.requireOperableProject(summary.projectId);
    await this.assertProjectStillOperable(project);
    const workPackage = {
      projectId: project.id,
      title: summary.title.slice(0, 120) || "本機對話",
      objective: summary.preview || summary.title || "Continue an existing local Codex conversation.",
      context: "",
      acceptanceCriteria: [],
      constraints: [],
      executionMode: input.executionMode,
      approvalReviewer: input.approvalReviewer,
      dataClassification: input.dataClassification,
      model: input.model,
      effort: input.effort,
      inputBundleIds: [],
    } satisfies WorkPackage;
    const synchronizedAt = new Date().toISOString();
    const imported = await this.store.importLocalThread({
      project,
      workPackage,
      previewDigest: digestWorkPackage(workPackage),
      threadId: input.localThreadId,
      threadResponse: response,
      freshness: {
        historyMode: history.metadata.historyMode,
        synchronized: true,
        sourceAvailability: "available",
        lastMetadataCheckedAt: synchronizedAt,
        lastHydratedAt: synchronizedAt,
        sourceUpdatedAt: history.metadata.updatedAt,
        sourceRecencyAt: history.metadata.recencyAt,
        sourceFingerprint: history.sourceFingerprint,
      },
    });
    this.jobsByThread.set(input.localThreadId, imported.record.id);
    this.threadSyncStates.set(input.localThreadId, {
      fingerprint: history.sourceFingerprint,
      lastFullReadAt: Date.now(),
      historyMode: history.metadata.historyMode,
    });
    return this.sendMessage({
      ...input,
      jobId: imported.record.id,
    });
  }

  async cancel(jobId: string): Promise<JobRecord> {
    const job = requireJob(this.store, jobId);
    if (isTerminal(job.status)) {
      return job;
    }
    if (job.threadId && job.turnId && this.appServer.status === "ready") {
      await this.appServer.request("turn/interrupt", { threadId: job.threadId, turnId: job.turnId });
    }
    if (job.turnId) {
      await this.store.applyConversationNotification(jobId, {
        method: "turn/completed",
        params: { threadId: job.threadId, turn: { id: job.turnId, status: "interrupted", items: [] } },
      });
    }
    return this.store.complete(jobId, resultFor(job, "cancelled", "Job cancelled by the operator."));
  }

  async steer(jobId: string, message: string): Promise<JobRecord> {
    const job = requireJob(this.store, jobId);
    if (!job.threadId || !job.turnId || !["running", "awaiting_approval"].includes(job.status)) {
      throw new Error("Only a running Codex turn can be steered.");
    }
    const text = message.trim();
    if (!text || text.length > 4_000) {
      throw new Error("Steering text must be between 1 and 4000 characters.");
    }
    await this.appServer.request("turn/steer", {
      threadId: job.threadId,
      expectedTurnId: job.turnId,
      input: [{ type: "text", text }],
    });
    return this.store.appendEvent(jobId, "operator.steered", "Operator sent steering guidance.", {
      characterCount: text.length,
    });
  }

  async decideApproval(
    jobId: string,
    approvalId: string,
    decision: "accept" | "decline" | "cancel",
  ): Promise<JobRecord> {
    const live = this.liveApprovals.get(approvalId);
    if (!live || live.jobId !== jobId) {
      throw new Error("This approval is no longer attached to a live App Server request.");
    }
    const job = requireJob(this.store, jobId);
    const approval = job.approvals.find((item) => item.id === approvalId);
    if (
      decision === "accept" &&
      approval?.kind === "file_change" &&
      (job.currentExecutionMode ?? job.workPackage.executionMode) === "plan"
    ) {
      throw new Error("File changes cannot be accepted while the job is in plan mode.");
    }
    this.appServer.respond(live.requestId, { decision });
    this.liveApprovals.delete(approvalId);
    const state: ApprovalState = decision === "accept" ? "accepted" : decision === "decline" ? "declined" : "cancelled";
    const record = await this.store.resolveApproval(jobId, approvalId, state);
    await this.store.applyConversationNotification(jobId, {
      method: "bridge/approval",
      params: {
        threadId: job.threadId,
        turnId: stringValue(approval?.summary.turnId) ?? job.turnId,
        itemId: stringValue(approval?.summary.itemId),
        approvalId,
        state,
        kind: approval?.kind,
      },
    });
    return record;
  }

  private async execute(jobId: string): Promise<void> {
    const job = requireJob(this.store, jobId);
    try {
      await this.assertProjectStillOperable(job.project);
      await this.store.transition(jobId, "preparing", "Starting the local Codex App Server.");
      await this.appServer.ensureStarted();
      const permissionProfile = await this.selectPermissionProfile(job, job.workPackage.executionMode);
      const threadResponse = await this.appServer.request<Record<string, unknown>>("thread/start", {
        cwd: job.project.path,
        runtimeWorkspaceRoots: [job.project.path],
        approvalPolicy: "on-request",
        approvalsReviewer: job.workPackage.approvalReviewer ?? "user",
        permissions: permissionProfile,
        serviceName: "codex-handoff-bridge",
        ...(job.workPackage.model ? { model: job.workPackage.model } : {}),
      });
      const threadId = nestedId(threadResponse, "thread");
      if (!threadId) {
        throw new Error("Codex App Server did not return a thread id.");
      }
      this.jobsByThread.set(threadId, jobId);
      await this.store.setThread(jobId, threadId);
      const inputArtifacts = await this.store.readInputArtifacts(jobId, job.workPackage.inputBundleIds);

      const turnResponse = await this.appServer.request<Record<string, unknown>>("turn/start", {
        threadId,
        clientUserMessageId: `initial:${job.id}`,
        cwd: job.project.path,
        runtimeWorkspaceRoots: [job.project.path],
        approvalPolicy: "on-request",
        approvalsReviewer: job.workPackage.approvalReviewer ?? "user",
        ...(job.workPackage.model ? { model: job.workPackage.model } : {}),
        ...(job.workPackage.effort ? { effort: job.workPackage.effort } : {}),
        input: [
          {
            type: "text",
            text: buildInitialTurnUserInput(job.workPackage, inputArtifacts),
          },
        ],
      });
      const turnId = nestedId(turnResponse, "turn");
      if (!turnId) {
        throw new Error("Codex App Server did not return a turn id.");
      }
      this.jobsByTurn.set(turnId, jobId);
      await this.store.setTurn(jobId, turnId);
      await this.store.applyConversationNotification(jobId, {
        method: "turn/started",
        params: { threadId, turn: isObject(turnResponse.turn) ? turnResponse.turn : { id: turnId, status: "inProgress", items: [] } },
      });
    } catch (error) {
      const current = requireJob(this.store, jobId);
      if (!isTerminal(current.status)) {
        await this.store.complete(jobId, resultFor(current, "failed", `Unable to start Codex work: ${errorMessage(error)}`));
      }
      this.removeMappings(current);
    }
  }

  private async resumeAndExecute(jobId: string, input: ResolvedConversationSendInput): Promise<void> {
    let job = requireJob(this.store, jobId);
    try {
      await this.assertProjectStillOperable(job.project);
      await this.appServer.ensureStarted();
      const permissionProfile = await this.selectPermissionProfile(job, input.executionMode);
      const resumed = await this.appServer.request<Record<string, unknown>>("thread/resume", {
        threadId: job.threadId,
        cwd: job.project.path,
        runtimeWorkspaceRoots: [job.project.path],
        approvalPolicy: "on-request",
        approvalsReviewer: input.approvalReviewer,
        permissions: permissionProfile,
        serviceName: "codex-handoff-bridge",
        ...(input.model ? { model: input.model } : {}),
      });
      const threadId = nestedId(resumed, "thread") ?? job.threadId;
      if (!threadId) {
        throw new Error("Codex App Server did not return a resumed thread id.");
      }
      this.threadSyncStates.delete(threadId);
      this.jobsByThread.set(threadId, jobId);
      const turnResponse = await this.appServer.request<Record<string, unknown>>("turn/start", {
        threadId,
        clientUserMessageId: input.clientMessageId,
        cwd: job.project.path,
        runtimeWorkspaceRoots: [job.project.path],
        approvalPolicy: "on-request",
        approvalsReviewer: input.approvalReviewer,
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        input: [{ type: "text", text: buildCodexUserInput({
          message: input.content,
          context: input.context,
          artifacts: input.inputArtifacts,
        }) }],
      });
      const turnId = nestedId(turnResponse, "turn");
      if (!turnId) {
        throw new Error("Codex App Server did not return a turn id.");
      }
      this.jobsByTurn.set(turnId, jobId);
      await this.store.setTurn(jobId, turnId);
      await this.store.applyConversationNotification(jobId, {
        method: "turn/started",
        params: { threadId, turn: isObject(turnResponse.turn) ? turnResponse.turn : { id: turnId, status: "inProgress", items: [] } },
      });
    } catch (error) {
      job = requireJob(this.store, jobId);
      if (!isTerminal(job.status)) {
        await this.store.complete(jobId, resultFor(job, "failed", `Unable to continue Codex conversation: ${errorMessage(error)}`));
      }
      this.removeMappings(job);
    }
  }

  private async validateModelSelection(model?: string, effort?: string): Promise<void> {
    if (!model && !effort) {
      return;
    }
    const models = await this.listModels();
    const selected = model
      ? models.find((candidate) => candidate.id === model)
      : models.find((candidate) => candidate.isDefault) ?? models[0];
    if (!selected) {
      throw new Error(model ? `Codex model '${model}' is not available.` : "Codex did not return a default model.");
    }
    if (effort && !selected.supportedReasoningEfforts.some((option) => option.reasoningEffort === effort)) {
      throw new Error(`Reasoning effort '${effort}' is not available for model '${selected.id}'.`);
    }
  }

  private async assertProjectStillOperable(project: BridgeProject): Promise<void> {
    const configured = this.config.projects.get(project.id);
    if (configured && comparablePath(configured.path) === comparablePath(project.path)) return;
    const resolved = await this.localProjectForPath(project.path);
    if (resolved.historyOnly || resolved.id !== project.id) {
      throw new Error(`Project '${project.name}' is no longer an operable discovered workspace.`);
    }
  }

  private async withJobLock<T>(jobId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.jobLocks.get(jobId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.jobLocks.set(jobId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.jobLocks.get(jobId) === queued) {
        this.jobLocks.delete(jobId);
      }
    }
  }

  private async selectPermissionProfile(job: JobRecord, executionMode = job.currentExecutionMode ?? job.workPackage.executionMode): Promise<string> {
    const requiredId = executionMode === "plan" ? "codex-bridge-read-only" : "codex-bridge-workspace";
    const response = await this.appServer.request<Record<string, unknown>>("permissionProfile/list", {
      cwd: job.project.path,
      limit: 100,
    });
    const profiles = Array.isArray(response.data) ? response.data : [];
    const profile = profiles.find(
      (value) => isObject(value) && stringValue(value.id) === requiredId && value.allowed === true,
    );
    if (!profile) {
      throw new Error(`Required Codex permission profile '${requiredId}' is unavailable for this project.`);
    }
    return requiredId;
  }

  private async handleNotification(message: JsonRpcNotification): Promise<void> {
    const params = message.params ?? {};
    const jobId = this.findJobId(params);
    if (!jobId) {
      return;
    }
    await this.withJobLock(jobId, async () => {
      const job = this.store.get(jobId);
      if (!job || isTerminal(job.status)) return;
      try {
        await this.store.applyConversationNotification(jobId, message);
        if (message.method === "turn/diff/updated") {
          const diff = stringValue(params.diff) ?? stringValue(params.unifiedDiff);
          if (diff !== undefined) {
            await this.store.setDiff(jobId, diff);
          }
          return;
        }
        if (message.method === "turn/completed") {
          const status = completionStatus(params);
          const output = finalAgentOutput(params) ?? this.finalOutputByJob.get(jobId);
          await this.store.complete(jobId, resultFor(job, status, completionMessage(params, status), output));
          this.finalOutputByJob.delete(jobId);
          this.removeMappings(job);
          return;
        }
        if (message.method === "error") {
          await this.store.appendEvent(jobId, "codex.error", "Codex reported an error.", summarizeParams(params));
          return;
        }
        if (message.method === "item/started" || message.method === "item/completed") {
          const item = isObject(params.item) ? params.item : params;
          const phase = message.method === "item/started" ? "started" : "completed";
          if (phase === "completed" && stringValue(item.type) === "agentMessage") {
            const text = stringValue(item.text);
            if (text) this.finalOutputByJob.set(jobId, boundedOutput(text));
          }
          if (!shouldPersistItemEvent(item, phase)) {
            return;
          }
          await this.store.appendEvent(
            jobId,
            phase === "started" ? "codex.item.started" : "codex.item.completed",
            itemMessage(item, phase),
            itemSummary(item),
          );
        }
      } catch (error) {
        await this.store.appendEvent(jobId, "bridge.event.error", "Failed to persist a Codex event.", {
          method: message.method,
          error: errorMessage(error),
        }).catch(() => undefined);
      }
    });
  }

  private async handleServerRequest(message: JsonRpcServerRequest): Promise<void> {
    const params = message.params ?? {};
    const jobId = this.findJobId(params);
    const kind = approvalKind(message.method);
    if (!jobId || !kind) {
      this.appServer.respond(message.id, safeDeclineResponse(message.method));
      return;
    }
    if (kind !== "command" && kind !== "file_change") {
      this.appServer.respond(message.id, safeDeclineResponse(message.method));
      await this.store.appendEvent(jobId, "codex.request.declined", "Unsupported interactive request declined by v1 bridge.", {
        method: message.method,
        kind,
      });
      return;
    }

    const approval: PendingApproval = {
      id: randomUUID(),
      kind,
      state: "pending",
      method: message.method,
      createdAt: new Date().toISOString(),
      summary: summarizeApproval(kind, params),
    };
    this.liveApprovals.set(approval.id, { jobId, requestId: message.id });
    try {
      await this.store.addApproval(jobId, approval);
      await this.store.applyConversationNotification(jobId, {
        method: "bridge/approval",
        params: {
          threadId: stringValue(params.threadId),
          turnId: stringValue(params.turnId),
          itemId: stringValue(params.itemId),
          approvalId: approval.id,
          state: approval.state,
          kind: approval.kind,
        },
      });
    } catch (error) {
      this.liveApprovals.delete(approval.id);
      this.appServer.respond(message.id, { decision: "decline" });
    }
  }

  private async handleStderr(line: string): Promise<void> {
    const active = Array.from(this.jobsByTurn.values()).at(-1);
    if (!active) {
      return;
    }
    const diagnostic = errorDiagnostic(line);
    if (!diagnostic) {
      return;
    }
    const signatures = this.diagnosticSignaturesByJob.get(active) ?? new Set<string>();
    if (signatures.has(diagnostic.signature) || signatures.size >= 10) {
      return;
    }
    signatures.add(diagnostic.signature);
    this.diagnosticSignaturesByJob.set(active, signatures);
    await this.store.appendEvent(active, "codex.diagnostic.error", "Codex App Server reported an error.", diagnostic.data)
      .catch(() => undefined);
  }

  private async handleExit(error: Error): Promise<void> {
    const jobIds = new Set(this.jobsByTurn.values());
    this.jobsByThread.clear();
    this.jobsByTurn.clear();
    this.liveApprovals.clear();
    for (const jobId of jobIds) {
      const job = this.store.get(jobId);
      if (job && !isTerminal(job.status)) {
        if (job.turnId) {
          await this.store.applyConversationNotification(jobId, {
            method: "turn/completed",
            params: { threadId: job.threadId, turn: { id: job.turnId, status: "interrupted", items: [] } },
          }).catch(() => undefined);
        }
        await this.store.complete(jobId, resultFor(job, "interrupted", error.message)).catch(() => undefined);
      }
      this.finalOutputByJob.delete(jobId);
      this.diagnosticSignaturesByJob.delete(jobId);
    }
  }

  private findJobId(params: Record<string, unknown>): string | undefined {
    const turnId = stringValue(params.turnId) ?? nestedId(params, "turn");
    if (turnId && this.jobsByTurn.has(turnId)) {
      return this.jobsByTurn.get(turnId);
    }
    const threadId = stringValue(params.threadId) ?? nestedId(params, "thread");
    return threadId ? this.jobsByThread.get(threadId) : undefined;
  }

  private removeMappings(job: JobRecord): void {
    if (job.threadId) this.jobsByThread.delete(job.threadId);
    if (job.turnId) this.jobsByTurn.delete(job.turnId);
    this.diagnosticSignaturesByJob.delete(job.id);
  }
}

function approvalKind(method: string): ApprovalKind | undefined {
  if (method === "item/commandExecution/requestApproval") return "command";
  if (method === "item/fileChange/requestApproval") return "file_change";
  if (method.includes("permissions") || method.includes("Permissions")) return "permissions";
  if (method.includes("userInput") || method.includes("UserInput")) return "user_input";
  if (method.includes("elicitation") || method.includes("Elicitation")) return "elicitation";
  return undefined;
}

function safeDeclineResponse(method: string): Record<string, unknown> {
  if (method.includes("userInput")) return { answers: {} };
  if (method.includes("permissions") || method.includes("Permissions")) {
    return { permissions: {}, scope: "turn", strictAutoReview: true };
  }
  if (method.includes("elicitation") || method.includes("Elicitation")) {
    return { action: "decline", content: null, _meta: null };
  }
  return { decision: "decline" };
}

function summarizeApproval(kind: ApprovalKind, params: Record<string, unknown>): Record<string, unknown> {
  const allowed =
    kind === "command"
      ? ["command", "cwd", "reason", "risk", "parsedCommand", "itemId", "turnId", "threadId"]
      : ["changes", "reason", "grantRoot", "itemId", "turnId", "threadId"];
  const summary: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in params) summary[key] = params[key];
  }
  return sanitizeForStorage(summary) as Record<string, unknown>;
}

function summarizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const key of ["message", "code", "willRetry", "turnId", "threadId"]) {
    if (key in params) summary[key] = params[key];
  }
  return sanitizeForStorage(summary) as Record<string, unknown>;
}

function itemSummary(item: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const key of ["id", "type", "status", "command", "cwd", "exitCode", "filePath", "changes", "server", "tool", "durationMs"]) {
    if (key in item) summary[key] = item[key];
  }
  return sanitizeForStorage(summary) as Record<string, unknown>;
}

function shouldPersistItemEvent(item: Record<string, unknown>, phase: "started" | "completed"): boolean {
  const type = stringValue(item.type);
  if (!type || type === "reasoning" || type === "userMessage") {
    return false;
  }
  if (type === "agentMessage") {
    return phase === "completed";
  }
  return true;
}

function itemMessage(item: Record<string, unknown>, phase: string): string {
  const type = stringValue(item.type) ?? "work item";
  if (type === "agentMessage") return `Codex response ${phase}.`;
  if (type === "commandExecution") return `Command execution ${phase}.`;
  if (type === "fileChange") return `File change ${phase}.`;
  return `${type} ${phase}.`;
}

function errorDiagnostic(line: string): { signature: string; data: Record<string, unknown> } | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isObject(parsed)) {
      const level = stringValue(parsed.level)?.toLowerCase();
      if (level !== "error" && level !== "fatal") {
        return undefined;
      }
      const fields = isObject(parsed.fields) ? parsed.fields : {};
      const text = redactDiagnostic(stringValue(fields.message) ?? trimmed);
      const target = stringValue(parsed.target);
      const data = sanitizeForStorage({ level, text, ...(target ? { target } : {}) }) as Record<string, unknown>;
      return { signature: JSON.stringify(data), data };
    }
  } catch {
    // Plain stderr is handled below.
  }
  if (!/\b(error|fatal|panic|failed)\b/i.test(trimmed)) {
    return undefined;
  }
  const data = { level: "error", text: redactDiagnostic(trimmed) };
  return { signature: JSON.stringify(data), data };
}

function completionStatus(params: Record<string, unknown>): JobResult["status"] {
  const raw = stringValue(params.status) ?? (isObject(params.turn) ? stringValue(params.turn.status) : undefined);
  if (raw === "cancelled" || raw === "canceled") return "cancelled";
  if (raw === "interrupted") return "interrupted";
  if (raw === "failed" || raw === "error") return "failed";
  return "completed";
}

function completionMessage(params: Record<string, unknown>, status: JobResult["status"]): string {
  const direct = stringValue(params.message);
  if (direct) return direct.slice(0, 2_000);
  if (status === "completed") return "Codex turn completed.";
  if (status === "cancelled") return "Codex turn was cancelled.";
  if (status === "interrupted") return "Codex turn was interrupted.";
  return "Codex turn failed.";
}

function resultFor(job: JobRecord, status: JobResult["status"], message: string, output?: string): JobResult {
  return {
    status,
    message: message.slice(0, 4_000),
    output,
    completedAt: new Date().toISOString(),
    threadId: job.threadId,
    turnId: job.turnId,
  };
}

function finalAgentOutput(params: Record<string, unknown>): string | undefined {
  if (!isObject(params.turn) || !Array.isArray(params.turn.items)) return undefined;
  for (let index = params.turn.items.length - 1; index >= 0; index -= 1) {
    const item = params.turn.items[index];
    if (isObject(item) && stringValue(item.type) === "agentMessage") {
      const text = stringValue(item.text);
      if (text) return boundedOutput(text);
    }
  }
  return undefined;
}

function boundedOutput(value: string): string {
  const redacted = redactString(value);
  return redacted.length > 100_000 ? `${redacted.slice(0, 100_000)}\n[output truncated]` : redacted;
}

function boundedMetadata(value: string, maxChars: number): string {
  return redactString(value.replaceAll("\0", "")).slice(0, maxChars);
}

function firstLine(value: string): string | undefined {
  return value.split(/\r?\n/).find((line) => line.trim())?.trim();
}

function timestampValue(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value * 1_000);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return new Date(0).toISOString();
}

function unixSeconds(value: string): number {
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? Math.max(0, Math.floor(millis / 1_000)) : 0;
}

function localThreadStatus(value: unknown): string {
  if (isObject(value)) return stringValue(value.type) ?? "unknown";
  return stringValue(value) ?? "unknown";
}

function comparablePath(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isSafeDiscoveredProjectPath(candidate: string, config: BridgeConfig): boolean {
  if (!isAbsolute(candidate)) return false;
  const normalized = comparablePath(candidate);
  if (normalized === comparablePath(parse(candidate).root)) return false;

  const userHome = homedir();
  if (normalized === comparablePath(userHome)) return false;
  const deniedRoots = [
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.ProgramData,
    process.env.APPDATA,
    process.env.LOCALAPPDATA,
    config.dataDir,
    config.stagingDir,
    config.jobsDir,
    config.handoffDir,
    join(config.projectRoot, ".local"),
    join(userHome, ".codex"),
    join(userHome, ".ssh"),
    join(userHome, ".aws"),
    join(userHome, ".azure"),
    join(userHome, "Downloads"),
  ].filter((value): value is string => Boolean(value));
  if (deniedRoots.some((denied) => isSameOrDescendant(normalized, comparablePath(denied)))) return false;

  const segments = normalized.split(/[\\/]+/).filter(Boolean);
  return !segments.some((segment) => [
    ".git",
    ".codex",
    ".ssh",
    ".aws",
    ".azure",
    "appdata",
    "node_modules",
    ".venv",
    "venv",
  ].includes(segment));
}

function isSameOrDescendant(candidate: string, parent: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

function nestedId(value: Record<string, unknown>, key: string): string | undefined {
  const nested = value[key];
  return isObject(nested) ? stringValue(nested.id) : undefined;
}

function requireJob(store: JobStore, jobId: string): JobRecord {
  const job = store.get(jobId);
  if (!job) throw new Error(`Unknown job id '${jobId}'.`);
  return job;
}

function isTerminal(status: JobRecord["status"]): boolean {
  return ["completed", "failed", "interrupted", "cancelled"].includes(status);
}

function normalizeIdempotencyKey(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(normalized)) {
    throw new Error("idempotencyKey must be 8-128 URL-safe characters.");
  }
  return normalized;
}

function redactDiagnostic(line: string): string {
  return line
    .replace(/(bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:token|key|secret)=)[^&\s]+/gi, "$1[REDACTED]")
    .slice(0, 2_000);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function isReasoningEffort(value: string | undefined): value is "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" {
  return value !== undefined && ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
