import { useEffect, useReducer } from "react";
import { canCancel, currentFrame, FIXTURE, fixtureInstrument, initialTicket, ticketReducer, type TicketFields } from "./synthetic-ticket";

const money = (cents: number) => (cents / 100).toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Symbol is the ONLY input: no bridge, quote, holdings, account or callbacks. */
export function SyntheticOrderPanel({ symbol }: { symbol?: string }) {
  const [view, dispatch] = useReducer(ticketReducer, symbol ?? "", initialTicket);
  // Also safe when used outside the keyed workspace mount.
  if (view.symbol !== (symbol ?? "")) dispatch({ type: "select", symbol: symbol ?? "" });
  useEffect(() => {
    const clear = () => dispatch({ type: "reset" });
    window.addEventListener("pagehide", clear);
    window.addEventListener("pageshow", clear);
    return () => { window.removeEventListener("pagehide", clear); window.removeEventListener("pageshow", clear); };
  }, []);
  useEffect(() => {
    if (view.phase !== "preview") return;
    const timer = setInterval(() => dispatch({ type: "tick", now: Date.now() }), 500);
    return () => clearInterval(timer);
  }, [view.phase, view.preview?.id]);
  const edit = (patch: Partial<TicketFields>) => dispatch({ type: "edit", patch });
  const instrument = fixtureInstrument(view.symbol);
  const preview = view.preview;
  const frame = currentFrame(view);
  return <section className="workspace-pane synthetic-ticket" aria-label="SYNTHETIC 手動委託" data-phase={view.phase}>
    <h2>手動委託演練</h2>
    <p className="synthetic-banner"><strong>SYNTHETIC · simulated · no broker</strong><br/>僅本機記憶體模擬，沒有送單。重新載入即清空。</p>
    <p>真實交易預覽：<strong>unavailable</strong>。未取得可信市場、帳戶與權限快照；本預覽未經 M1 後端驗證，勾選不是登入、OAuth 或正式授權。</p>
    <form noValidate onSubmit={(event) => { event.preventDefault(); dispatch({ type: "preview", now: Date.now() }); }}>
      <p className="synthetic-symbol">標的 <strong>{view.symbol || "尚未選股"}</strong> · {instrument ? `TW / ${instrument.asset} / ${instrument.venue} fixture identity` : "fixture unavailable"}</p>
      <p><small>選股只帶入代碼。研究行情與持股不作為可送單事實。</small></p>
      <div className="synthetic-fields">
        <label>方向<select aria-label="模擬方向" value={view.fields.side} onChange={(e) => edit({ side: e.target.value as TicketFields["side"] })}><option value="">請選擇</option><option value="BUY">BUY 買進</option><option value="SELL">SELL 賣出</option></select></label>
        <label>委託類型<select aria-label="模擬委託類型" value={view.fields.orderKind} onChange={(e) => edit({ orderKind: e.target.value as TicketFields["orderKind"] })}><option value="">請選擇</option><option value="LIMIT">LIMIT 限價</option></select></label>
        <label>交易單位<select aria-label="模擬交易單位" value={view.fields.lot} onChange={(e) => edit({ lot: e.target.value as TicketFields["lot"] })}><option value="">請選擇</option><option value="BOARD">BOARD 整股</option><option value="ODD">ODD 零股</option></select></label>
        <label>股數（不是張數）<input aria-label="模擬股數" inputMode="numeric" autoComplete="off" value={view.fields.quantity} maxLength={16} onChange={(e) => edit({ quantity: e.target.value })}/></label>
        <label>限價（TWD／股）<input aria-label="模擬限價" inputMode="decimal" autoComplete="off" value={view.fields.price} maxLength={16} onChange={(e) => edit({ price: e.target.value })}/></label>
        <label>回報情境<select aria-label="模擬回報情境" value={view.fields.scenario} onChange={(e) => edit({ scenario: e.target.value as TicketFields["scenario"] })}><option value="fill">接受 → 部分／全部成交</option><option value="reject">拒絕</option><option value="unknown">逾時 → 人工對帳</option><option value="empty">空回報</option><option value="error">錯誤回報</option></select></label>
      </div>
      <p>CASH 現款／現股 · LIMIT · DAY 當日 · TWD／PER_SHARE</p>
      <details className="synthetic-facts"><summary>查看 SYNTHETIC 假資料與限制</summary><p>所有 fixture 標的共用假參考價 {FIXTURE.referencePrice} TWD；不帶入限價。假可用額度 {money(FIXTURE.cashCents)} TWD、假可賣 {FIXTURE.sellableShares.toLocaleString()} 股；假買進費用預留 {money(FIXTURE.feeCents)} TWD。</p><p>假價格 1–200、tick 0.01、整股 1,000 股倍數、零股 1–999 股、上限 10,000 股。這些是假規則，不是真實交易所規則、稅費或購買力；不消耗或預留額度。</p></details>
      {view.errors.length > 0 && <ul className="workspace-error" role="alert">{view.errors.map((error) => <li key={error}>{error}</li>)}</ul>}
      <div className="synthetic-actions"><button type="submit" disabled={view.phase === "preview" || view.phase === "receipt"}>1. 產生模擬預覽</button><button type="button" onClick={() => dispatch({ type: "reset" })}>清空本機演練</button></div>
    </form>
    {preview && <section className="synthetic-preview" aria-label="SYNTHETIC 預覽">
      <h3>SYNTHETIC 預覽 #{preview.id}</h3>
      <p>{preview.symbol} · {preview.fields.side} · {preview.fields.lot} · CASH / LIMIT / DAY</p>
      <dl><dt>股數 × 假限價</dt><dd>{preview.estimate.shares} 股 × {money(preview.estimate.priceCents)} TWD</dd><dt>模擬估計金額</dt><dd>{money(preview.estimate.notionalCents)} TWD</dd><dt>假買進所需額度（含預留）</dt><dd>{preview.fields.side === "BUY" ? `${money(preview.estimate.requiredCashCents)} TWD` : "不適用；賣出淨額與稅費未估算"}</dd><dt>人工確認期限</dt><dd>{new Date(preview.expiresAt).toLocaleTimeString("zh-TW")}（60 秒內；到期失效）</dd></dl>
      {view.phase === "preview" && <><p>確認前須核對代碼、方向、股數、限價與模式。任一欄位或選股變更即作廢，必須重新預覽。</p><label className="synthetic-ack"><input type="checkbox" checked={view.acknowledged} onChange={(e) => dispatch({ type: "acknowledge", value: e.target.checked, previewId: preview.id, now: Date.now() })}/>我已核對，知道這是 SYNTHETIC 本機演練，沒有券商送單。</label><button type="button" disabled={!view.acknowledged} onClick={() => dispatch({ type: "confirm", previewId: preview.id, now: Date.now() })}>2. 明確確認本次模擬</button></>}
      {view.phase === "expired" && <p role="status">預覽已失效；無法確認，請重新產生預覽。</p>}
    </section>}
    {canCancel(view) && <button type="button" onClick={() => dispatch({ type: "cancel", now: Date.now() })}>{view.phase === "preview" ? "取消未確認預覽" : "提出模擬取消意圖"}</button>}
    {frame && <section className="synthetic-receipt" aria-label="SYNTHETIC 模擬結果" aria-live="polite">
      <h3>SYNTHETIC 回報 · 非券商回執</h3><strong>{frame.state}</strong><p>{frame.note}</p>
      <p>simulated=true · durable=false · 模擬次數 {view.attempts} · 累積模擬成交 {frame.filled} 股{view.cancelRequested ? " · 已記錄取消意圖" : ""}</p>
      {view.phase === "receipt" && view.cursor + 1 < view.frames.length && <button type="button" onClick={() => dispatch({ type: "next", now: Date.now() })}>{frame.state === "UNKNOWN" ? "人工播放對帳 fixture" : "播放下一筆 fixture 回報"}</button>}
      <ol aria-label="本機模擬回報記錄">{view.frames.slice(0, view.cursor + 1).map((row, index) => <li key={index}>{row.state} · {row.filled} 股</li>)}</ol>
      <p><small>固定情境展示；不是 M1 審計紀錄。不保存、不自動重試，重新載入或清空後不延續。</small></p>
    </section>}
  </section>;
}
