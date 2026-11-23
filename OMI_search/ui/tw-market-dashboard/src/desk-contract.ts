import { isRecord, type UnknownRecord } from "./state";
import { CallError, toolValue, type CandidateBridge } from "./candidate-state";

export type DeskSelection = {
  kind: "review" | "pending" | "staged"; id: string; revision: number; digest: string;
  snapshot: UnknownRecord; command: UnknownRecord; owner: string; source: string;
  conditions?: unknown;
};
const record = (value: unknown): UnknownRecord => isRecord(value) ? value : {};
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const decimal = (value: unknown): boolean => (typeof value === "string" || typeof value === "number") && /^\d+(?:\.\d+)?$/.test(String(value)) && Number.isFinite(Number(value)) && Number(value) > 0;
const decimalText = (value: unknown) => String(value).replace(/^0+(?=\d)/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
export const deskCall = async (bridge: CandidateBridge, name: string, args: UnknownRecord = {}, signal?: AbortSignal) =>
  toolValue(await (signal ? bridge.callTool(name, args, signal) : bridge.callTool(name, args)));
export const deskError = (error: unknown) => `${error instanceof Error ? error.message : String(error)}${/HTTP 404|HTTP 405|Method not found|Unknown tool|尚未接線/.test(String(error)) ? " · API 契約待接（尚未接線）" : ""}`;
export const definitiveRejection = (error: unknown) => /OMI API HTTP (400|404|405|422):/.test(String(error));

export function deskOrderRead(value: unknown, id: string, market: string): UnknownRecord {
  const data = record(value), execution = record(data.execution);
  if (data.market !== market || execution.execution_id !== id || typeof execution.state !== "string")
    throw Error("券商回應與此筆委託身分或市場不符，請重新讀回。");
  const protection = record(data.protection);
  if (data.protection != null && (protection.entry_execution_id !== id || typeof protection.strategy_id !== "string"
    || !Number.isSafeInteger(protection.strategy_revision) || !isRecord(protection.rules)))
    throw Error("此單保護設定的身分／版本尚未確認。");
  return data;
}

export function protectionRequestObserved(data: UnknownRecord, request: UnknownRecord): boolean {
  const protection = record(data.protection);
  return protection.strategy_id === request.strategy_id && Number(protection.strategy_revision) > Number(request.expected_revision)
    && Array.isArray(protection.audit) && protection.audit.some(value => {
      const event = record(value), payload = record(event.payload);
      return event.kind === "STRATEGY_REVISED" && payload.request_id === request.request_id
        && payload.strategy_id === request.strategy_id && payload.strategy_revision === Number(request.expected_revision) + 1;
    });
}

export function deskReviews(value: unknown): UnknownRecord[] {
  const data = record(value);
  if (!Array.isArray(data.reviews) || data.reviews.some(row => !isRecord(row) || typeof row.review_id !== "string")) throw Error("掛單 API 未提供 Native reviews；不能推定沒有掛單");
  return data.reviews as UnknownRecord[];
}

export function brokerReadback(value: unknown, kind: "orders" | "fills" | "inventory"): UnknownRecord {
  const data = record(value);
  if (data.contract !== "omi.execution-desk.v1" || typeof data.trade_date !== "string" || typeof data.quality !== "string") throw Error("Broker readback 契約／交易日／品質未確認");
  if (kind === "orders" && (!Array.isArray(data.reviews) || !Array.isArray(data.broker_orders))) throw Error("掛單讀回缺少 reviews／broker_orders");
  if (kind === "fills" && (!Array.isArray(data.fills) || typeof data.fill_history_complete !== "boolean" || !Array.isArray(data.sources) || !Array.isArray(data.unparsed_reports))) throw Error("成交讀回缺少 fills／完整性／來源");
  if (kind === "inventory") {
    const inventory = record(data.inventory);
    for (const part of ["cash", "margin", "short_selling"]) {
      const row = record(inventory[part]);
      if (typeof row.quality !== "string" || !(row.items === null || Array.isArray(row.items)) || typeof row.complete !== "boolean") throw Error(`庫存 ${part} 契約未確認`);
    }
  }
  for (const key of kind === "orders" ? ["reviews", "broker_orders"] : kind === "fills" ? ["fills"] : []) {
    if ((data[key] as unknown[]).some(row => !isRecord(row))) throw Error(`Broker ${key} 含無法辨識記錄`);
  }
  return data;
}

export function reviewSelection(value: unknown): DeskSelection {
  const review = record(value), snapshot = record(review.snapshot), draft = record(snapshot.draft), command = record(draft.command);
  if (Array.isArray(review.execution_audit) && review.execution_audit.some(item => record(item).kind === "CANDIDATE_REVIEW_BOUND")) throw Error("條件 Review 必須從原 Pending prepare/approve 路徑送出");
  if (typeof review.review_id !== "string" || !positive(review.review_revision) || snapshot.review_id !== review.review_id
    || snapshot.review_revision !== review.review_revision || typeof snapshot.digest !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.digest)
    || typeof command.symbol !== "string" || typeof command.trade_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(command.trade_date)
    || !positive(command.quantity) || !decimal(command.price) || !["Buy", "Sell"].includes(String(command.action))
    || !["CASH", "CASH_SELLING", "MARGIN", "SHORT_SELLING"].includes(String(command.condition)) || !["Common", "Odd"].includes(String(command.lot))
    || command.space_id !== "USER_SPACE" || draft.owner_id !== "MCP" || draft.source !== "MANUAL") throw Error("Native 快照缺少或不符合 USER_SPACE / MANUAL / MCP 的價量、日期、版本與 digest；不可送出");
  return { kind: "review", id: review.review_id, revision: review.review_revision, digest: snapshot.digest, snapshot, command, owner: draft.owner_id, source: draft.source };
}

