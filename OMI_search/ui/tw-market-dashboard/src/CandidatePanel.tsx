import { useEffect, useMemo, useState } from "react";
import { isRecord, type UnknownRecord } from "./state";
import { CandidateSession, candidateExample, json, visibleCandidates, type Candidate, type CandidateBridge, type Pending } from "./candidate-state";

const text = (value: unknown) => value === null || value === undefined ? "—" : String(value);
const numeric = (value: string) => value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : value;
const comparison = () => (candidateExample().conditions as { clauses: UnknownRecord[] }).clauses[0];

function ConditionEditor({ value, change, path = "條件" }: { value: unknown; change(value: unknown): void; path?: string }) {
  if (!isRecord(value)) return <button type="button" onClick={() => change({ kind: "AND", clauses: [comparison()] })}>加入條件</button>;
  if (value.kind === "AND" || value.kind === "OR") {
    const clauses = Array.isArray(value.clauses) ? value.clauses : [];
    return <fieldset className="candidate-condition"><legend>{path}</legend>
      <label>組合<select aria-label={`${path}組合`} value={value.kind} onChange={(event) => change({ ...value, kind: event.target.value })}><option>AND</option><option>OR</option></select></label>
      {clauses.map((clause, index) => <div className="candidate-clause" key={index}>
        <ConditionEditor path={`${path} ${index + 1}`} value={clause} change={(next) => change({ ...value, clauses: clauses.map((item, i) => i === index ? next : item) })}/>
        <button type="button" aria-label={`移除${path} ${index + 1}`} onClick={() => change({ ...value, clauses: clauses.filter((_, i) => i !== index) })}>移除</button>
      </div>)}
      <div className="candidate-actions"><button type="button" onClick={() => change({ ...value, clauses: [...clauses, comparison()] })}>加比較式</button>
        <button type="button" onClick={() => change({ ...value, clauses: [...clauses, { kind: "OR", clauses: [comparison()] }] })}>加子群組</button></div>
    </fieldset>;
  }
  if (value.kind !== "compare" || !isRecord(value.metric)) return <p role="alert">條件格式無法編輯；請使用下方原始 JSON。</p>;
  const metric = value.metric;
  const setMetric = (patch: UnknownRecord) => change({ ...value, metric: { ...metric, ...patch } });
  return <div className="candidate-grid">
    <label>指標<select aria-label={`${path}指標`} value={text(metric.kind)} onChange={(event) => {
      const kind = event.target.value;
      change({ ...value, metric: { kind, field: kind === "price" ? "last_trade" : kind === "rsi" ? "value" : "histogram", timeframe: kind === "price" ? "snapshot" : "1d", completed: true, parameters: kind === "price" ? [] : kind === "rsi" ? [14] : [12, 26, 9] } });
    }}><option value="price">Price · snapshot</option><option value="rsi">RSI · 1d</option><option value="macd">MACD · 1d</option></select></label>
    <label>欄位<select value={text(metric.field)} onChange={(event) => setMetric({ field: event.target.value })}>
      {(metric.kind === "price" ? ["last_trade", "bid", "ask", "indicative"] : metric.kind === "rsi" ? ["value"] : ["histogram", "macd", "signal"]).map((field) => <option key={field}>{field}</option>)}
    </select></label>
    {metric.kind !== "price" && <>
      <label>參數（逗號分隔）<input value={Array.isArray(metric.parameters) ? metric.parameters.join(",") : ""} onChange={(event) => setMetric({ parameters: event.target.value.split(",").map((v) => v.trim() === "" ? "" : numeric(v)) })}/></label>
      <label className="candidate-check"><input type="checkbox" checked={metric.completed === true} onChange={(event) => setMetric({ completed: event.target.checked })}/>已完成日 K</label>
    </>}
    <label>比較<select aria-label={`${path}比較`} value={text(value.operator)} onChange={(event) => change({ ...value, operator: event.target.value })}>{["<", "<=", ">", ">=", "=="].map((op) => <option key={op}>{op}</option>)}</select></label>
    <label>門檻<input aria-label={`${path}門檻`} type="number" step="any" value={value.value == null ? "" : String(value.value)} onChange={(event) => change({ ...value, value: event.target.value || null })}/></label>
  </div>;
}

