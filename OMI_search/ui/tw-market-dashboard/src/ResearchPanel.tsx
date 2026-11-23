import { useEffect, useRef, useState } from "react";
import type { CandidateBridge } from "./candidate-state";
import { deskCall, deskError, readStaged } from "./desk-contract";
import { researchList, researchDetail, researchDeleted, researchStaged, localRejection, deletedResearchRead, type ResearchSummary, type ResearchDetail } from "./research-contract";
import { TradeDetails, TradeError } from "./TradeFeedback";
import { isRecord, type UnknownRecord } from "./state";

const record = (value: unknown): UnknownRecord => isRecord(value) ? value : {};
const originName = (value: unknown) => value === "AI_NOMINATION" ? "AI 提名" : value === "PROGRAM_NOMINATION" ? "程式提名" : value === "OMI_SCREEN" ? "盤後自動" : "來源未提供";

function StrategyFields({ json, update }: { json: string; update(value: string): void }) {
  let value: UnknownRecord;
  try { value = record(JSON.parse(json)); } catch { return <p>詳細設定 JSON 格式有誤，請修正後儲存。</p>; }
  const change = (patch: UnknownRecord) => update(JSON.stringify({ ...value, ...patch }, null, 2));
  const targets = Array.isArray(value.targets) ? value.targets as UnknownRecord[] : [];
  return <>
    <label>方向<select value={String(value.direction)} onChange={e => change({ direction: Number(e.target.value) })}><option value="1">做多</option><option value="-1">做空</option></select></label>
    <div className="workspace-order-fields">{[["entry_price", "進場價"], ["stop_price", "停損價"], ["shares", "股數"]].map(([key, label]) => <label key={key}>{label}<input type="number" min="0" step={key === "shares" ? "1" : "any"} value={String(value[key])} onChange={e => change({ [key]: Number(e.target.value) })}/></label>)}</div>
    {targets.map((target, index) => <div className="workspace-order-fields" key={index}>{[["price", `停利 ${index + 1}`], ["fraction", "比例（0～1）"]].map(([key, label]) => <label key={key}>{label}<input type="number" min="0" step="any" value={String(target[key])} onChange={e => change({ targets: targets.map((t, i) => i === index ? { ...t, [key]: Number(e.target.value) } : t) })}/></label>)}<button type="button" onClick={() => change({ targets: targets.filter((_, i) => i !== index) })}>移除目標</button></div>)}
    <button type="button" onClick={() => change({ targets: [...targets, { price: 0, fraction: 0 }] })}>增加目標</button>
    <label>研究說明<textarea value={String(value.thesis)} onChange={e => change({ thesis: e.target.value })}/></label>
    <small>改變多空方向會建立新提案並保留原提案歷史；價位、數量與成本則保存為同一提案的新版本。</small>
  </>;
}