export function pendingSelection(value: unknown, candidate: UnknownRecord): DeskSelection {
  const pending = record(value), raw = record(candidate.raw), preparation = record(pending.preparation), draft = record(preparation.draft), command = record(draft.command), native = record(pending.native);
  if (pending.state !== "NATIVE_PREVIEW" || typeof pending.id !== "string" || !positive(pending.revision)
    || typeof pending.digest !== "string" || !/^[a-f0-9]{64}$/.test(pending.digest) || pending.candidate_id !== candidate.id
    || pending.candidate_revision !== candidate.revision || raw.space_id !== "USER_SPACE" || raw.source !== "MANUAL" || candidate.owner_id !== "MCP"
    || command.space_id !== "USER_SPACE" || draft.source !== "MANUAL" || draft.owner_id !== "MCP"
    || typeof native.review_id !== "string" || !positive(native.review_revision) || typeof native.digest !== "string" || !/^[a-f0-9]{64}$/.test(native.digest)
    || typeof command.trade_date !== "string" || command.symbol !== raw.symbol || command.price !== pending.price || command.quantity !== pending.quantity
    || !positive(command.quantity) || !decimal(command.price)) throw Error("Pending 尚無符合 USER_SPACE 的 Native 待送快照；舊 AGENT preparation 不能冒充手動倉");
  return { kind: "pending", id: pending.id, revision: pending.revision, digest: pending.digest, snapshot: pending, command, owner: "MCP", source: "MANUAL", conditions: raw.conditions };
}

export async function confirmDeskSelection(bridge: CandidateBridge, selection: DeskSelection) {
  if (selection.kind === "staged") stageSelection(selection.snapshot);
  return deskCall(bridge, selection.kind === "staged" ? "omi_confirm_desk_staged" : selection.kind === "review" ? "omi_confirm_desk_review" : "omi_approve_candidate_pending",
    { id: selection.id, expected_revision: selection.revision, expected_digest: selection.digest });
}

