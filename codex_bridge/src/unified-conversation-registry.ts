import type { AutomationRegistry } from "./automation-registry.js";
import type { BridgeConfig } from "./config.js";
import type { CodexBridgeController } from "./controller.js";
import { mergeConversationMessages } from "./conversation-projection.js";
import type { JobStore } from "./job-store.js";
import type {
  AutomationOverlay,
  JobSnapshot,
  JobSummary,
  LocalThreadSnapshot,
  LocalThreadSummary,
  UnifiedConversationDiagnostic,
  UnifiedConversationListPage,
  UnifiedConversationSnapshot,
  UnifiedConversationSummary,
} from "./types.js";

export type ConversationVisibility = "public" | "app";

const MAX_UNIFIED_INVENTORY = 10_000;

export class UnifiedConversationRegistry {
  private readonly nativeSnapshots = new Map<string, { sourceFingerprint: string; snapshot: LocalThreadSnapshot }>();

  constructor(
    private readonly config: BridgeConfig,
    private readonly store: JobStore,
    private readonly controller: CodexBridgeController,
    private readonly automations: AutomationRegistry,
  ) {}

  async listPage(input: {
    visibility: ConversationVisibility;
    projectId?: string;
    cursor?: string;
    limit?: number;
    maxConversations?: number;
  }): Promise<UnifiedConversationListPage> {
    const limit = boundedInt(input.limit ?? 50, 1, input.visibility === "public" ? 100 : 2_000);
    const maxConversations = boundedInt(input.maxConversations ?? MAX_UNIFIED_INVENTORY, limit, MAX_UNIFIED_INVENTORY);
    const diagnostics: UnifiedConversationDiagnostic[] = [];
    const [nativeResult, automationResult] = await Promise.allSettled([
      this.controller.listLocalThreads(undefined, maxConversations),
      this.automations.list(),
    ]);
    const nativePage = nativeResult.status === "fulfilled"
      ? nativeResult.value
      : { threads: [], complete: false };
    if (nativeResult.status === "rejected") {
      diagnostics.push(diagnostic("native", "native_unavailable", "Codex App Server conversation inventory is temporarily unavailable."));
    } else if (!nativePage.complete) {
      diagnostics.push(diagnostic(
        "native",
        "native_inventory_truncated",
        `Codex App Server conversation inventory exceeded the explicit ${maxConversations} item safety limit.`,
        { count: nativePage.threads.length },
      ));
    }
    const automationList = automationResult.status === "fulfilled" ? automationResult.value : [];
    if (automationResult.status === "rejected") {
      diagnostics.push(diagnostic("automation", "automation_unavailable", "Automation metadata is temporarily unavailable."));
    }

    const automationByThread = groupAutomations(automationList);
    const nativeByThread = new Map(nativePage.threads.map((thread) => [thread.threadId, thread]));
    const jobByThread = new Map<string, JobSummary>();
    const placeholders: JobSummary[] = [];
    for (const job of this.store.listAll()) {
      if (job.threadId) {
        if (!jobByThread.has(job.threadId)) jobByThread.set(job.threadId, job);
      } else {
        placeholders.push(job);
      }
    }

    const conversations: UnifiedConversationSummary[] = [];
    for (const native of nativePage.threads) {
      conversations.push(this.mergeNative(native, jobByThread.get(native.threadId), automationByThread.get(native.threadId) ?? []));
    }
    for (const [threadId, job] of jobByThread) {
      if (!nativeByThread.has(threadId)) conversations.push(this.fromJob(job, automationByThread.get(threadId) ?? []));
    }
    for (const job of placeholders) conversations.push(this.fromJob(job, []));

    const representedByThread = new Map(
      conversations.flatMap((conversation) => conversation.threadId ? [[conversation.threadId, conversation] as const] : []),
    );
    diagnostics.push(...automationDiagnostics(automationList, representedByThread, nativePage.complete, input.visibility));

    const filtered = conversations
      .filter((conversation) => this.visible(conversation, input.visibility))
      .filter((conversation) => !input.projectId || conversation.projectId === input.projectId)
      .sort(compareConversation)
      .filter(afterCursor(input.cursor));
    const page = filtered.slice(0, limit);
    const last = page.at(-1);
    return {
      conversations: page.map((conversation) => structuredClone(conversation)),
      nextCursor: filtered.length > page.length && last ? encodeCursor(last) : undefined,
      complete: nativeResult.status === "fulfilled" && nativePage.complete && filtered.length <= page.length,
      reset: !input.cursor,
      diagnostics,
    };
  }

