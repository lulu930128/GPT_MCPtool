import { isRecord, type UnknownRecord } from "./state";

export type Candidate = UnknownRecord & { id: string; revision: number; raw: UnknownRecord; owner_id: string };
export type Pending = UnknownRecord & { id: string; revision: number; candidate_id: string };
export type CandidateBridge = { callTool(name: string, args: UnknownRecord, signal?: AbortSignal): Promise<unknown> };
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export const json = (value: unknown) => JSON.stringify(value, null, 2);

export function newCandidate(symbol = ""): UnknownRecord {
  return { symbol, space_id: "USER_SPACE", source: "MANUAL", direction: "long", action: "Buy",
    condition: "CASH", lot: "Odd", quantity: 1, price_basis: "explicit", proposed_limit: null,
    valid_from_date: null, valid_until_date: null, hold_overnight: true, conditions: null };
}

export function candidateExample(short = false): UnknownRecord {
  if (short) return { ...newCandidate("3481"), direction: "short", action: "Sell", condition: "SHORT_SELLING",
    lot: "Common", quantity: 1000, conditions: null,
    reference_notes: { price_assumption: "upper", borrow: "UNKNOWN", note: "未提供真實漲停價與觸發條件；須自行填寫。" } };
  return { ...newCandidate("2330"),
    conditions: { kind: "AND", clauses: [
      { kind: "compare", metric: { kind: "price", field: "last_trade", timeframe: "snapshot", completed: true, parameters: [] }, operator: "<", value: 2180 },
      { kind: "compare", metric: { kind: "rsi", field: "value", timeframe: "1d", completed: true, parameters: [14] }, operator: "<=", value: 1 },
      { kind: "compare", metric: { kind: "macd", field: "histogram", timeframe: "1d", completed: true, parameters: [12, 26, 9] }, operator: ">=", value: 9999 },
    ] } };
}

export class CallError extends Error {
  constructor(text: string, public uncertain = true, public httpStatus?: number,
    public backendError?: unknown, public tool?: string) { super(text); }
}

export function toolValue(result: unknown): unknown {
  let data = result;
  if (isRecord(result)) {
    if (isRecord(result.structuredContent)) data = result.structuredContent;
    else if (Array.isArray(result.content)) {
      const item = result.content.find((part) => isRecord(part) && part.type === "text");
      if (isRecord(item) && typeof item.text === "string") {
        try { data = JSON.parse(item.text); } catch { throw new CallError("MCP 回傳無法解析"); }
      }
    }
    if (result.isError === true) {
      const text = isRecord(data) && typeof data.error === "string" ? data.error : json(data);
      const status = isRecord(data) && Number.isInteger(data.http_status) ? Number(data.http_status) : undefined;
      throw new CallError(text, status === undefined ? !/OMI API HTTP 4\d\d:/.test(text) : status < 400 || status >= 500,
        status, isRecord(data) ? data.backend_error : undefined, isRecord(data) && typeof data.tool === "string" ? data.tool : undefined);
    }
  }
  return isRecord(data) && Object.keys(data).length === 1 && "result" in data ? data.result : data;
}

function candidate(value: unknown): Candidate {
  if (!isRecord(value) || typeof value.id !== "string" || !Number.isInteger(value.revision)
    || Number(value.revision) < 1 || !isRecord(value.raw) || typeof value.owner_id !== "string") throw new CallError("候選回傳格式不符");
  return value as Candidate;
}
function pending(value: unknown): Pending {
  if (!isRecord(value) || typeof value.id !== "string" || !Number.isInteger(value.revision)
    || Number(value.revision) < 1 || typeof value.candidate_id !== "string") throw new CallError("Pending 回傳格式不符");
  return value as Pending;
}
const array = (value: unknown): unknown[] => { if (!Array.isArray(value)) throw new CallError("清單回傳格式不符"); return value; };

export type CandidateState = {
  rows: Candidate[] | null; detail: Candidate | null; pending: Pending[] | null; history: unknown[] | null;
  monitor: UnknownRecord | null; errors: Record<string, string>; draft: UnknownRecord; owner: string;
  baseRevision: number | null; dirty: boolean; busy: boolean; reading: boolean; selecting: boolean; uncertain: boolean;
  readback: boolean; uncertainPending: string | null; notice: string; hasMore: boolean;
  view: "list" | "detail" | "edit" | "new"; scopeSymbol: string; requestedSymbol: string;
  pendingSymbol: string | null; showAll: boolean; pendingDirty: boolean;
};