// Wire receipt validation only. No inference from HTTP status, error text or a
// STAGED snapshot. This must be called on the error from this exact await.
export function stageNotAttempted(error: unknown, pin: DeskSelection): boolean {
  if (pin.kind !== "staged" || !(error instanceof CallError) || error.httpStatus !== 503
    || error.tool !== "omi_confirm_desk_staged") return false;
  const body = record(error.backendError);
  const envelope = record(body.error), detail = record(envelope.detail);
  const attempt = record(detail.submission_attempt);
  return typeof envelope.code === "string" && !!envelope.code && typeof envelope.request_id === "string" && !!envelope.request_id
    && detail.retry_policy === "EXPLICIT_RETRY_SAME_STAGE"
    && attempt.contract === "omi.execution.submission-attempt.v1" && attempt.outcome === "NOT_ATTEMPTED"
    && attempt.phase === "READINESS" && attempt.native_command_started === false
    && attempt.candidate_id === pin.id && attempt.candidate_revision === pin.revision && attempt.candidate_digest === pin.digest;
}

export function sameStagedSelection(value: unknown, pin: DeskSelection): UnknownRecord {
  const row = stageRecord(value, record(pin.snapshot.raw));
  const current = stageSelection(row);
  if (row.state !== "ACTIVE" || current.id !== pin.id || current.revision !== pin.revision || current.digest !== pin.digest)
    throw Error("未送出回執之掛單讀回已變更；保留鎖定，只讀回");
  return row;
}

export function deskConnection(value: unknown): UnknownRecord {
  const connection = record(record(value).connection);
  if (connection.contract !== "omi.execution.connection.v1" || connection.market !== "TW" || connection.timezone !== "Asia/Taipei"
    || !["ONLINE", "OFFLINE"].includes(String(connection.desired))
    || !["STARTING", "CONNECTING", "ONLINE", "RECOVERING", "BACKOFF", "BLOCKED", "STOPPING", "OFFLINE"].includes(String(connection.actual))
    || ["session_bound", "date_ready", "ready", "disconnect_observed", "disconnect_callback_registered"].some(key => typeof connection[key] !== "boolean")
    || !Number.isSafeInteger(connection.session_generation) || typeof connection.trade_date !== "string"
    || !(connection.busy === null || (isRecord(connection.busy) && typeof connection.busy.operation === "string" && typeof connection.busy.started_at === "string"))
    || !(connection.last_error === null || typeof connection.last_error === "string")
    || !(connection.last_broker_read === null || (isRecord(connection.last_broker_read) && typeof connection.last_broker_read.status === "string"
      && typeof connection.last_broker_read.observed_at === "string" && Number.isSafeInteger(connection.last_broker_read.session_generation) && Array.isArray(connection.last_broker_read.sources))))
    throw Error("連線狀態缺少 connection v1 欄位；無法確認券商連線");
  return connection;
}

function wireEqual(a: unknown, b: unknown): boolean {
  if (isRecord(a) && isRecord(b)) return Object.keys(b).every(key => wireEqual(a[key], b[key]));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && b.every((value, i) => wireEqual(a[i], value));
  return a === b;
}

// ManualStageOrder's JSON codec omits TW/MUT and emits nested Decimal values
// as strings. Compare that codec semantically, without relaxing identity or
// using floating-point rounding. These defaults mirror the backend model;
// generated backend receipt fixtures guard parity.
function decimalKey(value: unknown): unknown {
  if (typeof value !== "string" && typeof value !== "number") return value;
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(String(value));
  if (!match) return value;
  let digits = (match[1] + (match[2] ?? "")).replace(/^0+/, "");
  let exponent = Number(match[3] ?? 0) - (match[2]?.length ?? 0);
  if (!Number.isSafeInteger(exponent)) return value;
  if (!digits) return "0e0";
  while (digits.endsWith("0")) { digits = digits.slice(0, -1); exponent++; }
  return `${digits}e${exponent}`;
}

