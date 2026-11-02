import { useEffect, useRef, useState } from "react";
import { isRecord, type UnknownRecord } from "./state";
import type { CandidateBridge } from "./candidate-state";
import { brokerReadback, confirmDeskSelection, deskCall, deskError, deskReviews, pendingSelection, reviewSelection, readStaged, stageRecord, stageSelection, stageNativeReview, type DeskSelection } from "./desk-contract";

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
    PENDING: "券商結果待確認", ACCEPTED: "已受理", PARTIALLY_FILLED: "部分成交", FILLED: "已成交", REJECTED: "遭拒絕",
    CANCEL_PENDING: "撤銷處理中", CANCELLED: local ? "已取消（本地）" : "已撤銷", UNKNOWN: "待確認", RECONCILING: "核對中" } as Record<string, string>)[String(value)] ?? "狀態待確認";
}

export function stageStatus(row: UnknownRecord): { label: string; note: string } {
  const submission = record(record(row.manual_stage).submission), execution = record(record(submission.receipt).execution);
  if (row.lifecycle === "SUBMITTING") return { label: ["DRAFT", "PREVIEW", "CONFIRM"].includes(String(submission.phase)) ? "正在送出" : "送單進度待確認", note: "" };
  if (row.lifecycle === "SUBMISSION_PENDING") return { label: "券商結果待確認", note: submission.phase === "RESULT" ? "送單請求已返回；券商結果待確認。" : "券商結果尚未確認。" };
  if (row.lifecycle === "SUBMISSION_REJECTED") return { label: execution.state === "REJECTED" ? "遭拒絕" : "送單遭拒", note: execution.state === "REJECTED" ? "券商拒單結果已確認。" : "送單流程遭拒，尚無券商拒單證據。" };
  return { label: orderStatus(row.lifecycle, true), note: row.lifecycle === "SUBMITTED" ? "已送出不代表成交，請以券商回報為準。" : "" };
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
    {selection.conditions !== undefined && <details><summary>觸發條件</summary><pre>{JSON.stringify(selection.conditions, null, 2)}</pre></details>}
    <details className="workspace-order-details"><summary>詳細資訊與技術紀錄</summary><pre>{JSON.stringify({ id: selection.id, revision: selection.revision, digest: selection.digest, owner: selection.owner, source: selection.source, snapshot: selection.snapshot }, null, 2)}</pre></details>
    {notice && <p role="alert">{notice}</p>}
    <div className="workspace-order-pair"><button type="button" autoFocus disabled={busy} onClick={cancel}>取消</button><button type="button" className="candidate-primary" disabled={busy || !!notice} onClick={confirm}>{busy ? "送出中…" : "確認送單"}</button></div>
  </dialog>;
}

