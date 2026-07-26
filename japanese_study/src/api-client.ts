import type { JapaneseStudyMcpConfig } from "./config.js";

export type StudyKind = "vocab" | "grammar" | "question";
export type ManualLabel = "known" | "unknown" | "uncertain" | "suspended";
export type AttemptResult = "seen" | "correct" | "wrong" | "easy" | "again";

export interface SearchItemsInput {
  query?: string;
  kind?: StudyKind;
  jlptLevel?: string;
  limit?: number;
}

export interface SetManualLabelInput {
  itemId: string;
  label: ManualLabel;
  note?: string;
  source?: string;
}

export interface RecordAttemptInput {
  eventId: string;
  itemId: string;
  result: AttemptResult;
  occurredAt?: string;
  sessionId?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export class HubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HubApiError";
  }
}

export class JapaneseStudyHubClient {
  constructor(private readonly config: Pick<JapaneseStudyMcpConfig, "hubBaseUrl" | "hubApiToken" | "hubTimeoutMs">) {}

  summary(): Promise<unknown> {
    return this.request("/api/v1/summary");
  }

  searchItems(input: SearchItemsInput): Promise<unknown> {
    const query = new URLSearchParams();
    if (input.query) query.set("query", input.query);
    if (input.kind) query.set("kind", input.kind);
    if (input.jlptLevel) query.set("jlpt_level", input.jlptLevel);
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    const suffix = query.size ? `?${query.toString()}` : "";
    return this.request(`/api/v1/items${suffix}`);
  }

  getItem(itemId: string): Promise<unknown> {
    return this.request(`/api/v1/items/${encodeURIComponent(itemId)}`);
  }

  studyPlan(input: { kind?: StudyKind; limit?: number }): Promise<unknown> {
    const query = new URLSearchParams();
    if (input.kind) query.set("kind", input.kind);
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    const suffix = query.size ? `?${query.toString()}` : "";
    return this.request(`/api/v1/study/plan${suffix}`);
  }

  setManualLabels(labels: SetManualLabelInput[]): Promise<unknown> {
    return this.request("/api/v1/mastery/labels", {
      method: "POST",
      body: JSON.stringify({
        labels: labels.map((entry) => ({
          item_id: entry.itemId,
          label: entry.label,
          note: entry.note || "",
          source: entry.source || "chatgpt_mcp",
        })),
      }),
    });
  }

  recordAttempt(input: RecordAttemptInput): Promise<unknown> {
    return this.request("/api/v1/attempts", {
      method: "POST",
      body: JSON.stringify({
        event_id: input.eventId,
        item_id: input.itemId,
        result: input.result,
        occurred_at: input.occurredAt,
        session_id: input.sessionId || "",
        source: input.source || "chatgpt_mcp",
        metadata: input.metadata || {},
      }),
    });
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.hubTimeoutMs);
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    if (this.config.hubApiToken) {
      headers.set("authorization", `Bearer ${this.config.hubApiToken}`);
    }

    try {
      const response = await fetch(`${this.config.hubBaseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: unknown = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { raw: text.slice(0, 500) };
        }
      }
      if (!response.ok) {
        throw new HubApiError(`Japanese Study Hub returned HTTP ${response.status}.`, response.status, payload);
      }
      return payload;
    } catch (error) {
      if (error instanceof HubApiError) {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new HubApiError("Japanese Study Hub request timed out.", 504);
      }
      throw new HubApiError(
        `Japanese Study Hub is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        503,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