  async get(conversationId: string, visibility: ConversationVisibility): Promise<UnifiedConversationSnapshot> {
    if (conversationId.startsWith("job:")) {
      const jobId = conversationId.slice(4);
      const job = this.store.get(jobId);
      if (!job || job.threadId) throw new Error("Unknown unified conversation id.");
      const summary = this.fromJob(this.store.listAll().find((candidate) => candidate.id === jobId)!, []);
      this.assertVisible(summary, visibility);
      return { ...summary, view: await this.store.snapshot(jobId, 0), diagnostics: [] };
    }

    const diagnostics: UnifiedConversationDiagnostic[] = [];
    const job = this.store.findByThreadId(conversationId);
    let preflightNative: LocalThreadSummary | undefined;
    let nativeFailure: unknown;
    let canReadNative = true;
    if (visibility === "public") {
      try {
        preflightNative = await this.controller.readLocalThreadSummary(conversationId);
      } catch (error) {
        if (!(job && this.config.projects.has(job.projectId))) throw error;
        nativeFailure = error;
        canReadNative = false;
      }
      if (preflightNative && !this.config.projects.has(preflightNative.projectId)) {
        throw new Error("This conversation is outside the public project allowlist.");
      }
    }

    let local: LocalThreadSnapshot | undefined;
    const cached = this.nativeSnapshots.get(conversationId);
    try {
      if (!canReadNative) throw nativeFailure;
      const fresh = await this.controller.readLocalThreadFresh(conversationId, cached?.sourceFingerprint);
      if (fresh.snapshot) {
        local = fresh.snapshot;
        this.nativeSnapshots.set(conversationId, {
          sourceFingerprint: fresh.sourceFingerprint,
          snapshot: structuredClone(fresh.snapshot),
        });
      } else if (cached) {
        local = structuredClone(cached.snapshot);
      }
    } catch (error) {
      nativeFailure = error;
      if (cached && errorCode(error) !== "ThreadNotFound") {
        local = structuredClone(cached.snapshot);
        diagnostics.push(diagnostic(
          "native",
          errorCode(error) === "HistoryChangedDuringRead" ? "native_snapshot_unstable" : "native_unavailable",
          errorCode(error) === "HistoryChangedDuringRead"
            ? "Codex history changed during pagination; the last verified native snapshot remains visible."
            : "Codex App Server history is temporarily unavailable; the last verified native snapshot remains visible.",
        ));
      }
    }

    let automationList: AutomationOverlay[] = [];
    try {
      automationList = (await this.automations.list()).filter((automation) => automation.targetThreadId === conversationId);
    } catch {
      diagnostics.push(diagnostic("automation", "automation_unavailable", "Automation metadata is temporarily unavailable."));
    }

    if (!local) {
      if (!job) throw nativeFailure ?? new Error("Unknown unified conversation id.");
      const summary = this.fromJob(job, automationList);
      this.assertVisible(summary, visibility);
      const view = await this.store.snapshot(job.id, 0);
      diagnostics.push(diagnostic("native", "native_unavailable", "Native Codex history is unavailable; the durable Bridge snapshot remains visible."));
      return {
        ...summary,
        historyFreshness: view.conversation?.freshness,
        view,
        diagnostics: dedupeDiagnostics(diagnostics),
      };
    }

    const native = summaryFromLocal(local);
    if (preflightNative && preflightNative.projectId !== native.projectId) {
      throw new Error("The conversation workspace changed during the allowlist check.");
    }
    if (visibility === "public" && !this.config.projects.has(native.projectId)) {
      throw new Error("This conversation is outside the public project allowlist.");
    }
    const summary = this.mergeNative(native, job, automationList);
    this.assertVisible(summary, visibility);
    if (!job) {
      return {
        ...summary,
        historyFreshness: local.conversation?.freshness,
        view: local,
        diagnostics: dedupeDiagnostics(diagnostics),
      };
    }
    const bridgeView = await this.store.snapshot(job.id, 0);
    return {
      ...summary,
      historyFreshness: local.conversation?.freshness,
      view: nativeBackedJobView(local, bridgeView),
      diagnostics: dedupeDiagnostics(diagnostics),
    };
  }