export function ResearchPanel({ bridge, active, onStaged }: { bridge: CandidateBridge; active: boolean; onStaged(target: { stageId: string; origin: "research"; lifecycle: string }): void }) {
  const [market, setMarket] = useState("TW"), [origin, setOrigin] = useState(""), [direction, setDirection] = useState("");
  const [offset, setOffset] = useState(0), [more, setMore] = useState(false), [rows, setRows] = useState<ResearchSummary[]>([]);
  const [selected, setSelected] = useState<string[]>([]), [busyIds, setBusyIds] = useState<string[]>([]), [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false), [error, setError] = useState(""), [loadedKey, setLoadedKey] = useState("");
  const [listFailed, setListFailed] = useState(false);
  const [edit, setEdit] = useState<{ row: ResearchSummary; detail: ResearchDetail } | null>(null), [strategy, setStrategy] = useState(""), [costs, setCosts] = useState("");
  const [deleting, setDeleting] = useState<ResearchSummary[] | null>(null), [unknownIds, setUnknownIds] = useState<string[]>([]);
  const [reason, setReason] = useState("調整研究設定"), [symbols, setSymbols] = useState(""), [date, setDate] = useState("");
  const [nomination, setNomination] = useState<unknown>(), [uncertain, setUncertain] = useState(false);
  const generation = useRef(0), flights = useRef(new Set<string>()), reads = useRef(new Map<string, Promise<void>>());
  const pendingStage = useRef<{ id: string; revision: string; intent: string; market: string; symbol: string } | null>(null);
  const stagedVersions = useRef(new Map<string, { stageId: string; origin: "research"; lifecycle: string }>());
  const unresolved = useRef(new Map<string, ResearchSummary>());
  const queryKey = JSON.stringify([market, origin, direction, offset]);
  const queryRef = useRef(queryKey); queryRef.current = queryKey;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const load = (): Promise<void> => {
    const existing = reads.current.get(queryKey);
    if (existing) return existing;
    const token = ++generation.current;
    setLoading(true);
    const promise = (async () => {
      try {
        const data = researchList(await deskCall(bridge, "omi_list_research_proposals", { market, limit: 25, offset,
          ...(origin ? { origin } : {}), ...(direction ? { direction } : {}) }), market, offset);
        if (!mounted.current || token !== generation.current || queryRef.current !== queryKey) return;
        if (!data.items.length && offset > 0) { setOffset(Math.max(0, offset - 25)); return; }
        setRows(data.items); setMore(data.hasMore); setLoadedKey(queryKey); setError(""); setListFailed(false);
        setSelected(previous => previous.filter(id => data.items.some(row => row.creation_id === id)));
      } catch (err) { if (mounted.current && token === generation.current) { setError(deskError(err)); setListFailed(true); } }
      finally { if (mounted.current && token === generation.current) setLoading(false); }
    })().finally(() => { if (reads.current.get(queryKey) === promise) reads.current.delete(queryKey); });
    reads.current.set(queryKey, promise);
    return promise;
  };
  useEffect(() => { if (active) void load(); }, [bridge, active, queryKey]);
  const run = async (ids: string[], action: () => Promise<void>) => {
    if (ids.some(id => flights.current.has(id))) return;
    ids.forEach(id => flights.current.add(id)); setBusyIds([...flights.current]); setError("");
    try { await action(); } catch (err) { if (mounted.current) setError(deskError(err)); }
    finally { ids.forEach(id => flights.current.delete(id)); if (mounted.current) setBusyIds([...flights.current]); }
  };
  const markUnknown = (row: ResearchSummary) => {
    unresolved.current.set(row.creation_id, row); setUnknownIds([...unresolved.current.keys()]);
  };
  const forgetUnknown = (id: string) => { unresolved.current.delete(id); setUnknownIds([...unresolved.current.keys()]); };
  const organize = async (items: ResearchSummary[], target?: string) => {
    setDeleting(null);
    const results: string[] = [], failed: string[] = [];
    for (const [index, row] of items.entries()) {
      const tool = target ? "omi_move_research_proposal" : "omi_delete_research_proposal";
      setNotice(`正在${target ? "移動" : "刪除"}研究 ${index + 1} / ${items.length}`);
      try {
        const value = await deskCall(bridge, tool, { id: row.creation_id, expected_revision_id: row.revision_id, ...(target ? { origin: target } : {}) });
        if (target) {
          const detail = researchDetail(value, row, false);
          if (detail.workflow_origin !== target || detail.proposal.revision_id === row.revision_id) throw Error("研究分類回應尚未確認");
        } else researchDeleted(value, row);
        setRows(previous => previous.filter(item => item.creation_id !== row.creation_id));
        if (edit?.row.creation_id === row.creation_id) setEdit(null);
        results.push(`${row.symbol}：${target ? `已移至 ${originName(target)}` : "已刪除研究"}`);
      } catch (err) {
        failed.push(row.creation_id);
        if (!localRejection(err, tool)) markUnknown(row);
        results.push(`${row.symbol}：${localRejection(err, tool) ? "未完成，請重新讀取後核對" : "結果待確認，請讀回此筆研究"}`);
        setError(deskError(err));
      }
    }
    // Invalidate a pre-mutation list. Await it before asking for a fresh snapshot.
    generation.current++;
    await reads.current.get(queryKey);
    if (queryRef.current === queryKey) { await load(); setSelected(failed); }
    setNotice(results.join("\n"));
  };
  const readOriginal = async (row: ResearchSummary) => {
    const original = unresolved.current.get(row.creation_id) ?? row;
    try {
      const detail = researchDetail(await deskCall(bridge, "omi_read_research_proposal", { id: original.creation_id }), original, false);
      if (detail.proposal.revision <= original.revision) { setNotice("原研究尚未讀到新版本，仍保留待確認狀態；不會自動重做操作。"); return; }
      forgetUnknown(row.creation_id); setNotice("已讀到原研究的新版本，請重新核對內容；不會重做上一個操作。");
    } catch (err) {
      if (!deletedResearchRead(err)) throw err;
      forgetUnknown(row.creation_id); setRows(previous => previous.filter(item => item.creation_id !== row.creation_id));
      setNotice(`${row.symbol} 已確認不在現行研究清單中，歷史仍保留。`);
    }
    await load();
  };
  const openEdit = async (row: ResearchSummary) => {
    const detail = researchDetail(await deskCall(bridge, "omi_read_research_proposal", { id: row.creation_id }), row);
    if (queryRef.current !== queryKey) return;
    setEdit({ row, detail }); setStrategy(JSON.stringify(detail.proposal.strategy, null, 2)); setCosts(JSON.stringify(detail.proposal.costs, null, 2));
  };
  const save = async () => {
    if (!edit) return;
    const next = record(JSON.parse(strategy)), nextCosts = record(JSON.parse(costs)), row = edit.row;
    const tool = "omi_revise_research_proposal";
    try {
      const result = researchDetail(await deskCall(bridge, tool, { id: row.creation_id,
        data: { expected_revision_id: row.revision_id, strategy: next, costs: nextCosts, change_reason: reason } }));
      const p = result.proposal;
      if (p.market !== row.market || p.symbol !== row.symbol || p.strategy.direction !== next.direction || p.revision_id === row.revision_id
        || (next.direction === edit.detail.proposal.strategy.direction && p.creation_id !== row.creation_id)) throw Error("研究修改回應尚未確認");
      setEdit(null); await load(); setNotice("研究修改已儲存。");
    } catch (err) { if (!localRejection(err, tool)) markUnknown(row); throw err; }
  };
  const stage = async (row: ResearchSummary) => {
    const existing = stagedVersions.current.get(row.revision_id);
    if (existing) { onStaged(existing); return; }
    if (pendingStage.current) throw Error("上一筆待送單結果尚待讀回");
    const intent = { id: row.creation_id, revision: row.revision_id, intent: crypto.randomUUID(), market: row.market, symbol: row.symbol };
    pendingStage.current = intent;
    try {
      const result = researchStaged(await deskCall(bridge, "omi_stage_research_order", { id: intent.id, data: { expected_revision_id: intent.revision, client_intent_id: intent.intent } }), intent);
      const target = { stageId: String(result.id), origin: "research" as const, lifecycle: String(result.lifecycle) };
      stagedVersions.current.set(row.revision_id, target);
      pendingStage.current = null; setNotice("已讀回原待送單。"); onStaged(target);
    } catch (err) {
      if (localRejection(err, "omi_stage_research_order")) pendingStage.current = null;
      else setUncertain(true);
      throw err;
    }
  };
  const recoverStage = async () => {
    const original = pendingStage.current;
    if (!original) return;
    const matches = (await readStaged(bridge)).filter(row => record(row.raw).client_intent_id === original.intent);
    if (matches.length !== 1) { setNotice("原意圖尚未取得唯一待送單，請稍後重新讀取。"); return; }
    researchStaged(matches[0], original);
    const target = { stageId: String(matches[0].id), origin: "research" as const, lifecycle: String(matches[0].lifecycle) };
    stagedVersions.current.set(original.revision, target);
    pendingStage.current = null; setUncertain(false); onStaged(target);
  };
  const change = (value: string, setter: (value: string) => void) => {
    generation.current++; setter(value); setOffset(0); setEdit(null); setDeleting(null); setSelected([]); setNotice(""); setError("");
  };
  const current = loadedKey === queryKey, chosen = rows.filter(row => selected.includes(row.creation_id));
  const blocked = (id: string) => busyIds.includes(id) || unknownIds.includes(id) || !current || loading || listFailed;
  return <section className="workspace-research" aria-label="台美股研究管理" aria-busy={loading}>
    <div className="candidate-heading"><h3>研究預選</h3><button disabled={loading} onClick={() => void load()}>{loading ? "讀取中…" : "重新讀取"}</button></div>
    <div className="workspace-order-fields workspace-research-filters">
      <label>市場<select value={market} onChange={e => change(e.target.value, setMarket)}><option value="TW">台股</option><option value="US">美股</option></select></label>
      <label>來源<select value={origin} onChange={e => change(e.target.value, setOrigin)}><option value="">全部</option><option value="AI_NOMINATION">AI 提名</option><option value="PROGRAM_NOMINATION">程式提名</option><option value="OMI_SCREEN">盤後自動</option></select></label>
      <label>方向<select value={direction} onChange={e => change(e.target.value, setDirection)}><option value="">多空</option><option value="long">做多</option><option value="short">做空</option></select></label>
    </div>
    <details className="workspace-order-details"><summary>新增研究提名</summary><form onSubmit={e => { e.preventDefault(); void run(["nomination"], async () => {
      const result = await deskCall(bridge, "omi_nominate_research_stocks", { data: { market, stock_ids: symbols.split(/[\s,，]+/).filter(Boolean), as_of_trade_date: date, requested_at: new Date().toISOString(), nomination_origin: "AI_NOMINATION", direction: direction || "both" } });
      setNomination(result); await load(); setNotice("已取得提名結果，請查看研究清單及處理詳情。");
    }); }}><label>股票代碼（最多 5 檔）<input required value={symbols} onChange={e => setSymbols(e.target.value)}/></label><label>完整日線日期<input required type="date" value={date} onChange={e => setDate(e.target.value)}/></label><button disabled={busyIds.includes("nomination")}>建立 AI 提名</button></form></details>
    {loading && <p role="status">正在讀取研究清單…{current && rows.length ? " 保留上次結果。" : ""}</p>}
    {notice && <p role="status" className="workspace-operation-notice">{notice}</p>}
    <TradeError error={error}/>
    {chosen.length > 0 && current && <div className="workspace-order-pair"><button disabled={chosen.some(row => blocked(row.creation_id))} onClick={() => void run(chosen.map(row => row.creation_id), () => organize(chosen, "AI_NOMINATION"))}>移至 AI 提名（{chosen.length}）</button><button disabled={chosen.some(row => blocked(row.creation_id))} onClick={() => setDeleting(chosen)}>刪除所選研究</button></div>}
    {deleting && <div className="workspace-delete-confirm" role="group" aria-label="確認刪除研究"><p>刪除 {deleting.map(row => row.symbol).join("、")} 的 {deleting.length} 筆研究？歷史會保留，已建立的委託不受影響。</p><button onClick={() => void run(deleting.map(row => row.creation_id), () => organize(deleting))}>確認刪除研究</button><button onClick={() => setDeleting(null)}>保留研究</button></div>}
    {current && rows.map(row => {
      const canStage = row.workflow_origin === "AI_NOMINATION" && row.stage_supported !== false;
      // Matches the Backend's research-to-order projection. Neutral research has no order side.
      const side = row.direction === "long" ? "Buy" : row.direction === "short" ? "Sell" : undefined;
      return <article className="workspace-staged-order workspace-order-card" key={row.creation_id} aria-label={`${row.symbol} 研究預選`} aria-busy={busyIds.includes(row.creation_id)}>
      <header className="workspace-order-card-heading"><label className="workspace-research-select"><input type="checkbox" disabled={blocked(row.creation_id)} checked={selected.includes(row.creation_id)} onChange={e => setSelected(previous => e.target.checked ? [...previous, row.creation_id] : previous.filter(v => v !== row.creation_id))}/><strong>{row.symbol}</strong><span>{String(row.stock_name ?? "")}</span></label><span className={canStage ? "workspace-order-direction" : undefined} data-side={canStage ? side : undefined}>{row.direction === "long" ? (canStage ? "做多 · 買進" : "做多") : row.direction === "short" ? (canStage ? "做空 · 賣出" : "做空") : "中性觀察"}</span></header>
      <p className="workspace-ticket-note">{originName(row.workflow_origin)} · {row.market === "US" ? "美股" : "台股"} · 研究日 {String(row.as_of_trade_date ?? "未提供")}{row.status === "scheduled" ? " · 尚未生效" : ""}</p>
      {row.market === "US" && row.direction === "short" && <p>美股賣出使用現股；目前介面沒有融券放空參數。</p>}
      {canStage && <button className="candidate-primary workspace-order-action" data-side={side} disabled={blocked(row.creation_id) || uncertain || busyIds.includes("stage")} onClick={() => void run([row.creation_id, "stage"], () => stage(row))}>加入待送單</button>}
      <details className="workspace-secondary-actions"><summary>研究管理</summary><div className="workspace-order-actions"><button disabled={blocked(row.creation_id)} onClick={() => void run([row.creation_id], () => openEdit(row))}>{row.revise_supported === false ? "檢視研究" : "修改"}</button><button disabled={blocked(row.creation_id)} onClick={() => void run([row.creation_id], () => organize([row], row.workflow_origin === "AI_NOMINATION" ? "OMI_SCREEN" : "AI_NOMINATION"))}>{row.workflow_origin === "AI_NOMINATION" ? "移回盤後自動" : "移至 AI 提名"}</button><button disabled={blocked(row.creation_id)} onClick={() => setDeleting([row])}>刪除</button></div></details>
      {(blocked(row.creation_id) || uncertain || busyIds.includes("stage")) && <p className="workspace-ticket-note">{unknownIds.includes(row.creation_id) || uncertain ? "操作結果待確認，請讀回原紀錄。" : "資料讀取或操作處理中，請稍候。"}</p>}
      {(row.workflow_origin !== "AI_NOMINATION" || row.stage_supported === false) && <p className="workspace-ticket-note">{row.stage_supported === false ? "此研究尚不支援建立待送單，可展開研究管理檢視。" : "先在研究管理移至 AI 提名，才能加入待送單。"}</p>}
      {busyIds.includes(row.creation_id) && <p role="status">處理中…</p>}
      {unknownIds.includes(row.creation_id) && <div><p role="status">這筆研究的操作結果待確認，不會自動重做。</p><button disabled={busyIds.includes(row.creation_id)} onClick={() => void run([row.creation_id], () => readOriginal(row))}>讀回此筆研究</button></div>}
    </article>;
    })}
    {!loading && current && !rows.length && !error && <p>目前沒有符合條件的研究候選。</p>}
    {[...unresolved.current.values()].filter(row => !current || !rows.some(item => item.creation_id === row.creation_id)).map(row => <div className="workspace-operation-error" key={row.creation_id}><p role="status">{row.symbol} 的操作結果仍待確認；清單更新不代表該次操作已完成。</p><button disabled={busyIds.includes(row.creation_id)} onClick={() => void run([row.creation_id], () => readOriginal(row))}>讀回此筆研究</button></div>)}
    <div className="workspace-research-pagination"><button disabled={loading || offset === 0} onClick={() => setOffset(v => Math.max(0, v - 25))}>上一頁</button><span>第 {Math.floor(offset / 25) + 1} 頁</span><button disabled={loading || !current || !more} onClick={() => setOffset(v => v + 25)}>下一頁</button></div>
    {edit && <form className="workspace-stage-edit" aria-label="修改研究" onSubmit={e => { e.preventDefault(); void run([edit.row.creation_id], save); }}>
      <h4>研究 {edit.row.symbol}</h4>{edit.row.revise_supported === false && <p>此為凍結研究，原始證據保留。已建立的待送單可另行調整價量與出場規則。</p>}<fieldset disabled={blocked(edit.row.creation_id) || edit.row.revise_supported === false}><StrategyFields json={strategy} update={setStrategy}/>
      <details className="workspace-order-details"><summary>成本假設</summary><div className="workspace-order-fields">{[["commission_rate", "手續費率"], ["minimum_commission", "最低手續費"], ["sell_tax_rate", "賣出稅率"], ["slippage_per_share", "每股滑價"], ["short_borrow_per_share_session", "每股每日借券成本"], ["other_cost", "其他成本"]].map(([key, label]) => <label key={key}>{label}<input type="number" min="0" step="any" value={String(record(JSON.parse(costs))[key] ?? "")} onChange={e => setCosts(JSON.stringify({ ...record(JSON.parse(costs)), [key]: e.target.value === "" ? null : Number(e.target.value) }))}/></label>)}</div></details>
      <label>修改原因<input required value={reason} onChange={e => setReason(e.target.value)}/></label><button disabled={blocked(edit.row.creation_id)}>儲存研究</button></fieldset><button type="button" onClick={() => setEdit(null)}>關閉</button><TradeDetails value={edit.detail} label="研究原始證據"/>
    </form>}
    {uncertain && <div><p role="status">加入待送單的結果尚未確認，請讀回原意圖。</p><button disabled={busyIds.includes("stage")} onClick={() => void run(["stage"], recoverStage)}>讀回原待送單</button></div>}
    {nomination !== undefined && <TradeDetails value={nomination} label="提名處理詳情"/>}
  </section>;
}
