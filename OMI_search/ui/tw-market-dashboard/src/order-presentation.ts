import { currentStageDecision, stageNativeReview } from "./desk-contract";
import { brokerTerminal, stageOrderView, type BrokerOrderView } from "./broker-orders";
import { isRecord, type UnknownRecord } from "./state";

const record = (value: unknown): UnknownRecord => isRecord(value) ? value : {};
// Association changes presentation only, never permission or cancellation pins.
export function associatedStages(stages: UnknownRecord[], data: UnknownRecord | null, broker: UnknownRecord): UnknownRecord[] {
  if (!data || broker.ownership !== "MANAGED" || typeof broker.execution_id !== "string" || !broker.execution_id) return [];
  const peers = Array.isArray(data.broker_orders) ? data.broker_orders.filter(item => record(item).execution_id === broker.execution_id) : [];
  if (peers.length !== 1) return [];
  const key = record(broker.broker_key);
  if (![key.account_id, key.trade_date, key.order_id].every(value => typeof value === "string" && !!value)) return [];
  return stages.filter(stage => {
    if ((record(stage.raw).market ?? "TW") !== "TW") return false;
    const review = stageNativeReview(stage, data), execution = record(review?.execution), command = record(record(review?.draft).command);
    return execution.execution_id === broker.execution_id && execution.broker_order_id === key.order_id
      && execution.trade_date === key.trade_date && command.trade_date === key.trade_date && command.account_id === key.account_id
      && command.symbol === broker.symbol;
  });
}

export function remainingShares(row: UnknownRecord): string {
  const facts = Array.isArray(row.facts) ? row.facts.filter(item => isRecord(item) && item.current_read === true) : [];
  const latest = record(facts.at(-1));
  return Number.isSafeInteger(latest.remaining_shares) && Number(latest.remaining_shares) >= 0
    ? `${Number(latest.remaining_shares).toLocaleString("zh-TW")} 股` : "待回報";
}

export function orderTradeDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? value : null;
}

// Only immutable creation evidence. Never sort by recorded_at, updated_at,
// queried_at, received_at, cancellation ACK, or the browser's current date.
function creationTime(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !orderTradeDate(value.slice(0, 10)) || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

// This is the Taipei civil date shown in the workspace. Session validity stays
// Backend-owned, including US decisions whose New York date differs.
const taipeiDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" });
const newYorkDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
export const workspaceDay = (now: number) => taipeiDate.format(now);
export const nextWorkspaceDayAt = (today: string) => Date.parse(`${today}T00:00:00+08:00`) + 86_400_000;

export function stageCreatedDay(row: UnknownRecord, now: number) {
  const validity = record(row.stage_validity), market = record(row.raw).market ?? "TW";
  const decision = orderTradeDate(validity.decision_date);
  if (!decision || (market !== "TW" && market !== "US")) return null;
  if (validity.created_at == null) return market === "TW" && decision <= workspaceDay(now) ? decision : null;
  const stamp = creationTime(validity.created_at);
  if (!stamp) return null;
  const at = Date.parse(stamp);
  if (at > now || (market === "US" ? newYorkDate : taipeiDate).format(at) !== decision) return null;
  return workspaceDay(at);
}

export function stagedSection(row: UnknownRecord, execution: UnknownRecord, uncertain: boolean, now: number) {
  const created = stageCreatedDay(row, now);
  if (!created) return "undated";
  const stage = record(row.manual_stage);
  const terminal = brokerTerminal(execution.state) || (!execution.state &&
    ["SUBMISSION_CANCELLED", "SUBMISSION_REJECTED", "CANCELLED"].includes(String(row.lifecycle)));
  const unsent = stage.state === "STAGED" && stage.submission === null;
  if (created !== workspaceDay(now)) return terminal || (unsent && !uncertain) ? "history" : "historyReview";
  if (terminal) return stage.submission ? "submitted" : "inactive";
  if (uncertain) return "review";
  if (unsent && row.state === "ACTIVE" && row.lifecycle === "STAGED") {
    if (currentStageDecision(row, now)) return "current";
    if (record(row.stage_validity).state === "EXPIRED" || Date.parse(String(record(row.stage_validity).expires_at)) <= now) return "inactive";
  }
  if (stage.submission && ["OPEN", "ACCEPTED", "PARTIALLY_FILLED"].includes(String(execution.state))) return "submitted";
  return "review";
}

function localCreation(row: UnknownRecord, linked?: UnknownRecord | null): string | null {
  const receipt = record(record(record(row.manual_stage).submission).receipt);
  return creationTime(linked?.created_at) ?? creationTime(receipt.created_at) ?? creationTime(receipt.confirmed_at);
}

function brokerCreation(row: UnknownRecord, data: UnknownRecord, source?: UnknownRecord): string | null {
  const key = record(row.broker_key);
  const matches = Array.isArray(data.reviews) && typeof row.execution_id === "string" ? data.reviews.filter(value => {
    const review = record(value), execution = record(review.execution), command = record(record(review.draft).command);
    return review.execution_id === row.execution_id && execution.execution_id === row.execution_id
      && execution.broker_order_id === key.order_id && execution.trade_date === key.trade_date
      && command.trade_date === key.trade_date && command.account_id === key.account_id && command.symbol === row.symbol;
  }) : [];
  const reviewTime = matches.length === 1 ? creationTime(record(matches[0]).created_at) : null;
  const localTime = source ? localCreation(source, stageNativeReview(source, data)) : null;
  if (reviewTime || localTime) return reviewTime ?? localTime;
  const accepted = (Array.isArray(row.facts) ? row.facts : []).map(record)
    .filter(fact => fact.kind === "ACCEPTED").map(fact => creationTime(fact.source_at)).filter((time): time is string => time !== null);
  // The first ACCEPTED source event is evidence of placement; the latest
  // snapshot or ACK may merely reflect a subsequent fill/cancel/read.
  return accepted.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
}

export function orderCreatedLabel(at: string | null): string {
  return at ? new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(at)) : "建立時間未提供";
}