export const visibleCandidates = (state: CandidateState, space?: string): Candidate[] =>
  (state.rows ?? []).filter((row) => (!space || row.raw.space_id === space) && (state.showAll || !state.scopeSymbol || row.raw.symbol === state.scopeSymbol));

/** UI request state only; all domain transitions and persistence belong to Backend. */
export class CandidateSession {
  state: CandidateState;
  private listeners = new Set<(state: CandidateState) => void>();
  private selection = 0;
  private readSequence = 0;
  private pendingDrafts = new Set<string>();
  constructor(private bridge: CandidateBridge, symbol?: string) {
    this.state = { rows: null, detail: null, pending: null, history: null, monitor: null, errors: {},
      draft: newCandidate(symbol), owner: "MCP", baseRevision: null, dirty: false, busy: false, reading: false, selecting: false,
      uncertain: false, readback: false, uncertainPending: null, notice: "", hasMore: false,
      view: "list", scopeSymbol: symbol ?? "", requestedSymbol: symbol ?? "", pendingSymbol: null, showAll: false, pendingDirty: false };
  }
  subscribe(listener: (state: CandidateState) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private update(patch: Partial<CandidateState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach((fn) => fn(this.state)); }
  private async call(name: string, args: UnknownRecord = {}) { return toolValue(await this.bridge.callTool(name, args)); }
  edit(raw: UnknownRecord) { if (!this.state.busy) this.update({ draft: clone(raw), dirty: true }); }
  owner(_value: string) { /* Creation provenance is fixed MCP; persisted legacy ownership is retained. */ }
  syncSymbol(symbol = "") {
    if (symbol === this.state.scopeSymbol) {
      if (this.state.requestedSymbol !== symbol || this.state.pendingSymbol !== null) this.update({ requestedSymbol: symbol, pendingSymbol: null });
      return;
    }
    if (this.state.dirty || this.state.pendingDirty || this.state.busy || this.state.selecting || this.state.uncertain) {
      if (this.state.pendingSymbol !== symbol || this.state.requestedSymbol !== symbol) this.update({ requestedSymbol: symbol, pendingSymbol: symbol });
      return;
    }
    this.applySymbol(symbol);
  }
  private applySymbol(symbol: string) {
    this.selection++; this.readSequence++; this.pendingDrafts.clear();
    this.update({ scopeSymbol: symbol, requestedSymbol: symbol, pendingSymbol: null, showAll: false,
      view: "list", detail: null, pending: null, history: null, baseRevision: null, draft: newCandidate(symbol),
      dirty: false, pendingDirty: false, reading: false, selecting: false, notice: "", errors: {} });
  }
  keepEditing() { this.update({ pendingSymbol: null }); }
  discardAndSwitch() {
    if (this.state.uncertain || this.state.busy || this.state.selecting || this.state.pendingSymbol === null) return;
    this.applySymbol(this.state.pendingSymbol);
  }
  setShowAll(value: boolean) { this.update({ showAll: value }); }
  setPendingDirty(id: string, value: boolean) {
    if (value) this.pendingDrafts.add(id); else this.pendingDrafts.delete(id);
    if (this.state.pendingDirty !== (this.pendingDrafts.size > 0)) this.update({ pendingDirty: this.pendingDrafts.size > 0 });
  }
  beginEdit() {
    if (!this.state.detail || this.state.busy || this.state.selecting || this.state.uncertain || this.state.pendingDirty) return;
    this.update({ view: "edit", draft: clone(this.state.detail.raw), owner: this.state.detail.owner_id,
      baseRevision: this.state.detail.revision, dirty: false, notice: "" });
  }
  backToList(discard = false): boolean {
    if (this.state.busy || this.state.selecting || this.state.uncertain || (!discard && (this.state.dirty || this.state.pendingDirty))) return false;
    const showAll = this.state.showAll;
    const symbolChanged = this.state.scopeSymbol !== this.state.requestedSymbol;
    this.applySymbol(this.state.requestedSymbol);
    if (!symbolChanged) this.update({ showAll });
    return true;
  }
  start(symbol?: string, example?: boolean) {
    if (this.state.busy || this.state.selecting || this.state.uncertain || this.state.dirty || this.state.pendingDirty) return;
    this.selection++;
    this.update({ view: "new", detail: null, pending: null, history: null, draft: example === undefined ? newCandidate(symbol ?? this.state.scopeSymbol) : candidateExample(example),
      owner: "MCP", baseRevision: null, dirty: example !== undefined, notice: "", errors: {} });
  }
  discard() {
    if (this.state.busy || this.state.uncertain) return;
    if (!this.state.detail) {
      this.update({ draft: newCandidate(this.state.scopeSymbol), dirty: false, notice: "已放棄未保存的候選草稿。" }); return;
    }
    this.adopt();
  }
  adopt() {
    if (this.state.busy || this.state.uncertainPending || (this.state.uncertain && (!this.state.readback || !this.state.detail))) return;
    const detail = this.state.detail;
    this.update({ draft: detail ? clone(detail.raw) : this.state.draft, owner: detail?.owner_id ?? this.state.owner,
      baseRevision: detail?.revision ?? null, dirty: false, uncertain: false, readback: false,
      notice: detail ? "已使用讀回版本；請檢查內容後再編輯。" : "已核對清單；草稿保留，尚未再次建立。" });
  }
  acknowledgePendingReadback() {
    if (this.state.busy || !this.state.uncertainPending || !this.state.readback) return;
    this.update({ uncertain: false, uncertainPending: null, readback: false,
      notice: "已核對 Pending 讀回資料；候選草稿保留。Pending 編輯仍須使用正確版號。" });
  }
  rebuildAfterUnknownCreate() {
    if (this.state.busy || !this.state.uncertain || !this.state.readback || this.state.detail) return;
    this.selection++;
    this.update({ view: "new", draft: newCandidate(this.state.scopeSymbol), baseRevision: null, dirty: false, uncertain: false, readback: false,
      notice: "前次建立結果仍未知；已放下原草稿，開始新的空白草稿。請勿把重建視為前次未保存。" });
  }
  async viewAfterUnknownCreate(id: string) {
    if (this.state.busy || !this.state.uncertain || !this.state.readback || this.state.detail) return;
    this.update({ selecting: true });
    try {
      const detail = candidate(await this.call("omi_read_candidate", { id }));
      if (detail.id !== id) throw new CallError("候選識別碼不符");
      this.selection++;
      this.update({ view: "detail", detail, draft: clone(detail.raw), owner: detail.owner_id, baseRevision: detail.revision,
        pending: null, history: null, dirty: false, uncertain: false, readback: false,
        notice: "已明確選擇查看此記錄；未推斷它屬於前次建立。" });
      await this.refresh();
    } catch (error) { this.update({ notice: `讀取失敗；前次建立結果仍未知。${message(error)}` }); }
    finally { this.update({ selecting: false }); }
  }
  async select(id: string) {
    if (this.state.dirty || this.state.pendingDirty || this.state.busy || this.state.selecting || this.state.uncertain) return;
    const token = ++this.selection;
    this.update({ selecting: true, notice: "讀取候選中…" });
    try {
      const detail = candidate(await this.call("omi_read_candidate", { id }));
      if (token !== this.selection) return;
      if (detail.id !== id) throw new CallError("候選識別碼不符");
      this.update({ view: "detail", detail, draft: clone(detail.raw), owner: detail.owner_id, baseRevision: detail.revision,
        pending: null, history: null, dirty: false, notice: "" });
      await this.refresh();
    } catch (error) { if (token === this.selection) this.update({ errors: { ...this.state.errors, selection: message(error) } }); }
    finally { if (token === this.selection) this.update({ selecting: false }); }
  }
  async refresh(more = false) {
    const seq = ++this.readSequence, token = this.selection, id = this.state.detail?.id;
    this.update({ reading: true });
    const tasks: [string, () => Promise<unknown>][] = [
      ["rows", () => this.call("omi_list_candidates", more && this.state.rows?.length ? { after: this.state.rows.at(-1)!.id, limit: 100 } : { limit: 100 })],
      ["monitor", () => this.call("omi_read_candidate_monitor_status")],
      ...(id ? [
        ["detail", () => this.call("omi_read_candidate", { id })],
        ["pending", () => this.call("omi_read_candidate_pending", { id })],
        ["history", () => this.call("omi_read_candidate_revisions", { id })],
      ] as [string, () => Promise<unknown>][] : []),
    ];
    const values = await Promise.allSettled(tasks.map(async ([key, fn]) => {
      const value = await fn();
      if (key === "rows") return array(value).map(candidate);
      if (key === "pending") {
        const items = array(value).map(pending);
        if (items.some((item) => item.candidate_id !== id)) throw new CallError("Pending 所屬候選不符");
        return items;
      }
      if (key === "history") return array(value);
      if (key === "detail") { const item = candidate(value); if (item.id !== id) throw new CallError("候選識別碼不符"); return item; }
      if (!isRecord(value)) throw new CallError("Monitor 回傳格式不符");
      return value;
    }));
    if (seq !== this.readSequence || token !== this.selection) return;
    const patch: Partial<CandidateState> = { reading: false, errors: { ...this.state.errors } };
    values.forEach((result, index) => {
      const key = tasks[index][0];
      if (result.status === "rejected") { patch.errors![key] = message(result.reason); return; }
      delete patch.errors![key];
      Object.assign(patch, { [key]: result.value });
      if (key === "rows") {
        const rows = result.value as Candidate[];
        patch.rows = more ? [...new Map([...(this.state.rows ?? []), ...rows].map((row) => [row.id, row])).values()] : rows;
        patch.hasMore = rows.length === 100;
      }
      if (key === "detail" && !this.state.dirty && !this.state.busy && !this.state.uncertain) {
        const detail = result.value as Candidate;
        patch.draft = clone(detail.raw); patch.baseRevision = detail.revision; patch.owner = detail.owner_id;
      }
    });
    if (this.state.uncertain) patch.readback = this.state.uncertainPending
      ? !patch.errors!.pending && !!(patch.pending ?? this.state.pending)?.some((item) => item.id === this.state.uncertainPending)
      : !patch.errors![id ? "detail" : "rows"];
    this.update(patch);
  }
  async save() {
    const { detail, baseRevision, draft } = this.state;
    await this.mutate(detail ? "omi_revise_candidate" : "omi_create_candidate", detail
      ? { id: detail.id, expected_revision: baseRevision, raw: clone(draft) }
      : { owner_id: "MCP", raw: clone(draft) }, true);
  }
  async action(operation: "pause" | "resume" | "cancel") {
    if (this.state.dirty || this.state.pendingDirty || !this.state.detail) return;
    await this.mutate(`omi_${operation}_candidate`, { id: this.state.detail.id, expected_revision: this.state.baseRevision }, true);
  }
  async changePending(item: Pending, price?: string, quantity?: number) {
    return this.mutate(price === undefined ? "omi_cancel_candidate_pending" : "omi_revise_candidate_pending",
      { id: item.id, expected_revision: item.revision, ...(price === undefined ? {} : { price, quantity }) }, false);
  }
  private async mutate(name: string, args: UnknownRecord, updatesCandidate: boolean) {
    if (this.state.busy || this.state.selecting || this.state.uncertain) return false;
    let saved = false;
    this.readSequence++; // In-flight reads cannot replace post-mutation evidence.
    this.update({ busy: true, reading: false, notice: "保存中…", readback: false, uncertainPending: null });
    try {
      const value = await this.call(name, args);
      if (updatesCandidate) {
        const detail = candidate(value);
        if (args.id !== undefined && detail.id !== args.id) throw new CallError("候選識別碼不符；請讀回核對");
        this.selection++;
        this.update({ view: "detail", detail, draft: clone(detail.raw), owner: detail.owner_id, baseRevision: detail.revision,
          dirty: false, pending: null, history: null });
      } else {
        const item = pending(value);
        if (item.id !== args.id) throw new CallError("Pending 識別碼不符；請讀回核對");
      }
      const invalid = updatesCandidate && Array.isArray(this.state.detail?.validation_reasons) && this.state.detail!.validation_reasons.length > 0;
      this.update({ notice: invalid ? "Backend 已保留未生效的研究草稿；請查看 validation reasons，不能視為 USER_SPACE 可送候選。" : "Backend 已保存；尚未送單。" });
      saved = true;
    } catch (error) {
      const uncertain = !(error instanceof CallError) || error.uncertain;
      this.update({ uncertain, uncertainPending: uncertain && !updatesCandidate ? String(args.id) : null, readback: false,
        notice: `${message(error)}${uncertain ? "\n寫入結果未知；不會自動重送。請核對讀回版本／清單。" : "\n未保存；保留草稿。請核對讀回版號。"}` });
    } finally { this.update({ busy: false }); await this.refresh(); }
    return saved;
  }
}