function JsonDetails({ title, value }: { title: string; value: unknown }) {
  return <details className="candidate-json"><summary>{title}</summary><pre>{json(value)}</pre></details>;
}

function ConditionSummary({ value }: { value: unknown }) {
  if (!isRecord(value)) return <span className="candidate-muted">尚未設定</span>;
  if (value.kind === "AND" || value.kind === "OR") return <div className="candidate-condition-summary">
    {(Array.isArray(value.clauses) ? value.clauses : []).map((clause, index) => <div key={index}>
      {index > 0 && <span className="candidate-operator">{text(value.kind)}</span>}<ConditionSummary value={clause}/>
    </div>)}
  </div>;
  const metric = isRecord(value.metric) ? value.metric : {};
  const parameters = Array.isArray(metric.parameters) ? metric.parameters.join(",") : "";
  return <span className="candidate-expression">{metric.kind === "price" ? text(metric.field) : `${text(metric.kind).toUpperCase()}(${parameters}) ${metric.kind === "macd" ? text(metric.field) : ""}`} {text(value.operator)} {text(value.value)}
    {metric.timeframe === "1d" && <small>1d{metric.completed === true ? " · 已完成" : " · 未限定完成"}</small>}
  </span>;
}

function PendingEditor({ item, session, disabled }: { item: Pending; session: CandidateSession; disabled: boolean }) {
  const [editing, setEditing] = useState(false);
  const [base, setBase] = useState(item);
  const [price, setPrice] = useState(item.price == null ? "" : String(item.price));
  const [quantity, setQuantity] = useState(String(item.quantity ?? ""));
  const dirty = editing && (price !== (base.price == null ? "" : String(base.price)) || quantity !== String(base.quantity ?? ""));
  useEffect(() => { session.setPendingDirty(item.id, dirty); return () => session.setPendingDirty(item.id, false); }, [session, item.id, dirty]);
  const stale = base.revision !== item.revision;
  const terminal = ["CANCELLED", "STALE", "SELECTING", "SELECTED", "SELECTION_UNKNOWN"].includes(text(item.state));
  const load = () => { setBase(item); setPrice(item.price == null ? "" : String(item.price)); setQuantity(String(item.quantity ?? "")); };
  return <article className="candidate-pending">
    <div className="candidate-section-heading"><strong>{text(item.state)}</strong><small>v{item.revision}</small></div>
    <p>{text(item.price)} · {text(item.quantity)} 股</p>
    <JsonDetails title="資格與依據" value={{ qualification: item.qualification, evidence: item.evidence, price_evidence: item.price_evidence }}/>
    <JsonDetails title="Native 狀態" value={{ native: item.native, executor_status: item.executor_status, native_invalidation: item.native_invalidation, execution_receipt: item.execution_receipt }}/>
    {!editing ? <div className="candidate-actions">
      <button type="button" disabled={disabled || terminal} onClick={() => { load(); setEditing(true); }}>修改 Pending</button>
      <button type="button" disabled={disabled || terminal} onClick={() => void session.changePending(item)}>取消研究 Pending</button>
    </div> : <form onSubmit={async (event) => { event.preventDefault(); if (await session.changePending(base, price, Number(quantity))) setEditing(false); }}>
      {stale && <p role="alert" className="candidate-error">讀回 v{item.revision}；表單保留 v{base.revision}。<button type="button" disabled={disabled} onClick={load}>使用最新 Pending</button></p>}
      <fieldset disabled={disabled || stale || terminal}><legend>修改 Pending · v{base.revision}</legend>
        <div className="candidate-grid"><label>價格<input aria-label={`Pending ${item.id}價格`} type="number" min="0" step="any" required value={price} onChange={(event) => setPrice(event.target.value)}/></label>
          <label>股數<input aria-label={`Pending ${item.id}股數`} type="number" min="1" step="1" required value={quantity} onChange={(event) => setQuantity(event.target.value)}/></label></div>
        <div className="candidate-actions"><button type="submit">保存 Pending</button></div>
      </fieldset>
      <button type="button" disabled={disabled} onClick={() => { load(); setEditing(false); }}>取消修改</button>
    </form>}
  </article>;
}

