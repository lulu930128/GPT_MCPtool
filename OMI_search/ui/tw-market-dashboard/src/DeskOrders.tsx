import { ProtectionFields, LiveOrderControls, BrokerOrderControls } from "./OrderProtection";
import { brokerOrderViews, stageOrderView, fillView, type BrokerOrderView } from "./broker-orders";
import { useEffect, useRef, useState } from "react";
import { isRecord, type UnknownRecord } from "./state";
import type { CandidateBridge } from "./candidate-state";
import { localRejection } from "./research-contract";
import { TradeDetails } from "./TradeFeedback";
import { OrderTechnicalSummary, type OrderResearchCache } from "./OrderTechnicalSummary";
import { localStageResult, type LocalStageChange } from "./desk-contract";
import { brokerReadback, confirmDeskSelection, deskCall, deskConnection, deskError, deskOrderRead, deskReviews, pendingSelection, reviewSelection, readStaged, sameStagedSelection, stageNotAttempted, stageRecord, stageSelection, stageNativeReview, type DeskSelection } from "./desk-contract";

const record = (value: unknown): UnknownRecord => isRecord(value) ? value : {};
const text = (value: unknown) => value === null || value === undefined ? "未提供" : String(value);

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
  const side = { Buy: "買進", Sell: "賣出" }[String(command.action)];
  return condition && side ? command.condition === "CASH_SELLING" ? `${condition}（${side}）` : `${condition}${side}` : "交易類別待確認";
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

export function SendOrderModal({ selection, busy, notice, cancel, confirm }: {
  selection: DeskSelection; busy: boolean; notice: string; cancel(): void; confirm(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current, previous = document.activeElement as HTMLElement | null;
    element?.showModal();
    return () => { element?.close(); previous?.focus({ preventScroll: true }); };
  }, []);
  const command = selection.command;
  return <dialog ref={dialog} className="workspace-send-modal" aria-labelledby="workspace-send-title" onCancel={event => { event.preventDefault(); if (!busy) cancel(); }}>
    <h2 id="workspace-send-title">確認送出此筆委託</h2>
    <p>請核對股票、方向、限價與數量。確認後送交券商；已送出不代表成交。</p>
    <dl>{[["股票", command.symbol], ["交易類別", orderDirection(command)], ["限價", orderPrice(command.price)], ["數量", orderQuantity(command.lot, command.quantity)], ...(command.trade_date ? [["交易日", command.trade_date]] : [])].map(([label, value]) => <div key={String(label)}><dt>{text(label)}</dt><dd>{text(value)}</dd></div>)}</dl>
    <p>{command.market === "US" ? "美股 · USD" : "台股 · TWD"}</p>
    {command.market === "US" && <p>交割：{command.settlement_mode === "TWD" ? "台幣" : "外幣"}</p>}
    {isRecord(command.protection) && <div><p>停損 {orderPrice(command.protection.stop_loss)} · 停利 {orderPrice(command.protection.take_profit)}</p>
      {Array.isArray(command.protection.targets) && command.protection.targets.map((value, index) => { const target = record(value); return <p key={index}>目標 {index + 1}：{orderPrice(target.price)} · {Number(target.fraction) * 100}%</p>; })}
      <p>本機出場規則隨此單採用，可在原訂單修改。</p></div>}
    {selection.conditions !== undefined && <details><summary>觸發條件</summary><pre>{JSON.stringify(selection.conditions, null, 2)}</pre></details>}
    <details className="workspace-order-details"><summary>開發診斷</summary><pre>{JSON.stringify({ id: selection.id, revision: selection.revision, digest: selection.digest, owner: selection.owner, source: selection.source, snapshot: selection.snapshot }, null, 2)}</pre></details>
    {notice && <p role="alert">{notice}</p>}
    <div className="workspace-order-pair"><button type="button" autoFocus disabled={busy} onClick={cancel}>取消</button><button type="button" className="candidate-primary" disabled={busy || !!notice} onClick={confirm}>{busy ? "送出中…" : "確認送單"}</button></div>
  </dialog>;
}

