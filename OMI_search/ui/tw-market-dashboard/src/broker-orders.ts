import type { CandidateBridge } from "./candidate-state";
import { deskCall, deskOrderRead, stageNativeReview } from "./desk-contract";
import { isRecord, type UnknownRecord } from "./state";

const record = (value: unknown): UnknownRecord => isRecord(value) ? value : {};
const identifier = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value === value.trim();
const day = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export const brokerTerminal = (state: unknown) => ["FILLED", "CANCELLED", "REJECTED"].includes(String(state));
const active = (state: unknown) => ["OPEN", "ACCEPTED", "PARTIALLY_FILLED"].includes(String(state));
const quality = (value: unknown) => ["KNOWN", "PARTIAL"].includes(String(value));

export type BrokerCancelPin = { id: string; market: string; accountId: string; tradeDate: string; brokerOrderId: string };
export type BrokerOrderView = { row: UnknownRecord; history: boolean; needsCheck: boolean; state: unknown; pin?: BrokerCancelPin; note: string };

// Presentation of Backend facts only: never infer ROD cancellation, fills or a
// session date from the browser clock. PARTIAL fill history is not zero fills.
export function brokerOrderViews(data: UnknownRecord, stale = false): BrokerOrderView[] {
  const rows = data.broker_orders as UnknownRecord[];
  const ids = new Map<unknown, number>(), keys = new Map<string, number>();
  const keyOf = (row: UnknownRecord) => { const key = record(row.broker_key); return JSON.stringify([key.account_id, key.trade_date, key.order_id]); };
  for (const row of rows) {
    if (identifier(row.execution_id)) ids.set(row.execution_id, (ids.get(row.execution_id) ?? 0) + 1);
    keys.set(keyOf(row), (keys.get(keyOf(row)) ?? 0) + 1);
  }
  return rows.map(row => {
    const key = record(row.broker_key), state = row.execution_state ?? row.broker_status;
    const dated = day(data.trade_date) && day(key.trade_date), today = dated && key.trade_date === data.trade_date;
    const history = brokerTerminal(state) || (dated && !today);
    const currentFacts = Array.isArray(row.facts) ? row.facts.filter(value => {
      const fact = record(value);
      return fact.current_read === true && ["SNAPSHOT", "ACCEPTED", "PENDING", "REJECTED"].includes(String(fact.kind));
    }) : [];
    // Backend orders facts chronologically. An earlier positive remainder must
    // not override a newer zero/rejected observation from the same read.
    const latest = record(currentFacts.at(-1));
    const current = latest.kind !== "REJECTED" && Number.isSafeInteger(latest.remaining_shares) && Number(latest.remaining_shares) > 0;
    const duplicate = (identifier(row.execution_id) && ids.get(row.execution_id)! > 1) || keys.get(keyOf(row))! > 1;
    const trusted = !stale && quality(data.quality) && quality(row.quality) && current && !duplicate
      && !(brokerTerminal(row.broker_status) && !brokerTerminal(state));
    const needsCheck = !brokerTerminal(state) && (!today || !active(state) || !trusted);
    let pin: BrokerCancelPin | undefined;
    if (today && active(state) && trusted && row.ownership === "MANAGED" && identifier(row.execution_id)
      && identifier(key.account_id) && identifier(key.order_id)) {
      pin = { id: row.execution_id, market: "TW", accountId: key.account_id, tradeDate: key.trade_date as string, brokerOrderId: key.order_id };
    }
    const note = !dated ? "交易日未確認；待核對，未列為有效委託。"
      : !today ? "過往紀錄；未推定今日仍有效或已撤銷。"
      : needsCheck ? "待核對；目前證據不足，未列為可撤委託。"
      : row.ownership === "EXTERNAL" ? "外部委託；目前僅能查看，無 Native 精確撤單身分。"
      : !pin && !brokerTerminal(state) ? "缺少可核對的 Native／券商身分，僅能讀回。" : "";
    return { row, history, needsCheck, state, pin, note };
  });
}

export function stageOrderView(row: UnknownRecord, data: UnknownRecord | null, brokerRows: BrokerOrderView[], stale = false) {
  const stage = record(row.manual_stage), submission = record(stage.submission), receipt = record(submission.receipt);
  const market = String(record(row.raw).market ?? "TW");
  const linked = stageNativeReview(row, data), execution = record(linked?.execution), command = record(record(linked?.draft).command);
  const dates = [record(submission.draft).command, record(receipt.draft).command].map(value => record(value).trade_date);
  dates.push(record(receipt.execution).trade_date, command.trade_date, execution.trade_date);
  const pins = dates.filter(value => value != null);
  const date = pins.length > 0 && day(pins[0]) && pins.every(value => value === pins[0]) ? pins[0] as string : null;
  const submitted = isRecord(stage.submission), state = execution.state;
  const history = submitted && (brokerTerminal(state) || (!!date && day(data?.trade_date) && date !== data?.trade_date));
  const historicalUnknown = history && !brokerTerminal(state);
  const needsCheck = !linked || typeof state !== "string" || ["UNKNOWN", "RECONCILING"].includes(state) || stale || !quality(data?.quality);
  const matches = typeof execution.execution_id === "string" ? brokerRows.filter(item => item.row.execution_id === execution.execution_id) : [];
  const broker = matches.length === 1 ? matches[0] : undefined, key = record(broker?.row.broker_key);
  const exact = broker && broker.row.ownership === "MANAGED" && key.account_id === command.account_id && key.trade_date === date
    && key.order_id === execution.broker_order_id && broker.state === state;
  const cancelOrder = submitted && !history && !needsCheck && market === "TW" && exact && broker.pin
    && deskOrderCancellable({ execution, command }) ? broker : undefined;
  const reason = !submitted ? "" : brokerTerminal(state) ? "此單已結案，保留歷史與停損停利資訊。"
    : historicalUnknown ? "歷史待核對；未推定今日仍有效或已撤銷，請讀回原委託。"
    : !date ? "原委託日未確認；請讀回核對，不推定為當日有效委託。"
    : stale ? "讀回可能已過期，請更新清單後再核對。"
    : !linked ? "Native 身分／日期／版本關聯未確認；僅能讀回核對。"
    : ["UNKNOWN", "RECONCILING", "PENDING"].includes(String(state)) ? "券商結果待核對，尚無可撤的未完成委託證據。"
    : state === "CANCEL_PENDING" ? "撤銷處理中，僅能讀回確認結果。"
    : market === "US" ? "此市場請使用下方券商委託與停損停利控制。"
    : market !== "TW" ? "市場未確認，僅能讀回核對。"
    : matches.length !== 1 ? "缺少唯一的當日券商紀錄，僅能讀回核對。"
    : broker?.row.ownership !== "MANAGED" ? "外部委託缺少 Managed 精確身分，不能從此處撤單。"
    : !exact ? "Native 與券商身分／狀態不一致，僅能讀回核對。"
    : !cancelOrder ? broker?.note || "尚無可信的未完成委託或已提出撤單，請讀回確認。" : "";
  return { linked, execution, date, state, submitted, history, historicalUnknown, needsCheck, cancelOrder, reason, market };
}

