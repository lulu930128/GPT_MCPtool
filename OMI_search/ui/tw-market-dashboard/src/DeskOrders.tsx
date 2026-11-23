import { ProtectionFields, LiveOrderControls, BrokerOrderControls } from "./OrderProtection";
import { StockName } from "./StockName";
import { inventoryPresentation, inventoryTypes, stockGroups, type InventoryEntry } from "./readback-presentation";
import { stagedSection, stageCreatedDay, workspaceDay, nextWorkspaceDayAt, associatedStages, remainingShares, todayOrderPresentation, orderCreatedLabel } from "./order-presentation";
import { brokerOrderViews, stageOrderView, fillView, type BrokerOrderView } from "./broker-orders";
import { useEffect, useRef, useState } from "react";
import { isRecord, type UnknownRecord } from "./state";
import type { CandidateBridge } from "./candidate-state";
import { localRejection } from "./research-contract";
import { TradeDetails } from "./TradeFeedback";
import { OrderTechnicalSummary, type OrderResearchCache } from "./OrderTechnicalSummary";
import { localStageResult, type LocalStageChange } from "./desk-contract";
import { brokerReadback, confirmDeskSelection, currentStageDecision, deskCall, deskConnection, deskError, deskOrderRead, deskReviews, pendingSelection, reviewSelection, readStaged, readStageExecution, sameStagedSelection, stageNotAttempted, stageRecord, stageSelection, stageNativeReview, type DeskSelection } from "./desk-contract";

const record = (value: unknown): UnknownRecord => isRecord(value) ? value : {};
const text = (value: unknown) => value === null || value === undefined ? "未提供" : String(value);
const orderSideText = (action: unknown) => action === "Buy" ? "買進" : action === "Sell" ? "賣出" : undefined;

// Display only. Identity, validation and submission remain in desk-contract.
export function orderPrice(value: unknown): string {
  const price = text(value);
  if (!/^\d+(?:\.\d+)?$/.test(price)) return "未提供";
  const [whole, fraction] = price.split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction === undefined ? "" : `.${fraction}`);
}

export function orderQuantity(lot: unknown, value: unknown): string {
  const shares = Number(value);
  if (!/^\d+$/.test(text(value)) || !Number.isSafeInteger(shares) || shares < 0) return "數量未確認";
  const count = shares.toLocaleString("zh-TW");
  if (lot === "Odd") return `零股 ${count} 股`;
  if (lot === "Shares") return `${count} 股`;
  if (lot === "Common" && shares % 1000 === 0) return `整股 ${(shares / 1000).toLocaleString("zh-TW")} 張（${count} 股）`;
  return `${count} 股（交易單位待確認）`;
}

export function orderDirection(command: UnknownRecord): string {
  const condition = { CASH: "現股", CASH_SELLING: "現先賣", MARGIN: "融資", SHORT_SELLING: "融券" }[String(command.condition)];
  const side = orderSideText(command.action);
  if (!side) return "交易類別待確認";
  if (!condition) return `${side} · 交易類別待確認`;
  return command.condition === "CASH_SELLING" ? `${condition}（${side}）` : `${condition}${side}`;
}

export function orderStatus(value: unknown, local = false): string {
  return ({ STAGED: "待送出", PREVIEW: "待送出", SUBMITTING: "正在送出", SUBMISSION_UNKNOWN: "送單結果待確認",
    SUBMISSION_REJECTED: "送單遭拒", SUBMISSION_PENDING: "券商結果待確認", SUBMISSION_CANCELLED: "已撤銷", SUBMITTED: "已送出",
    PENDING: "券商結果待確認", OPEN: "未完成", ACCEPTED: "已受理", PARTIALLY_FILLED: "部分成交", FILLED: "已成交", REJECTED: "遭拒絕",
    CANCEL_PENDING: "撤銷處理中", CANCELLED: local ? "已取消（本地）" : "已撤銷", UNKNOWN: "待確認", RECONCILING: "核對中" } as Record<string, string>)[String(value)] ?? "狀態待確認";
}

export function stageStatus(row: UnknownRecord): { label: string; note: string } {
  const submission = record(record(row.manual_stage).submission), execution = record(record(submission.receipt).execution);
  if (execution.submit_stage === "NOT_SENT") return { label: "未送出", note: "送單前檢查未通過，未呼叫券商送單。" };
  if (row.lifecycle === "SUBMITTING") return { label: ["DRAFT", "PREVIEW", "CONFIRM"].includes(String(submission.phase)) ? "正在送出" : "送單進度待確認", note: "" };
  if (row.lifecycle === "SUBMISSION_PENDING") return { label: "券商結果待確認", note: submission.phase === "RESULT" ? "送單請求已返回；券商結果待確認。" : "券商結果尚未確認。" };
  if (row.lifecycle === "SUBMISSION_REJECTED") return { label: execution.state === "REJECTED" ? "遭拒絕" : "送單遭拒", note: execution.state === "REJECTED" ? "券商拒單結果已確認。" : "送單流程遭拒，尚無券商拒單證據。" };
  return { label: orderStatus(row.lifecycle, true), note: row.lifecycle === "SUBMITTED" ? "已送出不代表成交，請以券商回報為準。" : "" };
}

export function executionStatus(value: UnknownRecord): string {
  return value.submit_stage === "NOT_SENT" ? "未送出" : orderStatus(value.state);
}

const unresolvedSubmission = (row: UnknownRecord) => ["SUBMITTING", "SUBMISSION_UNKNOWN", "SUBMISSION_PENDING"].includes(String(row.lifecycle));

export function SendOrderModal({ selection, busy, notice, cancel, confirm }: {
  selection: DeskSelection; busy: boolean; notice: string; cancel(): void; confirm(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current, previous = document.activeElement as HTMLElement | null;
    element?.showModal();
    cancelButton.current?.focus({ preventScroll: true });
    return () => { element?.close(); previous?.focus({ preventScroll: true }); };
  }, []);
  const command = selection.command;
  const side = orderSideText(command.action);
  return <dialog ref={dialog} className="workspace-send-modal" aria-labelledby="workspace-send-title" onCancel={event => { event.preventDefault(); if (!busy) cancel(); }}>
    <h2 id="workspace-send-title">確認送出此筆委託</h2>
    <p>請核對股票、方向、限價與數量。確認後送交券商；已送出不代表成交。</p>
    <dl className="workspace-order-confirm-facts workspace-order-tint" data-side={text(command.action)}>
      <div><dt>交易類別</dt><dd><strong className="workspace-order-direction">{orderDirection(command)}</strong></dd></div>
      <div><dt>股票</dt><dd className="workspace-order-tint">{text(command.symbol)}</dd></div>
      <div><dt>限價</dt><dd className="workspace-order-tint">{orderPrice(command.price)}</dd></div>
      <div><dt>數量</dt><dd className="workspace-order-tint">{orderQuantity(command.lot, command.quantity)}</dd></div>
      {command.trade_date ? <div><dt>交易日</dt><dd>{text(command.trade_date)}</dd></div> : null}
    </dl>
    <p>{command.market === "US" ? "美股 · USD" : "台股 · TWD"}</p>
    {command.market === "US" && <p>交割：{command.settlement_mode === "TWD" ? "台幣" : "外幣"}</p>}
    {isRecord(command.protection) && <div><p>停損 {orderPrice(command.protection.stop_loss)} · 停利 {orderPrice(command.protection.take_profit)}</p>
      {Array.isArray(command.protection.targets) && command.protection.targets.map((value, index) => { const target = record(value); return <p key={index}>目標 {index + 1}：{orderPrice(target.price)} · {Number(target.fraction) * 100}%</p>; })}
      <p>本機出場規則隨此單採用，可在原訂單修改。</p></div>}
    {selection.conditions !== undefined && <details><summary>觸發條件</summary><pre>{JSON.stringify(selection.conditions, null, 2)}</pre></details>}
    <details className="workspace-order-details"><summary>開發診斷</summary><pre>{JSON.stringify({ id: selection.id, revision: selection.revision, digest: selection.digest, owner: selection.owner, source: selection.source, snapshot: selection.snapshot }, null, 2)}</pre></details>
    {notice && <p role="alert">{notice}</p>}
    <div className="workspace-order-pair"><button type="button" ref={cancelButton} disabled={busy} onClick={cancel}>取消</button><button type="button" className="workspace-order-action" data-side={text(command.action)} aria-busy={busy} disabled={busy || !!notice} onClick={confirm}>{busy ? "送出中…" : "確認送單"}{side && ` · ${side}`}</button></div>
  </dialog>;
}