  private mergeNative(native: LocalThreadSummary, job: JobSummary | undefined, automations: AutomationOverlay[]): UnifiedConversationSummary {
    const hasAutomation = automations.length > 0;
    return {
      conversationId: native.threadId,
      threadId: native.threadId,
      projectId: native.projectId,
      projectName: native.projectName,
      title: native.title,
      preview: native.preview,
      createdAt: native.createdAt,
      updatedAt: latest(native.updatedAt, job?.updatedAt),
      threadStatus: native.threadStatus,
      historyMode: native.historyMode,
      source: job || hasAutomation ? "mixed" : "native",
      readOnly: native.historyOnly,
      historyOnly: native.historyOnly,
      bridgeJob: job ? structuredClone(job) : undefined,
      automations: structuredClone(automations),
      automationState: automationState(automations),
      automationUpdatedAt: latestOptional(...automations.map((automation) => automation.updatedAt)),
    };
  }

  private fromJob(job: JobSummary, automations: AutomationOverlay[]): UnifiedConversationSummary {
    const hasAutomation = automations.length > 0;
    return {
      conversationId: job.threadId ?? `job:${job.id}`,
      threadId: job.threadId,
      projectId: job.projectId,
      projectName: job.projectName,
      title: job.title,
      preview: job.objective,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      threadStatus: job.status === "running" || job.status === "awaiting_approval" ? "active" : "idle",
      historyMode: "legacy",
      source: hasAutomation ? "mixed" : "bridge",
      readOnly: false,
      historyOnly: false,
      bridgeJob: structuredClone(job),
      automations: structuredClone(automations),
      automationState: automationState(automations),
      automationUpdatedAt: latestOptional(...automations.map((automation) => automation.updatedAt)),
    };
  }

  private visible(conversation: UnifiedConversationSummary, visibility: ConversationVisibility): boolean {
    return visibility === "app" || this.config.projects.has(conversation.projectId);
  }

  private assertVisible(conversation: UnifiedConversationSummary, visibility: ConversationVisibility): void {
    if (!this.visible(conversation, visibility)) throw new Error("This conversation is outside the public project allowlist.");
  }
}

function summaryFromLocal(local: LocalThreadSnapshot): LocalThreadSummary {
  return {
    source: "local",
    threadId: local.localThreadId,
    projectId: local.projectId,
    projectName: local.projectName,
    title: local.title,
    preview: local.objective,
    createdAt: local.createdAt,
    updatedAt: local.updatedAt,
    threadStatus: local.threadStatus,
    historyMode: local.conversation?.freshness?.historyMode ?? "legacy",
    isPinned: false,
    historyOnly: local.readOnly,
  };
}

function nativeBackedJobView(local: LocalThreadSnapshot, bridgeView: JobSnapshot): JobSnapshot {
  const conversation = local.conversation ? mergeConversationMessages(local.conversation, bridgeView.messages) : undefined;
  return {
    ...bridgeView,
    conversation,
    conversationChanges: [],
    nextConversationRevision: conversation?.revision ?? 0,
    serverConversationRevision: conversation?.revision ?? 0,
    conversationHasMore: false,
  };
}

