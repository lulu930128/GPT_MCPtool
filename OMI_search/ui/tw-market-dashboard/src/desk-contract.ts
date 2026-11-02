import { isRecord, type UnknownRecord } from "./state";
import { toolValue, type CandidateBridge } from "./candidate-state";

export type DeskSelection = {
  kind: "review" | "pending" | "staged"; id: string; revision: number; digest: string;
  snapshot: UnknownRecord; command: UnknownRecord; owner: string; source: string;
  conditions?: unknown;
};
const record = (value: unknown): UnknownRecord => isRecord(value) ? value : {};
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const decimal = (value: unknown): boolean => (typeof value === "string" || typeof value === "number") && /^\d+(?:\.\d+)?$/.test(String(value)) && Number.isFinite(Number(value)) && Number(value) > 0;
const decimalText = (value: unknown) => String(value).replace(/^0+(?=\d)/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
export const deskCall = async (bridge: CandidateBridge, name: string, args: UnknownRecord = {}) => toolValue(await bridge.callTool(name, args));
export const deskError = (error: unknown) => `${error instanceof Error ? error.message : String(error)}${/HTTP 404|HTTP 405|Method not found|Unknown tool|尚未接線/.test(String(error)) ? " · API 契約待接（尚未接線）" : ""}`;
export const definitiveRejection = (error: unknown) => /OMI API HTTP (400|404|405|422):/.test(String(error));

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
  return deskCall(bridge, selection.kind === "staged" ? "omi_confirm_desk_staged" : selection.kind === "review" ? "omi_confirm_desk_review" : "omi_approve_candidate_pending",
    { id: selection.id, expected_revision: selection.revision, expected_digest: selection.digest });
}

export function stageRecord(value: unknown, expected?: UnknownRecord): UnknownRecord {
  const row = record(value), raw = record(row.raw), stage = record(row.manual_stage);
  if (row.kind !== "manual_stage" || row.owner_id !== "MCP" || typeof row.id !== "string" || !row.id
    || !positive(row.revision) || typeof row.digest !== "string" || !/^[a-f0-9]{64}$/.test(row.digest)
    || stage.space_id !== "USER_SPACE" || stage.source !== "MANUAL" || typeof stage.state !== "string"
    || typeof stage.original_digest !== "string" || !/^[a-f0-9]{64}$/.test(stage.original_digest)
    || typeof raw.client_intent_id !== "string" || stage.client_intent_id !== raw.client_intent_id
    || typeof raw.symbol !== "string" || !positive(raw.quantity_shares) || !decimal(raw.price)
    || !["Buy", "Sell"].includes(String(raw.action)) || !["Common", "Odd"].includes(String(raw.lot))
    || !["CASH", "CASH_SELLING", "MARGIN", "SHORT_SELLING"].includes(String(raw.condition))
    || typeof row.lifecycle !== "string" || !("submission" in stage)) throw Error("本地待送單身份／版本／USER_SPACE / MANUAL / MCP 契約不符；結果仍 UNKNOWN");
  if (expected && Object.keys(expected).some(key => key === "price"
    ? decimalText(raw[key]) !== decimalText(expected[key]) : raw[key] !== expected[key])) throw Error("本地待送單與原意圖價量／身份不符；結果仍 UNKNOWN");
  return row;
}

export function stageSelection(value: unknown): DeskSelection {
  const row = stageRecord(value), stage = record(row.manual_stage), raw = record(row.raw);
  if (stage.state !== "STAGED" || stage.submission !== null || row.lifecycle !== "STAGED") throw Error("此筆本地待送單已鎖定或取消，不可送出");
  return { kind: "staged", id: String(row.id), revision: Number(row.revision), digest: String(row.digest), snapshot: row,
    command: { ...raw, quantity: raw.quantity_shares, space_id: stage.space_id }, owner: "MCP", source: "MANUAL" };
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
  const executionId = consistent([receipt.execution_id, execution.execution_id]);
  const intentId = consistent([submission.native_intent_id, command.intent_id, receiptCommand.intent_id, execution.intent_id]);
  const tradeDate = consistent([command.trade_date, receiptCommand.trade_date, execution.trade_date]);
  if (!tradeDate || readback.trade_date !== tradeDate || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)
    || (!reviewId && !executionId && !intentId)
    || ([native.review_id, receipt.review_id].some(value => value != null) && !reviewId)
    || ([receipt.execution_id, execution.execution_id].some(value => value != null) && !executionId)
    || ([submission.native_intent_id, command.intent_id, receiptCommand.intent_id, execution.intent_id].some(value => value != null) && !intentId)) return null;
  const matches = deskReviews(readback).filter(review => {
    const draftCommand = record(record(review.draft).command), current = record(review.execution), snapshot = record(review.snapshot);
    return positive(review.review_revision) && (!reviewId || review.review_id === reviewId) && (!executionId || review.execution_id === executionId)
      && (!intentId || draftCommand.intent_id === intentId) && draftCommand.trade_date === tradeDate
      && (native.review_revision === undefined || review.review_revision === native.review_revision)
      && (native.digest === undefined || snapshot.digest === native.digest)
      && (receipt.review_revision === undefined || review.review_revision === receipt.review_revision)
      && (receiptSnapshot.digest === undefined || snapshot.digest === receiptSnapshot.digest)
      && (snapshot.review_id === undefined || snapshot.review_id === review.review_id)
      && (snapshot.review_revision === undefined || snapshot.review_revision === review.review_revision)
      && (current.execution_id === undefined || current.execution_id === review.execution_id)
      && (current.intent_id === undefined || current.intent_id === draftCommand.intent_id)
      && (current.trade_date === undefined || current.trade_date === tradeDate);
  });
  return matches.length === 1 ? matches[0] : null;
}

// Fixed, bounded pagination. An incomplete/ambiguous scan never proves absence.
export async function readStaged(bridge: CandidateBridge): Promise<UnknownRecord[]> {
  const rows: UnknownRecord[] = [], seen = new Set<string>();
  let after = "";
  for (let page = 0; page < 100; page++) {
    const value = await deskCall(bridge, "omi_read_desk_staged", { after, limit: 100 });
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