// UI-only effect latches, shared by the local detail and broker card for this
export function fillView(data: UnknownRecord, scope: "today" | "history", selectedDate = "") {
  const rows = Array.isArray(data.fills) ? data.fills.filter(isRecord) : [];
  const dateOf = (row: UnknownRecord) => { const value = record(row.broker_key).trade_date; return day(value) ? String(value) : null; };
  return {
    dated: rows.filter(row => { const date = dateOf(row); return date && (scope === "today" ? date === data.trade_date : (!selectedDate || date === selectedDate)); }),
    undated: rows.filter(row => !dateOf(row)),
  };
}

// UI-only effect latches, shared by the local detail and broker card for this
// bridge. No order ledger or persisted business state. Remount/list refresh
// must not forget an uncertain cancel. Once dispatched, this session never
// sends it again; exact reads can establish the resulting terminal state.
type CancelLatch = { busy: boolean; attempted: boolean; listeners: Set<() => void> };
const sessions = new WeakMap<CandidateBridge, Map<string, CancelLatch>>();
export function deskCancelLatch(bridge: CandidateBridge, id: string, market: string): CancelLatch {
  let session = sessions.get(bridge);
  if (!session) { session = new Map(); sessions.set(bridge, session); }
  const key = JSON.stringify([market, id]);
  let latch = session.get(key);
  if (!latch) { latch = { busy: false, attempted: false, listeners: new Set() }; session.set(key, latch); }
  return latch;
}
const publish = (latch: CancelLatch) => latch.listeners.forEach(listener => listener());

export function exactBrokerOrder(value: unknown, id: string, market: string, pin?: BrokerCancelPin): UnknownRecord {
  const data = deskOrderRead(value, id, market), execution = record(data.execution), command = record(data.command);
  if (pin && (pin.id !== id || pin.market !== market || execution.broker_order_id !== pin.brokerOrderId
    || execution.trade_date !== pin.tradeDate || command.trade_date !== pin.tradeDate || command.account_id !== pin.accountId))
    throw Error("此單讀回與清單的券商編號／交易日／帳戶不符；只讀回，不撤單。");
  return data;
}

export function deskOrderCancellable(data: UnknownRecord): boolean {
  const execution = record(data.execution), command = record(data.command);
  return active(execution.state) && identifier(execution.broker_order_id) && day(execution.trade_date)
    && command.trade_date === execution.trade_date && identifier(command.account_id)
    && (execution.cancel_stage === null || execution.cancel_stage === "NOT_SENT")
    && Number.isSafeInteger(execution.quantity) && Number(execution.quantity) > 0
    && Number.isSafeInteger(execution.filled_shares) && Number(execution.filled_shares) >= 0
    && Number(execution.filled_shares) < Number(execution.quantity);
}

export async function cancelDeskOrder(bridge: CandidateBridge, id: string, market: string, pin?: BrokerCancelPin): Promise<UnknownRecord> {
  const latch = deskCancelLatch(bridge, id, market);
  if (latch.busy || latch.attempted) throw Error("撤單已鎖定；請精確讀回結果，不會重複撤單。");
  latch.busy = true; publish(latch);
  try {
    const current = exactBrokerOrder(await deskCall(bridge, "omi_read_desk_order", { id, market }), id, market, pin);
    if (!deskOrderCancellable(current)) throw Error("此單已結案、撤銷處理中或狀態尚未核對；未發出撤單，請讀回更新。");
    const execution = record(current.execution), command = record(current.command);
    const exactPin = pin ?? { id, market, accountId: command.account_id as string, tradeDate: execution.trade_date as string, brokerOrderId: execution.broker_order_id as string };
    // Latch before dispatch, including timeout, rejection or malformed receipt.
    latch.attempted = true; publish(latch);
    const result = exactBrokerOrder(await deskCall(bridge, "omi_cancel_desk_order", { id, market }), id, market, exactPin);
    // Only this exact command response can release the latch. A later read may
    // be stale and cannot prove that a timed-out invocation was not dispatched.
    if (record(result.execution).cancel_stage === "NOT_SENT") { latch.attempted = false; publish(latch); }
    return result;
  } finally { latch.busy = false; publish(latch); }
}