function savedFieldReasons(detail: Candidate | null, key: string): string[] {
  if (!Array.isArray(detail?.validation_reasons)) return [];
  const related: Record<string, string[]> = { valid_from_date: ["INCOMPLETE_DATE", "INVALID_DATE_RANGE"], valid_until_date: ["INCOMPLETE_DATE", "INVALID_DATE_RANGE"],
    quantity: ["QUANTITY_UNIT_MISMATCH"], direction: ["INVALID_ENTRY_DIRECTION"], action: ["INVALID_ENTRY_DIRECTION"], condition: ["INVALID_ENTRY_DIRECTION"], lot: ["CREDIT_COMMON_REQUIRED"], conditions: ["INCOMPLETE_CONDITION"] };
  return detail.validation_reasons.filter((reason): reason is string => typeof reason === "string" && (reason.includes(`:${key}`) || related[key]?.includes(reason)));
}

export function CandidatePanel({ bridge, symbol, active, space = "USER_SPACE", onShowPending }: { bridge: CandidateBridge; symbol?: string; active: boolean; space?: string; onShowPending?: (id: string) => void }) {
  const session = useMemo(() => new CandidateSession(bridge, symbol), [bridge]);
  const [state, setState] = useState(session.state);
  const [rawText, setRawText] = useState("");
  const [rawError, setRawError] = useState("");
  const [leaving, setLeaving] = useState(false);
  useEffect(() => session.subscribe(setState), [session]);
  useEffect(() => session.syncSymbol(symbol), [session, symbol]);
  useEffect(() => { if (!state.dirty) { setRawText(json(state.draft)); setRawError(""); } }, [state.dirty, state.detail?.id, state.baseRevision, state.scopeSymbol, state.view]);
  useEffect(() => setLeaving(false), [state.view, state.scopeSymbol]);
  useEffect(() => {
    if (!active) return;
    void session.refresh();
    const timer = setInterval(() => { if (!document.hidden && !session.state.busy && !session.state.reading && !session.state.selecting) void session.refresh(); }, 30_000);
    return () => clearInterval(timer);
  }, [session, active]);
  const raw = state.draft, detail = state.detail;
  const edit = (key: string, value: unknown) => session.edit({ ...raw, [key]: value });
  const locked = state.busy || state.selecting || state.uncertain;
  const unknownCreateReadback = state.uncertain && !detail && state.readback && !state.busy && !state.selecting;
  const formView = state.view === "new" || state.view === "edit";
  const rows = visibleCandidates(state, space);
  const back = () => { if (!session.backToList()) setLeaving(true); };
  const reasons = Array.isArray(detail?.validation_reasons) ? detail.validation_reasons.filter((v): v is string => typeof v === "string") : [];
  const reminders = [...reasons.map((reason) => `候選：${reason}`),
    ...Object.entries(state.errors).filter(([key]) => ["history", "monitor"].includes(key)).map(([key, error]) => `${key}：${error}`),
    ...(state.pending ?? []).flatMap((item) => isRecord(item.qualification) && Array.isArray(item.qualification.reasons) ? item.qualification.reasons.map((reason) => `Pending v${item.revision}：${text(reason)}`) : []),
    ...(formView && raw.condition === "SHORT_SELLING" ? ["放空研究草稿；borrow UNKNOWN 與 upper 假設均不是送單資格或真實漲停價。"] : []),
    ...(state.hasMore ? [`已載入 ${state.rows?.length ?? 0} 筆；目前股票篩選僅涵蓋已載入資料。`] : []),
  ];
  const fieldError = (key: string) => savedFieldReasons(detail, key).map((reason) => <small className="candidate-field-error" key={reason}>上次保存：{reason}</small>);
  const selectRow = (row: Candidate) => void (unknownCreateReadback ? session.viewAfterUnknownCreate(row.id) : session.select(row.id));
  const rowButton = (row: Candidate, recovery = false) => <button type="button" key={row.id} className="candidate-row" disabled={locked && !(recovery && unknownCreateReadback)} onClick={() => selectRow(row)}>
    <span><strong>{text(row.raw.symbol)}</strong><small>{row.raw.direction === "short" ? "放空" : text(row.raw.direction) === "long" ? "做多" : text(row.raw.direction)} · {text(row.raw.quantity)} 股</small></span>
    <span><span className="candidate-state-label">{text(row.lifecycle ?? row.state)}</span><small>v{row.revision}</small></span>
  </button>;
  return <section className="candidate-panel" aria-label="候選單" data-view={state.view} data-symbol={state.scopeSymbol}>
    <p className="workspace-candidate-boundary">MCP 新候選固定 USER_SPACE / MANUAL / MCP；AGENT_SPACE 僅檢視與管理原 AI 候選。保存不會送單。</p>
    {formView && raw.space_id !== space && <p role="status">目前保留 {text(raw.space_id)} 草稿；切換檢視不會轉換或清除未保存內容。</p>}
    {state.pendingSymbol !== null && <div className="candidate-switch-prompt" role="alert">
      <strong>工作台已切換至 {state.pendingSymbol || "未選股"}</strong><p>目前 {text(raw.symbol)} 的編輯仍保留。</p>
      <div className="candidate-actions"><button type="button" onClick={() => session.keepEditing()}>保留編輯</button><button type="button" disabled={locked} onClick={() => session.discardAndSwitch()}>放棄編輯並切換</button></div>
      {state.uncertain && <p>請先核對 UNKNOWN 寫入結果，再切換候選。</p>}
    </div>}
    {state.scopeSymbol !== state.requestedSymbol && state.pendingSymbol === null && <p className="candidate-retained">保留 {state.scopeSymbol} 編輯 · 工作台 {state.requestedSymbol}<button type="button" onClick={() => session.syncSymbol(state.requestedSymbol)}>切換候選股票</button></p>}
    <header className="candidate-heading">
      <div>{state.view !== "list" && <button type="button" className="candidate-back" disabled={state.busy || state.selecting || state.uncertain} onClick={back}>‹ 清單</button>}
        <h2>{state.view === "list" ? "候選單" : state.view === "new" ? "新增候選" : state.view === "edit" ? "編輯候選" : text(detail?.raw.symbol)}</h2>
        <small>{formView && detail ? `編輯 v${state.baseRevision}` : state.view === "detail" ? `v${detail?.revision} · ${text(detail?.lifecycle ?? detail?.state)}` : state.scopeSymbol || "全部股票"}</small>
      </div>
      <div className="candidate-actions"><button type="button" aria-label="讀回候選資料" disabled={state.reading || state.busy || state.selecting} onClick={() => void session.refresh()}>{state.reading ? "讀取中…" : "更新"}</button>
        {state.view === "list" && <button className="candidate-primary" type="button" disabled={space !== "USER_SPACE" || locked || state.dirty || state.pendingDirty} onClick={() => session.start()}>＋ 新增</button>}</div>
    </header>
    {leaving && <div role="alert" className="candidate-switch-prompt"><p>尚有未保存修改。</p><div className="candidate-actions"><button type="button" onClick={() => setLeaving(false)}>保留編輯</button><button type="button" disabled={locked} onClick={() => { if (session.backToList(true)) setLeaving(false); }}>放棄修改並返回</button></div></div>}
    {Object.entries(state.errors).filter(([key]) => !["history", "monitor"].includes(key)).map(([key, error]) => <p className="candidate-error" role="alert" key={key}>{error}。{state[key === "selection" ? "detail" : key as keyof typeof state] == null ? "尚無可用資料。" : "保留上次資料，可能已過期。"}</p>)}
    {state.notice && <p role={state.uncertain || state.notice.includes("未保存") ? "alert" : "status"} aria-live="polite" className="candidate-notice">{state.notice}</p>}
    {(state.uncertain || (formView && detail && detail.revision !== state.baseRevision)) && <div className="candidate-error" role="alert">
      {state.uncertainPending ? "Pending 結果未知；請核對 Pending 讀回資料。" : detail ? `表單 v${state.baseRevision}，讀回 v${detail.revision}。草稿未被覆蓋。` : "清單成功不代表本次建立已確認，請查看已有記錄或重建空白草稿。"}
      {state.uncertainPending ? <button type="button" disabled={state.busy || !state.readback} onClick={() => session.acknowledgePendingReadback()}>已核對 Pending，繼續編輯</button>
        : detail ? <button type="button" disabled={state.busy || (state.uncertain && !state.readback)} onClick={() => session.adopt()}>使用讀回版本（取代草稿）</button>
        : <><button type="button" disabled={!unknownCreateReadback} onClick={() => session.rebuildAfterUnknownCreate()}>放下原草稿，重建空白草稿</button>
          <details><summary>查看已保存記錄</summary>{(state.rows ?? []).map((row) => rowButton(row, true))}</details></>}
    </div>}
    {state.view === "list" && <>
      <div className="candidate-filter" role="group" aria-label="候選範圍"><button type="button" aria-pressed={!state.showAll} onClick={() => session.setShowAll(false)}>目前股票{state.scopeSymbol ? ` ${state.scopeSymbol}` : ""}</button><button type="button" aria-pressed={state.showAll} onClick={() => session.setShowAll(true)}>全部</button><small>{rows.length} 筆</small></div>
      <div className="candidate-list" aria-label="已保存候選">
        {state.rows === null ? <p className="candidate-empty">{state.reading ? "讀取候選中…" : "尚未取得候選清單"}</p> : rows.length === 0 ? <div className="candidate-empty"><p>{state.showAll ? "沒有已保存候選" : `${state.scopeSymbol || "目前股票"} 尚無候選`}</p><button type="button" disabled={space !== "USER_SPACE" || locked} onClick={() => session.start()}>新增候選</button></div> : rows.map((row) => rowButton(row))}
      </div>
      {state.hasMore && <button type="button" disabled={state.reading || state.busy} onClick={() => void session.refresh(true)}>載入更多</button>}
    </>}
    {state.view === "detail" && detail && <div className="candidate-detail">
      <dl className="candidate-facts">
        <div><dt>方向</dt><dd><span className="workspace-order-direction" data-side={text(detail.raw.action)}>{detail.raw.action === "Buy" ? "買進" : detail.raw.action === "Sell" ? "賣出" : "方向待確認"}</span> · {text(detail.raw.direction)} · {text(detail.raw.action)} / {text(detail.raw.condition)}</dd></div>
        <div><dt>數量</dt><dd className="workspace-order-tint" data-side={text(detail.raw.action)}>{text(detail.raw.quantity)} 股 · {text(detail.raw.lot)}</dd></div>
        <div><dt>提議限價</dt><dd className="workspace-order-tint" data-side={text(detail.raw.action)}>{text(detail.raw.proposed_limit)} <small>{text(detail.raw.price_basis)}</small></dd></div>
        <div><dt>有效期間</dt><dd>{text(detail.raw.valid_from_date)} — {text(detail.raw.valid_until_date)}</dd></div>
      </dl>
      <section className="candidate-detail-section"><h3>觸發條件</h3><ConditionSummary value={detail.raw.conditions}/></section>
      <div className="candidate-actions"><button type="button" className="candidate-primary" disabled={locked || state.pendingDirty || detail.state === "CANCELLED"} onClick={() => session.beginEdit()}>編輯</button>
        <button type="button" disabled={locked || state.pendingDirty || detail.state === "CANCELLED"} onClick={() => void session.action(detail.state === "PAUSED" ? "resume" : "pause")}>{detail.state === "PAUSED" ? "恢復候選" : "暫停候選"}</button></div>
      <details className="candidate-disclosure"><summary>Pending <span>{state.pending?.length ?? "—"}</span></summary>
        {onShowPending && <button type="button" onClick={() => onShowPending(detail.id)}>到掛單頁查看此候選 Pending</button>}
        {state.pending === null ? <p>尚未取得 Pending</p> : state.pending.length === 0 ? <p>沒有 Pending</p> : state.pending.map((item) => <PendingEditor key={item.id} item={item} session={session} disabled={locked || !!state.errors.pending}/>)}</details>
      <JsonDetails title={`版本紀錄${state.history ? ` · ${state.history.length}` : ""}`} value={state.history}/>
      <details className="candidate-disclosure"><summary>更多資料與操作</summary><p className="candidate-id">{detail.id} · {text(detail.recorded_at)}</p>
        <JsonDetails title="完整候選" value={detail}/><button type="button" className="candidate-cancel" disabled={locked || state.pendingDirty || detail.state === "CANCELLED"} onClick={() => void session.action("cancel")}>取消研究候選</button></details>
    </div>}
    {formView && <form onSubmit={(event) => { event.preventDefault(); if (!rawError) void session.save(); }}>
      <fieldset disabled={locked}><legend>基本資料</legend>
        <div className="candidate-grid"><label>股票代碼<input aria-label="候選股票代碼" required value={raw.symbol == null ? "" : String(raw.symbol)} onChange={(event) => edit("symbol", event.target.value)}/>{fieldError("symbol")}</label>
          <label>方向<select aria-label="候選方向" className="workspace-order-side-field" data-side={raw.direction === "long" ? "Buy" : raw.direction === "short" ? "Sell" : undefined} value={text(raw.direction)} onChange={(event) => { const direction = event.target.value; session.edit({ ...raw, direction, action: direction === "long" ? "Buy" : "Sell", condition: direction === "long" ? "CASH" : "SHORT_SELLING" }); }}><option value="long">做多 · 買進 (Buy / CASH)</option><option value="short">放空 · 賣出 (Sell / SHORT_SELLING)</option></select>{fieldError("direction")}</label>
          <label>交易單位<select value={text(raw.lot)} onChange={(event) => edit("lot", event.target.value)}><option value="Odd">Odd · 零股</option><option value="Common">Common · 整股</option></select>{fieldError("lot")}</label>
          <label>數量（股）<input aria-label="候選股數" type="number" step="1" value={raw.quantity == null ? "" : String(raw.quantity)} onChange={(event) => edit("quantity", numeric(event.target.value))}/>{fieldError("quantity")}</label>
          </div>
      </fieldset>
      <fieldset disabled={locked}><legend>價格</legend><div className="candidate-grid">
        <label>價格依據<select value={text(raw.price_basis)} onChange={(event) => edit("price_basis", event.target.value)}><option>explicit</option><option>support</option><option>resistance</option></select></label>
        {[["proposed_limit", "提議限價"], ["reference_entry", "參考進場"], ["stop_loss", "停損"], ["take_profit", "停利"], ["exit_limit_price", "出場限價"]].map(([key, label]) => <label key={key}>{label}<input type="number" step="any" value={raw[key] == null ? "" : String(raw[key])} onChange={(event) => edit(key, event.target.value || null)}/>{fieldError(key)}</label>)}
      </div></fieldset>
      <fieldset disabled={locked}><legend>有效期間</legend><div className="candidate-grid">
        <label>有效起日<input type="date" value={raw.valid_from_date == null ? "" : String(raw.valid_from_date)} onChange={(event) => edit("valid_from_date", event.target.value || null)}/>{fieldError("valid_from_date")}</label>
        <label>有效迄日<input type="date" value={raw.valid_until_date == null ? "" : String(raw.valid_until_date)} onChange={(event) => edit("valid_until_date", event.target.value || null)}/>{fieldError("valid_until_date")}</label>
        <label className="candidate-check"><input type="checkbox" checked={raw.hold_overnight === true} onChange={(event) => edit("hold_overnight", event.target.checked)}/>可隔夜</label>
      </div></fieldset>
      <fieldset disabled={locked}><legend>觸發條件</legend><ConditionEditor value={raw.conditions} change={(value) => edit("conditions", value)}/>{fieldError("conditions")}</fieldset>
      <details className="candidate-disclosure candidate-owner-details"><summary>來源與識別</summary>
        <p>{text(raw.space_id)} / {text(raw.source)}；新建 owner_id 固定 MCP，這是來源名稱，不是認證身份。原記錄歸屬保留。</p>
        <label className="candidate-owner-field">owner_id<input aria-label="候選 owner_id" readOnly value={detail ? state.owner : "MCP"}/></label>
      </details>
      <details className="candidate-disclosure"><summary>進階設定</summary><fieldset disabled={locked}><div className="candidate-grid">
        <label>買賣 action<select className="workspace-order-side-field" data-side={text(raw.action)} value={text(raw.action)} onChange={(event) => edit("action", event.target.value)}><option value="Buy">買進 (Buy)</option><option value="Sell">賣出 (Sell)</option></select>{fieldError("action")}</label>
        <label>交易 condition<select value={text(raw.condition)} onChange={(event) => edit("condition", event.target.value)}><option>CASH</option><option>SHORT_SELLING</option></select>{fieldError("condition")}</label>
      </div>
        {!detail && <details><summary>載入範例</summary><div className="candidate-actions"><button type="button" onClick={() => { session.edit(candidateExample()); setRawError(""); }}>2330 條件例</button><button type="button" onClick={() => { session.edit(candidateExample(true)); setRawError(""); }}>3481 放空草稿</button></div></details>}
        <details className="candidate-json"><summary onClick={() => { if (!rawError) setRawText(json(raw)); }}>原始候選 JSON</summary><textarea aria-label="原始候選 JSON" rows={10} value={rawText} onChange={(event) => {
          setRawText(event.target.value); try { const parsed: unknown = JSON.parse(event.target.value); if (!isRecord(parsed)) throw new Error("必須是 object"); session.edit(parsed); setRawError(""); }
          catch (error) { session.edit(raw); setRawError(String(error)); }
        }}/>{rawError && <p className="candidate-field-error" role="alert">{rawError}</p>}</details>
      </fieldset></details>
      <div className="candidate-form-actions"><span>{state.dirty ? "未保存" : ""}</span><button type="button" disabled={locked} onClick={back}>取消</button><button className="candidate-primary workspace-order-action" type="submit" data-side={text(raw.action)} aria-busy={state.busy} disabled={locked || !!rawError}>{state.busy ? "保存中…" : detail ? "保存修改" : "建立候選"}</button></div>
    </form>}
    <details className="candidate-reminders"><summary>提醒 {reminders.length} 項</summary>{reminders.length > 0 ? <ul>{reminders.map((reminder, index) => <li key={index}>{reminder}</li>)}</ul> : <p>目前沒有額外提醒。</p>}
      <JsonDetails title="Monitor 狀態" value={state.monitor}/><p>研究候選取消僅取消研究邏輯；正式送單僅從掛單頁確認。</p></details>
  </section>;
}