export function stageIntent(value: UnknownRecord): UnknownRecord {
  const result: UnknownRecord = { market: "TW", settlement_mode: "MUT", protection: null, research_proposal: null, ...value };
  result.price = decimalKey(result.price);
  if (isRecord(result.protection)) {
    const protection: UnknownRecord = { enabled: true, stop_loss: null, take_profit: null, direction: 1,
      targets: [], stop_limit_price: null, protection_mode: "LOCAL_SYNTHETIC", ...result.protection };
    for (const key of ["stop_loss", "take_profit", "exit_limit_price", "stop_limit_price"]) protection[key] = decimalKey(protection[key]);
    if (Array.isArray(protection.targets)) protection.targets = protection.targets.map(target => isRecord(target)
      ? { ...target, price: decimalKey(target.price), fraction: decimalKey(target.fraction), limit_price: decimalKey(target.limit_price) } : target);
    result.protection = protection;
  }
  return result;
}

export function stageRecord(value: unknown, expected?: UnknownRecord): UnknownRecord {
  const row = record(value), raw = record(row.raw), stage = record(row.manual_stage);
  if (row.kind !== "manual_stage" || row.owner_id !== "MCP" || typeof row.id !== "string" || !row.id
    || !positive(row.revision) || typeof row.digest !== "string" || !/^[a-f0-9]{64}$/.test(row.digest)
    || stage.space_id !== "USER_SPACE" || stage.source !== "MANUAL" || typeof stage.state !== "string"
    || typeof stage.original_digest !== "string" || !/^[a-f0-9]{64}$/.test(stage.original_digest)
    || typeof raw.client_intent_id !== "string" || stage.client_intent_id !== raw.client_intent_id
    || typeof raw.symbol !== "string" || !positive(raw.quantity_shares) || !decimal(raw.price)
    || !["Buy", "Sell"].includes(String(raw.action)) || !["Common", "Odd", "Shares"].includes(String(raw.lot))
    || !["CASH", "CASH_SELLING", "MARGIN", "SHORT_SELLING"].includes(String(raw.condition))
    || typeof row.lifecycle !== "string" || !("submission" in stage)) throw Error("本地待送單身份／版本／USER_SPACE / MANUAL / MCP 契約不符；結果仍 UNKNOWN");
  if (expected && !wireEqual(stageIntent(raw), stageIntent(expected))) throw Error("本地待送單與原意圖價量／身份不符；結果仍 UNKNOWN");
  return row;
}

// Only the Backend determines the exchange session. A cached decision cannot
// outlive its absolute Backend deadline while a modal or tab stays open.
export function currentStageDecision(row: UnknownRecord, now = Date.now()): boolean {
  const validity = record(row.stage_validity);
  const instant = (value: unknown) => typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
  const day = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  return validity.state === "CURRENT" && day(validity.decision_date) && day(validity.market_date)
    && (validity.reason === "STAGE_ENTRY_WINDOW" || (validity.reason === "STAGE_SAME_TRADING_DAY" && validity.decision_date === validity.market_date))
    && instant(validity.created_at) <= now && now < instant(validity.expires_at);
}

export function stageSelection(value: unknown): DeskSelection {
  const row = stageRecord(value), stage = record(row.manual_stage), raw = record(row.raw);
  if (!currentStageDecision(row) || row.state !== "ACTIVE" || stage.state !== "STAGED" || stage.submission !== null || row.lifecycle !== "STAGED") throw Error("此筆本地待送單已鎖定或取消，不可送出");
  return { kind: "staged", id: String(row.id), revision: Number(row.revision), digest: String(row.digest), snapshot: row,
    command: { ...raw, quantity: raw.quantity_shares, space_id: stage.space_id }, owner: "MCP", source: "MANUAL" };
}

export type LocalStageChange = { before: UnknownRecord; raw?: UnknownRecord };