export function DeskOrders({ bridge, active, candidateId, focusStageId, brokerTarget, onNavigateBroker, refreshKey, view = "all" }: { bridge: CandidateBridge; active: boolean; candidateId?: string; focusStageId?: string; brokerTarget?: { id: string; market: string }; onNavigateBroker?: (target: { id: string; market: string }) => void; refreshKey: number; view?: "all" | "staged" | "orders" }) {
  const [data, setData] = useState<UnknownRecord | null>(null), [error, setError] = useState("");
  const [candidate, setCandidate] = useState<UnknownRecord | null>(null), [pending, setPending] = useState<UnknownRecord[]>([]), [pendingError, setPendingError] = useState("");
  const [selection, setSelection] = useState<DeskSelection | null>(null), [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false), [unknown, setUnknown] = useState<string[]>([]);
  const [stages, setStages] = useState<UnknownRecord[]>([]), [stageError, setStageError] = useState("");
  const [, updateClock] = useState(0);
  const [stageScope, setStageScope] = useState<"today" | "history">("today");
  const now = Date.now(), today = workspaceDay(now);
  useEffect(() => { if (!active || view !== "staged") setStageScope("today"); }, [active, view]);
  const nextDeadline = stages.reduce((next, row) => {
    const deadline = Date.parse(String(record(row.stage_validity).expires_at));
    return currentStageDecision(row, now) ? Math.min(next, deadline) : next;
  }, view === "staged" ? nextWorkspaceDayAt(today) : Infinity);
  useEffect(() => {
    if (!active || !Number.isFinite(nextDeadline)) return;
    const schedule = () => setTimeout(() => updateClock(value => value + 1), Math.max(0, nextDeadline - Date.now()));
    let timer = schedule();
    const resume = () => {
      if (document.hidden) return;
      clearTimeout(timer); updateClock(value => value + 1); timer = schedule();
    };
    document.addEventListener("visibilitychange", resume);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", resume); };
  }, [active, nextDeadline]);
  const [edit, setEdit] = useState<{ row: UnknownRecord; raw: UnknownRecord } | null>(null);
  const [showCancelled, setShowCancelled] = useState(false), [reading, setReading] = useState(false), [localBusyIds, setLocalBusyIds] = useState<string[]>([]);
  const inFlight = useRef(false), selectedRef = useRef<DeskSelection | null>(null), generation = useRef(0);
  const localChanges = useRef(new Map<string, LocalStageChange>()), refreshFlight = useRef<Promise<void> | null>(null);
  const refreshToken = useRef(-1), refreshView = useRef("");
  const brokerFlight = useRef<Promise<unknown> | null>(null);
  const localFlights = useRef(new Set<string>()), localReads = useRef(new Map<string, number>());
  useEffect(() => {
    if (view === "staged" && selection?.kind === "staged" && !inFlight.current
      && stageCreatedDay(selection.snapshot, Date.now()) !== today) {
      selectedRef.current = null;
      setSelection(null);
    }
  }, [view, today, selection]);
  const focused = useRef<string>();
  const researchCache = useRef<OrderResearchCache>(new Map());
  const [brokerFocusNotice, setBrokerFocusNotice] = useState("");
  useEffect(() => {
    if (!active || view === "staged" || !brokerTarget || !data || reading) return;
    let disposed = false;
    const matches = (data.broker_orders as UnknownRecord[]).filter(row => row.execution_id === brokerTarget.id && row.ownership === "MANAGED");
    setBrokerFocusNotice("正在讀回指定委託…");
    void deskCall(bridge, "omi_read_desk_order", { id: brokerTarget.id, market: brokerTarget.market }).then(value => {
      const detail = deskOrderRead(value, brokerTarget.id, brokerTarget.market);
      if (disposed) return;
      const exact = matches.length === 1 && record(matches[0].broker_key).order_id === record(detail.execution).broker_order_id;
      const card = document.getElementById(`broker-${brokerTarget.id}`);
      if (!card || (brokerTarget.market === "TW" && !exact)) { setBrokerFocusNotice("尚未讀到唯一對應券商委託；請讀回核對。"); return; }
      card.closest("details")?.setAttribute("open", ""); card.focus({ preventScroll: true }); card.scrollIntoView({ block: "nearest" }); setBrokerFocusNotice("");
    }).catch(() => { if (!disposed) setBrokerFocusNotice("此筆委託尚待核對；請讀回原單。"); });
    return () => { disposed = true; };
  }, [active, view, brokerTarget, data, reading, bridge]);
  useEffect(() => {
    if (!active || !focusStageId || focused.current === focusStageId || !stages.some(row => row.id === focusStageId)) return;
    const card = document.getElementById(`stage-${focusStageId}`);
    if (card && (view !== "staged" || !card.closest("details:not([open])"))) { card.closest("details")?.setAttribute("open", ""); card.focus({ preventScroll: true }); card.scrollIntoView({ block: "nearest" }); focused.current = focusStageId; }
  }, [active, view, focusStageId, stages, stageScope]);
  // Only this await's terminal NOT_ATTEMPTED receipt can permit an exact local
  // read to release its latch. Actual/uncertain submissions retain the ID latch.
  const attemptedStages = useRef(new Map<string, DeskSelection & { notAttempted?: boolean }>());
  const latestStages = useRef(stages);
  latestStages.current = stages;
  const stageExecutions = useRef(new Map<string, { revision: unknown; digest: unknown; execution: UnknownRecord }>());
  const stageReadSignal = useRef<AbortSignal>();
  const stageReads = useRef(new Map<string, number>());
  const observedExecution = (row: UnknownRecord) => {
    const observed = stageExecutions.current.get(String(row.id));
    return observed?.revision === row.revision && observed?.digest === row.digest ? observed?.execution : undefined;
  };
  const readSubmission = async (expected: UnknownRecord, token: number, orders: () => Promise<UnknownRecord>, signal?: AbortSignal) => {
    const id = String(expected.id), pin = attemptedStages.current.get(id);
    if (token !== generation.current || signal?.aborted || inFlight.current || stageReads.current.get(id) === token) return;
    stageReads.current.set(id, token);
    const current = () => token === generation.current && !signal?.aborted && attemptedStages.current.get(id) === pin;
    let row: UnknownRecord | undefined;
    let execution: UnknownRecord | undefined;
    try {
      const observed = stageRecord(await deskCall(bridge, "omi_read_desk_stage", { id }, signal), record(expected.raw));
      const bound = record(record(record(observed.manual_stage).submission).pin);
      const originalPin = record(record(record(expected.manual_stage).submission).pin);
      if (observed.id !== id || Number(observed.revision) < Number(expected.revision)
        || (observed.revision === expected.revision && observed.digest !== expected.digest)
        || record(observed.manual_stage).original_digest !== record(expected.manual_stage).original_digest
        || (originalPin.revision != null && (bound.revision !== originalPin.revision || bound.digest !== originalPin.digest))
        || (pin && (Number(observed.revision) <= pin.revision || bound.revision !== pin.revision || bound.digest !== pin.digest)))
        throw Error("本地待送單讀回 ID／版號／意圖不符");
      if (!current()) return;
      row = observed;
      setStages(previous => previous.map(item => item.id === id && Number(item.revision) <= Number(observed.revision) ? observed : item));
      const readback = await orders();
      if (!current()) return;
      execution = await readStageExecution(bridge, observed, readback, signal);
    } catch { /* Incomplete evidence leaves the original submission pending. */ }
    finally {
      if (stageReads.current.get(id) === token) stageReads.current.delete(id);
    }
    if (!current()) return;
    if (row && execution) {
      const revision = row.revision;
      if (latestStages.current.some(item => item.id === id && Number(item.revision) > Number(revision))) return;
      stageExecutions.current.set(id, { revision: row.revision, digest: row.digest, execution });
      setUnknown(previous => previous.filter(value => value !== id));
    } else {
      stageExecutions.current.delete(id);
      setUnknown(previous => previous.includes(id) ? previous : [...previous, id]);
    }
  };
  const refresh = (signal = stageReadSignal.current): Promise<void> => {
    if (inFlight.current || (view === "staged" && [...stageReads.current.values()].includes(generation.current))) return Promise.resolve();
    const key = `${view}:${candidateId ?? ""}`;
    if (refreshFlight.current && refreshToken.current === generation.current && refreshView.current === key) return refreshFlight.current;
    const task = performRefresh(signal).finally(() => { if (refreshFlight.current === task) { refreshFlight.current = null; setReading(false); } });
    refreshToken.current = generation.current; refreshView.current = key;
    refreshFlight.current = task; return task;
  };
  const performRefresh = async (signal?: AbortSignal) => {
    setReading(true);
    const token = ++generation.current;
    // Local storage reads must render even while Native is slow/offline.
    const local = readStaged(bridge, signal).then(rows => { if (token === generation.current) { setStages(previous => {
      const merged = rows.map(row => { const current = previous.find(item => item.id === row.id);
        return current && (Number(current.revision) > Number(row.revision) || localChanges.current.has(String(row.id))) ? current : row; });
      return [...merged, ...previous.filter(row => !rows.some(item => item.id === row.id))];
    }); setStageError(""); } return rows; })
      .catch(err => { if (token === generation.current) setStageError(deskError(err)); return []; });
    const candidateRead = async () => {
      if (!candidateId) { setCandidate(null); setPending([]); return; }
      try {
        const [detail, items] = await Promise.all([deskCall(bridge, "omi_read_candidate", { id: candidateId }), deskCall(bridge, "omi_read_candidate_pending", { id: candidateId })]);
        if (!isRecord(detail) || detail.id !== candidateId || !Array.isArray(items) || items.some(item => !isRecord(item) || item.candidate_id !== candidateId)) throw Error("研究 Pending 回傳身份不符");
        if (token === generation.current) { setCandidate(detail); setPending(items as UnknownRecord[]); setPendingError(""); }
      } catch (err) { if (token === generation.current) { setPending([]); setCandidate(null); setPendingError(deskError(err)); } }
    };
    const candidates = candidateRead();
    if (view === "staged") {
      const rows = new Map((await local).map(row => [String(row.id), row]));
      for (const row of latestStages.current) {
        const id = String(row.id), listed = rows.get(id);
        if (!listed || Number(row.revision) > Number(listed.revision)) rows.set(id, row);
      }
      for (const [id, pin] of attemptedStages.current) if (!rows.has(id)) rows.set(id, pin.snapshot);
      // Share one orders report across unresolved originals in this refresh.
      let report: Promise<UnknownRecord> | undefined;
      const orders = () => report ??= deskCall(bridge, "omi_read_desk_orders", {}, signal).then(value => brokerReadback(value, "orders"));
      await Promise.all([candidates, ...[...rows].map(([id, row]) => {
        const pin = attemptedStages.current.get(id);
        if (!pin?.notAttempted && !observedExecution(row) && (unresolvedSubmission(row) || pin))
          return readSubmission(row, token, orders, signal);
      })]);
      return;
    }
    try {
      if (!brokerFlight.current) { const flight = deskCall(bridge, "omi_read_desk_orders").finally(() => { if (brokerFlight.current === flight) brokerFlight.current = null; }); brokerFlight.current = flight; }
      const value = brokerReadback(await brokerFlight.current, "orders"), reviews = deskReviews(value);
      if (token === generation.current) {
        setData(value); setError("");
        // Native review IDs retain their existing readback recovery. Candidate
        // IDs can only recover through readStage's original pin + exact join.
        setUnknown(previous => previous.filter(id => attemptedStages.current.has(id) || localChanges.current.has(id) || stages.some(row => row.id === id)
          || !reviews.some(row => row.review_id === id && !!row.execution_id)));
      }
    }
    catch (err) { if (token === generation.current) setError(deskError(err)); }
    await Promise.all([local, candidates]);
  };
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    stageReadSignal.current = controller.signal;
    let disposed = false, running = false, timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      if (disposed || document.hidden || running) return;
      running = true;
      // An old view's read may finish, but must not overwrite the new view.
      if (disposed || document.hidden) { running = false; return; }
      if (!inFlight.current) await refresh(controller.signal);
      running = false;
      if (!disposed && !document.hidden) timer = setTimeout(() => void run(), 30_000);
    };
    const visible = () => { clearTimeout(timer); if (!document.hidden) void run(); };
    document.addEventListener("visibilitychange", visible); void run();
    return () => { disposed = true; generation.current++; controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [bridge, active, candidateId, refreshKey, view]);
  const open = (value: DeskSelection) => { if (inFlight.current || selectedRef.current || localChanges.current.has(value.id) || unknown.includes(value.id) || attemptedStages.current.has(value.id)) return; selectedRef.current = value; setSelection(value); setNotice(""); };
  const send = async (expected: DeskSelection) => {
    const pin = selectedRef.current;
    if (!pin || pin !== expected || inFlight.current || localChanges.current.has(pin.id) || unknown.includes(pin.id) || attemptedStages.current.has(pin.id)) return;
    if (pin.kind === "staged") {
      try {
        const current = stageSelection(latestStages.current.find(row => row.id === pin.id));
        const checkedAt = Date.now();
        if (view === "staged" && (stageScope !== "today" || stageCreatedDay(current.snapshot, checkedAt) !== workspaceDay(checkedAt))) throw Error();
        if (current.revision !== pin.revision || current.digest !== pin.digest || stageError) throw Error();
      } catch {
        selectedRef.current = null; setSelection(null); setNotice("草稿有效期或版本已變更，請讀回原紀錄。"); return;
      }
    }
    const token = ++generation.current; // Discard reads begun before this pinned mutation.
    const attempt = { ...pin, notAttempted: false }; // Object identity is this local attempt ID.
    inFlight.current = true; selectedRef.current = null; setBusy(true);
    if (pin.kind === "staged") attemptedStages.current.set(pin.id, attempt);
    try {
      const receipt = await confirmDeskSelection(bridge, pin);
      if (token !== generation.current) throw Error("較早請求回覆已過期；請讀回原 ID");
      if (pin.kind === "staged") {
        const row = stageRecord(receipt, record(pin.snapshot.raw));
        if (row.id !== pin.id || Number(row.revision) <= pin.revision) throw Error("確認回應身份／版號未確認");
        const submission = record(record(row.manual_stage).submission), bound = record(submission.pin);
        if (bound.revision !== pin.revision || bound.digest !== pin.digest) throw Error("確認回應未綁定原 revision / digest");
        // Keep all returned states visible. A fulfilled call alone is not success.
        setStages(previous => previous.map(item => item.id === pin.id && Number(item.revision) <= Number(row.revision) ? row : item));
        setNotice(`原 ID ${pin.id} · Backend 狀態 ${text(record(row.manual_stage).state)}；僅讀回，不重送。`);
      } else setNotice(`已取得回應；以讀回狀態為準：${text(record(receipt).state)}`);
    }
    catch (err) {
      if (token === generation.current && attemptedStages.current.get(pin.id) === attempt && stageNotAttempted(err, pin)) {
        attempt.notAttempted = true;
        setUnknown(previous => previous.filter(id => id !== pin.id));
        setNotice("本次請求確定未送出；正在讀回同一掛單，完成後可重新手動確認。");
      } else {
        setUnknown(previous => previous.includes(pin.id) ? previous : [...previous, pin.id]);
        setNotice(`UNKNOWN · ${deskError(err)}；只讀回，不會自動重送。`);
      }
    }
    finally {
      inFlight.current = false; setBusy(false); setSelection(null);
      if (pin.kind === "staged") await readStage(pin.snapshot); else await refresh();
    }
  };
  const readStage = async (expected: UnknownRecord) => {
    if (inFlight.current) return;
    const id = String(expected.id);
    const retry = attemptedStages.current.get(id);
    if (!retry && record(expected.manual_stage).state === "STAGED" && record(expected.manual_stage).submission === null) {
      const localToken = (localReads.current.get(id) ?? 0) + 1, change = localChanges.current.get(id);
      localReads.current.set(id, localToken);
      try {
        const value = await deskCall(bridge, "omi_read_desk_stage", { id });
        if (localReads.current.get(id) !== localToken || localChanges.current.get(id) !== change) return;
        const row = change ? localStageResult(value, change) : stageRecord(value);
        if (row.id !== id || Number(row.revision) < Number(expected.revision)
          || record(row.raw).client_intent_id !== record(expected.raw).client_intent_id
          || record(row.manual_stage).original_digest !== record(expected.manual_stage).original_digest
          || (row.revision === expected.revision && row.digest !== expected.digest)) throw Error("本地待送單讀回身分／版本不符");
        localChanges.current.delete(id);
        setStages(previous => previous.map(item => item.id === id && Number(item.revision) <= Number(row.revision) ? row : item));
        setUnknown(previous => previous.filter(value => value !== id)); setStageError("");
        setNotice(change ? change.raw ? "本地修改已確認；尚未送交券商。" : "已刪除本地待送單；歷史仍保留。" : "本地待送單已更新，請核對內容。");
      } catch (err) { if (localReads.current.get(id) === localToken) setNotice(`本地操作結果待確認：${deskError(err)}`); }
      return;
    }
    if (view === "staged" && stageReads.current.get(id) === generation.current) return;
    const token = ++generation.current;
    if (retry?.notAttempted) {
      // Native never started for this request. Its absence must not prevent the
      // Backend-owned local exact read; a list read alone cannot release this.
      try {
        const value = await deskCall(bridge, "omi_read_desk_stage", { id });
        if (token !== generation.current || attemptedStages.current.get(id) !== retry) return;
        const observed = stageRecord(value);
        let row: UnknownRecord;
        try { row = sameStagedSelection(observed, retry); }
        catch (err) {
          // A completed read showing a changed/claimed stage consumes this
          // retry proof. A later stale STAGED snapshot must never resurrect it.
          retry.notAttempted = false;
          setUnknown(previous => previous.includes(id) ? previous : [...previous, id]);
          setStages(previous => previous.map(item => item.id === id && observed.id === id && Number(item.revision) <= Number(observed.revision) ? observed : item));
          throw err;
        }
        attemptedStages.current.delete(id);
        setStages(previous => previous.map(item => item.id === id ? row : item));
        setUnknown(previous => previous.filter(value => value !== id)); setStageError("");
        setNotice("本次請求確定未送出；同一掛單讀回一致，可按送單重新核對並手動確認。");
      } catch (err) {
        if (token !== generation.current || attemptedStages.current.get(id) !== retry) return;
        setStageError(deskError(err));
        setNotice("本次請求確定未送出；掛單讀回尚未確認，請再讀回，不會自動重送。");
      }
      return;
    }
    if (view === "staged" && (retry || unresolvedSubmission(expected))) {
      const signal = stageReadSignal.current;
      return readSubmission(expected, token,
        async () => brokerReadback(await deskCall(bridge, "omi_read_desk_orders", {}, signal), "orders"), signal);
    }
    const localRead = deskCall(bridge, "omi_read_desk_stage", { id }).then(value => {
      const row = stageRecord(value, record(expected.raw));
      if (row.id !== id || Number(row.revision) < Number(expected.revision)
        || (row.revision === expected.revision && row.digest !== expected.digest)) throw Error("本地待送單讀回 ID／版號／意圖不符");
      if (token === generation.current) {
        setStages(previous => previous.map(item => item.id === id && Number(item.revision) <= Number(row.revision) ? row : item));
        setStageError("");
      }
      return row;
    });
    const nativeRead = deskCall(bridge, "omi_read_desk_orders").then(value => {
      const readback = brokerReadback(value, "orders"); deskReviews(readback); return readback;
    });
    // Start both reads together; Native failure must not hide a valid local row.
    const [local, native] = await Promise.allSettled([localRead, nativeRead]);
    if (token !== generation.current) return;
    if (native.status === "fulfilled") { setData(native.value); setError(""); }
    else setError(deskError(native.reason));
    try {
      if (local.status === "rejected") throw local.reason;
      const row = local.value;
      const pin = attemptedStages.current.get(id), bound = record(record(record(row.manual_stage).submission).pin);
      const linked = native.status === "fulfilled" ? stageNativeReview(row, native.value) : null;
      const execution = record(linked?.execution);
      if (!linked || !linked.execution_id || execution.execution_id !== linked.execution_id || typeof execution.state !== "string"
        || (pin && (Number(row.revision) <= pin.revision || bound.revision !== pin.revision || bound.digest !== pin.digest))) {
        setUnknown(previous => previous.includes(id) ? previous : [...previous, id]);
        setNotice(`UNKNOWN · 原 ID ${id} 讀回證據尚不完整；僅讀回，不重送。`);
        return;
      }
      setUnknown(previous => previous.filter(value => value !== id));
      setNotice(`原 ID ${id} · ${text(row.lifecycle)}；讀回不代表重送。`);
    } catch (err) { setStageError(deskError(err)); setUnknown(previous => previous.includes(id) ? previous : [...previous, id]); }
  };
  const changeStage = async (row: UnknownRecord, raw?: UnknownRecord) => {
    const id = String(row.id);
    if (localFlights.current.has(id) || localChanges.current.has(id) || unknown.includes(id) || attemptedStages.current.has(id)) return;
    const change = { before: row, ...(raw ? { raw } : {}) }, tool = raw ? "omi_revise_candidate" : "omi_cancel_candidate";
    localChanges.current.set(id, change);
    localFlights.current.add(id); setLocalBusyIds([...localFlights.current]);
    try {
      const result = localStageResult(await deskCall(bridge, tool,
        { id, expected_revision: row.revision, ...(raw ? { raw } : {}) }), change);
      localChanges.current.delete(id);
      setStages(previous => previous.map(item => item.id === id ? result : item)); setEdit(current => current?.row.id === id ? null : current);
      setNotice(raw ? "修改已儲存；尚未送交券商。" : "已刪除本地待送單；歷史仍保留。");
    } catch (err) {
      if (localRejection(err, tool)) { localChanges.current.delete(id); setNotice(`本地操作未完成：${deskError(err)}；請核對內容或重新讀取。`); }
      else { setUnknown(previous => previous.includes(id) ? previous : [...previous, id]); setNotice(`本地操作結果待確認：${deskError(err)}`); await readStage(row); }
    }
    finally { localFlights.current.delete(id); setLocalBusyIds([...localFlights.current]); }
  };
  const prepare = async (item: UnknownRecord) => {
    if (inFlight.current || unknown.includes(String(item.id))) return;
    inFlight.current = true; setBusy(true);
    try { await deskCall(bridge, "omi_prepare_candidate_pending", { id: item.id }); setNotice("已讀取準備結果；尚未送單。請核對待送快照。"); }
    catch (err) { setUnknown(previous => [...previous, String(item.id)]); setNotice(`準備結果 UNKNOWN · ${deskError(err)}；不會自動重送。`); }
    finally { inFlight.current = false; setBusy(false); await refresh(); }
  };
  const rows = data ? deskReviews(data) : [];
  const brokerRows = data ? brokerOrderViews(data, !!error) : [];
  const currentOrders = brokerRows.filter(row => !row.history), checkOrders = brokerRows.filter(row => row.history && row.needsCheck), historicalOrders = brokerRows.filter(row => row.history && !row.needsCheck);
  const brokerCard = (order: BrokerOrderView, index: number, createdAt?: string | null, source?: UnknownRecord) => {
    const row = order.row;
    return <article id={row.execution_id ? `broker-${row.execution_id}` : undefined} tabIndex={-1} key={JSON.stringify([row.execution_id, row.broker_key, index])} className="workspace-desk-row workspace-order-card" aria-label={`${text(row.symbol)} 券商委託`}>
      <header className="workspace-order-card-heading"><div><strong className="workspace-order-symbol">{text(row.symbol)}<StockName bridge={bridge} symbol={String(row.symbol ?? "")}/></strong><span className="workspace-order-direction" data-side={text(row.action)}>{orderDirection(row)}</span></div><span className="workspace-order-status">{order.needsCheck ? createdAt !== undefined ? `${orderStatus(order.state)} · 待核對` : "待核對" : orderStatus(order.state)}</span></header>
      <dl className="workspace-order-facts" data-side={text(row.action)}><div><dt>限價</dt><dd className="workspace-order-tint">{orderPrice(row.price)}</dd></div><div><dt>數量</dt><dd className="workspace-order-tint">{orderQuantity(row.lot, row.quantity_shares)}</dd></div><div><dt>交易日</dt><dd>{text(record(row.broker_key).trade_date)}</dd></div></dl>
      {createdAt !== undefined && <p className="workspace-ticket-note">委託建立：{orderCreatedLabel(createdAt)}{createdAt ? "（台北）" : " · 列於已知時間之後"}</p>}
      <p className="workspace-ticket-note">已知成交 {text(row.known_filled_shares)} 股{row.fill_history_complete === true ? "" : " · 部分回報"} · 剩餘 {remainingShares(row)}</p>
      {order.note && <p className="workspace-ticket-note">{order.note}</p>}
      {order.needsCheck && <p className="workspace-ticket-note">待核對 · 請讀回</p>}
      {row.ownership === "MANAGED" && typeof row.execution_id === "string" && row.execution_id.trim() === row.execution_id && row.execution_id.length > 0
        && <><BrokerOrderControls bridge={bridge} order={order} onRead={refresh}/><LiveOrderControls bridge={bridge} id={row.execution_id} market="TW" cancelAllowed={false}/></>}
      <OrderTechnicalSummary bridge={bridge} symbol={String(row.symbol ?? "")} market="TW" cache={researchCache.current}/>
      <TradeDetails value={{ row, note: order.note }}/>
      {source && <details className="workspace-order-details"><summary>本地來源與讀回</summary><button type="button" disabled={busy || localBusyIds.includes(String(source.id))} onClick={() => void readStage(source)}>讀回本地來源</button><TradeDetails value={source}/>{unknown.includes(String(source.id)) && <p role="status">本地操作結果待確認，請讀回原紀錄。</p>}</details>}
    </article>;
  };
  const presentBrokerCard = (order: BrokerOrderView, index: number) => {
    const sources = associatedStages(stages, data, order.row);
    return sources.length === 1 ? <details className="workspace-order-details workspace-linked-order" key={String(order.row.execution_id)}><summary>{text(order.row.symbol)} · 同筆券商回報（已列於本地來源）</summary><p>依 execution、帳戶、交易日與券商編號關聯；不同委託不合併。</p>{brokerCard(order, index)}</details> : brokerCard(order, index);
  };
  const visibleStages = view === "staged" ? stages : stages.filter(row =>
    (showCancelled || row.id === focusStageId || row.lifecycle !== "CANCELLED" || unknown.includes(String(row.id)))
    && (view === "all" || record(row.manual_stage).submission !== null || unknown.includes(String(row.id))));
  const stageViews = visibleStages.map(row => ({ row, ...stageOrderView(row, data, brokerRows, !!error || !!stageError) }));
  const stageObservation = (row: UnknownRecord) => {
    const readback = record(row.native_readback);
    return (readback.status === "OBSERVED" && isRecord(readback.execution) ? readback.execution : observedExecution(row));
  };
  const section = (item: typeof stageViews[number]) => {
    const row = item.row, submission = record(record(row.manual_stage).submission);
    const receiptExecution = unresolvedSubmission(row) ? {} : record(record(submission.receipt).execution);
    const execution = stageObservation(row) ?? (item.linked ? item.execution : receiptExecution);
    const uncertain = !!stageError || unknown.includes(String(row.id)) || (!item.submitted && attemptedStages.current.has(String(row.id)));
    return stagedSection(row, execution, uncertain, now);
  };
  const groups = { undated: [] as typeof stageViews, inactive: [] as typeof stageViews, historyReview: [] as typeof stageViews, current: [] as typeof stageViews, history: [] as typeof stageViews, review: [] as typeof stageViews, submitted: [] as typeof stageViews };
  for (const item of stageViews) {
    const group = view === "staged" ? section(item)
      : !item.history || item.historicalUnknown || item.row.id === focusStageId ? "current" : "history";
    groups[group].push(item);
  }
  const { current: mainStages, history: historyStages, review: reviewStages, submitted: submittedStages } = groups;
  const historyCount = historyStages.length + groups.historyReview.length + groups.undated.length;
  const historySelected = view === "staged" && stageScope === "history";
  const stageCard = (item: typeof stageViews[number], createdAt?: string | null, readOnly = false) => {
        const { row, linked, execution, cancelOrder } = item;
        const raw = record(row.raw), validity = record(row.stage_validity);
        let pin: DeskSelection | null = null;
        if (!readOnly) { try { pin = stageSelection(row); } catch { /* Read-only until a current decision is attested. */ } }
        const locked = localBusyIds.includes(String(row.id)) || unknown.includes(String(row.id)) || attemptedStages.current.has(String(row.id));
        const needsRead = unknown.includes(String(row.id)) || !!stageError || attemptedStages.current.has(String(row.id)) || String(row.lifecycle).startsWith("SUBMISSION_") || ["SUBMITTING", "SUBMITTED"].includes(String(row.lifecycle));
        const status = stageStatus(row);
        const receiptExecution = record(record(record(record(row.manual_stage).submission).receipt).execution);
        const observed = view === "staged" ? stageObservation(row) : undefined;
        const awaitingSubmission = view === "staged" && (unresolvedSubmission(row) || (item.submitted && attemptedStages.current.has(String(row.id))));
        const deadlinePassed = validity.state === "CURRENT" && Date.parse(String(validity.expires_at)) <= now;
        const label = readOnly && row.lifecycle === "STAGED" && deadlinePassed ? "本次確認期限已過" : view === "staged" && validity.state === "EXPIRED" && row.lifecycle === "STAGED" ? "草稿已到期"
          : readOnly && row.lifecycle === "STAGED" && currentStageDecision(row, now) ? "待送出"
          : readOnly && row.lifecycle === "STAGED" ? (validity.reason === "STAGE_OUTSIDE_ENTRY_WINDOW" ? "研究進場窗口外" : "有效期待核對")
          : observed ? executionStatus(observed) : awaitingSubmission ? "待核對" : readOnly && receiptExecution.state ? executionStatus(receiptExecution) : createdAt !== undefined
          ? `${linked ? executionStatus(execution) : receiptExecution.state ? executionStatus(receiptExecution) : status.label}${item.needsCheck ? " · 待核對" : ""}`
          : item.historicalUnknown ? "歷史待核對" : item.submitted && item.needsCheck ? "待核對" : linked ? executionStatus(execution) : status.label;
        const executionId = String(execution.execution_id ?? receiptExecution.execution_id ?? "");
        return <article id={`stage-${row.id}`} tabIndex={-1} data-highlighted={row.id === focusStageId} className="workspace-desk-row workspace-order-card" key={String(row.id)} aria-label={`${text(raw.symbol)} 本地掛單`}>
          <header className="workspace-order-card-heading"><div><strong className="workspace-order-symbol">{text(raw.symbol)}{!readOnly && <StockName bridge={bridge} symbol={String(raw.symbol ?? "")} market={item.market}/>}</strong><span className="workspace-order-direction" data-side={text(raw.action)}>{orderDirection(raw)}</span></div><span className="workspace-order-status">{label}</span></header>
          <dl className="workspace-order-facts" data-side={text(raw.action)}><div><dt>委託限價 · {raw.market === "US" ? "USD" : "TWD"}</dt><dd className="workspace-order-tint">{orderPrice(raw.price)}</dd></div><div><dt>委託數量</dt><dd className="workspace-order-tint">{orderQuantity(raw.lot, raw.quantity_shares)}</dd></div>{item.submitted && <div><dt>原委託日</dt><dd>{item.date ?? "待核對"}</dd></div>}{linked && <div><dt>已成交</dt><dd>{text(execution.filled_shares)} 股</dd></div>}</dl>
          {createdAt !== undefined && <p className="workspace-ticket-note">委託建立：{orderCreatedLabel(createdAt)}{createdAt ? "（台北）" : " · 列於已知時間之後"}</p>}
          {createdAt !== undefined && !cancelOrder && <p className="workspace-ticket-note">已知成交 {text((linked ? execution : receiptExecution).filled_shares)} 股 · 剩餘待回報{!linked ? " · 依原送單回覆，請讀回核對" : ""}</p>}
          {observed && typeof observed.broker_order_id === "string" && <p className="workspace-ticket-note">券商單號 {observed.broker_order_id}</p>}
          {observed?.reconcile_required === true && <p className="workspace-ticket-note">成交與剩餘數量待核對</p>}
          {!observed && item.needsCheck && item.submitted && <p className="workspace-ticket-note">待核對 · 請讀回</p>}
          {readOnly && <p className="workspace-ticket-note" style={{ overflowWrap: "anywhere" }}>建立日（台北）{text(stageCreatedDay(row, now))} · 原 ID {text(row.id)} · {text(row.lifecycle)}</p>}
          {!readOnly && !awaitingSubmission && <>{cancelOrder && <BrokerOrderControls bridge={bridge} order={cancelOrder} onRead={refresh}/>}
          {item.submitted && !cancelOrder && <div><button type="button" disabled>撤銷剩餘委託</button><p role="status" className="workspace-ticket-note">{item.reason || "尚未取得可撤的券商剩餘委託，請讀回此單核對。"}</p></div>}
          {executionId && <LiveOrderControls bridge={bridge} id={executionId} market={item.market} cancelAllowed={view === "orders" && item.market === "US"}/>}
          {cancelOrder && <p className="workspace-ticket-note">券商剩餘 {remainingShares(cancelOrder.row)}</p>}</>}
          {unknown.includes(String(row.id)) && <p role="status">操作結果待確認 · 請讀回</p>}
          {attemptedStages.current.get(String(row.id))?.notAttempted && <p role="status">本次請求確定未送出；請讀回同一掛單後再手動確認。</p>}
          <div className="workspace-order-actions">
            {pin && <><button type="button" className="candidate-primary workspace-order-action" data-side={text(pin.command.action)} aria-label={`送單 · ${orderDirection(pin.command)}`} disabled={locked || !!stageError || edit?.row.id === row.id} onClick={() => open(pin!)}>送單</button><details className="workspace-secondary-actions"><summary>修改／刪除</summary><div className="workspace-order-actions"><button type="button" disabled={locked || !!stageError || !!selection} onClick={() => setEdit({ row, raw: { ...raw } })}>修改</button>
              <button type="button" disabled={locked || !!stageError || edit?.row.id === row.id || selection?.id === row.id} onClick={() => void changeStage(row)}>刪除</button>
              </div></details></>}
          {pin && (locked || !!stageError || edit?.row.id === row.id || !!selection) && <p role="status" className="workspace-ticket-note">{localBusyIds.includes(String(row.id)) ? "此單處理中，請稍候。" : edit?.row.id === row.id ? "請先儲存或關閉修改，再送單。" : selection ? "請先完成或取消目前的送單確認。" : "此單待讀回核對；確認原操作結果後才能繼續。"}</p>}
          {localBusyIds.includes(String(row.id)) && <span role="status">處理中…</span>}
          {(readOnly || needsRead || localChanges.current.has(String(row.id))) && <button type="button" disabled={busy || localBusyIds.includes(String(row.id))} onClick={() => void readStage(row)}>讀回</button>}
          </div>
      {pin && edit && edit.row.id === row.id && <form className="workspace-stage-edit" aria-label="修改本地待送單" onSubmit={event => { event.preventDefault(); void changeStage(edit.row, edit.raw); }}>
        <h3>修改 {text(record(edit.row.raw).symbol)} 的本地掛單 · <span className="workspace-order-direction" data-side={text(edit.raw.action)}>{orderDirection(edit.raw)}</span></h3><p>數量以股輸入；儲存後仍須按「送單」並確認才會送交券商。</p>
        {[["symbol", "修改股票代碼"], ["price", "修改價格"], ["quantity_shares", "修改股數"]].map(([key, label]) => <label key={key}>{label}<input aria-label={label} value={text(edit.raw[key])} disabled={localBusyIds.includes(String(edit.row.id)) || unknown.includes(String(edit.row.id))} onChange={event => setEdit({ ...edit, raw: { ...edit.raw, [key]: key === "quantity_shares" ? Number(event.target.value) : event.target.value } })}/></label>)}
        {isRecord(edit.raw.protection) && <ProtectionFields value={edit.raw.protection} onChange={protection => setEdit({ ...edit, raw: { ...edit.raw, protection } })} disabled={localBusyIds.includes(String(edit.row.id))}/>}
        {edit.raw.market === "US" && <label>交割方式<select value={String(edit.raw.settlement_mode ?? "MUT")} disabled={localBusyIds.includes(String(edit.row.id))} onChange={e => setEdit({ ...edit, raw: { ...edit.raw, settlement_mode: e.target.value } })}><option value="MUT">外幣交割</option><option value="TWD">台幣交割</option></select></label>}
        <div className="workspace-order-pair"><button type="submit" className="workspace-order-action" data-side={text(edit.raw.action)} disabled={localBusyIds.includes(String(edit.row.id)) || unknown.includes(String(edit.row.id))}>儲存修改</button><button type="button" disabled={localBusyIds.includes(String(edit.row.id))} onClick={() => setEdit(null)}>關閉修改</button></div>
      </form>}
          {!readOnly && <OrderTechnicalSummary bridge={bridge} symbol={String(raw.symbol ?? "")} market={item.market} cache={researchCache.current}/>}
          <TradeDetails value={{ local: row, reason: awaitingSubmission ? undefined : item.reason, ...(observed ? { readback: observed } : linked ? { readback: { trade_date: data?.trade_date, queried_at: data?.queried_at, quality: data?.quality, review: linked } } : {}) }}><p>本地紀錄：{status.label}。{status.note}</p>{(observed || linked) && <p>委託讀回：{executionStatus(observed ?? execution)}。</p>}</TradeDetails>
        </article>;
  };
  if (view === "orders") {
    const today = todayOrderPresentation(stages, data, brokerRows, !!error || !!stageError);
    const undatedCount = today.undatedStages.length + today.undatedBrokers.length;
    return <section className="workspace-desk-orders" aria-label="券商委託">
      <div className="candidate-heading"><h3>當日委託</h3><button type="button" disabled={reading || busy} onClick={() => void refresh()}>{reading ? "讀取中…" : "更新委託"}</button></div>
      <p className="workspace-ticket-note">{today.date ? `交易日 ${today.date} · 依委託建立時間新到舊，包含已結案。` : "交易日尚未確認，請更新委託；尚未列出今日清單。"}</p>
      {error && <p role="status">券商資料讀取失敗；{data ? "保留上次回覆的交易日與資料，可能已過期。" : "請更新委託。"}</p>}
      {stageError && <p role="status">本地來源讀取失敗；券商回報仍獨立顯示。</p>}
      {brokerFocusNotice && <p role="status">{brokerFocusNotice}</p>}
      <section aria-label="當日委託清單">
        {today.orders.map((item, index) => item.kind === "broker"
          ? <div key={item.id} id={item.source ? `stage-${item.source.id}` : undefined} tabIndex={item.source ? -1 : undefined} data-order-entry={item.id}>{brokerCard(item.order, index, item.createdAt, item.source)}</div>
          : <div key={item.id} data-order-entry={item.id}>{stageCard(item.stage, item.createdAt)}</div>)}
        {today.date && today.orders.length === 0 && <p>{reading ? "正在讀取當日委託…" : "尚未讀到當日委託。"}</p>}
      </section>
      {today.date && undatedCount > 0 && <details className="workspace-order-details" aria-label="委託日期待確認"><summary>{undatedCount} 筆委託日期未確認，未列入今日清單</summary>
        <p>僅讀回原紀錄核對日期；不推定為今日或已撤銷。</p>
        {today.undatedStages.map(item => <div key={String(item.row.id)}><span>{text(record(item.row.raw).symbol)} · 本地來源日期待確認</span><button type="button" disabled={busy || localBusyIds.includes(String(item.row.id))} onClick={() => void readStage(item.row)}>讀回原紀錄</button></div>)}
        {today.undatedBrokers.map((order, index) => <div key={index}><span>{text(order.row.symbol)} · 券商日期待確認</span>{order.row.ownership === "MANAGED" && typeof order.row.execution_id === "string" && order.row.execution_id.trim() ? <BrokerOrderControls bridge={bridge} order={order} onRead={refresh}/> : <p>請使用更新委託讀取券商回報。</p>}</div>)}
      </details>}
      {notice && <p role="status">{unknown.length ? "操作結果待確認，請讀回原紀錄。" : "已讀回資料，請核對此單狀態。"}</p>}
      <TradeDetails value={{ trade_date: data?.trade_date, queried_at: data?.queried_at, quality: data?.quality, error: error || undefined, local_error: stageError || undefined }}/>
    </section>;
  }
  return <section className="workspace-desk-orders" aria-label="待送與已送委託">
    <section aria-label="本地待送單" className="workspace-local-orders">
      <div className="candidate-heading"><h3>待送單</h3><button type="button" disabled={reading || busy} onClick={() => void refresh()}>{reading ? "讀取中…" : "更新清單"}</button></div>
      {view !== "staged" && <label className="workspace-history-toggle"><input type="checkbox" checked={showCancelled} onChange={event => setShowCancelled(event.target.checked)}/>顯示已刪除紀錄</label>}
      {view === "staged" && <div className="workspace-order-pair" role="group" aria-label="待送單範圍">
        <button type="button" aria-pressed={!historySelected} onClick={() => setStageScope("today")}>當日（{stageViews.length - historyCount}）</button>
        <button type="button" aria-pressed={historySelected} onClick={() => setStageScope("history")}>歷史（{historyCount}）</button>
      </div>}
      {stageError && <p role="alert">本地清單讀取失敗 · 保留上次結果</p>}
      {historySelected ? <section aria-label="本地歷史紀錄">
        {groups.historyReview.length > 0 && <section aria-label="跨日待核對"><h4>跨日待核對（{groups.historyReview.length}）</h4><p>原委託尚無終態，請依原 ID 讀回核對。</p>{groups.historyReview.map(item => stageCard(item, undefined, true))}</section>}
        {groups.undated.length > 0 && <details className="workspace-order-details"><summary>建立日期待核對（{groups.undated.length}）</summary>{groups.undated.map(item => stageCard(item, undefined, true))}</details>}
        {historyStages.map(item => stageCard(item, undefined, true))}
        {historyCount === 0 && !stageError && <p>{reading ? "正在讀取清單…" : "沒有歷史紀錄。"}</p>}
      </section> : <>
        <section aria-label="本地目前委託">{view === "staged" && <h4>今日待送單（{mainStages.length}）</h4>}{mainStages.map(item => stageCard(item))}
          {mainStages.length === 0 && !stageError && <p>{reading ? "正在讀取清單…" : "目前沒有待送單。"}</p>}
        </section>
        {submittedStages.length > 0 && <section aria-label="當日已送委託"><h4>當日已送委託（{submittedStages.length}）</h4>{submittedStages.map(item => stageCard(item, undefined, true))}</section>}
        {groups.inactive.length > 0 && <section aria-label="當日草稿紀錄"><h4>當日草稿紀錄（{groups.inactive.length}）</h4>{groups.inactive.map(item => stageCard(item, undefined, true))}</section>}
        {reviewStages.length > 0 && <details className="workspace-order-details" aria-label="當日待核對"><summary>當日待核對（{reviewStages.length}）</summary>{reviewStages.map(item => stageCard(item, undefined, true))}</details>}
        {view !== "staged" && historyStages.length > 0 && <details className="workspace-order-details" aria-label="本地已結案與歷史紀錄"><summary>已結案／歷史紀錄（{historyStages.length}）</summary>{historyStages.map(item => stageCard(item))}</details>}
      </>}

      {stageError && <details className="workspace-order-details"><summary>開發診斷</summary><pre>{stageError}</pre></details>}
    </section>
    {notice && !selection && <div><p role="status">{unknown.length > 0 && /^(UNKNOWN|準備結果 UNKNOWN|本地操作結果待確認)/.test(notice) ? "操作結果待確認 · 請讀回" : /^本地操作未完成/.test(notice) ? "修改未完成 · 請核對或讀回" : /^(已刪除|修改已儲存|本地修改已確認|本地待送單已更新|本次請求確定未送出)/.test(notice) ? notice : "請核對清單狀態"}</p><TradeDetails value={notice}/></div>}
    {view !== "staged" && <section aria-label="券商委託">
      <div className="candidate-heading"><h3>券商委託</h3><button type="button" disabled={busy} onClick={() => void refresh()}>更新委託</button></div>
      {brokerFocusNotice && <p role="status">{brokerFocusNotice}</p>}
      {stageViews.filter(item => item.submitted && item.market === "US" && typeof item.execution.execution_id === "string").map(item => <article id={`broker-${item.execution.execution_id}`} tabIndex={-1} className="workspace-desk-row workspace-order-card" key={String(item.execution.execution_id)} aria-label={`${text(record(item.row.raw).symbol)} 美股委託`}><strong>{text(record(item.row.raw).symbol)} · 美股委託</strong><p>{orderStatus(item.execution.state)}</p><LiveOrderControls bridge={bridge} id={String(item.execution.execution_id)} market="US"/></article>)}
      {error && <p role="status" className="workspace-ticket-note">券商委託暫時無法讀取，本地掛單仍可管理。{data ? " 保留上次券商資料，可能已過期。" : ""}</p>}
      {!data && !error && <p>正在讀取券商委託…</p>}
      {data && <><p className="workspace-ticket-note">交易日 {text(data.trade_date)}；已送出不代表成交。</p>
        {Array.isArray(data.unparsed_reports) && data.unparsed_reports.length > 0 && <p className="workspace-ticket-note" role="status">{`有 ${data.unparsed_reports.length} 筆券商回報無法確認委託身分，請查看詳細資訊。`}</p>}
        <section aria-label="當日未完成與待核對委託"><h4>當日未完成／待核對委託（{currentOrders.length}）</h4>
          {currentOrders.map(presentBrokerCard)}
          {currentOrders.length === 0 && <p>尚未讀到當日未結委託</p>}
        </section>
        {checkOrders.length > 0 && <section aria-label="跨日待核對委託"><h4>跨日待核對（{checkOrders.length}）</h4><p>保留原狀態；換日不代表已取消。</p>{checkOrders.map(presentBrokerCard)}</section>}
        <details className="workspace-order-details" aria-label="歷史委託"><summary>歷史委託（{historicalOrders.length}）</summary>
          {historicalOrders.map(presentBrokerCard)}
          {historicalOrders.length === 0 && <p>本次沒有歷史紀錄。</p>}
        </details>
        {(data.broker_orders as unknown[]).length === 0 && <p>尚未讀到券商委託</p>}</>}
      <details className="workspace-order-details"><summary>開發診斷</summary>
        {error && <pre>{error}</pre>}
        {data && <><h4>Native 待送與已送紀錄</h4>
          {rows.length === 0 && <p>本次沒有 Native review；不推定券商沒有掛單。</p>}
          {rows.map(row => {
            let pin: DeskSelection | null = null;
            const stagedLink = stages.some(item => {
              const submission = record(record(item.manual_stage).submission), native = record(submission.native);
              return native.review_id === row.review_id;
            });
            try { if (row.state === "PREVIEW" && !stagedLink) pin = reviewSelection(row); } catch { /* Existing malformed/legacy reviews stay read-only. */ }
            const command = record(record(row.draft).command);
            return <article className="workspace-desk-row" key={String(row.review_id)}><strong>{text(command.symbol)} · <span className="workspace-order-direction" data-side={text(command.action)}>{orderDirection(command)}</span></strong>
              <p>{row.execution_id ? executionStatus(record(row.execution)) : orderStatus(row.state)} · <span className="workspace-order-tint" data-side={text(command.action)}>限價 {orderPrice(command.price)} · {orderQuantity(command.lot, command.quantity)}</span></p>
              <pre>{JSON.stringify(row, null, 2)}</pre>
              {stagedLink && <p>此紀錄屬於本地掛單，請從該筆本地掛單讀回。</p>}
              {unknown.includes(String(row.review_id)) ? <p role="status">此筆結果待確認，已鎖定重送；請核對原紀錄。</p> : pin && <button type="button" className="workspace-order-action" data-side={text(pin.command.action)} disabled={busy || !!error} onClick={() => open(pin!)}>送單</button>}
            </article>;
          })}<pre>{JSON.stringify(data, null, 2)}</pre></>}
      </details>
    </section>}
    {candidateId && <section aria-label="研究 Pending 待送"><h3>條件交易待送</h3><p>僅列出這筆候選的待送項目，與券商委託分開。</p>{pendingError && <p role="alert">候選待送項目暫時無法讀取，請展開詳細資訊查看原因。</p>}{pending.map(item => {
      let pin: DeskSelection | null = null; try { if (candidate) pin = pendingSelection(item, candidate); } catch { /* Backend truth is shown below without inventing a snapshot. */ }
      const raw = record(candidate?.raw);
      const manual = raw.space_id === "USER_SPACE" && candidate?.owner_id === "MCP";
      const direction = pin?.command ?? raw;
      return <article key={String(item.id)} className="workspace-desk-row"><strong>{text(raw.symbol)} · {orderStatus(item.state)}</strong><p className="workspace-order-tint" data-side={text(direction.action)}><strong className="workspace-order-direction">{orderDirection(direction)}</strong> · 限價 {orderPrice(item.price)} · {orderQuantity(raw.lot, item.quantity)}</p>
        {unknown.includes(String(item.id)) ? <p>結果待確認，不會自動重送。</p> : pin ? <button type="button" className="workspace-order-action" data-side={text(direction.action)} disabled={busy || !!pendingError} onClick={() => open(pin!)}>送單</button>
          : manual && !["SELECTED", "SELECTING", "SELECTION_UNKNOWN", "CANCELLED", "STALE"].includes(String(item.state)) ? <button type="button" className="workspace-order-action" data-side={text(direction.action)} disabled={busy} onClick={() => void prepare(item)}>建立待送快照</button> : <p>此候選尚無可送出的待送快照，僅供檢視。</p>}
        <details className="workspace-order-details"><summary>開發診斷</summary><pre>{JSON.stringify({ candidate, pending: item }, null, 2)}</pre></details></article>;
    })}{pendingError && <details><summary>開發診斷</summary><pre>{pendingError}</pre></details>}</section>}
    {selection && <SendOrderModal selection={selection} busy={busy} notice={selection.kind === "staged" && (!currentStageDecision(selection.snapshot) || (view === "staged" && stageCreatedDay(selection.snapshot, now) !== today)) ? "草稿已超過本次確認期限，請關閉後讀回原紀錄。" : ""} cancel={() => { if (!inFlight.current && selectedRef.current === selection) { selectedRef.current = null; setSelection(null); } }} confirm={() => void send(selection)}/>}
  </section>;
}