export function DeskOrders({ bridge, active, candidateId, focusStageId, brokerTarget, onNavigateBroker, refreshKey, view = "all" }: { bridge: CandidateBridge; active: boolean; candidateId?: string; focusStageId?: string; brokerTarget?: { id: string; market: string }; onNavigateBroker?: (target: { id: string; market: string }) => void; refreshKey: number; view?: "all" | "staged" | "orders" }) {
  const [data, setData] = useState<UnknownRecord | null>(null), [error, setError] = useState("");
  const [candidate, setCandidate] = useState<UnknownRecord | null>(null), [pending, setPending] = useState<UnknownRecord[]>([]), [pendingError, setPendingError] = useState("");
  const [selection, setSelection] = useState<DeskSelection | null>(null), [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false), [unknown, setUnknown] = useState<string[]>([]);
  const [stages, setStages] = useState<UnknownRecord[]>([]), [stageError, setStageError] = useState("");
  const [edit, setEdit] = useState<{ row: UnknownRecord; raw: UnknownRecord } | null>(null);
  const [showCancelled, setShowCancelled] = useState(false), [reading, setReading] = useState(false), [localBusyIds, setLocalBusyIds] = useState<string[]>([]);
  const inFlight = useRef(false), selectedRef = useRef<DeskSelection | null>(null), generation = useRef(0);
  const localChanges = useRef(new Map<string, LocalStageChange>()), refreshFlight = useRef<Promise<void> | null>(null);
  const refreshToken = useRef(-1), refreshView = useRef("");
  const brokerFlight = useRef<Promise<unknown> | null>(null);
  const localFlights = useRef(new Set<string>()), localReads = useRef(new Map<string, number>());
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
    if (card) { card.focus({ preventScroll: true }); card.scrollIntoView({ block: "nearest" }); focused.current = focusStageId; }
  }, [active, view, focusStageId, stages]);
  // Only this await's terminal NOT_ATTEMPTED receipt can permit an exact local
  // read to release its latch. Actual/uncertain submissions retain the ID latch.
  const attemptedStages = useRef(new Map<string, DeskSelection & { notAttempted?: boolean }>());
  const refresh = (): Promise<void> => {
    const key = `${view}:${candidateId ?? ""}`;
    if (refreshFlight.current && refreshToken.current === generation.current && refreshView.current === key) return refreshFlight.current;
    const task = performRefresh().finally(() => { if (refreshFlight.current === task) { refreshFlight.current = null; setReading(false); } });
    refreshToken.current = generation.current; refreshView.current = key;
    refreshFlight.current = task; return task;
  };
  const performRefresh = async () => {
    setReading(true);
    const token = ++generation.current;
    // Local storage reads must render even while Native is slow/offline.
    const local = readStaged(bridge).then(rows => { if (token === generation.current) { setStages(previous => {
      const merged = rows.map(row => { const current = previous.find(item => item.id === row.id);
        return current && (Number(current.revision) > Number(row.revision) || localChanges.current.has(String(row.id))) ? current : row; });
      return [...merged, ...previous.filter(row => !rows.some(item => item.id === row.id))];
    }); setStageError(""); } })
      .catch(err => { if (token === generation.current) setStageError(deskError(err)); });
    const candidateRead = async () => {
      if (!candidateId) { setCandidate(null); setPending([]); return; }
      try {
        const [detail, items] = await Promise.all([deskCall(bridge, "omi_read_candidate", { id: candidateId }), deskCall(bridge, "omi_read_candidate_pending", { id: candidateId })]);
        if (!isRecord(detail) || detail.id !== candidateId || !Array.isArray(items) || items.some(item => !isRecord(item) || item.candidate_id !== candidateId)) throw Error("研究 Pending 回傳身份不符");
        if (token === generation.current) { setCandidate(detail); setPending(items as UnknownRecord[]); setPendingError(""); }
      } catch (err) { if (token === generation.current) { setPending([]); setCandidate(null); setPendingError(deskError(err)); } }
    };
    const candidates = candidateRead();
    // Local drafts do not require an expensive Native orders read. Submitted
    // rows are read explicitly or on the broker tab; status remains independent.
    if (view === "staged") { await Promise.all([local, candidates]); return; }
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
    let disposed = false, running = false, timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      if (disposed || document.hidden || running) return;
      running = true;
      // An old view's read may finish, but must not overwrite the new view.
      if (disposed || document.hidden) { running = false; return; }
      if (!inFlight.current) await refresh();
      running = false;
      if (!disposed && !document.hidden) timer = setTimeout(() => void run(), 30_000);
    };
    const visible = () => { clearTimeout(timer); if (!document.hidden) void run(); };
    document.addEventListener("visibilitychange", visible); void run();
    return () => { disposed = true; generation.current++; clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [bridge, active, candidateId, refreshKey, view]);
  const open = (value: DeskSelection) => { if (inFlight.current || selectedRef.current || localChanges.current.has(value.id) || unknown.includes(value.id) || attemptedStages.current.has(value.id)) return; selectedRef.current = value; setSelection(value); setNotice(""); };
  const send = async (expected: DeskSelection) => {
    const pin = selectedRef.current;
    if (!pin || pin !== expected || inFlight.current || localChanges.current.has(pin.id) || unknown.includes(pin.id) || attemptedStages.current.has(pin.id)) return;
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
  const brokerCard = (order: BrokerOrderView, index: number) => {
    const row = order.row;
    return <article id={row.execution_id ? `broker-${row.execution_id}` : undefined} tabIndex={-1} key={JSON.stringify([row.execution_id, row.broker_key, index])} className="workspace-desk-row workspace-order-card" aria-label={`${text(row.symbol)} 券商委託`}>
      <header className="workspace-order-card-heading"><div><strong className="workspace-order-symbol">{text(row.symbol)}</strong><span className="workspace-order-direction" data-side={text(row.action)}>{orderDirection(row)}</span></div><span className="workspace-order-status">{order.needsCheck ? "待核對" : orderStatus(order.state)}</span></header>
      <dl className="workspace-order-facts"><div><dt>限價</dt><dd>{orderPrice(row.price)}</dd></div><div><dt>數量</dt><dd>{orderQuantity(row.lot, row.quantity_shares)}</dd></div><div><dt>交易日</dt><dd>{text(record(row.broker_key).trade_date)}</dd></div></dl>
      <p className="workspace-ticket-note">已知成交 {text(row.known_filled_shares)} 股{row.fill_history_complete === true ? "" : " · 部分回報"}</p>
      {order.needsCheck && <p className="workspace-ticket-note">待核對 · 請讀回</p>}
      {row.ownership === "MANAGED" && typeof row.execution_id === "string" && row.execution_id.trim() === row.execution_id && row.execution_id.length > 0
        && <><BrokerOrderControls bridge={bridge} order={order} onRead={refresh}/><LiveOrderControls bridge={bridge} id={row.execution_id} market="TW" cancelAllowed={false}/></>}
      <OrderTechnicalSummary bridge={bridge} symbol={String(row.symbol ?? "")} market="TW" cache={researchCache.current}/>
      <TradeDetails value={{ row, note: order.note }}/>
    </article>;
  };
  const visibleStages = stages.filter(row => (showCancelled || row.id === focusStageId || row.lifecycle !== "CANCELLED" || unknown.includes(String(row.id)))
    && (view === "all" || unknown.includes(String(row.id)) || (view === "orders" ? record(row.manual_stage).submission !== null : record(row.manual_stage).submission === null)));
  const stageViews = visibleStages.map(row => ({ row, ...stageOrderView(row, data, brokerRows, !!error || !!stageError) }));
  const mainStages = stageViews.filter(item => view === "staged" || !item.history || item.historicalUnknown || item.row.id === focusStageId), historyStages = stageViews.filter(item => view !== "staged" && item.history && !item.historicalUnknown && item.row.id !== focusStageId);
  const stageCard = (item: typeof stageViews[number]) => {
        const { row, linked, execution, cancelOrder } = item;
        const raw = record(row.raw); let pin: DeskSelection | null = null;
        try { pin = stageSelection(row); } catch { /* Backend state stays visible; only STAGED is actionable. */ }
        const locked = localBusyIds.includes(String(row.id)) || unknown.includes(String(row.id)) || attemptedStages.current.has(String(row.id));
        const needsRead = unknown.includes(String(row.id)) || !!stageError || attemptedStages.current.has(String(row.id)) || String(row.lifecycle).startsWith("SUBMISSION_") || ["SUBMITTING", "SUBMITTED"].includes(String(row.lifecycle));
        const status = stageStatus(row);
        const label = item.historicalUnknown ? "歷史待核對" : item.submitted && item.needsCheck ? "待核對" : linked ? executionStatus(execution) : status.label;
        const receiptExecution = record(record(record(record(row.manual_stage).submission).receipt).execution);
        const executionId = String(execution.execution_id ?? receiptExecution.execution_id ?? "");
        const nativeChanged = !!linked && JSON.stringify(execution) !== JSON.stringify(receiptExecution);
        return <article id={`stage-${row.id}`} tabIndex={-1} data-highlighted={row.id === focusStageId} className="workspace-desk-row workspace-order-card" key={String(row.id)} aria-label={`${text(raw.symbol)} 本地掛單`}>
          <header className="workspace-order-card-heading"><div><strong className="workspace-order-symbol">{text(raw.symbol)}</strong><span className="workspace-order-direction" data-side={text(raw.action)}>{orderDirection(raw)}</span></div><span className="workspace-order-status">{label}</span></header>
          <dl className="workspace-order-facts"><div><dt>委託限價 · {raw.market === "US" ? "USD" : "TWD"}</dt><dd>{orderPrice(raw.price)}</dd></div><div><dt>委託數量</dt><dd>{orderQuantity(raw.lot, raw.quantity_shares)}</dd></div>{item.submitted && <div><dt>原委託日</dt><dd>{item.date ?? "待核對"}</dd></div>}{linked && <div><dt>已成交</dt><dd>{text(execution.filled_shares)} 股</dd></div>}</dl>
          {item.needsCheck && item.submitted && <p className="workspace-ticket-note">待核對 · 請讀回</p>}
          {executionId && <button type="button" onClick={() => onNavigateBroker?.({ id: executionId, market: item.market })}>前往此筆券商委託</button>}
          {nativeChanged && <p className="workspace-ticket-note">委託讀回：{executionStatus(execution)}。</p>}
          {unknown.includes(String(row.id)) && <p role="status">操作結果待確認 · 請讀回</p>}
          {attemptedStages.current.get(String(row.id))?.notAttempted && <p role="status">本次請求確定未送出；請讀回同一掛單後再手動確認。</p>}
          <div className="workspace-order-actions">
            {pin && <><button type="button" disabled={locked || !!stageError || !!selection} onClick={() => setEdit({ row, raw: { ...raw } })}>修改</button>
              <button type="button" disabled={locked || !!stageError || edit?.row.id === row.id || selection?.id === row.id} onClick={() => void changeStage(row)}>刪除</button>
              <button type="button" className="candidate-primary" disabled={locked || !!stageError || edit?.row.id === row.id} onClick={() => open(pin!)}>送單</button></>}
          {localBusyIds.includes(String(row.id)) && <span role="status">處理中…</span>}
          {(needsRead || localChanges.current.has(String(row.id))) && <button type="button" disabled={busy || localBusyIds.includes(String(row.id))} onClick={() => void readStage(row)}>讀回</button>}
          </div>
      {edit && edit.row.id === row.id && <form className="workspace-stage-edit" aria-label="修改本地待送單" onSubmit={event => { event.preventDefault(); void changeStage(edit.row, edit.raw); }}>
        <h3>修改 {text(record(edit.row.raw).symbol)} 的本地掛單</h3><p>數量以股輸入；儲存後仍須按「送單」並確認才會送交券商。</p>
        {[["symbol", "修改股票代碼"], ["price", "修改價格"], ["quantity_shares", "修改股數"]].map(([key, label]) => <label key={key}>{label}<input aria-label={label} value={text(edit.raw[key])} disabled={localBusyIds.includes(String(edit.row.id)) || unknown.includes(String(edit.row.id))} onChange={event => setEdit({ ...edit, raw: { ...edit.raw, [key]: key === "quantity_shares" ? Number(event.target.value) : event.target.value } })}/></label>)}
        {isRecord(edit.raw.protection) && <ProtectionFields value={edit.raw.protection} onChange={protection => setEdit({ ...edit, raw: { ...edit.raw, protection } })} disabled={localBusyIds.includes(String(edit.row.id))}/>}
        {edit.raw.market === "US" && <label>交割方式<select value={String(edit.raw.settlement_mode ?? "MUT")} disabled={localBusyIds.includes(String(edit.row.id))} onChange={e => setEdit({ ...edit, raw: { ...edit.raw, settlement_mode: e.target.value } })}><option value="MUT">外幣交割</option><option value="TWD">台幣交割</option></select></label>}
        <div className="workspace-order-pair"><button type="submit" disabled={localBusyIds.includes(String(edit.row.id)) || unknown.includes(String(edit.row.id))}>儲存修改</button><button type="button" disabled={localBusyIds.includes(String(edit.row.id))} onClick={() => setEdit(null)}>關閉修改</button></div>
      </form>}
          <OrderTechnicalSummary bridge={bridge} symbol={String(raw.symbol ?? "")} market={item.market} cache={researchCache.current}/>
          <TradeDetails value={{ local: row, reason: item.reason, ...(linked ? { readback: { trade_date: data?.trade_date, queried_at: data?.queried_at, quality: data?.quality, review: linked } } : {}) }}><p>本地紀錄：{status.label}。{status.note}</p></TradeDetails>
        </article>;
  };
  return <section className="workspace-desk-orders" aria-label="待送與已送委託">
    <section aria-label="本地待送單" className="workspace-local-orders">
      <div className="candidate-heading"><h3>{view === "orders" ? "當日已送出／待核對" : "待送單"}</h3><button type="button" disabled={reading || busy} onClick={() => void refresh()}>{reading ? "讀取中…" : "更新清單"}</button></div>
      {view !== "orders" && <label className="workspace-history-toggle"><input type="checkbox" checked={showCancelled} onChange={event => setShowCancelled(event.target.checked)}/>顯示已刪除紀錄</label>}
      {view !== "orders" && <p className="workspace-ticket-note">修改／刪除僅限本地</p>}
      {stageError && <p role="alert">本地清單讀取失敗 · 保留上次結果</p>}
      <section aria-label="本地目前委託">{mainStages.map(stageCard)}
        {mainStages.length === 0 && !stageError && <p>{reading ? "正在讀取清單…" : view === "orders" ? "目前沒有當日未完成或待核對的本地已送紀錄。" : "目前沒有待送單。"}</p>}
      </section>
      {historyStages.length > 0 && <details className="workspace-order-details" aria-label="本地已結案與歷史紀錄"><summary>已結案／歷史紀錄（{historyStages.length}）</summary>
        {historyStages.map(stageCard)}
      </details>}

      {stageError && <details className="workspace-order-details"><summary>開發診斷</summary><pre>{stageError}</pre></details>}
    </section>
    {notice && !selection && <div><p role="status">{unknown.length > 0 && /^(UNKNOWN|準備結果 UNKNOWN|本地操作結果待確認)/.test(notice) ? "操作結果待確認 · 請讀回" : /^本地操作未完成/.test(notice) ? "修改未完成 · 請核對或讀回" : /^(已刪除|修改已儲存|本地修改已確認|本地待送單已更新|本次請求確定未送出)/.test(notice) ? notice : "請核對清單狀態"}</p><TradeDetails value={notice}/></div>}
    <section aria-label="券商委託" hidden={view === "staged"}>
      <div className="candidate-heading"><h3>券商委託</h3><button type="button" disabled={busy} onClick={() => void refresh()}>更新委託</button></div>
      {brokerFocusNotice && <p role="status">{brokerFocusNotice}</p>}
      {stageViews.filter(item => item.submitted && item.market === "US" && typeof item.execution.execution_id === "string").map(item => <article id={`broker-${item.execution.execution_id}`} tabIndex={-1} className="workspace-desk-row workspace-order-card" key={String(item.execution.execution_id)} aria-label={`${text(record(item.row.raw).symbol)} 美股委託`}><strong>{text(record(item.row.raw).symbol)} · 美股委託</strong><p>{orderStatus(item.execution.state)}</p><LiveOrderControls bridge={bridge} id={String(item.execution.execution_id)} market="US"/></article>)}
      {error && <p role="status" className="workspace-ticket-note">券商委託暫時無法讀取，本地掛單仍可管理。{data ? " 保留上次券商資料，可能已過期。" : ""}</p>}
      {!data && !error && <p>正在讀取券商委託…</p>}
      {data && <><p className="workspace-ticket-note">交易日 {text(data.trade_date)}；已送出不代表成交。</p>
        {Array.isArray(data.unparsed_reports) && data.unparsed_reports.length > 0 && <p className="workspace-ticket-note" role="status">{`有 ${data.unparsed_reports.length} 筆券商回報無法確認委託身分，請查看詳細資訊。`}</p>}
        <section aria-label="當日未完成與待核對委託"><h4>當日未完成／待核對委託（{currentOrders.length}）</h4>
          {currentOrders.map(brokerCard)}
          {currentOrders.length === 0 && <p>尚未讀到當日未結委託</p>}
        </section>
        {checkOrders.length > 0 && <section aria-label="跨日待核對委託"><h4>跨日待核對（{checkOrders.length}）</h4><p>保留原狀態；換日不代表已取消。</p>{checkOrders.map(brokerCard)}</section>}
        <details className="workspace-order-details" aria-label="歷史委託"><summary>歷史委託（{historicalOrders.length}）</summary>
          {historicalOrders.map(brokerCard)}
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
            return <article className="workspace-desk-row" key={String(row.review_id)}><strong>{text(command.symbol)} · {orderDirection(command)}</strong>
              <p>{row.execution_id ? executionStatus(record(row.execution)) : orderStatus(row.state)} · 限價 {orderPrice(command.price)} · {orderQuantity(command.lot, command.quantity)}</p>
              <pre>{JSON.stringify(row, null, 2)}</pre>
              {stagedLink && <p>此紀錄屬於本地掛單，請從該筆本地掛單讀回。</p>}
              {unknown.includes(String(row.review_id)) ? <p role="status">此筆結果待確認，已鎖定重送；請核對原紀錄。</p> : pin && <button type="button" disabled={busy || !!error} onClick={() => open(pin!)}>送單</button>}
            </article>;
          })}<pre>{JSON.stringify(data, null, 2)}</pre></>}
      </details>
    </section>
    {candidateId && <section aria-label="研究 Pending 待送"><h3>條件交易待送</h3><p>僅列出這筆候選的待送項目，與券商委託分開。</p>{pendingError && <p role="alert">候選待送項目暫時無法讀取，請展開詳細資訊查看原因。</p>}{pending.map(item => {
      let pin: DeskSelection | null = null; try { if (candidate) pin = pendingSelection(item, candidate); } catch { /* Backend truth is shown below without inventing a snapshot. */ }
      const manual = record(candidate?.raw).space_id === "USER_SPACE" && candidate?.owner_id === "MCP";
      return <article key={String(item.id)} className="workspace-desk-row"><strong>{text(record(candidate?.raw).symbol)} · {orderStatus(item.state)}</strong><p>限價 {orderPrice(item.price)} · {orderQuantity(record(candidate?.raw).lot, item.quantity)}</p>
        {unknown.includes(String(item.id)) ? <p>結果待確認，不會自動重送。</p> : pin ? <button type="button" disabled={busy || !!pendingError} onClick={() => open(pin!)}>送單</button>
          : manual && !["SELECTED", "SELECTING", "SELECTION_UNKNOWN", "CANCELLED", "STALE"].includes(String(item.state)) ? <button type="button" disabled={busy} onClick={() => void prepare(item)}>建立待送快照</button> : <p>此候選尚無可送出的待送快照，僅供檢視。</p>}
        <details className="workspace-order-details"><summary>開發診斷</summary><pre>{JSON.stringify({ candidate, pending: item }, null, 2)}</pre></details></article>;
    })}{pendingError && <details><summary>開發診斷</summary><pre>{pendingError}</pre></details>}</section>}
    {selection && <SendOrderModal selection={selection} busy={busy} notice="" cancel={() => { if (!inFlight.current && selectedRef.current === selection) { selectedRef.current = null; setSelection(null); } }} confirm={() => void send(selection)}/>}
  </section>;
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
  const fillCard = (row: UnknownRecord, index: number) => <article className="workspace-desk-row" key={JSON.stringify([row.broker_key, row.fill_id, index])}><strong>{text(row.symbol)} · {orderDirection(row)}</strong><p>{orderQuantity(row.lot, row.quantity_shares)} · 成交價 {orderPrice(row.price)} · {text(record(row.broker_key).trade_date)}</p></article>;
  return <section className="workspace-broker-readback" aria-label={kind === "fills" ? "券商成交" : "券商庫存"}><div className="candidate-heading"><h3>{kind === "fills" ? "券商成交" : "券商庫存"}</h3><button type="button" disabled={loading} onClick={() => setRetry(value => value + 1)}>{loading ? "讀取中…" : "更新資料"}</button></div>
    {error && <p role="alert">券商資料暫時無法讀取。{data ? "保留上次資料，可能已過期。" : "請稍後更新資料。"}</p>}
    {!data && !error && <p>正在讀取券商資料…</p>}
    {data && <><p>交易日 {text(data.trade_date)}{data.quality === "KNOWN" ? "" : "；部分回報"}</p>
      {kind === "fills" ? <><div className="workspace-order-pair" role="group" aria-label="成交範圍"><button aria-pressed={fillScope === "today"} onClick={() => setFillScope("today")}>當日成交</button><button aria-pressed={fillScope === "history"} onClick={() => setFillScope("history")}>歷史成交</button></div>{fillScope === "history" && <label>已讀回歷史日期<input aria-label="成交日期" type="date" value={fillDate} onChange={event => setFillDate(event.target.value)}/></label>}<p>{data.fill_history_complete === true ? "完整回報" : "歷史資料不全"}</p>{fills.dated.map(fillCard)}{fills.dated.length === 0 && <p>此範圍尚未讀到成交。</p>}{fills.undated.length > 0 && <section aria-label="成交日期待核對"><h4>日期待核對</h4>{fills.undated.map(fillCard)}</section>}</>
        : [["cash", "現股"], ["margin", "融資"], ["short_selling", "融券"]].map(([key, name]) => {
          const part = record(record(data.inventory)[key]);
          return <section key={key} aria-label={`${name}券商庫存`}><h3>{name}</h3>
            {part.complete !== true && <p>資料不全</p>}
            {Array.isArray(part.items) ? part.items.map((row, index) => <article key={index}><strong>{text(record(row).symbol)}</strong><p>回報總數 {text(record(row).reported_total_shares)} 股 · 零股 {text(record(row).odd_shares)} 股 · 可賣 {text(record(row).sellable_shares)}</p></article>) : <p>庫存未知，不視為零</p>}</section>;
        })}</>}
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