function groupAutomations(automations: AutomationOverlay[]): Map<string, AutomationOverlay[]> {
  const grouped = new Map<string, AutomationOverlay[]>();
  for (const automation of automations) {
    const group = grouped.get(automation.targetThreadId) ?? [];
    group.push(automation);
    grouped.set(automation.targetThreadId, group);
  }
  return grouped;
}

function automationDiagnostics(
  automations: AutomationOverlay[],
  representedByThread: Map<string, UnifiedConversationSummary>,
  nativeComplete: boolean,
  visibility: ConversationVisibility,
): UnifiedConversationDiagnostic[] {
  const output: UnifiedConversationDiagnostic[] = [];
  for (const automation of automations) {
    const target = representedByThread.get(automation.targetThreadId);
    if (!target) {
      output.push(diagnostic(
        "automation",
        nativeComplete ? "automation_target_missing" : "automation_target_unresolved",
        nativeComplete
          ? "An automation targets a conversation that no longer exists."
          : "An automation target could not be resolved from the incomplete native inventory.",
        visibility === "app" ? { automationId: automation.automationId, targetThreadId: automation.targetThreadId } : undefined,
      ));
    } else if (target.historyOnly) {
      output.push(diagnostic(
        "automation",
        "automation_target_protected",
        "An automation targets a protected read-only conversation.",
        visibility === "app" ? { automationId: automation.automationId, targetThreadId: automation.targetThreadId } : undefined,
      ));
    }
  }
  return dedupeDiagnostics(output);
}

function diagnostic(
  source: UnifiedConversationDiagnostic["source"],
  code: UnifiedConversationDiagnostic["code"],
  message: string,
  details?: Pick<UnifiedConversationDiagnostic, "count" | "automationId" | "targetThreadId">,
): UnifiedConversationDiagnostic {
  return { source, code, message, ...details };
}

function dedupeDiagnostics(diagnostics: UnifiedConversationDiagnostic[]): UnifiedConversationDiagnostic[] {
  const known = new Map<string, UnifiedConversationDiagnostic>();
  for (const item of diagnostics) {
    const key = [item.code, item.automationId, item.targetThreadId].join(":");
    const previous = known.get(key);
    if (previous && !item.automationId) {
      previous.count = (previous.count ?? 1) + (item.count ?? 1);
    } else {
      known.set(key, structuredClone(item));
    }
  }
  return Array.from(known.values());
}

function automationState(automations: AutomationOverlay[]): UnifiedConversationSummary["automationState"] {
  if (automations.some((automation) => automation.status === "ACTIVE")) return "automation_active";
  if (automations.length > 0) return "automation_paused";
  return undefined;
}

function latest(...values: Array<string | undefined>): string {
  return latestOptional(...values) ?? new Date(0).toISOString();
}

function latestOptional(...values: Array<string | undefined>): string | undefined {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1);
}

function compareConversation(left: UnifiedConversationSummary, right: UnifiedConversationSummary): number {
  return right.updatedAt.localeCompare(left.updatedAt) || right.conversationId.localeCompare(left.conversationId);
}

function encodeCursor(conversation: UnifiedConversationSummary): string {
  return Buffer.from(JSON.stringify({ updatedAt: conversation.updatedAt, id: conversation.conversationId }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { updatedAt: string; id: string } {
  if (!/^[A-Za-z0-9_-]{8,1024}$/.test(cursor)) throw new Error("Invalid unified conversation cursor.");
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.updatedAt !== "string" || typeof parsed.id !== "string" || parsed.id.length > 256) throw new Error();
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch {
    throw new Error("Invalid unified conversation cursor.");
  }
}

function afterCursor(cursor: string | undefined): (conversation: UnifiedConversationSummary) => boolean {
  if (!cursor) return () => true;
  const decoded = decodeCursor(cursor);
  return (conversation) => conversation.updatedAt < decoded.updatedAt || (
    conversation.updatedAt === decoded.updatedAt && conversation.conversationId < decoded.id
  );
}

function boundedInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