// A local revision receipt is unrelated to a submission receipt. Only the next
// revision of this exact draft, with the requested event/content, resolves it.
export function localStageResult(value: unknown, change: LocalStageChange): UnknownRecord {
  const previous = stageRecord(change.before), row = stageRecord(value, change.raw ?? record(previous.raw));
  const stage = record(row.manual_stage), original = record(previous.manual_stage);
  if (row.id !== previous.id || row.revision !== Number(previous.revision) + 1
    || stage.original_digest !== original.original_digest || stage.client_intent_id !== original.client_intent_id
    || stage.state !== "STAGED" || stage.submission !== null
    || row.event !== (change.raw ? "REVISE" : "CANCEL")
    || (change.raw ? row.state !== "ACTIVE" || row.lifecycle !== "STAGED" : row.state !== "CANCELLED" || row.lifecycle !== "CANCELLED"))
    throw Error("本地操作尚未取得相符的新版本，請讀回原待送單。");
  return row;
}

// Read-only identity join. Never use symbol/price/quantity or quarantined reports.
// Every available pin must agree; a duplicate or conflicting link proves nothing.
export function stageNativeReview(value: UnknownRecord, readback: UnknownRecord | null): UnknownRecord | null {
  if (!readback) return null;
  const submission = record(record(value.manual_stage).submission), native = record(submission.native);
  const receipt = record(submission.receipt), execution = record(receipt.execution), receiptSnapshot = record(receipt.snapshot);
  const command = record(record(submission.draft).command), receiptCommand = record(record(receipt.draft).command);
  const consistent = (values: unknown[]) => {
    const pins = values.filter(value => value !== undefined && value !== null);
    return pins.length && pins.every(value => typeof value === "string" && !!value && value === pins[0]) ? pins[0] as string : null;
  };
  const reviewId = consistent([native.review_id, receipt.review_id]);
  const executionId = consistent([native.execution_id, receipt.execution_id, execution.execution_id]);
  const intentId = consistent([submission.native_intent_id, command.intent_id, receiptCommand.intent_id, execution.intent_id]);
  const tradeDate = consistent([command.trade_date, receiptCommand.trade_date, execution.trade_date]);
  // The envelope date is the query/session day and may include historical
  // reviews. Join on the original order's dated identity, never the query day.
  const localDates = [command.trade_date, receiptCommand.trade_date, execution.trade_date].filter(value => value != null);
  if ((localDates.length > 0 && (!tradeDate || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)))
    || (!reviewId && !executionId && !intentId)
    || ([native.review_id, receipt.review_id].some(value => value != null) && !reviewId)
    || ([native.execution_id, receipt.execution_id, execution.execution_id].some(value => value != null) && !executionId)
    || ([submission.native_intent_id, command.intent_id, receiptCommand.intent_id, execution.intent_id].some(value => value != null) && !intentId)) return null;
  const candidates = deskReviews(readback).filter(review => {
    const draftCommand = record(record(review.draft).command);
    return (reviewId && review.review_id === reviewId)
      || (executionId && (review.execution_id === executionId || record(review.execution).execution_id === executionId))
      || (intentId && draftCommand.intent_id === intentId && (!tradeDate || draftCommand.trade_date === tradeDate));
  });
  if (candidates.length !== 1) return null;
  const matches = candidates.filter(review => {
    const draftCommand = record(record(review.draft).command), current = record(review.execution), snapshot = record(review.snapshot);
    const originalDate = tradeDate ?? draftCommand.trade_date;
    return typeof originalDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(originalDate)
      && positive(review.review_revision) && (!reviewId || review.review_id === reviewId) && (!executionId || review.execution_id === executionId)
      && (!intentId || draftCommand.intent_id === intentId) && draftCommand.trade_date === originalDate
      && (native.review_revision === undefined || review.review_revision === native.review_revision)
      && (native.digest === undefined || snapshot.digest === native.digest)
      && (receipt.review_revision === undefined || review.review_revision === receipt.review_revision)
      && (receiptSnapshot.digest === undefined || snapshot.digest === receiptSnapshot.digest)
      && (snapshot.review_id === undefined || snapshot.review_id === review.review_id)
      && (snapshot.review_revision === undefined || snapshot.review_revision === review.review_revision)
      && (review.execution_id == null || (current.execution_id === review.execution_id
        && current.intent_id === draftCommand.intent_id && current.trade_date === originalDate))
      && (current.execution_id === undefined || current.execution_id === review.execution_id)
      && (current.intent_id === undefined || current.intent_id === draftCommand.intent_id)
      && (current.trade_date === undefined || current.trade_date === originalDate);
  });
  return matches.length === 1 ? matches[0] : null;
}

