import { createHash, randomUUID } from "node:crypto";
import { DirectOperationError } from "./direct-operation-error.js";
import { ControlPlaneReader } from "./control-plane.js";
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
import { CONVERSATION_DELIVERY, isCoalescibleConversationNotification } from "./conversation-delivery.js";
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
  source?: "app" | "model_direct";
  preview: WorkPackagePreview;
  previewDigest: string;
  idempotencyKey: string;
}

export interface ConversationSendInput extends AppendUserMessageInput {
  jobId: string;
  inputBundleIds?: string[];
}

export type DirectConversationSendInput = Omit<ConversationSendInput, "approvalReviewer"> & {
  approvalReviewer?: ConversationSendInput["approvalReviewer"];
};

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
  private readonly backgroundTasks = new Set<Promise<void>>();
  private backgroundFailure?: unknown;
  private readonly jobsByThread = new Map<string, string>();
  private readonly jobsByTurn = new Map<string, string>();
  private readonly liveApprovals = new Map<string, LiveApproval>();
  private readonly finalOutputByJob = new Map<string, string>();
  private readonly diagnosticSignaturesByJob = new Map<string, Set<string>>();
  private readonly jobLocks = new Map<string, Promise<void>>();
  private readonly historyReader: ThreadHistoryReader;
  private readonly controlPlane: ControlPlaneReader;
  private readonly threadSyncStates = new Map<string, {
    fingerprint: string;
    lastFullReadAt: number;
    historyMode: "legacy" | "paginated";
  }>();
  private readonly hydrationRetryAfter = new Map<string, number>();
  private readonly discoveredProjects = new Map<string, BridgeProject>();
  private readonly notificationEpochs = new Map<string, number>();
  private readonly lastNotificationAt = new Map<string, number>();
  private readonly activeRecoveries = new Map<string, Promise<boolean>>();
  private readonly activeRecoveryAfter = new Map<string, number>();
  private readonly recoveryDiagnostics = new Map<string, { lastAttemptAt: string; outcome: string }>();
  private unmatchedNotificationCount = 0;
  private modelCache?: { expiresAt: number; models: CodexModelOption[] };

  constructor(
    private readonly config: BridgeConfig,
    private readonly store: JobStore,
    private readonly textBundles: TextBundleStore,
    private readonly appServer: AppServerTransport,
  ) {
    this.historyReader = new ThreadHistoryReader(appServer);
    this.controlPlane = new ControlPlaneReader(appServer);
    this.appServer.on("notification", (message) => this.trackBackground(this.handleNotification(message)));
    this.appServer.on("serverRequest", (message) => this.trackBackground(this.handleServerRequest(message)));
    this.appServer.on("stderr", (line) => this.trackBackground(this.handleStderr(line)));
    this.appServer.on("exit", (error) => this.trackBackground(this.handleExit(error)));
  }

  get status(): AppServerTransport["status"] {
    return this.backgroundFailure ? "unavailable" : this.appServer.status;
  }

  async close(): Promise<void> {
    while (this.backgroundTasks.size) await Promise.allSettled([...this.backgroundTasks]);
    await this.appServer.close();
    while (this.backgroundTasks.size) await Promise.allSettled([...this.backgroundTasks]);
    await this.store.flushConversations();
    if (this.backgroundFailure) throw this.backgroundFailure;
  }

  private trackBackground(task: Promise<void>): void {
    this.backgroundTasks.add(task);
    void task.then(() => this.backgroundTasks.delete(task), (error) => {
      this.backgroundTasks.delete(task);
      this.backgroundFailure ??= error;
    });
  }

  async hydrateConversation(jobId: string, force = false): Promise<boolean> {
    const selected = requireJob(this.store, jobId);
    if (selected.threadId && this.jobsByThread.get(selected.threadId) === jobId && !isTerminal(selected.status)) {
      return this.recoverActiveConversation(jobId, force);
    }
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

  /** Native reads never hold the notification lock across App Server IO. */
  async recoverActiveConversation(jobId: string, requested = true): Promise<boolean> {
    const existing = this.activeRecoveries.get(jobId);
    if (existing) return existing;
    const job = requireJob(this.store, jobId);
    if (!job.threadId || !job.turnId || isTerminal(job.status)) return false;
    const now = Date.now();
    if ((this.activeRecoveryAfter.get(jobId) ?? 0) > now) return false;
    if (!requested && now - (this.lastNotificationAt.get(jobId) ?? Date.parse(job.updatedAt)) < CONVERSATION_DELIVERY.activeQuietMs) return false;
    this.activeRecoveryAfter.set(jobId, now + CONVERSATION_DELIVERY.nativeRetryMs);
    this.recoveryDiagnostics.set(jobId, { lastAttemptAt: new Date(now).toISOString(), outcome: "reading" });
    const recovery = this.readActiveConversation(jobId, job.threadId, job.turnId);
    this.activeRecoveries.set(jobId, recovery);
    try {
      const applied = await recovery;
      this.recoveryDiagnostics.set(jobId, { lastAttemptAt: new Date(now).toISOString(), outcome: applied ? "applied" : "deferred" });
      return applied;
    }
    catch (error) {
      this.recoveryDiagnostics.set(jobId, { lastAttemptAt: new Date(now).toISOString(), outcome: "persistence_failed" });
      throw error;
    }
    finally { this.activeRecoveries.delete(jobId); }
  }

  conversationRecoveryDiagnostics(jobId: string) {
    return { ...this.recoveryDiagnostics.get(jobId), unmatchedNotificationCount: this.unmatchedNotificationCount };
  }

  private async readActiveConversation(jobId: string, threadId: string, turnId: string): Promise<boolean> {
    const baseline = await this.withJobLock(jobId, async () => {
      await this.store.flushConversation(jobId);
      return { epoch: this.notificationEpochs.get(jobId) ?? 0, revision: this.store.conversationRevision(jobId) };
    });
    const checkedAt = new Date().toISOString();
    let history;
    try {
      history = await this.historyReader.read(threadId);
    } catch {
      await this.store.appendEvent(jobId, "conversation.recovery.deferred", "Native conversation recovery is temporarily unavailable; the committed projection was preserved.")
        .catch(() => undefined);
      return false;
    }
    return this.withJobLock(jobId, async () => {
      const job = requireJob(this.store, jobId);
      if (job.threadId !== threadId || job.turnId !== turnId || isTerminal(job.status)
        || (this.notificationEpochs.get(jobId) ?? 0) !== baseline.epoch
        || this.store.conversationRevision(jobId) !== baseline.revision) return false;
      const thread = history.response.thread as Record<string, unknown> | undefined;
      const turns = Array.isArray(thread?.turns) ? thread.turns : [];
      // An active read may be valid but not yet contain the current turn. Never erase it.
      const activeTurn = turns.find((turn) => isObject(turn) && turn.id === turnId);
      if (thread?.id !== threadId || !isObject(activeTurn)) return false;
      const projection = await this.store.hydrateConversation(jobId, history.response, checkedAt, {
        historyMode: history.metadata.historyMode, synchronized: true, sourceAvailability: "available",
        lastMetadataCheckedAt: checkedAt, lastHydratedAt: checkedAt, sourceFingerprint: history.sourceFingerprint,
      });
      await this.store.appendEvent(jobId, "conversation.recovery.completed", "Active conversation synchronized from native history.", {
        previousRevision: baseline.revision, revision: this.store.conversationRevision(jobId),
      });
      if (["completed", "failed", "interrupted"].includes(String(activeTurn.status))) {
        const output = projection.turns.find((turn) => turn.turnId === turnId)?.items.filter((item) => item.type === "agentMessage").at(-1)?.text;
        await this.store.complete(jobId, resultFor(job, completionStatus({ turn: activeTurn }), "Recovered the completed native turn without retrying it.", output));
        this.removeMappings(job);
        this.finalOutputByJob.delete(jobId);
      }
      return true;
    });
  }

  async listModels(force = false): Promise<CodexModelOption[]> {
    if (!force && this.modelCache && this.modelCache.expiresAt > Date.now()) {
      return structuredClone(this.modelCache.models);
    }
    const data: unknown[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = await this.appServer.request<Record<string, unknown>>("model/list", {
        limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(response.data)) throw new DirectOperationError("MODEL_LIST_INVALID_RESPONSE");
      if (response.nextCursor != null && typeof response.nextCursor !== "string") throw new DirectOperationError("MODEL_LIST_INVALID_RESPONSE");
      data.push(...response.data);
      cursor = stringValue(response.nextCursor);
      if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new DirectOperationError("MODEL_LIST_INCOMPLETE");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const models = data
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

  async modelListDiagnostics(force = false) {
    const cacheHit = !force && Boolean(this.modelCache && this.modelCache.expiresAt > Date.now());
    const models = await this.listModels(force);
    return { models, cacheHit, fetchedAt: new Date(this.modelCache!.expiresAt - 5 * 60_000).toISOString(), appServerIdentity: { transport: "controller-owned-stdio", status: this.appServer.status, bridgeBuildId: this.config.buildId } };
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
    if (input.source === "model_direct") {
      this.requireDirectProject(input.preview.workPackage.projectId);
      if (input.preview.workPackage.dataClassification === "company_approved") throw new DirectOperationError("DIRECT_COMPANY_AUTHORIZATION_REQUIRES_APP");
    }
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
      dispatchSource: input.source,
      project,
      workPackage: input.preview.workPackage,
      previewDigest: input.previewDigest,
      idempotencyKey: input.source === "model_direct" ? `direct:${createHash("sha256").update(normalizeIdempotencyKey(input.idempotencyKey)).digest("hex")}` : normalizeIdempotencyKey(input.idempotencyKey),
      inputArtifacts,
    });
    if (created.created) {
      this.trackBackground(this.execute(created.record.id));
    }
    return created;
  }

  async sendMessage(input: ConversationSendInput): Promise<ConversationSendResult> {
    return this.withJobLock(input.jobId, () => this.sendMessageLocked(input));
  }

  private async sendMessageLocked(input: ConversationSendInput, source: "app" | "model_direct" = "app"): Promise<ConversationSendResult> {
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
          source,
          characterCount: input.content.length,
        });
        return { record, accepted: true, delivery: "steer" };
      }
      if (!job.threadId) {
        throw new Error("This legacy conversation has no Codex thread id and cannot be resumed.");
      }
      const prepared = await this.store.prepareTurn(job.id, input);
      await this.store.appendEvent(job.id, "operator.message", "Conversation message accepted.", { source });
      this.trackBackground(this.resumeAndExecute(prepared.id, resolvedInput));
      return { record: prepared, accepted: true, delivery: "turn" };
  }

  requireDirectProject(projectId: string): BridgeProject {
    const project = this.config.projects.get(projectId);
    if (!project) throw new DirectOperationError("DIRECT_PROJECT_NOT_ALLOWLISTED");
    return structuredClone(project);
  }

  usageStatus() { return this.controlPlane.usage(); }

  async runtimeStatus(projectId: string) {
    const project = this.requireDirectProject(projectId);
    return { projectId, controller: this.status, ...await this.controlPlane.runtime(project.path) };
  }

  async inventory(projectId: string, kind: "all" | "skills" | "hooks" | "mcp" = "all") {
    const project = this.requireDirectProject(projectId);
    return { projectId, ...await this.controlPlane.inventory(project.path, kind) };
  }

  async directThreadAction(kind: "compact" | "review" | "fork", input: {
    jobId: string; requestId: string; expectedThreadId: string; expectedTurnId: string;
  }) {
    return this.withJobLock(input.jobId, async () => {
      const job = requireJob(this.store, input.jobId);
      await this.assertDirectJob(job, false);
      if (job.threadId !== input.expectedThreadId) throw new DirectOperationError("DIRECT_THREAD_CHANGED");
      // 0.154.0 allocates the fork id remotely without a replay key. A lost response or crash
      // cannot be reconciled atomically with JobStore/UnifiedConversationRegistry ownership.
      if (kind === "fork") throw new DirectOperationError("DIRECT_FORK_OWNERSHIP_UNSUPPORTED",
        "Fork is blocked: protocol 0.154.0 cannot guarantee recoverable Bridge ownership after a lost response.");
      return this.runDirectRequest(job, `${kind}:${normalizeIdempotencyKey(input.requestId)}`, {
        expectedThreadId: input.expectedThreadId, expectedTurnId: input.expectedTurnId,
      }, async () => {
        if (job.turnId !== input.expectedTurnId) throw new DirectOperationError("DIRECT_TURN_CHANGED");
        if (!isTerminal(job.status) || job.approvals.some((approval) => approval.state === "pending")) throw new DirectOperationError("DIRECT_THREAD_BUSY");
        const projectPath = await realpath(job.project.path);
        if (comparablePath(projectPath) !== comparablePath(job.project.path)) throw new DirectOperationError("DIRECT_PROJECT_CHANGED");
        const metadata = await this.historyReader.readMetadata(input.expectedThreadId);
        if (typeof metadata.rawThread.cwd !== "string" || comparablePath(await realpath(metadata.rawThread.cwd)) !== comparablePath(projectPath)) {
          throw new DirectOperationError("DIRECT_THREAD_PROJECT_MISMATCH");
        }
        const nativeStatus = isObject(metadata.rawThread.status) ? metadata.rawThread.status.type : metadata.rawThread.status;
        if (nativeStatus !== "idle" && nativeStatus !== "notLoaded") throw new DirectOperationError("DIRECT_THREAD_BUSY");
        const executionMode = kind === "review" ? "plan" : job.currentExecutionMode ?? job.workPackage.executionMode;
        const approvalReviewer = job.currentApprovalReviewer ?? job.workPackage.approvalReviewer ?? "user";
        const permissions = await this.selectPermissionProfile(job, executionMode);
        const resumed = await this.appServer.request("thread/resume", {
          threadId: input.expectedThreadId, cwd: projectPath, runtimeWorkspaceRoots: [projectPath],
          approvalPolicy: "on-request", approvalsReviewer: approvalReviewer, permissions, excludeTurns: true,
        });
        if (nestedId(resumed, "thread") !== input.expectedThreadId) throw new DirectOperationError("DIRECT_THREAD_CHANGED");
        await this.store.prepareTurn(job.id, {
          executionMode, approvalReviewer, dataClassification: job.currentDataClassification ?? job.workPackage.dataClassification,
          model: job.model, effort: job.effort, controlAction: { kind, priorTurnId: input.expectedTurnId },
        });
        this.jobsByThread.set(input.expectedThreadId, job.id);
        this.threadSyncStates.delete(input.expectedThreadId);
        this.finalOutputByJob.delete(job.id);
        // A timeout leaves the preparing job + durable unknown receipt in place. Notifications
        // can still settle it; no second action or automatic retry can run over uncertain work.
        if (kind === "compact") {
          await this.appServer.request("thread/compact/start", { threadId: input.expectedThreadId });
        } else {
          const response = await this.appServer.request("review/start", {
            threadId: input.expectedThreadId, target: { type: "uncommittedChanges" }, delivery: "inline",
          });
          const turnId = nestedId(response, "turn");
          if (response.reviewThreadId !== input.expectedThreadId || !turnId || turnId === input.expectedTurnId) throw new DirectOperationError("DIRECT_REVIEW_IDENTITY_MISMATCH");
          this.jobsByTurn.set(turnId, job.id);
          await this.store.setTurn(job.id, turnId);
          await this.store.applyConversationNotification(job.id, { method: "turn/started", params: { threadId: input.expectedThreadId, turn: response.turn } });
        }
        await this.store.appendEvent(job.id, `codex.${kind}.accepted`, `Codex ${kind} accepted; completion is reported separately.`, { threadId: input.expectedThreadId });
      }).catch((error) => {
        if (error instanceof DirectOperationError) throw error;
        throw new DirectOperationError("DIRECT_ACTION_UNAVAILABLE", "Action delivery could not be confirmed. Inspect the job; do not retry with a new request id.");
      });
    });
  }

  async directMessage(input: DirectConversationSendInput, expectedTurnId?: string, steerOnly = false) {
    return this.withJobLock(input.jobId, async () => {
      const job = requireJob(this.store, input.jobId);
      await this.assertDirectJob(job, false);
      if (input.dataClassification === "company_approved") throw new DirectOperationError("DIRECT_COMPANY_AUTHORIZATION_REQUIRES_APP");
      const key = `${steerOnly ? "steer" : "send"}:${normalizeIdempotencyKey(input.clientMessageId)}`;
      return this.runDirectRequest(job, key, { ...input, expectedTurnId }, async () => {
        if (expectedTurnId && (!["running", "awaiting_approval"].includes(job.status) || job.turnId !== expectedTurnId)) throw new DirectOperationError("DIRECT_TURN_CHANGED");
        if (steerOnly && !["running", "awaiting_approval"].includes(job.status)) throw new DirectOperationError("DIRECT_TURN_NOT_ACTIVE");
        if ((steerOnly || ["running", "awaiting_approval"].includes(job.status)) && (!expectedTurnId || job.turnId !== expectedTurnId)) throw new DirectOperationError("DIRECT_TURN_CHANGED");
        await this.sendMessageLocked({
          ...input,
          approvalReviewer: input.approvalReviewer ?? job.currentApprovalReviewer ?? job.workPackage.approvalReviewer ?? "user",
          model: input.model ?? job.model ?? job.workPackage.model,
          effort: input.effort ?? job.effort ?? job.workPackage.effort,
        }, "model_direct");
      }, input.approvalReviewer === undefined ? { ...input, approvalReviewer: "user", expectedTurnId } : undefined);
    });
  }

  async directCancel(jobId: string, requestId: string, expectedTurnId: string) {
    return this.withJobLock(jobId, async () => {
      const job = requireJob(this.store, jobId);
      await this.assertDirectJob(job, true);
      return this.runDirectRequest(job, `cancel:${normalizeIdempotencyKey(requestId)}`, { expectedTurnId }, async () => {
        if (job.turnId !== expectedTurnId) throw new DirectOperationError("DIRECT_TURN_CHANGED");
        await this.cancelLocked(jobId);
      });
    });
  }

  private async assertDirectJob(job: JobRecord, stopOnly: boolean): Promise<void> {
    const project = this.requireDirectProject(job.project.id);
    if (comparablePath(project.path) !== comparablePath(job.project.path)) throw new DirectOperationError("DIRECT_PROJECT_CHANGED");
    if (stopOnly) return;
    if (job.idempotencyKey.startsWith("local-thread:")) throw new DirectOperationError("DIRECT_HISTORY_CLASSIFICATION_UNKNOWN");
    if (await this.store.hasCompanyHistory(job.id)) throw new DirectOperationError("DIRECT_COMPANY_AUTHORIZATION_REQUIRES_APP");
  }

  private async runDirectRequest(job: JobRecord, key: string, payload: unknown, operation: () => Promise<void>, legacyPayload?: unknown) {
    const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const prior = job.directRequests?.[key];
    if (prior) {
      // Before reviewer selection was exposed, the MCP adapter injected user into every message.
      // Match that old receipt only for a retry with an omitted reviewer; never redeliver it.
      const legacyMatch = prior.inputVersion === undefined && legacyPayload !== undefined &&
        prior.digest === createHash("sha256").update(JSON.stringify(legacyPayload)).digest("hex");
      if (prior.digest !== digest && !legacyMatch) throw new DirectOperationError("DIRECT_REQUEST_CONFLICT");
      return { jobId: job.id, accepted: false, delivery: prior.state === "completed" ? "duplicate" : "unknown" };
    }
    if (Object.keys(job.directRequests ?? {}).length >= 10_000) throw new DirectOperationError("DIRECT_REQUEST_LIMIT");
    await this.store.recordDirectRequest(job.id, key, digest, "pending", 2);
    try {
      await operation();
      await this.store.recordDirectRequest(job.id, key, digest, "completed", 2);
      return { jobId: job.id, accepted: true, delivery: "accepted" };
    } catch (error) {
      await this.store.recordDirectRequest(job.id, key, digest, "unknown", 2);
      throw error;
    }
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
    this.notificationEpochs.set(jobId, (this.notificationEpochs.get(jobId) ?? 0) + 1);
    return this.withJobLock(jobId, async () => {
      await this.store.appendEvent(jobId, "operator.cancel", "Cancellation requested.", { source: "app" });
      return this.cancelLocked(jobId);
    });
  }

  private async cancelLocked(jobId: string): Promise<JobRecord> {
    const job = requireJob(this.store, jobId);
    if (isTerminal(job.status)) {
      return job;
    }
    if (job.threadId && job.turnId && this.appServer.status === "ready") {
      // App Server is shared across jobs. Cancellation must target the exact turn and must never
      // close or kill the component-owned App Server process.
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
    return this.withJobLock(jobId, () => this.steerLocked(jobId, message));
  }

  private async steerLocked(jobId: string, message: string): Promise<JobRecord> {
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
      source: "app",
      characterCount: text.length,
    });
  }

  async decideApproval(
    jobId: string,
    approvalId: string,
    decision: "accept" | "decline" | "cancel",
  ): Promise<JobRecord> {
    this.notificationEpochs.set(jobId, (this.notificationEpochs.get(jobId) ?? 0) + 1);
    return this.withJobLock(jobId, () => this.decideApprovalLocked(jobId, approvalId, decision));
  }

  private async decideApprovalLocked(
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

  async validateModelSelection(model?: string, effort?: string): Promise<void> {
    if (!model && !effort) {
      return;
    }
    const models = await this.listModels();
    const selected = model
      ? models.find((candidate) => candidate.id === model)
      : models.find((candidate) => candidate.isDefault) ?? models[0];
    if (!selected) {
      if (model === "gpt-6-astra") throw new DirectOperationError("GPT6_MODEL_NOT_EXPOSED_BY_APP_SERVER");
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
    const telemetry = message.method === "thread/tokenUsage/updated" || message.method === "model/rerouted";
    const jobId = this.findJobId(params) ?? (telemetry && typeof params.threadId === "string" ? this.store.findByThreadId(params.threadId)?.id : undefined);
    if (!jobId) {
      if (/^(item|turn)\//.test(message.method)) this.unmatchedNotificationCount += 1;
      return;
    }
    // Count at ingress, before locks: a queued delta invalidates an in-flight native read too.
    this.notificationEpochs.set(jobId, (this.notificationEpochs.get(jobId) ?? 0) + 1);
    this.lastNotificationAt.set(jobId, Date.now());
    await this.withJobLock(jobId, async () => {
      const job = this.store.get(jobId);
      if (!job) return;
      const eventThreadId = stringValue(params.threadId) ?? nestedId(params, "thread");
      const eventTurnId = stringValue(params.turnId) ?? nestedId(params, "turn");
      if (eventThreadId && eventThreadId !== job.threadId) return;
      if (telemetry) {
        if (eventThreadId !== job.threadId || !eventTurnId || eventTurnId !== job.turnId) return;
        await this.store.applyConversationNotification(jobId, message.method === "model/rerouted"
          ? { ...message, params: { ...params, requestedModel: job.model ?? job.workPackage.model ?? null } } : message);
        return;
      }
      if (isTerminal(job.status)) return;
      if (job.controlAction) {
        if (eventTurnId === job.controlAction.priorTurnId) return;
        if (!job.turnId && message.method === "turn/started" && eventTurnId) {
          this.jobsByTurn.set(eventTurnId, jobId);
          await this.store.setTurn(jobId, eventTurnId);
        } else if (eventTurnId && eventTurnId !== job.turnId) return;
      }
      try {
        await this.store.applyConversationNotification(jobId, message, new Date().toISOString(), true);
        if (isCoalescibleConversationNotification(message.method)) return;
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

    this.notificationEpochs.set(jobId, (this.notificationEpochs.get(jobId) ?? 0) + 1);
    await this.withJobLock(jobId, async () => {
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
        await this.store.flushConversation(jobId);
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
    });
  }

  private async handleStderr(line: string): Promise<void> {
    const activeJobs = new Set(this.jobsByTurn.values());
    if (activeJobs.size !== 1) {
      // App Server stderr has no thread identity. With concurrent turns, assigning it to the most
      // recently inserted job would make shared process diagnostics look like per-thread truth.
      return;
    }
    const active = activeJobs.values().next().value!;
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
    join(config.projectRoot, ".secrets"),
    join(config.projectRoot, ".tunnel-client"),
    join(config.projectRoot, "..", "project_reading", ".secrets"),
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