export function DeskOrders({ bridge, active, candidateId, refreshKey }: { bridge: CandidateBridge; active: boolean; candidateId?: string; refreshKey: number }) {
  const [data, setData] = useState<UnknownRecord | null>(null), [error, setError] = useState("");
  const [candidate, setCandidate] = useState<UnknownRecord | null>(null), [pending, setPending] = useState<UnknownRecord[]>([]), [pendingError, setPendingError] = useState("");
  const [selection, setSelection] = useState<DeskSelection | null>(null), [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false), [unknown, setUnknown] = useState<string[]>([]);
  const [stages, setStages] = useState<UnknownRecord[]>([]), [stageError, setStageError] = useState("");
  const [edit, setEdit] = useState<{ row: UnknownRecord; raw: UnknownRecord } | null>(null);
  const inFlight = useRef(false), selectedRef = useRef<DeskSelection | null>(null), generation = useRef(0);
  // Preserve the original one-shot ID latch even after a UI-only warning clears.
  const attemptedStages = useRef(new Map<string, DeskSelection>());
  const refresh = async () => {
    const token = ++generation.current;
    // Local storage reads must render even while Native is slow/offline.
    void readStaged(bridge).then(rows => { if (token === generation.current) { setStages(rows); setStageError(""); } })
      .catch(err => { if (token === generation.current) setStageError(deskError(err)); });
    try {
      const value = brokerReadback(await deskCall(bridge, "omi_read_desk_orders"), "orders"), reviews = deskReviews(value);
      if (token === generation.current) {
        setData(value); setError("");
        // Native review IDs retain their existing readback recovery. Candidate
        // IDs can only recover through readStage's original pin + exact join.
        setUnknown(previous => previous.filter(id => attemptedStages.current.has(id) || stages.some(row => row.id === id)
          || !reviews.some(row => row.review_id === id && !!row.execution_id)));
      }
    }
    catch (err) { if (token === generation.current) setError(deskError(err)); }
    if (candidateId) {
      try {
        const [detail, items] = await Promise.all([deskCall(bridge, "omi_read_candidate", { id: candidateId }), deskCall(bridge, "omi_read_candidate_pending", { id: candidateId })]);
        if (!isRecord(detail) || detail.id !== candidateId || !Array.isArray(items) || items.some(item => !isRecord(item) || item.candidate_id !== candidateId)) throw Error("研究 Pending 回傳身份不符");
        if (token === generation.current) { setCandidate(detail); setPending(items as UnknownRecord[]); setPendingError(""); }
      } catch (err) { if (token === generation.current) { setPending([]); setCandidate(null); setPendingError(deskError(err)); } }
    } else { setCandidate(null); setPending([]); }
  };
  useEffect(() => {
    if (!active) return;
    void refresh(); const timer = setInterval(() => { if (!document.hidden && !inFlight.current) void refresh(); }, 30_000);
    return () => { generation.current++; clearInterval(timer); };
  }, [bridge, active, candidateId, refreshKey]);
  const open = (value: DeskSelection) => { if (inFlight.current || unknown.includes(value.id) || attemptedStages.current.has(value.id)) return; selectedRef.current = value; setSelection(value); setNotice(""); };
  const send = async () => {
    const pin = selectedRef.current;
    if (!pin || inFlight.current || unknown.includes(pin.id) || attemptedStages.current.has(pin.id)) return;
    generation.current++; // Discard reads begun before this pinned mutation.
    inFlight.current = true; selectedRef.current = null; setBusy(true);
    if (pin.kind === "staged") attemptedStages.current.set(pin.id, pin);
    try {
      const receipt = await confirmDeskSelection(bridge, pin);
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
    catch (err) { setUnknown(previous => [...previous, pin.id]); setNotice(`UNKNOWN · ${deskError(err)}；只讀回，不會自動重送。`); }
    finally { inFlight.current = false; setBusy(false); setSelection(null); if (pin.kind === "staged") await readStage(pin.snapshot); else await refresh(); }
  };
  const readStage = async (expected: UnknownRecord) => {
    const id = String(expected.id), token = ++generation.current;
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
    if (inFlight.current || unknown.includes(id) || attemptedStages.current.has(id)) return;
    generation.current++;
    inFlight.current = true; setBusy(true);
    try {
      const result = stageRecord(await deskCall(bridge, raw ? "omi_revise_candidate" : "omi_cancel_candidate",
        { id, expected_revision: row.revision, ...(raw ? { raw } : {}) }), raw);
      if (result.id !== id || Number(result.revision) <= Number(row.revision)) throw Error("修改回應 ID／版號未確認");
      setStages(previous => previous.map(item => item.id === id ? result : item)); setEdit(null);
      setNotice(`本地待送單 ${id} · ${text(result.lifecycle)}`);
    } catch (err) { setUnknown(previous => [...previous, id]); setNotice(`UNKNOWN · ${deskError(err)}；保留草稿，只讀回原 ID。`); await readStage(row); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const prepare = async (item: UnknownRecord) => {
    if (inFlight.current || unknown.includes(String(item.id))) return;
    inFlight.current = true; setBusy(true);
    try { await deskCall(bridge, "omi_prepare_candidate_pending", { id: item.id }); setNotice("已讀取準備結果；尚未送單。請核對待送快照。"); }
    catch (err) { setUnknown(previous => [...previous, String(item.id)]); setNotice(`準備結果 UNKNOWN · ${deskError(err)}；不會自動重送。`); }
    finally { inFlight.current = false; setBusy(false); await refresh(); }
  };
  const rows = data ? deskReviews(data) : [];
  return <section className="workspace-desk-orders" aria-label="待送與已送委託">
    <section aria-label="本地待送單" className="workspace-local-orders"><h3>本地掛單</h3>
      <p className="workspace-ticket-note">修改與刪除只影響本地掛單，不會撤銷券商委託。</p>
      {stageError && <p role="alert">本地掛單暫時無法更新，保留上次清單。請讀回確認後再操作。</p>}
      {stages.map(row => {
        const raw = record(row.raw); let pin: DeskSelection | null = null;
        try { pin = stageSelection(row); } catch { /* Backend state stays visible; only STAGED is actionable. */ }
        const locked = busy || unknown.includes(String(row.id)) || attemptedStages.current.has(String(row.id));
        const needsRead = unknown.includes(String(row.id)) || !!stageError || attemptedStages.current.has(String(row.id)) || String(row.lifecycle).startsWith("SUBMISSION_") || ["SUBMITTING", "SUBMITTED"].includes(String(row.lifecycle));
        const status = stageStatus(row), linked = stageNativeReview(row, data), execution = record(linked?.execution);
        const receiptExecution = record(record(record(record(row.manual_stage).submission).receipt).execution);
        const nativeChanged = !!linked && JSON.stringify(execution) !== JSON.stringify(receiptExecution);
        return <article className="workspace-desk-row workspace-order-card" key={String(row.id)} aria-label={`${text(raw.symbol)} 本地掛單`}>
          <header className="workspace-order-card-heading"><div><strong className="workspace-order-symbol">{text(raw.symbol)}</strong><span className="workspace-order-direction" data-side={text(raw.action)}>{orderDirection(raw)}</span></div><span className="workspace-order-status">{status.label}</span></header>
          <dl className="workspace-order-facts"><div><dt>限價</dt><dd>{orderPrice(raw.price)}</dd></div><div><dt>數量</dt><dd>{orderQuantity(raw.lot, raw.quantity_shares)}</dd></div></dl>
          {status.note && <p className="workspace-ticket-note">{status.note}</p>}
          {nativeChanged && <p className="workspace-ticket-note">券商階段讀回：{orderStatus(execution.state)}。本地紀錄保留原狀態。</p>}
          {unknown.includes(String(row.id)) && <p role="status">操作結果待確認；請讀回此筆掛單，不會自動重送。</p>}
          <div className="workspace-order-actions">
            {pin && <><button type="button" disabled={locked || !!stageError || !!selection} onClick={() => setEdit({ row, raw: { ...raw } })}>修改</button>
              <button type="button" disabled={locked || !!stageError || !!edit || !!selection} onClick={() => void changeStage(row)}>刪除</button>
              <button type="button" className="candidate-primary" disabled={locked || !!stageError || !!edit} onClick={() => open(pin!)}>送單</button></>}
            {needsRead && <button type="button" disabled={busy} onClick={() => void readStage(row)}>讀回</button>}
          </div>
          <details className="workspace-order-details"><summary>詳細資訊與技術紀錄</summary><pre>{JSON.stringify(row, null, 2)}</pre>{linked && <><h4>精確關聯的 Native 讀回</h4><pre>{JSON.stringify({ trade_date: data?.trade_date, queried_at: data?.queried_at, quality: data?.quality, review: linked }, null, 2)}</pre></>}</details>
        </article>;
      })}
      {stages.length === 0 && !stageError && <p>目前沒有本地掛單。</p>}
      {edit && <form className="workspace-stage-edit" aria-label="修改本地待送單" onSubmit={event => { event.preventDefault(); void changeStage(edit.row, edit.raw); }}>
        <h3>修改 {text(record(edit.row.raw).symbol)} 的本地掛單</h3><p>數量以股輸入；儲存後仍須按「送單」並確認才會送交券商。</p>
        {[["symbol", "修改股票代碼"], ["price", "修改價格"], ["quantity_shares", "修改股數"]].map(([key, label]) => <label key={key}>{label}<input aria-label={label} value={text(edit.raw[key])} disabled={busy || unknown.includes(String(edit.row.id))} onChange={event => setEdit({ ...edit, raw: { ...edit.raw, [key]: key === "quantity_shares" ? Number(event.target.value) : event.target.value } })}/></label>)}
        <div className="workspace-order-pair"><button type="submit" disabled={busy || unknown.includes(String(edit.row.id))}>儲存修改</button><button type="button" disabled={busy} onClick={() => setEdit(null)}>關閉修改</button></div>
      </form>}
      {stageError && <details className="workspace-order-details"><summary>詳細資訊與技術紀錄</summary><pre>{stageError}</pre></details>}
    </section>
    {notice && !selection && <div><p role="status">{unknown.length > 0 && /^(UNKNOWN ·|準備結果 UNKNOWN)/.test(notice) ? "操作結果待確認；請讀回此筆掛單，不會自動重送。" : "操作已有回應，請以掛單狀態為準。"}</p><details className="workspace-order-details"><summary>詳細資訊與技術紀錄</summary><pre>{notice}</pre></details></div>}
    <section aria-label="券商委託">
      <div className="candidate-heading"><h3>券商委託</h3><button type="button" disabled={busy} onClick={() => void refresh()}>更新委託</button></div>
      {error && <p role="status" className="workspace-ticket-note">券商委託暫時無法讀取，本地掛單仍可管理。{data ? " 保留上次券商資料，可能已過期。" : ""}</p>}
      {!data && !error && <p>正在讀取券商委託…</p>}
      {data && <><p className="workspace-ticket-note">交易日 {text(data.trade_date)}；已送出不代表成交。</p>
        {Array.isArray(data.unparsed_reports) && data.unparsed_reports.length > 0 && <p className="workspace-ticket-note" role="status">{`有 ${data.unparsed_reports.length} 筆券商回報無法確認委託身分，請查看詳細資訊。`}</p>}
        {(data.broker_orders as UnknownRecord[]).map((row, index) => <article key={index} className="workspace-desk-row workspace-order-card">
          <header className="workspace-order-card-heading"><div><strong className="workspace-order-symbol">{text(row.symbol)}</strong><span className="workspace-order-direction" data-side={text(row.action)}>{orderDirection(row)}</span></div><span className="workspace-order-status">{orderStatus(row.execution_state ?? row.broker_status)}</span></header>
          <dl className="workspace-order-facts"><div><dt>限價</dt><dd>{orderPrice(row.price)}</dd></div><div><dt>數量</dt><dd>{orderQuantity(row.lot, row.quantity_shares)}</dd></div></dl>
          <p className="workspace-ticket-note">已知成交 {text(row.known_filled_shares)} 股{row.fill_history_complete === true ? "" : "；成交歷史尚不完整"}。</p>
          <details className="workspace-order-details"><summary>詳細資訊與技術紀錄</summary><pre>{JSON.stringify(row, null, 2)}</pre></details>
        </article>)}
        {(data.broker_orders as unknown[]).length === 0 && <p>本次沒有讀到券商委託；不代表券商沒有掛單。</p>}</>}
      <details className="workspace-order-details"><summary>詳細資訊與技術紀錄</summary>
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
              <p>{orderStatus(row.execution_id ? record(row.execution).state : row.state)} · 限價 {orderPrice(command.price)} · {orderQuantity(command.lot, command.quantity)}</p>
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
        <details className="workspace-order-details"><summary>詳細資訊與技術紀錄</summary><pre>{JSON.stringify({ candidate, pending: item }, null, 2)}</pre></details></article>;
    })}{pendingError && <details><summary>詳細資訊與技術紀錄</summary><pre>{pendingError}</pre></details>}</section>}
    {selection && <SendOrderModal selection={selection} busy={busy} notice="" cancel={() => { if (!inFlight.current) { selectedRef.current = null; setSelection(null); } }} confirm={() => void send()}/>}
  </section>;
}

