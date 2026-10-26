import { isRecord, type UnknownRecord } from "./state";

export type PaneState = {
  data: UnknownRecord | null;
  dataKey: string | null;
  loading: boolean;
  error: string | null;
};

export function readToolData(response: unknown, kind: string): UnknownRecord {
  if (isRecord(response) && response.isError === true) {
    const content = Array.isArray(response.content) ? response.content : [];
    const message = content.find((item) => isRecord(item) && typeof item.text === "string");
    throw new Error(isRecord(message) ? String(message.text) : "工具讀取失敗");
  }
  const value = isRecord(response) && "structuredContent" in response ? response.structuredContent : response;
  const validVersion = isRecord(value) && (value.version === `${kind}.v1`
    || (kind === "omi.tw_stock_research" && value.version === "omi.tw_stock_research.workspace.v1"));
  if (!isRecord(value) || value.kind !== kind || !validVersion) {
    throw new Error("資料格式不符；服務可能尚未採用 workspace contract");
  }
  return value;
}

// One owner per pane. Requests retain the prior result while pending, and an
// invalidated generation cannot publish data, errors, or completion state.
export class PaneLoader {
  state: PaneState = { data: null, dataKey: null, loading: false, error: null };
  private generation = 0;
  private controller: AbortController | null = null;

  constructor(private publish: (state: PaneState) => void) {}

  cancel(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
  }

  async load(key: string, read: (signal: AbortSignal) => Promise<UnknownRecord>): Promise<void> {
    this.cancel();
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.set({ ...this.state, loading: true, error: null });
    try {
      const data = await read(controller.signal);
      if (generation !== this.generation) return;
      this.set({ data, dataKey: key, loading: false, error: null });
    } catch (error) {
      if (generation !== this.generation) return;
      this.set({ ...this.state, loading: false, error: error instanceof Error ? error.message : "讀取失敗" });
    }
  }

  private set(state: PaneState): void {
    this.state = state;
    this.publish(state);
  }
}

export type WorkspaceSelection = { stock_id?: string; timeframe?: "today" | "daily" | "weekly" | "monthly"; watchlist_group_id?: number };

export function initialSelection(value: unknown): WorkspaceSelection {
  const data = isRecord(value) && "structuredContent" in value ? value.structuredContent : value;
  if (!isRecord(data)) return {};
  return {
    ...(typeof data.stock_id === "string" && data.stock_id ? { stock_id: data.stock_id } : {}),
    ...(["today", "daily", "weekly", "monthly"].includes(String(data.timeframe)) ? { timeframe: data.timeframe as WorkspaceSelection["timeframe"] } : {}),
    ...(typeof data.watchlist_group_id === "number" && Number.isInteger(data.watchlist_group_id) && data.watchlist_group_id > 0 ? { watchlist_group_id: data.watchlist_group_id } : {}),
  };
}
