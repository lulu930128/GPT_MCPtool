import { useEffect, useState } from "react";
import type { CandidateBridge } from "./candidate-state";
import { readStockName } from "./stock-name";

export function StockName({ bridge, symbol, market = "TW" }: { bridge?: CandidateBridge; symbol: string; market?: string }) {
  const [result, setResult] = useState<{ key: string; bridge: CandidateBridge; name?: string; failed?: boolean }>();
  const [retry, setRetry] = useState<{ key: string; sequence: number }>();
  const key = JSON.stringify([market, symbol]);
  useEffect(() => {
    if (!bridge || market !== "TW" || !symbol) return;
    let disposed = false;
    // Avoid a request for every keystroke in the manual ticket.
    const timer = setTimeout(() => {
      void readStockName(bridge, symbol, market, retry?.key === key).then(name => {
        if (!disposed) setResult({ key, bridge, name });
      }).catch(() => { if (!disposed) setResult({ key, bridge, failed: true }); });
    }, 180);
    return () => { disposed = true; clearTimeout(timer); };
  }, [bridge, key, symbol, market, retry]);
  if (market !== "TW" || !symbol) return null;
  const current = result?.key === key && result.bridge === bridge ? result : undefined;
  return <span className="workspace-stock-name">{current?.name ? ` ${current.name}` : <small>{current?.failed
    ? <> 名稱未取得<button type="button" className="workspace-name-retry" aria-label={`重新查詢 ${symbol} 名稱`} onClick={() => setRetry(value => ({ key, sequence: (value?.sequence ?? 0) + 1 }))}>重查</button></>
    : bridge ? " 名稱查詢中…" : " 名稱連線未提供"}</small>}</span>;
}
