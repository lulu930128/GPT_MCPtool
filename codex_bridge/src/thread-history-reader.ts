import { createHash } from "node:crypto";
import type { AppServerTransport } from "./app-server-client.js";

export type ThreadHistoryMode = "legacy" | "paginated";

export interface ThreadMetadata {
  threadId: string;
  historyMode: ThreadHistoryMode;
  updatedAt?: number;
  recencyAt?: number;
  rawThread: Record<string, unknown>;
}

export interface ThreadHistorySnapshot {
  response: Record<string, unknown>;
  metadata: ThreadMetadata;
  pageCount: number;
  turnCount: number;
  sourceFingerprint: string;
}

export class ThreadHistoryError extends Error {
  constructor(
    readonly code:
      | "ThreadNotFound"
      | "ThreadMetadataReadFailed"
      | "PaginatedHistoryUnsupported"
      | "PaginationPageFailed"
      | "PaginationLoopDetected"
      | "HistoryChangedDuringRead"
      | "ConversationNormalizationFailed"
      | "HistoryLimitExceeded",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = code;
  }
}

export class ThreadHistoryReader {
  constructor(
    private readonly appServer: AppServerTransport,
    private readonly limits: { maxPages: number; maxTurns: number; pageSize: number } = {
      maxPages: 50,
      maxTurns: 5_000,
      pageSize: 100,
    },
  ) {}