// The aggregate order report may be PARTIAL even when this execution's
// durable Native status is available. Require the unique review AND the exact
// execution detail before presenting a settled result on the staged card.
export async function readStageExecution(bridge: CandidateBridge, row: UnknownRecord, readback: UnknownRecord, signal?: AbortSignal): Promise<UnknownRecord> {
  const linked = stageNativeReview(row, readback), listed = record(linked?.execution);
  const id = linked?.execution_id, market = record(row.raw).market ?? "TW";
  const draft = record(record(linked?.draft).command);
  const hasId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.trim() === value;
  if (!["KNOWN", "PARTIAL"].includes(String(readback.quality)) || !hasId(id)
    || !hasId(draft.intent_id) || !hasId(draft.account_id) || (market !== "TW" && market !== "US"))
    throw Error("Native 委託身分尚未核對");
  const detail = deskOrderRead(await deskCall(bridge, "omi_read_desk_order", { id, market }, signal), id, market);
  const execution = record(detail.execution), command = record(detail.command);
  const original = record(record(record(record(row.manual_stage).submission).receipt).execution);
  if (execution.intent_id !== draft.intent_id || command.intent_id !== draft.intent_id
    || execution.trade_date !== draft.trade_date || command.trade_date !== draft.trade_date || command.account_id !== draft.account_id
    || [listed.broker_order_id, original.broker_order_id].some(value => value != null && value !== execution.broker_order_id)
    || (detail.quality != null && detail.quality !== "KNOWN")
    || !["OPEN", "ACCEPTED", "PARTIALLY_FILLED", "FILLED", "CANCELLED", "REJECTED"].includes(String(execution.state))
    || (execution.state !== "REJECTED" && !hasId(execution.broker_order_id)))
    throw Error("原委託尚無一致的 Native 結果");
  return execution;
}

// Fixed, bounded pagination. An incomplete/ambiguous scan never proves absence.
export async function readStaged(bridge: CandidateBridge, signal?: AbortSignal): Promise<UnknownRecord[]> {
  const rows: UnknownRecord[] = [], seen = new Set<string>();
  let after = "";
  for (let page = 0; page < 100; page++) {
    const value = await deskCall(bridge, "omi_read_desk_staged", { after, limit: 100 }, signal);
    if (!Array.isArray(value)) throw Error("本地待送清單格式不符；不推定為空");
    for (const item of value) {
      const row = stageRecord(item);
      if (seen.has(String(row.id))) throw Error("本地待送清單身份重複；結果仍 UNKNOWN");
      seen.add(String(row.id)); rows.push(row);
    }
    if (value.length < 100) return rows;
    after = String(rows.at(-1)!.id);
  }
  throw Error("本地待送清單超過讀取上限；結果仍 UNKNOWN");
}

export function intentStage(rows: UnknownRecord[], intent: UnknownRecord): UnknownRecord | null {
  const matches = rows.filter(row => record(row.raw).client_intent_id === intent.client_intent_id);
  if (matches.length > 1) throw Error("同一 client_intent_id 回傳多筆 stage；結果仍 UNKNOWN");
  return matches.length ? stageRecord(matches[0], intent) : null;
}

export function intentReview(value: unknown, intentId: string): UnknownRecord | null {
  const matches = deskReviews(value).filter(review => {
    const command = record(record(review.draft).command);
    return command.intent_id === intentId && command.request_id === intentId;
  });
  if (matches.length > 1) throw Error("同一 client_intent_id 回傳多筆 review；結果仍 UNKNOWN");
  return matches[0] ?? null;
}