export function BrokerReadback({ bridge, kind, active }: { bridge: CandidateBridge; kind: "fills" | "inventory"; active: boolean }) {
  const [data, setData] = useState<UnknownRecord | null>(null), [error, setError] = useState("");
  const [retry, setRetry] = useState(0), [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    setLoading(true);
    void deskCall(bridge, `omi_read_desk_${kind}`).then(value => {
      const data = brokerReadback(value, kind);
      if (!disposed) { setData(data); setError(""); }
    }).catch(err => { if (!disposed) setError(deskError(err)); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [bridge, active, kind, retry]);
  return <section className="workspace-broker-readback" aria-label={kind === "fills" ? "券商成交" : "券商庫存"}><div className="candidate-heading"><h3>{kind === "fills" ? "券商成交" : "券商庫存"}</h3><button type="button" disabled={loading} onClick={() => setRetry(value => value + 1)}>{loading ? "讀取中…" : "更新資料"}</button></div>
    {error && <p role="alert">券商資料暫時無法讀取。{data ? "保留上次資料，可能已過期。" : "請稍後更新資料。"}</p>}
    {!data && !error && <p>正在讀取券商資料…</p>}
    {data && <><p>交易日 {text(data.trade_date)}{data.quality === "KNOWN" ? "" : "；資料尚不完整，請查看詳細資訊。"}</p>
      {kind === "fills" ? <><p>{data.fill_history_complete === true ? "成交歷史完整。" : "成交歷史尚不完整，僅列已知成交。"}</p>{(data.fills as UnknownRecord[]).map((row, index) => <article className="workspace-desk-row" key={index}><strong>{text(row.symbol)} · {orderDirection(row)}</strong><p>{orderQuantity(row.lot, row.quantity_shares)} · 成交價 {orderPrice(row.price)}</p></article>)}{(data.fills as unknown[]).length === 0 && <p>本次沒有讀到成交；不推定完整成交歷史為空。</p>}</>
        : [["cash", "現股"], ["margin", "融資"], ["short_selling", "融券"]].map(([key, name]) => {
          const part = record(record(data.inventory)[key]);
          return <section key={key} aria-label={`${name}券商庫存`}><h3>{name}</h3>
            {part.complete !== true && <p>此類庫存資料尚不完整。</p>}
            {Array.isArray(part.items) ? part.items.map((row, index) => <article key={index}><strong>{text(record(row).symbol)}</strong><p>回報總數 {text(record(row).reported_total_shares)} 股 · 零股 {text(record(row).odd_shares)} 股 · 可賣 {text(record(row).sellable_shares)}</p></article>) : <p>目前沒有足夠資料確認庫存，不能視為零。</p>}</section>;
        })}</>}
    <details className="workspace-order-details"><summary>詳細資訊與技術紀錄</summary>{error && <pre>{error}</pre>}{data && <pre>{JSON.stringify(data, null, 2)}</pre>}</details>
  </section>;
}

export function DeskStatus({ bridge }: { bridge: CandidateBridge }) {
  const [status, setStatus] = useState<UnknownRecord | null>(null), [error, setError] = useState("");
  useEffect(() => { let disposed = false; void deskCall(bridge, "omi_read_desk_status").then(value => {
    if (!isRecord(value)) throw Error("Native session status 格式不符");
    if (!disposed) setStatus(value);
  }).catch(err => { if (!disposed) setError(deskError(err)); }); return () => { disposed = true; }; }, [bridge]);
  return <div className="workspace-desk-status"><p className="workspace-ticket-note" role="status">{error ? "券商連線暫時無法確認，本地掛單仍可管理。" : status ? "券商連線資訊已讀取。" : "正在讀取券商連線資訊…"}</p><details className="workspace-order-details"><summary>詳細資訊與技術紀錄</summary><pre>{error || JSON.stringify(status, null, 2)}</pre></details></div>;
}