type StageView = ReturnType<typeof stageOrderView> & { row: UnknownRecord };
export type TodayOrder = { id: string; createdAt: string | null } & (
  { kind: "broker"; order: BrokerOrderView; source?: UnknownRecord } |
  { kind: "stage"; stage: StageView }
);

export function todayOrderPresentation(stages: UnknownRecord[], data: UnknownRecord | null, brokerRows: BrokerOrderView[], stale = false) {
  const date = orderTradeDate(data?.trade_date);
  const submitted = stages.map(row => ({ row, ...stageOrderView(row, data, brokerRows, stale) })).filter(item => item.submitted);
  const undatedStages = submitted.filter(item => !item.date);
  const undatedBrokers = brokerRows.filter(item => !orderTradeDate(record(item.row.broker_key).trade_date));
  const orders: TodayOrder[] = [];
  if (!date || !data) return { date, orders, undatedStages, undatedBrokers };
  const todayStages = submitted.filter(item => item.date === date);
  const consumed = new Set<UnknownRecord>();
  for (const order of brokerRows) {
    if (orderTradeDate(record(order.row.broker_key).trade_date) !== date) continue;
    const sources = associatedStages(todayStages.map(item => item.row), data, order.row);
    const source = sources.length === 1 ? sources[0] : undefined;
    if (source) consumed.add(source);
    const key = record(order.row.broker_key);
    orders.push({ kind: "broker", order, source, id: JSON.stringify(["broker", order.row.execution_id, key.account_id, key.trade_date, key.order_id]), createdAt: brokerCreation(order.row, data, source) });
  }
  for (const stage of todayStages) if (!consumed.has(stage.row)) {
    orders.push({ kind: "stage", stage, id: `stage:${String(stage.row.id)}`, createdAt: localCreation(stage.row, stage.linked) });
  }
  orders.sort((a, b) => {
    const time = (b.createdAt ? Date.parse(b.createdAt) : -Infinity) - (a.createdAt ? Date.parse(a.createdAt) : -Infinity);
    return (Number.isNaN(time) ? 0 : time) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  return { date, orders, undatedStages, undatedBrokers };
}