export function FillCapsules({ rows, bridge }: { rows: UnknownRecord[]; bridge?: CandidateBridge }) {
  return <>{stockGroups(rows.map(row => ({ symbol: row.symbol, row }))).map(group => <article className="workspace-order-card workspace-readback-card" key={group.key} aria-label={`${group.symbol} 成交`}>
    <header className="workspace-order-card-heading"><strong className="workspace-order-symbol">{group.symbol}<StockName bridge={bridge} symbol={group.symbol === "代號未提供" ? "" : group.symbol}/></strong><span>{group.rows.length} 筆成交</span></header>
    <div className="workspace-readback-entries">{group.rows.map(({ row }, index) => <section className="workspace-readback-entry" key={JSON.stringify([row.broker_key, row.fill_id, index])} aria-label={`${text(record(row.broker_key).trade_date)} ${orderDirection(row)}`}>
      <div className="workspace-readback-entry-heading"><strong className="workspace-order-direction" data-side={text(row.action)}>{orderDirection(row)}</strong><span>{text(record(row.broker_key).trade_date)}</span></div>
      <dl className="workspace-order-facts" data-side={text(row.action)}><div><dt>成交價</dt><dd className="workspace-order-tint">{orderPrice(row.price)}</dd></div><div><dt>成交數量</dt><dd className="workspace-order-tint">{orderQuantity(row.lot, row.quantity_shares)}</dd></div></dl>
    </section>)}</div>
  </article>)}</>;
}

