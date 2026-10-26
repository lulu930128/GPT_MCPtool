/** UI-only storyboard. NOT execution.contracts, preflight, auth, or an order ledger.
 * M1 execution/ remains the canonical offline domain. No transport or persistence.
 */
export const FIXTURE = Object.freeze({
  origin: "SYNTHETIC", simulated: true, durable: false,
  referencePrice: 100, minimumCents: 100, maximumCents: 20_000,
  cashCents: 100_000_000, feeCents: 2_000, sellableShares: 10_000,
  boardSize: 1_000, maximumShares: 10_000, ttlMs: 60_000,
});
const instruments: Readonly<Record<string, { asset: "CASH_STOCK" | "ETF"; venue: "TWSE" | "TPEX" }>> = {
  "2330": { asset: "CASH_STOCK", venue: "TWSE" },
  "2317": { asset: "CASH_STOCK", venue: "TWSE" },
  "0050": { asset: "ETF", venue: "TWSE" },
  "6488": { asset: "CASH_STOCK", venue: "TPEX" },
};
export const fixtureInstrument = (symbol: string) => Object.hasOwn(instruments, symbol) ? instruments[symbol] : undefined;
export type Scenario = "fill" | "reject" | "unknown" | "empty" | "error";
export type TicketFields = {
  side: "" | "BUY" | "SELL"; lot: "" | "BOARD" | "ODD";
  orderKind: "" | "LIMIT"; price: string; quantity: string; scenario: Scenario;
};
export type TicketEstimate = { priceCents: number; shares: number; notionalCents: number; requiredCashCents: number };
export type TicketPreview = { id: number; symbol: string; fields: TicketFields; estimate: TicketEstimate; createdAt: number; expiresAt: number };
type Frame = { state: string; filled: number; note: string };
export type TicketView = {
  symbol: string; fields: TicketFields; serial: number; preview: TicketPreview | null;
  phase: "editing" | "preview" | "expired" | "cancelled" | "receipt";
  acknowledged: boolean; errors: string[]; frames: readonly Frame[]; cursor: number;
  attempts: 0 | 1; cancelRequested: boolean; lastTime: number;
};
export type TicketAction =
  | { type: "select"; symbol: string }
  | { type: "edit"; patch: Partial<TicketFields> }
  | { type: "reset" }
  | { type: "preview"; now: number }
  | { type: "acknowledge"; value: boolean; now: number; previewId: number }
  | { type: "confirm"; now: number; previewId: number }
  | { type: "tick"; now: number }
  | { type: "cancel"; now: number }
  | { type: "next"; now: number };

export function initialTicket(symbol = "", serial = 0): TicketView {
  return { symbol, serial, fields: { side: "", lot: "", orderKind: "", price: "", quantity: "", scenario: "fill" },
    preview: null, phase: "editing", acknowledged: false, errors: [], frames: [], cursor: 0,
    attempts: 0, cancelRequested: false, lastTime: 0 };
}

/** Bounded fixture form validation only; no real market tick table or account policy. */
export function validateTicket(symbol: string, fields: TicketFields): { errors: string[]; estimate: TicketEstimate | null } {
  const errors: string[] = [];
  if (!fixtureInstrument(symbol)) errors.push("此標的沒有 UI fixture；模擬預覽 unavailable。可選 2330、2317、0050、6488。");
  if (!["BUY", "SELL"].includes(fields.side)) errors.push("請明確選擇 BUY 或 SELL。");
  if (fields.orderKind !== "LIMIT") errors.push("請選擇 LIMIT；只示範 CASH / LIMIT / DAY。");
  if (!["BOARD", "ODD"].includes(fields.lot)) errors.push("請明確選擇 BOARD 或 ODD。");
  if (!["fill", "reject", "unknown", "empty", "error"].includes(fields.scenario)) errors.push("模擬情境無效。");
  // Parse decimal input into integer cents; never round a malformed input into a valid price.
  const validPrice = /^\d{1,3}(?:\.\d{1,2})?$/.test(fields.price);
  const [whole, fraction = ""] = fields.price.split(".");
  const priceCents = validPrice ? Number(whole) * 100 + Number(fraction.padEnd(2, "0")) : 0;
  if (!validPrice || priceCents < FIXTURE.minimumCents || priceCents > FIXTURE.maximumCents) errors.push("假價格須為 1.00–200.00 TWD，最多兩位小數（fixture tick 0.01）。");
  const shares = /^\d{1,5}$/.test(fields.quantity) ? Number(fields.quantity) : 0;
  if (!Number.isSafeInteger(shares) || shares < 1 || shares > FIXTURE.maximumShares) errors.push("股數須為 1–10,000 的整數。");
  else if (fields.lot === "BOARD" && shares % FIXTURE.boardSize !== 0) errors.push("BOARD fixture 須為 1,000 股的倍數；輸入單位為股。");
  else if (fields.lot === "ODD" && shares >= FIXTURE.boardSize) errors.push("ODD fixture 須為 1–999 股。");
  const notionalCents = shares * priceCents;
  const requiredCashCents = fields.side === "BUY" ? notionalCents + FIXTURE.feeCents : 0;
  if (requiredCashCents > FIXTURE.cashCents) errors.push("超過假可用額度（含假費用預留）；不代表真實購買力。");
  if (fields.side === "SELL" && shares > FIXTURE.sellableShares) errors.push("超過假可賣股數；不支援放空。");
  return { errors, estimate: errors.length ? null : { priceCents, shares, notionalCents, requiredCashCents } };
}