  async readMetadata(threadId: string): Promise<ThreadMetadata> {
    let response: Record<string, unknown>;
    try {
      response = await this.appServer.request<Record<string, unknown>>("thread/read", {
        threadId,
        includeTurns: false,
      });
    } catch (error) {
      throw new ThreadHistoryError(
        "ThreadMetadataReadFailed",
        `Unable to read Codex thread metadata: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    const rawThread = isObject(response.thread) ? response.thread : undefined;
    if (!rawThread || stringValue(rawThread.id) !== threadId) {
      throw new ThreadHistoryError("ThreadNotFound", "Codex App Server did not return the requested thread metadata.");
    }
    const rawMode = stringValue(rawThread.historyMode) ?? "legacy";
    if (rawMode !== "legacy" && rawMode !== "paginated") {
      throw new ThreadHistoryError("ConversationNormalizationFailed", `Unsupported Codex history mode '${rawMode}'.`);
    }
    return {
      threadId,
      historyMode: rawMode,
      updatedAt: numberValue(rawThread.updatedAt),
      recencyAt: numberValue(rawThread.recencyAt),
      rawThread: structuredClone(rawThread),
    };
  }

  async freshnessFingerprint(metadata: ThreadMetadata): Promise<string> {
    const base = metadataFingerprintInput(metadata);
    if (metadata.historyMode === "legacy") {
      return digest(base);
    }
    try {
      const page = await this.appServer.request<Record<string, unknown>>("thread/turns/list", {
        threadId: metadata.threadId,
        limit: 1,
        sortDirection: "desc",
        itemsView: "full",
      });
      const turns = Array.isArray(page.data) ? page.data.filter(isObject) : [];
      return digest({ ...base, head: turns[0] ?? null });
    } catch (error) {
      throw new ThreadHistoryError(
        "PaginatedHistoryUnsupported",
        `Codex App Server cannot probe paginated thread history: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  async read(
    threadId: string,
    metadata?: ThreadMetadata,
    expectedFingerprint?: string,
  ): Promise<ThreadHistorySnapshot> {
    const resolved = metadata ?? await this.readMetadata(threadId);
    return resolved.historyMode === "paginated"
      ? this.readPaginated(resolved, expectedFingerprint)
      : this.readLegacy(resolved);
  }

  private async readLegacy(metadata: ThreadMetadata): Promise<ThreadHistorySnapshot> {
    let response: Record<string, unknown>;
    try {
      response = await this.appServer.request<Record<string, unknown>>("thread/read", {
        threadId: metadata.threadId,
        includeTurns: true,
      });
    } catch (error) {
      throw new ThreadHistoryError(
        "ThreadMetadataReadFailed",
        `Unable to read legacy Codex thread history: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    const rawThread = isObject(response.thread) ? response.thread : undefined;
    if (!rawThread || stringValue(rawThread.id) !== metadata.threadId || !Array.isArray(rawThread.turns)) {
      throw new ThreadHistoryError("ConversationNormalizationFailed", "Codex App Server returned malformed legacy thread history.");
    }
    const turns = rawThread.turns.filter(isObject);
    if (turns.length > this.limits.maxTurns) {
      throw new ThreadHistoryError("HistoryLimitExceeded", `Codex thread exceeds the ${this.limits.maxTurns} turn safety limit.`);
    }
    return {
      response,
      metadata: { ...metadata, rawThread: structuredClone(rawThread) },
      pageCount: 1,
      turnCount: turns.length,
      sourceFingerprint: digest({ ...metadataFingerprintInput(metadata), turns }),
    };
  }

  private async readPaginated(
    initialMetadata: ThreadMetadata,
    expectedFingerprint?: string,
  ): Promise<ThreadHistorySnapshot> {
    let metadata = initialMetadata;
    let beforeFingerprint = expectedFingerprint ?? await this.freshnessFingerprint(metadata);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const snapshot = await this.readPaginatedAttempt(metadata);
      const afterMetadata = await this.readMetadata(metadata.threadId);
      const afterFingerprint = await this.freshnessFingerprint(afterMetadata);
      if (beforeFingerprint === afterFingerprint) return snapshot;
      metadata = afterMetadata;
      beforeFingerprint = afterFingerprint;
    }
    throw new ThreadHistoryError(
      "HistoryChangedDuringRead",
      "Codex thread history changed while its paginated snapshot was being read.",
    );
  }

  private async readPaginatedAttempt(metadata: ThreadMetadata): Promise<ThreadHistorySnapshot> {
    const turns: Record<string, unknown>[] = [];
    const turnIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pageCount = 0;

    do {
      if (pageCount >= this.limits.maxPages) {
        throw new ThreadHistoryError("HistoryLimitExceeded", `Codex thread exceeds the ${this.limits.maxPages} page safety limit.`);
      }
      const remainingTurns = this.limits.maxTurns - turns.length;
      if (remainingTurns <= 0) {
        throw new ThreadHistoryError("HistoryLimitExceeded", `Codex thread exceeds the ${this.limits.maxTurns} turn safety limit.`);
      }
      let page: Record<string, unknown>;
      try {
        page = await this.appServer.request<Record<string, unknown>>("thread/turns/list", {
          threadId: metadata.threadId,
          limit: Math.min(this.limits.pageSize, remainingTurns),
          sortDirection: "asc",
          itemsView: "full",
          ...(cursor ? { cursor } : {}),
        });
      } catch (error) {
        throw new ThreadHistoryError(
          "PaginationPageFailed",
          `Unable to read paginated Codex thread history page ${pageCount + 1}: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      pageCount += 1;
      const data = Array.isArray(page.data) ? page.data : undefined;
      if (!data) {
        throw new ThreadHistoryError("ConversationNormalizationFailed", "Codex App Server returned a malformed history page.");
      }
      for (const value of data) {
        if (!isObject(value)) {
          throw new ThreadHistoryError("ConversationNormalizationFailed", "Codex App Server returned a malformed turn.");
        }
        const turnId = stringValue(value.id);
        if (!turnId || turnIds.has(turnId)) {
          throw new ThreadHistoryError("ConversationNormalizationFailed", "Codex App Server returned a missing or duplicate turn id.");
        }
        turnIds.add(turnId);
        turns.push(structuredClone(value));
        if (turns.length > this.limits.maxTurns) {
          throw new ThreadHistoryError("HistoryLimitExceeded", `Codex thread exceeds the ${this.limits.maxTurns} turn safety limit.`);
        }
      }
      const nextCursor = stringValue(page.nextCursor);
      if (!nextCursor) break;
      if (turns.length >= this.limits.maxTurns) {
        throw new ThreadHistoryError("HistoryLimitExceeded", `Codex thread exceeds the ${this.limits.maxTurns} turn safety limit.`);
      }
      if (seenCursors.has(nextCursor)) {
        throw new ThreadHistoryError("PaginationLoopDetected", "Codex App Server repeated a thread history cursor.");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);

    const thread = { ...structuredClone(metadata.rawThread), turns };
    return {
      response: { thread },
      metadata: { ...metadata, rawThread: thread },
      pageCount,
      turnCount: turns.length,
      sourceFingerprint: digest({ ...metadataFingerprintInput(metadata), turns }),
    };
  }
}

function metadataFingerprintInput(metadata: ThreadMetadata): Record<string, unknown> {
  return {
    threadId: metadata.threadId,
    historyMode: metadata.historyMode,
    updatedAt: metadata.updatedAt,
    recencyAt: metadata.recencyAt,
    status: metadata.rawThread.status,
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