export function InventoryCapsules({ inventory, bridge }: { inventory: UnknownRecord; bridge?: CandidateBridge }) {
  const groups = inventoryPresentation(inventory);
  const entry = ({ type, name, row, balance }: InventoryEntry, index: number) => <section className="workspace-readback-entry" key={`${type}-${index}`} aria-label={`${name} ${text(row.symbol)} 庫存`}>
    <div className="workspace-readback-entry-heading"><strong>{name}</strong>{balance === "unknown" && <span>餘額待確認</span>}</div>
    <dl className="workspace-order-facts"><div><dt>{type === "short_selling" ? "融券餘額（待回補）" : "今日餘額"}</dt><dd>{text(row.reported_total_shares)} 股</dd></div><div><dt>券商可出清 / 可下單</dt><dd>可出清 {text(row.closeable_shares)} 股<br/>可下單 {text(row.orderable_shares)} 股</dd></div></dl>
    {type === "cash" && <p className="workspace-ticket-note">零股欄位 {text(row.odd_shares)} 股（不另加總） · 零股可出清 {text(row.odd_closeable_shares)} 股</p>}
  </section>;
  const cards = (stocks: typeof groups.nonzero) => stocks.map(group => {
    const visible = group.rows.filter(row => row.balance !== "zero"), zeros = group.rows.filter(row => row.balance === "zero");
    return <article className="workspace-order-card workspace-readback-card" key={group.key} aria-label={`${group.symbol} 券商庫存`}>
      <header className="workspace-order-card-heading"><strong className="workspace-order-symbol">{group.symbol}<StockName bridge={bridge} symbol={group.symbol === "代號未提供" ? "" : group.symbol}/></strong></header>
      <div className="workspace-readback-entries">{(visible.length ? visible : zeros).map(entry)}</div>
      {visible.length > 0 && zeros.length > 0 && <details className="workspace-order-details"><summary>零餘額紀錄 · {zeros.length} 筆</summary><div className="workspace-readback-entries">{zeros.map(entry)}</div></details>}
    </article>;
  });
  return <>
    {cards(groups.nonzero)}
    {groups.unknown.length > 0 && <section aria-label="庫存餘額待確認"><h4>餘額待確認</h4><p className="workspace-ticket-note">欄位缺漏或未知，不視為零。</p>{cards(groups.unknown)}</section>}
    {groups.zero.length > 0 && <section className="workspace-zero-inventory" aria-label="零餘額紀錄"><TradeDetails label={`零餘額紀錄 · ${groups.zero.length} 檔`}><p>僅列出本次已回報為零的欄位；零值不代表已確認空手。</p>{cards(groups.zero)}</TradeDetails></section>}
    <div className="workspace-inventory-status">{inventoryTypes.map(([key, name]) => {
      const part = record(inventory[key]);
      return <section key={key} aria-label={`${name}券商庫存`}><h4>{name}回報 · {part.quality === "KNOWN" ? "已回報" : part.quality === "UNKNOWN" ? "未知" : "部分回報"}</h4>
        {part.complete !== true && <p>資料不全，零值不代表已確認空手。</p>}
        <p>查詢時間 {text(part.queried_at)} · 券商資料時間 {text(part.source_as_of)}</p>
        {!Array.isArray(part.items) ? <p>庫存未知，不視為零</p> : part.items.length === 0 && <p>{part.complete === true && part.empty_confirmed === true ? "已確認此類無持倉" : "本次未回傳庫存列，尚不能確認空手。"}</p>}
        <p>券商回報數量不等同交易授權；下單仍由既有風控驗證。</p>
      </section>;
    })}</div>
  </>;
}

