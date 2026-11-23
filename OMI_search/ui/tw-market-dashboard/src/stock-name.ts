import type { CandidateBridge } from "./candidate-state";
import { deskCall } from "./desk-contract";
import { isRecord } from "./state";

// Presentation cache only: the existing local symbol master owns all names.
// Scope to the bridge session, coalesce concurrent cards, and expire failures.
const sessions = new WeakMap<CandidateBridge, Map<string, { until: number; read: Promise<string> }>>();
export function readStockName(bridge: CandidateBridge, symbol: string, market: string, retry = false): Promise<string> {
  if (market !== "TW" || !symbol || symbol !== symbol.trim()) return Promise.resolve("");
  let cache = sessions.get(bridge);
  if (!cache) { cache = new Map(); sessions.set(bridge, cache); }
  const now = Date.now();
  for (const [key, entry] of cache) if (entry.until <= now) cache.delete(key);
  if (retry) cache.delete(symbol);
  const existing = cache.get(symbol);
  if (existing) return existing.read;
  const entry = { until: Infinity, read: Promise.resolve("") };
  entry.read = deskCall(bridge, "omi_search_tw_symbols", { keyword: symbol, limit: 20 }).then(value => {
    if (!isRecord(value) || value.kind !== "omi.tw_symbol_search" || value.query !== symbol || !Array.isArray(value.items)) throw Error("名稱回覆身分不符");
    const matches = value.items.filter(item => isRecord(item) && item.stock_id === symbol);
    if (matches.length !== 1 || !isRecord(matches[0]) || typeof matches[0].stock_name !== "string" || !matches[0].stock_name.trim()) throw Error("本機主檔無唯一名稱");
    entry.until = Date.now() + 5 * 60_000;
    return matches[0].stock_name.trim();
  }).catch(error => { entry.until = Date.now() + 15_000; throw error; });
  cache.set(symbol, entry);
  return entry.read;
}
