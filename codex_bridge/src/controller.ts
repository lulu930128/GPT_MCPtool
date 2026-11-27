import { createHash, randomUUID } from "node:crypto";
import { prepareResumedThread } from "./resume-thread.js";
import { DirectOperationError } from "./direct-operation-error.js";
import { ControlPlaneReader, nativeSourceKinds, type ThreadPageKind } from "./control-plane.js";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, normalize, parse, relative } from "node:path";
import type { BridgeConfig } from "./config.js";
import { NativeDeliveryUnknown } from "./app-server-client.js";
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
import { digestWorkPackage, normalizeTurnSpeed, recordModelSelection, type WorkPackagePreview } from "./work-package.js";

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
  delivery: "steer" | "turn" | "duplicate" | "unknown" | "failed";
}

type ResolvedConversationSendInput = Omit<ConversationSendInput, "inputArtifacts"> & {
  inputArtifacts: MaterializedTextArtifact[];
};

interface LiveApproval {
  jobId: string;
  requestId: string | number;
  questions?: NativeChoiceQuestion[];
}

export class CodexBridgeController {
  private readonly backgroundTasks = new Set<Promise<void>>();
  private reconciliationTimer?: NodeJS.Timeout;
  private readonly backgroundFailures = new Map<string, string>();
  private readonly releaseCandidates = new Map<string,string>();
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
  private readonly verifiedHeads = new Map<string, {turnId:string; fingerprint:string; revision:number}>();
  private readonly activeRecoveries = new Map<string, Promise<boolean>>();
  private readonly activeRecoveryAfter = new Map<string, number>();
  private readonly recoveryDiagnostics = new Map<string, { lastAttemptAt: string; outcome: string }>();
  private readonly notificationBatches = new Map<string, Array<() => Promise<void>>>();
  private waitingBytes = 0;
  private controlLocks = 0;
  private updatePressure() {
    this.appServer.setNotificationBacklog?.(this.controlLocks ? 0 : this.waitingBytes);
  }
  private readonly waiting = new Set<{at:number; bytes:number}>();
  pipelineWorkload() {
    const oldest = this.waiting.values().next().value;
    return {background:this.backgroundTasks.size, lockQueues:this.jobLocks.size, waiting:this.waiting.size,
      estimatedQueuedTextBytes:this.waitingBytes, oldestWaitMs:oldest ? performance.now()-oldest.at : 0, recoveries:this.activeRecoveries.size,
      unmatched:this.unmatchedNotificationCount, mappedTurns:this.jobsByTurn.size, mappedThreads:this.jobsByThread.size};
  }
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
    this.appServer.on("notification", (message) => { const task = this.handleNotification(message); if (task) this.trackBackground(task, this.findJobId(message.params ?? {})); });
    this.appServer.on("serverRequest", (message) => this.trackBackground(this.handleServerRequest(message)));
    this.appServer.on("stderr", (line) => this.trackBackground(this.handleStderr(line)));
    this.appServer.on("exit", (error) => this.trackBackground(this.handleExit(error)));
  }

  get status(): AppServerTransport["status"] {
    return this.appServer.status;
  }

  get maintenancePending() {
    return this.store.pendingManifestRepairs + this.backgroundTasks.size + this.activeRecoveries.size + this.jobLocks.size + this.liveApprovals.size;
  }

  startReconciliation() {
    if (this.reconciliationTimer) return;
    this.reconciliationTimer = setInterval(() => {
      for (const [jobId,threadId] of this.releaseCandidates) {
        this.releaseCandidates.delete(jobId);
        this.trackBackground(this.releaseIdleSubscription(jobId,threadId),jobId);
      }
      if (this.store.pendingManifestRepairs) this.trackBackground(this.store.reconcileManifestWrites());
      for (const id of new Set([...this.jobsByThread.values(), ...this.store.reconciliationJobs])) {
        try { this.schedulePollRecovery(id); }
        catch (error) { this.store.diagnostics?.observe("reconcile","job_unavailable",{jobId:id},true,error); }
      }
    }, CONVERSATION_DELIVERY.nativeRetryMs);
    this.reconciliationTimer.unref();
  }

  async close(): Promise<void> {
    clearInterval(this.reconciliationTimer);
    while (this.backgroundTasks.size) await Promise.allSettled([...this.backgroundTasks]);
    await this.appServer.close();
    while (this.backgroundTasks.size) await Promise.allSettled([...this.backgroundTasks]);
    await this.store.flushConversations();
    if (this.store.pendingManifestRepairs) throw new Error("MANIFEST_EVENT_RECONCILIATION_REQUIRED");
  }

  private trackBackground(task: Promise<void>, jobId?: string): void {
    this.backgroundTasks.add(task);
    void task.then(() => this.backgroundTasks.delete(task), (error) => {
      this.backgroundTasks.delete(task);
      if (jobId) this.backgroundFailures.set(jobId, "background_failed");
      this.store.diagnostics?.observe("reconcile","background_failed",{jobId},true,error);
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

  schedulePollRecovery(jobId: string) {
    const job = this.store.get(jobId);
    if (!job?.threadId || this.activeRecoveries.has(jobId)) return;
    if (job.nativeRequest?.method === "turn/start") {
      // Recovery is read-only. Native history must identify exactly one matching client input.
      if ((this.activeRecoveryAfter.get(jobId) ?? 0) > Date.now()) return;
      this.activeRecoveryAfter.set(jobId, Date.now() + CONVERSATION_DELIVERY.nativeRetryMs);
      const recovery = this.reconcileRequestedTurn(job, job.threadId, job.nativeRequest.clientMessageId);
      this.activeRecoveries.set(jobId, recovery);
      this.trackBackground(recovery.then(() => undefined).finally(() => this.activeRecoveries.delete(jobId)), jobId);
      return;
    }
    if (!job.turnId) return;
    if (this.jobsByThread.get(job.threadId) !== jobId && job.restartInterruptedTurnId !== job.turnId) return;
    this.trackBackground(this.recoverActiveConversation(jobId, false).then(() => undefined), jobId);
  }

  private async reconcileRequestedTurn(before: JobRecord, threadId: string, clientMessageId: string) {
    const {response} = await this.historyReader.read(threadId);
    const thread = response.thread;
    if (!isObject(thread) || thread.id !== threadId || !Array.isArray(thread.turns)) return false;
    const matches = thread.turns.filter(turn => isObject(turn) && Array.isArray(turn.items)
      && turn.items.some((item: unknown) => isObject(item) && item.type === "userMessage" && item.clientId === clientMessageId));
    const id = matches.length === 1 && stringValue(matches[0].id);
    if (!id) return false;
    return this.withJobLock(before.id, async () => {
      const current = requireJob(this.store,before.id);
      if (current.threadId !== threadId || current.nativeRequest?.clientMessageId !== clientMessageId || current.turnId) return false;
      const detached = this.jobsByThread.get(threadId) !== current.id;
      await this.store.setTurn(current.id, id, detached);
      if (!detached) this.jobsByTurn.set(id,current.id);
      this.activeRecoveryAfter.delete(current.id);
      return true;
    });
  }

  /** Native reads never hold the notification lock across App Server IO. */
  async recoverActiveConversation(jobId: string, requested = true): Promise<boolean> {
    const existing = this.activeRecoveries.get(jobId);
    if (existing) return existing;
    const job = requireJob(this.store, jobId);
    if (!job.threadId || !job.turnId || (isTerminal(job.status) && job.restartInterruptedTurnId !== job.turnId)) return false;
    const now = Date.now();
    if ((this.activeRecoveryAfter.get(jobId) ?? 0) > now) return false;
    if (!requested && now - (this.lastNotificationAt.get(jobId) ?? Date.parse(job.updatedAt)) < CONVERSATION_DELIVERY.activeQuietMs) return false;
    this.activeRecoveryAfter.set(jobId, now + CONVERSATION_DELIVERY.nativeRetryMs);
    this.recoveryDiagnostics.set(jobId, { lastAttemptAt: new Date(now).toISOString(), outcome: "reading" });
    const started = performance.now();
    const recovery = this.readActiveConversation(jobId, job.threadId, job.turnId, !requested);
    this.activeRecoveries.set(jobId, recovery);
    try {
      const applied = await recovery;
      this.recoveryDiagnostics.set(jobId, { lastAttemptAt: new Date(now).toISOString(), outcome: applied ? "applied" : "deferred" });
      this.store.diagnostics?.observe("native_read", applied ? "applied" : "deferred", {jobId, threadId:job.threadId, turnId:job.turnId, elapsedMs:performance.now()-started});
      if (applied) this.backgroundFailures.delete(jobId);
      return applied;
    }
    catch (error) {
      if (error instanceof Error && error.message === "NATIVE_HEAD_BEHIND_COMMIT") {
        this.recoveryDiagnostics.set(jobId,{lastAttemptAt:new Date(now).toISOString(),outcome:"native_behind"});
        this.store.diagnostics?.observe("reconcile","native_behind",{jobId,threadId:job.threadId,turnId:job.turnId});
        return false;
      }
      this.recoveryDiagnostics.set(jobId, { lastAttemptAt: new Date(now).toISOString(), outcome: "persistence_failed" });
      throw error;
    }
    finally { this.activeRecoveries.delete(jobId); }
  }

  conversationRecoveryDiagnostics(jobId: string) {
    return { backgroundFailure: this.backgroundFailures.get(jobId), ...this.recoveryDiagnostics.get(jobId), lastReceivedAt:this.lastNotificationAt.get(jobId),
      received:this.notificationEpochs.get(jobId) ?? 0, unmatchedNotificationCount: this.unmatchedNotificationCount };
  }

  private async readActiveConversation(jobId: string, threadId: string, turnId: string, recentOnly:boolean): Promise<boolean> {
    const baseline = await this.withJobLock(jobId, async () => {
      await this.store.flushConversation(jobId);
      return { epoch: this.notificationEpochs.get(jobId) ?? 0, revision: this.store.conversationRevision(jobId) };
    });
    const checkedAt = new Date().toISOString();
    let history, headOnly;
    try {
      const read = await this.historyReader.readForRecovery(threadId, turnId, recentOnly);
      history = read.snapshot;
      headOnly = read.headOnly;
    } catch {
      this.store.diagnostics?.observe("native_read", "failed", {jobId,threadId,turnId}, true);
      await this.store.appendEvent(jobId, "conversation.recovery.deferred", "Native conversation recovery is temporarily unavailable; the committed projection was preserved.")
        .catch(() => undefined);
      return false;
    }
    return this.withJobLock(jobId, async () => {
      const job = requireJob(this.store, jobId);
      if (job.threadId !== threadId || job.turnId !== turnId || (isTerminal(job.status) && job.restartInterruptedTurnId !== turnId)
        || (this.notificationEpochs.get(jobId) ?? 0) !== baseline.epoch
        || this.store.conversationRevision(jobId) !== baseline.revision) return false;
      const thread = history.response.thread as Record<string, unknown> | undefined;
      const turns = Array.isArray(thread?.turns) ? thread.turns : [];
      // An active read may be valid but not yet contain the current turn. Never erase it.
      const activeTurn = turns.find((turn) => isObject(turn) && turn.id === turnId);
      if (thread?.id !== threadId || !isObject(activeTurn)) {
        this.store.diagnostics?.observe("reconcile", "native_identity_unconfirmed", {jobId, threadId, turnId});
        return false;
      }
      const nativeTerminal = ["completed", "failed", "interrupted", "cancelled", "canceled"].includes(String(activeTurn.status));
      if (job.restartInterruptedTurnId === turnId && !nativeTerminal) {
        this.store.diagnostics?.observe("reconcile", "detached_native_nonterminal", {jobId, threadId, turnId});
        return false;
      }
      const previous = this.verifiedHeads.get(jobId);
      if (headOnly && !nativeTerminal && previous?.turnId === turnId && previous.revision === baseline.revision
        && previous.fingerprint === history.sourceFingerprint) return false;
      const freshness = { historyMode: history.metadata.historyMode, synchronized: !headOnly, sourceAvailability: "available" as const,
        lastMetadataCheckedAt: checkedAt, lastHydratedAt: checkedAt, sourceFingerprint: history.sourceFingerprint,
        ...(headOnly ? {scope:"current_turn" as const} : {}) };
      const recoveredTurn = headOnly ? await this.store.hydrateCurrentTurn(jobId,turnId,history.response,checkedAt,freshness)
        : (await this.store.hydrateConversation(jobId, history.response, checkedAt, freshness)).turns.find(turn => turn.turnId === turnId);
      this.verifiedHeads.set(jobId,{turnId,fingerprint:history.sourceFingerprint,revision:this.store.conversationRevision(jobId)});
      await this.store.appendEvent(jobId, "conversation.recovery.completed", "Active conversation synchronized from native history.", {
        previousRevision: baseline.revision, revision: this.store.conversationRevision(jobId),
      });
      if (nativeTerminal) {
        const output = recoveredTurn?.items.filter((item) => item.type === "agentMessage").at(-1)?.text;
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
    return this.store.withAdmission(() => this.dispatchAdmitted(input));
  }

  private async dispatchAdmitted(input: DispatchInput): Promise<{ record: JobRecord; created: boolean }> {
    normalizeTurnSpeed(input.preview.workPackage.speed);
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
      this.trackBackground(this.withJobLock(created.record.id, () => this.execute(created.record.id)), created.record.id);
    }
    return created;
  }

  async sendMessage(input: ConversationSendInput): Promise<ConversationSendResult> {
    return this.store.withAdmission(() => this.withJobLock(input.jobId, () => this.sendMessageLocked(input)));
  }

  private async sendMessageLocked(input: ConversationSendInput, source: "app" | "model_direct" = "app"): Promise<ConversationSendResult> {
      const speed = normalizeTurnSpeed(input.speed);
      let job = requireJob(this.store, input.jobId);
      const active = ["running", "awaiting_approval"].includes(job.status);
      // Resolve inheritance here, before recording, so explicit submission and
      // inherited settings stay distinguishable in the durable message record.
      const currentModel = job.selectionRecorded ? job.model : job.model ?? job.workPackage.model;
      const currentEffort = job.selectionRecorded ? job.effort : job.effort ?? job.workPackage.effort;
      const inherited = source === "model_direct" || active ? { model: currentModel, effort: currentEffort } : undefined;
      const selection = recordModelSelection(input, inherited, active ? "steer" : "turn");
      input = { ...input, ...selection, model: input.model ?? inherited?.model, effort: input.effort ?? inherited?.effort };
      await this.assertProjectStillOperable(job.project);
      const stagedInputArtifacts = await this.textBundles.resolveMany(
        input.inputBundleIds ?? [], job.project.id, input.dataClassification,
      );
      // Retry identity precedes active-turn gates: an accepted new turn may now be running.
      if (await this.store.isUserMessageRetry(job.id, { ...input, inputArtifacts: stagedInputArtifacts })) {
        return { record: job, accepted: false, delivery: await this.store.nativeMessageDelivery(job.id, input.clientMessageId) };
      }
      if (job.nativeRequest || job.restartInterruptedTurnId) throw new Error("NATIVE_DELIVERY_PENDING_READBACK");
      if (!active && !isTerminal(job.status)) {
        throw new Error("Wait for the current conversation turn to start before sending another message.");
      }
      if (active) {
        if (input.speed !== undefined) {
          throw new Error("Speed cannot be selected for an active turn. Omit speed to steer; select it only for a new turn.");
        }
        const currentMode = job.currentExecutionMode ?? job.workPackage.executionMode;
        const currentReviewer = job.currentApprovalReviewer ?? job.workPackage.approvalReviewer ?? "user";
        if (
          input.executionMode !== currentMode ||
          input.approvalReviewer !== currentReviewer ||
          input.model !== currentModel ||
          input.effort !== currentEffort
        ) {
          throw new Error("Execution mode, approval reviewer, model, and reasoning effort cannot change while a turn is running.");
        }
      }
      input = { ...input, speed: active ? undefined : speed };
      await this.validateModelSelection(input.model, input.effort);
      const appended = await this.store.appendUserMessage(input.jobId, { ...input, inputArtifacts: stagedInputArtifacts });
      if (!appended.created) {
        return { record: appended.record, accepted: false, delivery: await this.store.nativeMessageDelivery(job.id, input.clientMessageId) };
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
        const receipt = await this.appServer.request<{turnId:string}>("turn/steer", {
          threadId: job.threadId,
          expectedTurnId: job.turnId,
          clientUserMessageId: resolvedInput.clientMessageId,
          input: [{ type: "text", text: buildCodexUserInput({
            message: resolvedInput.content,
            context: resolvedInput.context,
            artifacts: resolvedInput.inputArtifacts,
          }) }],
        });
        if (receipt?.turnId !== job.turnId) throw new Error("NATIVE_STEER_TURN_UNCONFIRMED");
        const record = await this.store.appendEvent(job.id, "operator.steered", "Operator sent a conversation message.", {
          source,
          clientMessageId: input.clientMessageId, characterCount: input.content.length,
        });
        return { record, accepted: true, delivery: "steer" };
      }
      if (!job.threadId) {
        throw new Error("This legacy conversation has no Codex thread id and cannot be resumed.");
      }
      const priorTurnId = job.turnId ?? await this.store.lastProjectedTurnId(job.id, job.threadId);
      const prepared = await this.store.prepareTurn(job.id, input);
      await this.store.appendEvent(job.id, "operator.message", "Conversation message accepted.", { source });
      this.trackBackground(this.withJobLock(prepared.id, () => this.resumeAndExecute(prepared.id, resolvedInput, priorTurnId)), prepared.id);
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

  private async inspectOwnedThread(jobId:string, threadId:string) {
    const job = requireJob(this.store,jobId);
    if (!threadId || job.threadId !== threadId) throw new DirectOperationError("DIRECT_THREAD_CHANGED");
    await this.assertProjectStillOperable(job.project);
    const metadata = await this.historyReader.readMetadata(threadId);
    if (typeof metadata.rawThread.cwd !== "string" || comparablePath(await realpath(metadata.rawThread.cwd)) !== comparablePath(job.project.path))
      throw new DirectOperationError("DIRECT_THREAD_PROJECT_MISMATCH");
    return {job,metadata};
  }

  async readThreadPage(input:{jobId:string;threadId:string;kind:ThreadPageKind;cursor?:string;searchTerm?:string;childId?:string}) {
    const {metadata} = await this.inspectOwnedThread(input.jobId,input.threadId);
    if (input.childId) {
      if (input.kind !== "messages") throw new Error("CHILD_VIEW_MISMATCH");
      const child = await this.historyReader.readMetadata(input.childId);
      if (child.rawThread.parentThreadId !== input.threadId || typeof child.rawThread.cwd !== "string" ||
        typeof metadata.rawThread.cwd !== "string" || comparablePath(await realpath(child.rawThread.cwd)) !== comparablePath(await realpath(metadata.rawThread.cwd)))
        throw new DirectOperationError("DIRECT_THREAD_PROJECT_MISMATCH");
      return {...await this.controlPlane.threadPage(input.childId,"messages",input.cursor),source:"native_child"};
    }
    if (input.kind === "search" && !input.searchTerm?.trim()) throw new Error("SEARCH_TERM_REQUIRED");
    if (input.kind === "search" && metadata.historyMode === "legacy") {
      const history = await this.historyReader.read(input.threadId,metadata);
      const thread = history.response.thread;
      if (!isObject(thread) || !Array.isArray(thread.turns)) throw new Error("MALFORMED_LEGACY_HISTORY");
      const term = input.searchTerm!;
      const prefix = createHash("sha256").update(JSON.stringify([input.threadId,term,history.sourceFingerprint])).digest("hex") + ".";
      const offset = input.cursor === undefined ? 0 : input.cursor.startsWith(prefix) ? Number(input.cursor.slice(prefix.length)) : NaN;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("SEARCH_CURSOR_CHANGED");
      const items:Array<{turnId:string;itemId:string;snippet:string}> = [];
      let index = 0;
      // Literal Unicode matches over stored text. Never search the bounded UI checkpoint.
      const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
      for (const turn of thread.turns) {
        if (!isObject(turn) || typeof turn.id !== "string" || !Array.isArray(turn.items)) throw new Error("MALFORMED_LEGACY_TURN");
        for (const item of turn.items) {
          if (!isObject(item) || typeof item.id !== "string") continue;
          const message = item.type === "agentMessage" && typeof item.text === "string" ? item.text :
            item.type === "userMessage" && Array.isArray(item.content) ? item.content.filter(part => isObject(part) && part.type === "text").map(part => part.text).join("\n") : "";
          for (const match of message.matchAll(pattern)) {
            if (index++ < offset) continue;
            if (items.length === 100) return {status:"available",source:"legacy_history",data:{data:items,nextCursor:prefix+(index-1)},truncated:true};
            const start = match.index!;
            items.push({turnId:turn.id,itemId:item.id,snippet:redactString(message.slice(Math.max(0,start-100),start+match[0].length+100))});
          }
        }
      }
      if (offset > index) throw new Error("SEARCH_CURSOR_CHANGED");
      return {status:"available",source:"legacy_history",data:{data:items,nextCursor:null},truncated:false};
    }
    return {...await this.controlPlane.threadPage(input.threadId,input.kind,input.cursor,input.searchTerm),source:"native"};
  }

  async manageThread(input:{jobId:string;threadId:string;expectedTurnId:string;requestId:string;operation:
    {kind:"saveGoal"; objective:string} | {kind:"clearGoal"} | {kind:"deleteQueued";id:string}}) {
    return this.store.withAdmission(() => this.withJobLock(input.jobId,async () => {
      const {job} = await this.inspectOwnedThread(input.jobId,input.threadId);
      await this.assertDirectJob(job,false);
      return this.runDirectRequest(job, "native:"+normalizeIdempotencyKey(input.requestId),input,async () => {
        if (job.turnId !== input.expectedTurnId || job.nativeRequest || job.restartInterruptedTurnId) throw new DirectOperationError("DIRECT_TURN_CHANGED");
        const {operation,threadId} = input;
        switch (operation.kind) {
          case "saveGoal": {
            // An active goal may start further turns under native thread defaults.
            const response = await this.appServer.request("thread/goal/set",{threadId,objective:operation.objective,status:"paused",origin:"user"});
            if (!isObject(response.goal) || response.goal.threadId !== threadId || response.goal.objective !== operation.objective || response.goal.status !== "paused")
              throw new Error("GOAL_RECEIPT_UNCONFIRMED");
            break;
          }
          case "clearGoal": {
            const response = await this.appServer.request("thread/goal/clear",{threadId,origin:"user"});
            if (response.cleared !== true) throw new Error("GOAL_CLEAR_UNCONFIRMED");
            break;
          }
          case "deleteQueued": {
            const response = await this.appServer.request("thread/queue/delete",{threadId,queuedSubmissionId:operation.id});
            if (response.deleted !== true) throw new Error("QUEUE_DELETE_UNCONFIRMED");
            break;
          }
        }
      });
    }));
  }

  async directThreadAction(kind: "compact" | "review" | "fork", input: {
    jobId: string; requestId: string; expectedThreadId: string; expectedTurnId: string;
  }) {
    return this.store.withAdmission(() => this.withJobLock(input.jobId, async () => {
      const job = requireJob(this.store, input.jobId);
      await this.assertDirectJob(job, false);
      if (job.threadId !== input.expectedThreadId) throw new DirectOperationError("DIRECT_THREAD_CHANGED");
      // Native fork allocates the id remotely without a replay key. A lost response or crash
      // cannot be reconciled atomically with JobStore/UnifiedConversationRegistry ownership.
      if (kind === "fork") throw new DirectOperationError("DIRECT_FORK_OWNERSHIP_UNSUPPORTED",
        "Fork is blocked: the native protocol cannot guarantee recoverable Bridge ownership after a lost response.");
      return this.runDirectRequest(job, `${kind}:${normalizeIdempotencyKey(input.requestId)}`, {
        expectedThreadId: input.expectedThreadId, expectedTurnId: input.expectedTurnId,
      }, async () => {
        if (job.turnId !== input.expectedTurnId) throw new DirectOperationError("DIRECT_TURN_CHANGED");
        if (job.nativeRequest || job.restartInterruptedTurnId || !isTerminal(job.status) || job.approvals.some((approval) => approval.state === "pending")) throw new DirectOperationError("DIRECT_THREAD_BUSY");
        const projectPath = await realpath(job.project.path);
        if (comparablePath(projectPath) !== comparablePath(job.project.path)) throw new DirectOperationError("DIRECT_PROJECT_CHANGED");
        const metadata = await this.historyReader.readMetadata(input.expectedThreadId);
        if (typeof metadata.rawThread.cwd !== "string" || comparablePath(await realpath(metadata.rawThread.cwd)) !== comparablePath(projectPath)) {
          throw new DirectOperationError("DIRECT_THREAD_PROJECT_MISMATCH");
        }
        const executionMode = kind === "review" ? "plan" : job.currentExecutionMode ?? job.workPackage.executionMode;
        const approvalReviewer = job.currentApprovalReviewer ?? job.workPackage.approvalReviewer ?? "user";
        const permissions = await this.selectPermissionProfile(job, executionMode);
        await this.prepareContinuation(job, input.expectedThreadId, input.expectedTurnId, input.requestId, kind,
          permissions, approvalReviewer, job.model, job.effort);
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
    }));
  }

  async directMessage(input: DirectConversationSendInput, expectedTurnId?: string, steerOnly = false) {
    normalizeTurnSpeed(input.speed);
    return this.store.withAdmission(() => this.withJobLock(input.jobId, async () => {
      const job = requireJob(this.store, input.jobId);
      await this.assertDirectJob(job, false);
      if (input.dataClassification === "company_approved") throw new DirectOperationError("DIRECT_COMPANY_AUTHORIZATION_REQUIRES_APP");
      const key = `${steerOnly ? "steer" : "send"}:${normalizeIdempotencyKey(input.clientMessageId)}`;
      return this.runDirectRequest(job, key, { ...input, expectedTurnId }, async () => {
        if (expectedTurnId && (!["running", "awaiting_approval"].includes(job.status) || job.turnId !== expectedTurnId)) throw new DirectOperationError("DIRECT_TURN_CHANGED");
        if (steerOnly && !["running", "awaiting_approval"].includes(job.status)) throw new DirectOperationError("DIRECT_TURN_NOT_ACTIVE");
        if ((steerOnly || ["running", "awaiting_approval"].includes(job.status)) && (!expectedTurnId || job.turnId !== expectedTurnId)) throw new DirectOperationError("DIRECT_TURN_CHANGED");
        const sent = await this.sendMessageLocked({
          ...input,
          approvalReviewer: input.approvalReviewer ?? job.currentApprovalReviewer ?? job.workPackage.approvalReviewer ?? "user",
        }, "model_direct");
        if (sent.delivery === "failed") throw new Error("NATIVE_TURN_START_FAILED");
        if (sent.delivery === "unknown") throw new Error("NATIVE_DELIVERY_PENDING_READBACK");
      }, input.approvalReviewer === undefined ? { ...input, approvalReviewer: "user", expectedTurnId } : undefined);
    }));
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
    const messageId = /^(?:send|steer):(.+)$/.exec(key)?.[1];
    const prior = job.directRequests?.[key];
    if (prior) {
      // Before reviewer selection was exposed, the MCP adapter injected user into every message.
      // Match that old receipt only for a retry with an omitted reviewer; never redeliver it.
      const legacyMatch = prior.inputVersion === undefined && legacyPayload !== undefined &&
        prior.digest === createHash("sha256").update(JSON.stringify(legacyPayload)).digest("hex");
      if (prior.digest !== digest && !legacyMatch) throw new DirectOperationError("DIRECT_REQUEST_CONFLICT");
      const delivery = messageId && prior.inputVersion === 3
        ? await this.store.nativeMessageDelivery(job.id, messageId)
        : prior.state === "completed" ? "duplicate" : "unknown";
      return { jobId: job.id, accepted: false, delivery };
    }
    if (Object.keys(job.directRequests ?? {}).length >= 10_000) throw new DirectOperationError("DIRECT_REQUEST_LIMIT");
    await this.store.recordDirectRequest(job.id, key, digest, "pending", messageId ? 3 : 2);
    try {
      await operation();
      await this.store.recordDirectRequest(job.id, key, digest, "completed", messageId ? 3 : 2);
      return { jobId: job.id, accepted: true, delivery: "accepted" };
    } catch (error) {
      await this.store.recordDirectRequest(job.id, key, digest, "unknown", messageId ? 3 : 2);
      throw error;
    }
  }

  async sendLocalThreadMessage(input: LocalConversationSendInput): Promise<ConversationSendResult> {
    return this.store.withAdmission(() => this.sendLocalThreadMessageAdmitted(input));
  }

  private async sendLocalThreadMessageAdmitted(input: LocalConversationSendInput): Promise<ConversationSendResult> {
    normalizeTurnSpeed(input.speed);
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
    if (summary.threadStatus === "active") {
      const owned = this.store.findByThreadId(input.localThreadId);
      if (owned && ["running", "awaiting_approval"].includes(owned.status)) {
        return this.sendMessage({ ...input, jobId: owned.id });
      }
      throw new Error("The local Codex thread is active. Wait for it to finish before starting a new turn or selecting speed.");
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
      speed: normalizeTurnSpeed(input.speed),
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
    return this.store.withAdmission(() => this.withJobLock(jobId, () => this.steerLocked(jobId, message)));
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
    const receipt = await this.appServer.request<{turnId:string}>("turn/steer", {
      threadId: job.threadId,
      expectedTurnId: job.turnId,
      input: [{ type: "text", text }],
    });
    if (receipt?.turnId !== job.turnId) throw new Error("NATIVE_STEER_TURN_UNCONFIRMED");
    return this.store.appendEvent(jobId, "operator.steered", "Operator sent steering guidance.", {
      source: "app",
      characterCount: text.length,
    });
  }

  async decideApproval(
    jobId: string,
    approvalId: string,
    decision: "accept" | "decline" | "cancel",
    selections?: number[],
  ): Promise<JobRecord> {
    this.notificationEpochs.set(jobId, (this.notificationEpochs.get(jobId) ?? 0) + 1);
    return this.withJobLock(jobId, () => this.decideApprovalLocked(jobId, approvalId, decision, selections));
  }

  private async decideApprovalLocked(
    jobId: string,
    approvalId: string,
    decision: "accept" | "decline" | "cancel",
    selections?: number[],
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
    if (!approval || approval.state !== "pending" || !["running","awaiting_approval"].includes(job.status) ||
      (approval.summary.turnId && approval.summary.turnId !== job.turnId)) throw new Error("NATIVE_REQUEST_EXPIRED");
    let response:Record<string,unknown> = {decision};
    if (live.questions) {
      response = safeDeclineResponse(approval.method);
      if (decision === "accept") {
        const questions = live.questions;
        if (!selections || selections.length !== questions.length) throw new Error("NATIVE_INPUT_REQUIRED");
        const entries = questions.map((question,i) => {
          const index = selections[i];
          if (!Number.isInteger(index) || index < 0 || index >= question.labels.length) throw new Error("NATIVE_INPUT_INVALID");
          const value = question.labels[index];
          return [question.id,approval.kind === "user_input" ? {answers:[value]} : value];
        });
        response = approval.kind === "user_input" ? {answers:Object.fromEntries(entries)}
          : {action:"accept",content:Object.fromEntries(entries),_meta:null};
      } else if (decision === "cancel" && approval.kind === "elicitation") response.action = "cancel";
    } else if (selections) throw new Error("UNEXPECTED_NATIVE_INPUT");
    this.appServer.respond(live.requestId, response);
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

  private nativeStart(jobId:string, method:"thread/start"|"turn/start", clientMessageId:string, params:Record<string,unknown>) {
    return this.appServer.request<Record<string,unknown>>(method, params, (response,rejected) => {
      this.trackBackground(this.withJobLock(jobId, async () => {
        const current = requireJob(this.store,jobId);
        if (current.nativeRequest?.method !== method || current.nativeRequest.clientMessageId !== clientMessageId) return;
        if (rejected) {
          await this.store.complete(jobId,resultFor(current,"failed","Native server rejected the original request in a late response."),clientMessageId);
          this.removeMappings(current);
          return;
        }
        const id = isObject(response) && nestedId(response,method === "thread/start" ? "thread" : "turn");
        if (!id) return;
        if (method === "thread/start") {
          await this.store.setThread(jobId,id);
          await this.store.transition(jobId,"interrupted","Native thread creation confirmed by late reply. No turn was submitted.");
        } else {
          await this.store.setTurn(jobId,id,!current.threadId || this.jobsByThread.get(current.threadId) !== jobId);
          if (current.threadId && this.jobsByThread.get(current.threadId) === jobId) this.jobsByTurn.set(id,jobId);
          this.activeRecoveryAfter.delete(jobId);
        }
        this.store.diagnostics?.observe("reconcile","late_reply",{jobId,threadId:current.threadId,turnId:current.turnId});
      }),jobId);
    });
  }

  private async execute(jobId: string): Promise<void> {
    const job = requireJob(this.store, jobId);
    let savingNativeReply = false;
    try {
      await this.assertProjectStillOperable(job.project);
      await this.store.transition(jobId, "preparing", "Starting the local Codex App Server.");
      await this.appServer.ensureStarted();
      const permissionProfile = await this.selectPermissionProfile(job, job.workPackage.executionMode);
      await this.store.recordNativeRequest(jobId, {method:"thread/start", clientMessageId:`initial:${jobId}`, state:"requested"});
      const threadResponse = await this.nativeStart(jobId,"thread/start",`initial:${jobId}`, {
        cwd: job.project.path,
        runtimeWorkspaceRoots: [job.project.path],
        approvalPolicy: "on-request",
        approvalsReviewer: job.workPackage.approvalReviewer ?? "user",
        permissions: permissionProfile,
        serviceName: "codex-handoff-bridge",
        ...(job.workPackage.model ? { model: job.workPackage.model, allowProviderModelFallback: false } : {}),
      });
      const threadId = nestedId(threadResponse, "thread");
      if (!threadId) {
        throw new NativeDeliveryUnknown("Codex App Server did not return a thread id.");
      }
      this.jobsByThread.set(threadId, jobId);
      savingNativeReply = true;
      await this.store.setThread(jobId, threadId);
      savingNativeReply = false;
      if (permissionProfile === "codex-bridge-read-only" &&
        (!isObject(threadResponse.activePermissionProfile) || threadResponse.activePermissionProfile.id !== permissionProfile
          || !isObject(threadResponse.sandbox) || threadResponse.sandbox.type !== "readOnly"
          || threadResponse.sandbox.networkAccess !== true)) {
        throw new DirectOperationError("PERMISSION_PROFILE_UNVERIFIED");
      }
      const inputArtifacts = await this.store.readInputArtifacts(jobId, job.workPackage.inputBundleIds);

      await this.store.recordNativeRequest(jobId, {method:"turn/start", clientMessageId:`initial:${job.id}`, state:"requested"});
      const turnResponse = await this.nativeStart(jobId,"turn/start",`initial:${jobId}`, {
        threadId,
        clientUserMessageId: `initial:${job.id}`,
        cwd: job.project.path,
        runtimeWorkspaceRoots: [job.project.path],
        approvalPolicy: "on-request",
        approvalsReviewer: job.workPackage.approvalReviewer ?? "user",
        permissions: permissionProfile,
        ...(job.workPackage.model ? { model: job.workPackage.model } : {}),
        ...(job.workPackage.effort ? { effort: job.workPackage.effort } : {}),
        serviceTierForTurn: normalizeTurnSpeed(job.workPackage.speed) === "fast" ? "fast" : "default",
        input: [
          {
            type: "text",
            text: buildInitialTurnUserInput(job.workPackage, inputArtifacts),
          },
        ],
      });
      const turnId = nestedId(turnResponse, "turn");
      if (!turnId) {
        throw new NativeDeliveryUnknown("Codex App Server did not return a turn id.");
      }
      savingNativeReply = true;
      this.jobsByTurn.set(turnId, jobId);
      await this.store.setTurn(jobId, turnId);
      await this.store.applyConversationNotification(jobId, {
        method: "turn/started",
        params: { threadId, turn: isObject(turnResponse.turn) ? turnResponse.turn : { id: turnId, status: "inProgress", items: [] } },
      });
    } catch (error) {
      if (savingNativeReply) throw error;
      const current = requireJob(this.store, jobId);
      if (error instanceof NativeDeliveryUnknown && current.nativeRequest) {
        await this.store.recordNativeRequest(jobId, {...current.nativeRequest, state:"unknown"});
        return;
      }
      if (!isTerminal(current.status)) {
        await this.store.complete(jobId, resultFor(current, "failed", `Unable to start Codex work: ${errorMessage(error)}`));
      }
      this.removeMappings(current);
    }
  }

  private async resumeAndExecute(jobId: string, input: ResolvedConversationSendInput, priorTurnId?: string): Promise<void> {
    let job = requireJob(this.store, jobId);
    let savingNativeReply = false;
    try {
      await this.assertProjectStillOperable(job.project);
      await this.appServer.ensureStarted();
      const permissionProfile = await this.selectPermissionProfile(job, input.executionMode);
      if (!job.threadId) throw new Error("MISSING_NATIVE_THREAD");
      const threadId = job.threadId;
      await this.prepareContinuation(job, threadId, priorTurnId, input.clientMessageId, "turn",
        permissionProfile, input.approvalReviewer, input.model, input.effort);
      this.threadSyncStates.delete(threadId);
      this.jobsByThread.set(threadId, jobId);
      await this.store.recordNativeRequest(jobId, {method:"turn/start", clientMessageId:input.clientMessageId, state:"requested"});
      const turnResponse = await this.nativeStart(jobId,"turn/start",input.clientMessageId, {
        threadId,
        clientUserMessageId: input.clientMessageId,
        cwd: job.project.path,
        runtimeWorkspaceRoots: [job.project.path],
        approvalPolicy: "on-request",
        approvalsReviewer: input.approvalReviewer,
        // thread/resume may only rejoin a loaded session; bind the actual turn.
        permissions: permissionProfile,
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        serviceTierForTurn: normalizeTurnSpeed(input.speed) === "fast" ? "fast" : "default",
        input: [{ type: "text", text: buildCodexUserInput({
          message: input.content,
          context: input.context,
          artifacts: input.inputArtifacts,
        }) }],
      });
      const turnId = nestedId(turnResponse, "turn");
      if (!turnId) {
        throw new NativeDeliveryUnknown("Codex App Server did not return a turn id.");
      }
      savingNativeReply = true;
      this.jobsByTurn.set(turnId, jobId);
      await this.store.setTurn(jobId, turnId);
      await this.store.applyConversationNotification(jobId, {
        method: "turn/started",
        params: { threadId, turn: isObject(turnResponse.turn) ? turnResponse.turn : { id: turnId, status: "inProgress", items: [] } },
      });
    } catch (error) {
      if (savingNativeReply) throw error;
      job = requireJob(this.store, jobId);
      if (error instanceof NativeDeliveryUnknown && job.nativeRequest) {
        await this.store.recordNativeRequest(jobId, {...job.nativeRequest, state:"unknown"});
        return;
      }
      if (!isTerminal(job.status)) {
        await this.store.complete(jobId, resultFor(job, "failed", `Unable to continue Codex conversation: ${errorMessage(error)}`), input.clientMessageId);
      }
      this.removeMappings(job);
    }
  }

  async validateModelSelection(model?: string, effort?: string): Promise<void> {
    if (!model && !effort) {
      return;
    }
    let models: CodexModelOption[];
    try {
      models = await this.listModels();
    } catch (error) {
      if (!model) throw error;
      // Discovery is advisory for explicit IDs. Retain known effort constraints
      // from the last successful inventory when a refresh fails.
      models = this.modelCache?.models ?? [];
    }
    const selected = model
      ? models.find((candidate) => candidate.id === model)
      : models.find((candidate) => candidate.isDefault) ?? models[0];
    if (!selected) {
      if (model) return; // App Server owns support and authorization for unlisted IDs.
      throw new Error("Codex did not return a default model.");
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

  private async withJobLock<T>(jobId: string, operation: () => Promise<T>, notificationsOnly = false): Promise<T> {
    this.notificationBatches.delete(jobId);
    if (!notificationsOnly) { this.controlLocks++; this.updatePressure(); }
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
      if (!notificationsOnly) { this.controlLocks--; this.updatePressure(); }
      if (this.jobLocks.get(jobId) === queued) {
        this.jobLocks.delete(jobId);
      }
    }
  }

  private async assertResumeHasNoAutomaticWork(threadId:string) {
    // A fresh writer can consume persisted work inside resume, before a later
    // settings readback. These two native reads do not attach a writer.
    const [goal,queue] = await Promise.all([
      this.appServer.request("thread/goal/get",{threadId}),
      this.appServer.request("thread/queue/list",{threadId,limit:1}),
    ]);
    if (goal.goal !== null && (!isObject(goal.goal) || !["paused","complete","blocked","budgetLimited","usageLimited"].includes(String(goal.goal.status))))
      throw new DirectOperationError("NATIVE_GOAL_REQUIRES_RECONCILIATION");
    if (!Array.isArray(queue.data) || queue.data.length || queue.nextCursor !== null)
      throw new DirectOperationError("NATIVE_QUEUE_REQUIRES_RECONCILIATION");
  }

  private async prepareContinuation(job: JobRecord, threadId: string, priorTurnId: string | undefined,
    requestId: string, action: "turn" | "review" | "compact", permissions: string,
    reviewer: "user" | "auto_review", model?: string, effort?: string) {
    await prepareResumedThread(this.appServer, {
      threadId, priorTurnId, cwd: job.project.path, action, permissions, reviewer, model, effort,
      checkAutomaticWork: () => this.assertResumeHasNoAutomaticWork(threadId),
      record: async data => {
        await this.store.appendEvent(job.id, "codex.resume.verification", "Native continuation verification.", {
          jobId: job.id, requestId, ...data,
        });
      },
    });
  }

  private async selectPermissionProfile(job: JobRecord, executionMode = job.currentExecutionMode ?? job.workPackage.executionMode): Promise<string> {
    const requiredId = executionMode === "plan" ? "codex-bridge-read-only" : ":danger-full-access";
    const profiles = await this.controlPlane.permissionProfiles(job.project.path);
    const profile = profiles.status === "available" && profiles.data.find(row => row.id === requiredId && row.allowed);
    if (!profile) {
      throw new Error(`Required Codex permission profile '${requiredId}' is unavailable for this project.`);
    }
    return requiredId;
  }

  private handleNotification(message: JsonRpcNotification): Promise<void> | void {
    const params = message.params ?? {};
    const telemetry = message.method === "thread/tokenUsage/updated" || message.method === "model/rerouted";
    const jobId = this.findJobId(params) ?? (telemetry && typeof params.threadId === "string" ? this.store.findByThreadId(params.threadId)?.id : undefined);
    if (jobId && message.method === "serverRequest/resolved") {
      return this.withJobLock(jobId,async () => {
        const job = this.store.get(jobId);
        if (!job || job.threadId !== params.threadId) return;
        for (const [id,live] of this.liveApprovals) {
          if (live.jobId !== jobId || live.requestId !== params.requestId) continue;
          this.liveApprovals.delete(id);
          if (job.approvals.some(a => a.id === id && a.state === "pending")) await this.store.resolveApproval(jobId,id,"expired");
        }
      });
    }
    if (!jobId) {
      const scoped = /^(item|turn)\//.test(message.method);
      if (scoped) this.unmatchedNotificationCount++;
      const threadId = stringValue(params.threadId) ?? nestedId(params, "thread");
      const turnId = stringValue(params.turnId) ?? nestedId(params, "turn");
      this.store.diagnostics?.observe("unmatched", !scoped ? "other_notification" : turnId ? "unmapped_turn" :
        threadId ? "unmapped_thread" : "missing_identity", { threadId, turnId });
      return;
    }
    // Count at ingress, before locks: a queued delta invalidates an in-flight native read too.
    this.notificationEpochs.set(jobId, (this.notificationEpochs.get(jobId) ?? 0) + 1);
    this.lastNotificationAt.set(jobId, Date.now());
    const text = params.delta ?? params.diff ?? params.message;
    const received = {at:performance.now(), bytes:message.wireBytes ?? (typeof text === "string" ? text.length*2 : 0)};
    this.waitingBytes += received.bytes;
    this.waiting.add(received);
    this.store.diagnostics?.observe("notification","ingress",{jobId,threadId:stringValue(params.threadId) ?? nestedId(params,"thread"),
      turnId:stringValue(params.turnId) ?? nestedId(params,"turn"),depth:this.waiting.size,bytes:received.bytes});
    this.updatePressure();
    const run = async () => {
      this.waiting.delete(received);
      this.waitingBytes -= received.bytes;
      this.updatePressure();
      const started = performance.now();
      const ids = {jobId, threadId:stringValue(params.threadId), turnId:stringValue(params.turnId)};
      this.store.diagnostics?.observe("queue", "received", {...ids, elapsedMs:started-received.at, depth:this.waiting.size});
      try {
        const target = this.store.notificationTarget(jobId);
        if (!target) return;
        const eventThreadId = stringValue(params.threadId) ?? nestedId(params, "thread");
        const eventTurnId = stringValue(params.turnId) ?? nestedId(params, "turn");
        if (message.method === "turn/completed" && (!eventTurnId || !target.turnId)) {
          this.store.diagnostics?.observe("unmatched", "missing_identity", ids, true);
          return;
        }
        if ((eventThreadId && eventThreadId !== target.threadId) || (eventTurnId && target.turnId && eventTurnId !== target.turnId)) {
          this.store.diagnostics?.observe("unmatched", "identity_mismatch", ids);
          return;
        }
        if (isCoalescibleConversationNotification(message.method)) {
          if (isTerminal(target.status) || (target.priorTurnId && target.priorTurnId === eventTurnId)) {
            this.store.diagnostics?.observe("unmatched", isTerminal(target.status) ? "already_terminal" : "identity_mismatch", ids);
            return;
          }
          try { await this.store.applyConversationNotification(jobId, message, new Date().toISOString(), true, false); }
          catch (error) {
            this.store.diagnostics?.observe("notification","persistence_failed",ids,true,error);
            throw error;
          }
          return;
        }
        const job = this.store.get(jobId);
        if (!job) return;
        if (telemetry) {
          if (eventThreadId !== job.threadId || !eventTurnId || eventTurnId !== job.turnId) return;
          await this.store.applyConversationNotification(jobId, message.method === "model/rerouted"
            ? { ...message, params: { ...params, requestedModel: (job.selectionRecorded ? job.model : job.model ?? job.workPackage.model) ?? null } } : message);
          return;
        }
        if (isTerminal(job.status)) {
          this.store.diagnostics?.observe("unmatched", "already_terminal", ids);
          return;
        }
        if (job.controlAction) {
          if (eventTurnId === job.controlAction.priorTurnId) return;
          if (!job.turnId && message.method === "turn/started" && eventTurnId) {
            this.jobsByTurn.set(eventTurnId, jobId);
            await this.store.setTurn(jobId, eventTurnId);
          } else if (eventTurnId && eventTurnId !== job.turnId) return;
        }
        try {
          await this.store.applyConversationNotification(jobId, message, new Date().toISOString(), true, false);
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
          this.store.diagnostics?.observe("notification", "persistence_failed", ids, true);
          await this.store.appendEvent(jobId, "bridge.event.error", "Failed to persist a Codex event.", {
            method: message.method,
            error: errorMessage(error),
          }).catch(() => undefined);
        }
      } finally {
        this.store.diagnostics?.observe("service", "handled", {...ids, elapsedMs:performance.now()-started});
      }
    };
    if (!isCoalescibleConversationNotification(message.method)) return this.withJobLock(jobId, run, true);
    const queued = this.notificationBatches.get(jobId);
    if (queued) { queued.push(run); return; }
    const batch = [run];
    const drain = this.withJobLock(jobId, async () => {
      try {
        // A new command/approval reserves its own place in the same lock and seals
        // this batch. Release each captured notification immediately after use.
        let firstFailure: unknown;
        while (batch.length) {
          const entries = batch.splice(0);
          for (let index = 0; index < entries.length; index++) {
            const entry = entries[index];
            delete entries[index];
            try { await entry(); } catch (error) { firstFailure ??= error; }
          }
        }
        if (firstFailure) throw firstFailure;
      } finally { if (this.notificationBatches.get(jobId) === batch) this.notificationBatches.delete(jobId); }
    }, true);
    this.notificationBatches.set(jobId, batch);
    return drain;
  }

  private async handleServerRequest(message: JsonRpcServerRequest): Promise<void> {
    const params = message.params ?? {};
    const jobId = this.findJobId(params);
    const kind = approvalKind(message.method);
    if (!jobId || !kind) {
      this.appServer.respond(message.id, safeDeclineResponse(message.method));
      return;
    }
    const questions = nativeChoiceQuestions(message.method,params);
    if (kind !== "command" && kind !== "file_change" && !questions) {
      this.appServer.respond(message.id, safeDeclineResponse(message.method));
      await this.store.appendEvent(jobId, "codex.request.declined", "Unsupported interactive request declined by v1 bridge.", {
        method: message.method,
        kind,
      });
      return;
    }

    this.notificationEpochs.set(jobId, (this.notificationEpochs.get(jobId) ?? 0) + 1);
    await this.withJobLock(jobId, async () => {
      // Routing maps only identify a candidate. Revalidate against the current store
      // under the lock before creating approval state or projecting into a turn.
      const job = this.store.get(jobId);
      const turnId = stringValue(params.turnId) ?? nestedId(params, "turn");
      const threadIds = [params.threadId, params.thread === undefined ? undefined : nestedId(params, "thread") ?? null];
      const turnIds = [params.turnId, params.turn === undefined ? undefined : nestedId(params, "turn") ?? null];
      if (!job || !["running", "awaiting_approval"].includes(job.status)
        || !turnId?.trim() || turnId !== job.turnId
        || threadIds.some((id) => id !== undefined && id !== job.threadId)
        || turnIds.some((id) => id !== undefined && id !== job.turnId)) {
        this.appServer.respond(message.id, safeDeclineResponse(message.method));
        return;
      }
      const approval: PendingApproval = {
        id: randomUUID(),
        kind,
        state: "pending",
        method: message.method,
        createdAt: new Date().toISOString(),
        summary: questions ? {turnId, questions:questions.map(q => ({prompt:redactString(q.prompt),labels:q.labels.map(redactString)}))}
          : summarizeApproval(kind, params),
      };
      this.liveApprovals.set(approval.id, { jobId, requestId: message.id, questions });
      try {
        await this.store.flushConversation(jobId);
        await this.store.addApproval(jobId, approval);
        await this.store.applyConversationNotification(jobId, {
          method: "bridge/approval",
          params: {
            threadId: job.threadId,
            turnId: job.turnId,
            itemId: stringValue(params.itemId),
            approvalId: approval.id,
            state: approval.state,
            kind: approval.kind,
          },
        });
      } catch (error) {
        this.liveApprovals.delete(approval.id);
        this.appServer.respond(message.id, safeDeclineResponse(message.method));
      }
    });
  }

  private async handleStderr(line: string): Promise<void> {
    const activeJobs = new Set(this.jobsByTurn.values());
    const level = /\b(panic|fatal)\b/i.test(line) ? "fatal" : /\b(error|failed)\b/i.test(line) ? "error" : "other";
    this.store.diagnostics?.observe("stderr", level, {depth:activeJobs.size, bytes:Buffer.byteLength(line)}, level === "fatal");
    this.store.diagnostics?.observe("stderr", activeJobs.size > 1 ? "shared_process" : activeJobs.size ? "single_turn" : "no_mapped_turn",
      {depth: activeJobs.size, bytes:Buffer.byteLength(line)});
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
    const jobs = new Set([...this.jobsByThread.values(), ...this.jobsByTurn.values()]);
    this.jobsByThread.clear();
    this.jobsByTurn.clear();
    this.liveApprovals.clear();
    this.releaseCandidates.clear();
    // Reserve all per-job barriers before awaiting the first one. Earlier terminal
    // notifications can still commit their result ahead of this disconnect.
    await Promise.all([...jobs].map(jobId => this.withJobLock(jobId, async () => {
      const job = this.store.get(jobId);
      if (job && !isTerminal(job.status)) {
        this.store.diagnostics?.observe("reconcile","disconnected",{jobId,threadId:job.threadId,turnId:job.turnId},true,error);
        await this.store.markNativeDisconnected(jobId);
      }
      this.finalOutputByJob.delete(jobId);
      this.verifiedHeads.delete(jobId);
      this.diagnosticSignaturesByJob.delete(jobId);
    })));
  }

  private findJobId(params: Record<string, unknown>): string | undefined {
    const turnId = stringValue(params.turnId) ?? nestedId(params, "turn");
    if (turnId && this.jobsByTurn.has(turnId)) {
      return this.jobsByTurn.get(turnId);
    }
    const threadId = stringValue(params.threadId) ?? nestedId(params, "thread");
    return threadId ? this.jobsByThread.get(threadId) : undefined;
  }

  async releaseIdleSubscription(jobId:string, threadId:string) {
    await this.withJobLock(jobId,async () => {
      const job = requireJob(this.store,jobId);
      if (!isTerminal(job.status) || job.threadId !== threadId || job.nativeRequest || job.restartInterruptedTurnId ||
        job.idempotencyKey.startsWith("local-thread:") || this.jobsByThread.has(threadId) || job.approvals.some(row => row.state === "pending")) return;
      try {
        const read = await this.historyReader.readMetadata(threadId);
        if (!isObject(read.rawThread.status) || read.rawThread.status.type !== "idle") return;
        const [goal,queue,descendants,attached,terminals] = await Promise.all([
          this.appServer.request("thread/goal/get",{threadId}),this.appServer.request("thread/queue/list",{threadId,limit:1}),
          this.appServer.request("thread/list",{ancestorThreadId:threadId,sourceKinds:nativeSourceKinds,limit:1}),
          this.appServer.request("thread/list",{attachedToThreadId:threadId,sourceKinds:nativeSourceKinds,limit:1}),
          this.appServer.request("thread/backgroundTerminals/list",{threadId,limit:1}),
        ]);
        if (goal.goal !== null || [queue,descendants,attached,terminals].some(page =>
          !Array.isArray(page.data) || page.data.length || page.nextCursor !== null)) return;
        const result = await this.appServer.request("thread/unsubscribe",{threadId});
        if (!["unsubscribed","notLoaded","notSubscribed"].includes(String(result.status))) throw new Error("UNSUBSCRIBE_UNCONFIRMED");
        this.threadSyncStates.delete(threadId);
        this.hydrationRetryAfter.delete(threadId);
        this.lastNotificationAt.delete(jobId);
        this.notificationEpochs.delete(jobId);
        this.recoveryDiagnostics.delete(jobId);
        this.activeRecoveryAfter.delete(jobId);
        this.store.diagnostics?.observe("native_session","subscription_released",{jobId,threadId});
      } catch (error) {
        this.store.diagnostics?.observe("native_session","subscription_unconfirmed",{jobId,threadId},true,error);
      }
    });
  }

  private removeMappings(job: JobRecord): void {
    for (const [id,approval] of this.liveApprovals) if (approval.jobId === job.id) this.liveApprovals.delete(id);
    if (job.threadId && this.jobsByThread.get(job.threadId) === job.id) {
      this.releaseCandidates.set(job.id,job.threadId);
      this.jobsByThread.delete(job.threadId);
    }
    if (job.turnId && this.jobsByTurn.get(job.turnId) === job.id) this.jobsByTurn.delete(job.turnId);
    this.verifiedHeads.delete(job.id);
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

interface NativeChoiceQuestion {
  id: string;
  prompt: string;
  labels: string[];
}

function nativeChoiceQuestions(method:string, params:Record<string,unknown>): NativeChoiceQuestion[] | undefined {
  const questions:NativeChoiceQuestion[] = [];
  if (method === "item/tool/requestUserInput" && Array.isArray(params.questions)) {
    for (const q of params.questions) {
      if (!isObject(q) || q.isSecret !== false || !Array.isArray(q.options) ||
        typeof q.id !== "string" || typeof q.question !== "string" ||
        !q.options.every(o => isObject(o) && typeof o.label === "string")) return;
      questions.push({id:q.id,prompt:q.question,labels:q.options.map(o => o.label)});
    }
  } else if (method === "mcpServer/elicitation/request" && params.mode === "form" && isObject(params.requestedSchema)) {
    const schema = params.requestedSchema;
    if (schema.type !== "object" || !isObject(schema.properties) ||
      !Object.keys(schema).every(k => ["type","properties","required","$schema"].includes(k))) return;
    const properties = schema.properties;
    if (schema.required !== undefined && (!Array.isArray(schema.required) ||
      !schema.required.every(k => typeof k === "string" && Object.hasOwn(properties,k)))) return;
    for (const [id,field] of Object.entries(properties)) {
      if (!isObject(field) || field.type !== "string" || !Array.isArray(field.enum) ||
        !Object.keys(field).every(k => ["type","enum","title","description"].includes(k)) ||
        !field.enum.every(v => typeof v === "string")) return;
      questions.push({id,prompt:[params.serverName,params.message,field.title || id,field.description].filter(v => typeof v === "string").join(" · "),labels:field.enum});
    }
  } else return;
  if (!questions.length || new Set(questions.map(q => q.id)).size !== questions.length ||
    questions.some(q => !q.id || !q.prompt || !q.labels.length || q.labels.some(label => !label) ||
      new Set(q.labels).size !== q.labels.length)) return;
  return questions;
}

function safeDeclineResponse(method: string): Record<string, unknown> {
  if (method === "item/tool/requestUserInput" || method.includes("userInput")) return { answers: {} };
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