/** Fixed report slides, not a port of M1 transition(). No arbitrary events accepted. */
function storyboard(scenario: Scenario, shares: number): readonly Frame[] {
  switch (scenario) {
    case "fill": return [
      { state: "SIMULATED_ACCEPTED", filled: 0, note: "fixture 接受回報，沒有券商接受。" },
      ...(shares > 1 ? [{ state: "SIMULATED_PARTIALLY_FILLED", filled: Math.floor(shares / 2), note: "fixture 累積部分成交，沒有真實成交。" }] : []),
      { state: "SIMULATED_FILLED", filled: shares, note: "fixture 全數成交；不更新持股或額度。" },
    ];
    case "reject": return [{ state: "SIMULATED_REJECTED", filled: 0, note: "固定的拒絕回報示例；不是券商錯誤。" }];
    case "unknown": return [
      { state: "UNKNOWN", filled: 0, note: "逾時示例；不可推定失敗、取消或自動重試。" },
      { state: "RECONCILING", filled: 0, note: "人工播放對帳示例；沒有發出查單。" },
      { state: "SIMULATED_FILLED", filled: shares, note: "固定對帳 fixture 顯示全數成交。" },
    ];
    case "empty": return [{ state: "UNKNOWN", filled: 0, note: "空回報 fixture：結果 unavailable；不可推定未送達，也不重試。" }];
    case "error": return [{ state: "UNKNOWN", filled: 0, note: "錯誤回報 fixture：結果 unavailable；沒有網路錯誤或自動重試。" }];
  }
}
export const currentFrame = (view: TicketView) => view.frames[view.cursor];
export const canCancel = (view: TicketView) => view.phase === "preview" ||
  (view.phase === "receipt" && !view.cancelRequested && !["SIMULATED_FILLED", "SIMULATED_REJECTED", "SIMULATED_CANCELLED"].includes(currentFrame(view)?.state));

export function ticketReducer(view: TicketView, action: TicketAction): TicketView {
  if (action.type === "select") return action.symbol === view.symbol ? view : initialTicket(action.symbol, view.serial);
  if (action.type === "reset") return initialTicket(view.symbol, view.serial);
  if (action.type === "edit") return { ...initialTicket(view.symbol, view.serial), fields: { ...view.fields, ...action.patch } };
  // Clock rollback or a delayed click invalidates an unconsumed preview, even if the timer was suspended.
  if (!Number.isFinite(action.now) || action.now < view.lastTime) {
    return { ...view, phase: view.phase === "preview" ? "expired" : view.phase, acknowledged: false, errors: ["本機計時無效，請清空後重新預覽。"] };
  }
  if (view.phase === "preview" && view.preview && action.now >= view.preview.expiresAt) {
    return { ...view, phase: "expired", acknowledged: false, lastTime: action.now, errors: ["模擬預覽已過期；請重新預覽與人工確認。"] };
  }
  if (action.type === "tick") return view;
  if (action.type === "preview") {
    if (view.phase === "preview" || view.phase === "receipt") return view;
    const checked = validateTicket(view.symbol, view.fields);
    const clean = { ...initialTicket(view.symbol, view.serial), fields: view.fields, lastTime: action.now };
    if (!checked.estimate) return { ...clean, errors: checked.errors };
    const id = view.serial + 1;
    return { ...clean, serial: id, phase: "preview", preview: { id, symbol: view.symbol, fields: { ...view.fields }, estimate: checked.estimate, createdAt: action.now, expiresAt: action.now + FIXTURE.ttlMs } };
  }
  if (action.type === "acknowledge") return view.phase === "preview" && action.previewId === view.preview?.id
    ? { ...view, acknowledged: action.value === true, lastTime: action.now } : view;
  if (action.type === "confirm") {
    // Repeated clicks/replayed UI handlers keep the same receipt and attempts=1.
    if (view.phase !== "preview" || !view.acknowledged || action.previewId !== view.preview?.id) return view;
    return { ...view, phase: "receipt", acknowledged: false, attempts: 1, lastTime: action.now,
      frames: [{ state: "SIMULATED_PENDING", filled: 0, note: "人工確認僅建立本機模擬意圖，尚無接受或成交回報。" }, ...storyboard(view.fields.scenario, view.preview.estimate.shares)], cursor: 0 };
  }
  if (action.type === "cancel" && canCancel(view)) {
    if (view.phase === "preview") return { ...view, phase: "cancelled", acknowledged: false, cancelRequested: true, lastTime: action.now,
      frames: [{ state: "SIMULATED_CANCELLED", filled: 0, note: "已放棄未確認的 UI 預覽；模擬次數 0。" }], cursor: 0 };
    const frame = currentFrame(view);
    const unknown = ["UNKNOWN", "RECONCILING"].includes(frame.state);
    // Cancellation selects another fixed storyboard; it never asserts immediate cancellation.
    return { ...view, acknowledged: false, cancelRequested: true, lastTime: action.now, cursor: view.cursor + 1,
      frames: [...view.frames.slice(0, view.cursor + 1),
        { state: unknown ? frame.state : "CANCEL_PENDING", filled: frame.filled, note: "只記錄模擬取消意圖，等待 fixture 回報。" },
        ...(frame.state === "UNKNOWN" ? [{ state: "RECONCILING", filled: frame.filled, note: "人工播放取消後對帳示例。" }] : []),
        { state: "SIMULATED_CANCELLED", filled: frame.filled, note: "固定取消回報；保留已模擬成交股數。" }] };
  }
  if (action.type === "next" && view.phase === "receipt" && view.cursor + 1 < view.frames.length) return { ...view, cursor: view.cursor + 1, lastTime: action.now };
  return view;
}