export function BrokerReadback({ bridge, kind, active }: { bridge: CandidateBridge; kind: "fills" | "inventory"; active: boolean }) {
  const [data, setData] = useState<UnknownRecord | null>(null), [error, setError] = useState("");
  const [retry, setRetry] = useState(0), [loading, setLoading] = useState(false);
  const [fillScope, setFillScope] = useState<"today" | "history">("today"), [fillDate, setFillDate] = useState("");
  const readFlight = useRef<{ key: string; promise: Promise<UnknownRecord> }>();
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    setLoading(true);
    if (!readFlight.current || readFlight.current.key !== kind) {
      const flight = { key: kind, promise: deskCall(bridge, `omi_read_desk_${kind}`).then(value => brokerReadback(value, kind)) };
      readFlight.current = flight;
      void flight.promise.finally(() => { if (readFlight.current === flight) readFlight.current = undefined; }).catch(() => {});
    }
    void readFlight.current.promise.then(data => {
      if (!disposed) { setData(data); setError(""); }
    }).catch(err => { if (!disposed) setError(deskError(err)); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [bridge, active, kind, retry]);
  const fills = data ? fillView(data, fillScope, fillDate) : { dated: [], undated: [] };
  return <section className="workspace-broker-readback" aria-label={kind === "fills" ? "券商成交" : "券商庫存"}><div className="candidate-heading"><h3>{kind === "fills" ? "券商成交" : "券商庫存"}</h3><button type="button" disabled={loading} onClick={() => setRetry(value => value + 1)}>{loading ? "讀取中…" : "更新資料"}</button></div>
    {error && <p role="alert">券商資料暫時無法讀取。{data ? "保留上次資料，可能已過期。" : "請稍後更新資料。"}</p>}
    {!data && !error && <p>正在讀取券商資料…</p>}
    {data && <><p>交易日 {text(data.trade_date)}{data.quality === "KNOWN" ? "" : "；部分回報"}</p>
      {kind === "fills" ? <><div className="workspace-order-pair" role="group" aria-label="成交範圍"><button aria-pressed={fillScope === "today"} onClick={() => setFillScope("today")}>當日成交</button><button aria-pressed={fillScope === "history"} onClick={() => setFillScope("history")}>歷史成交</button></div>{fillScope === "history" && <label>已讀回歷史日期<input aria-label="成交日期" type="date" value={fillDate} onChange={event => setFillDate(event.target.value)}/></label>}<p>{data.fill_history_complete === true ? "完整回報" : "歷史資料不全"}</p><FillCapsules rows={fills.dated} bridge={bridge}/>{fills.dated.length === 0 && <p>此範圍尚未讀到成交。</p>}{fills.undated.length > 0 && <section aria-label="成交日期待核對"><h4>日期待核對</h4><FillCapsules rows={fills.undated} bridge={bridge}/></section>}</>
        : <InventoryCapsules inventory={record(data.inventory)} bridge={bridge}/>}</>}
    <TradeDetails value={{ error: error || undefined, data }}/>
  </section>;
}

export function DeskStatus({ bridge, active = true }: { bridge: CandidateBridge; active?: boolean }) {
  const [status, setStatus] = useState<UnknownRecord | null>(null), [error, setError] = useState("");
  const flight = useRef(false);
  useEffect(() => {
    if (!active) return;
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, generation = 0;
    const controller = new AbortController();
    setStatus(null); setError("");
    const schedule = () => { clearTimeout(timer); if (!disposed && !document.hidden) timer = setTimeout(() => void poll(), 15_000); };
    const poll = async () => {
      if (disposed || document.hidden) return;
      if (flight.current) { schedule(); return; }
      flight.current = true;
      const token = ++generation;
      try {
        const value = await deskCall(bridge, "omi_read_desk_status", {}, controller.signal);
        deskConnection(value);
        if (!disposed && token === generation) { setStatus(value as UnknownRecord); setError(""); }
      } catch (err) { if (!disposed && token === generation) setError(deskError(err)); }
      finally { flight.current = false; schedule(); }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (document.hidden) { generation++; setError("頁籤隱藏，狀態輪詢已暫停。"); } // Discard late hidden responses.
      else void poll();
    };
    document.addEventListener("visibilitychange", visibility);
    void poll();
    // Abort only the bridge wait/scheduling. This never cancels a remote SDK
    // operation; disposed/generation also guard uncancellable legacy replies.
    return () => { disposed = true; generation++; controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [bridge, active]);
  const connection = record(status?.connection), busy = record(connection.busy), read = record(connection.last_broker_read);
  const bool = (value: unknown) => value === true ? "是" : value === false ? "否" : "未提供";
  const actual = ({ STARTING: "啟動中", CONNECTING: "連線中", ONLINE: "已連線", RECOVERING: "恢復中", BACKOFF: "等待重試", BLOCKED: "受阻", STOPPING: "停止中", OFFLINE: "離線" } as Record<string, string>)[String(connection.actual)];
  const us = record(connection.us);
  const usLabel = us.market !== "US" ? "尚無連線資料" : us.account_bound === false ? "帳戶未綁定" : us.connected === true ? "已連線" : us.connected === false ? "未連線" : "尚待確認";
  return <div className="workspace-desk-status">
    <p className="workspace-ticket-note" role="status">{error ? "券商連線暫時無法確認，本地掛單仍可管理。" : status ? `台股連線：${actual}。` : "正在讀取券商連線資訊…"}</p>
    {status && <><p className="workspace-ticket-note">美股連線：{usLabel}。{us.ready === false && us.account_bound === true ? "目前尚未就緒。" : ""}</p>
      {(error || read.stale === true) && <p role="status" className="workspace-ticket-note">以下為上次讀取，尚未更新；券商資料可能已過期。</p>}
      {(connection.date_ready === false || connection.ready === false || connection.busy !== null) && <p className="workspace-ticket-note">{connection.busy !== null ? "券商正在處理其他請求。" : "台股交易程序尚未就緒。"}{connection.date_ready === false ? " 交易日尚待確認。" : ""}</p>}
      <details className="workspace-order-details workspace-connection-details"><summary>連線詳情{read.observed_at ? ` · 最近回讀 ${text(read.observed_at)}` : " · 尚無券商回讀"}</summary>
      <p className="workspace-ticket-note">連線與程序就緒不代表委託可送出、券商受理或成交。</p>
      <dl className="workspace-order-facts">
        <div><dt>連線意圖</dt><dd>{connection.desired === "ONLINE" ? "維持連線" : "保持離線"}</dd></div>
        <div><dt>實際狀態</dt><dd>{actual}</dd></div>
        <div><dt>交易日（台北）</dt><dd>{text(connection.trade_date)}</dd></div>
        <div><dt>交易日就緒</dt><dd>{bool(connection.date_ready)}</dd></div>
        <div><dt>工作階段代數／綁定</dt><dd>{text(connection.session_generation)}／{bool(connection.session_bound)}</dd></div>
        <div><dt>程序就緒</dt><dd>{bool(connection.ready)}</dd></div>
        <div><dt>SDK 忙碌</dt><dd>{connection.busy === null ? "否" : `${text(busy.operation)} · ${text(busy.started_at)}`}</dd></div>
        <div><dt>已觀察斷線</dt><dd>{bool(connection.disconnect_observed)}</dd></div>
        <div><dt>最後券商讀取</dt><dd>{connection.last_broker_read === null ? "尚無讀取證據" : `${text(read.status)} · ${text(read.observed_at)} · 工作階段 ${text(read.session_generation)} · 距今 ${text(read.age_seconds)} 秒 · 過期：${bool(read.stale)}`}</dd></div>
        <div><dt>最後連線錯誤</dt><dd>{connection.last_error === null ? "無已記錄錯誤" : text(connection.last_error)}</dd></div>
      </dl><TradeDetails value={status}/></details></>}
    {error && <TradeDetails value={error} label="查看連線錯誤"/>}
  </div>;
}
