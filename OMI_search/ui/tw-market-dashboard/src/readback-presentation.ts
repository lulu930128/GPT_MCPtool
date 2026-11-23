import { isRecord, type UnknownRecord } from "./state";

// Presentation only: keep each original report and its order inside a stock.
// Grouping is not an identity join, deduplication or balance calculation.
export function stockGroups<T extends { symbol: unknown }>(rows: readonly T[]) {
  const groups = new Map<string, { key: string; symbol: string; rows: T[] }>();
  rows.forEach((row, index) => {
    const symbol = typeof row.symbol === "string" && row.symbol.trim() ? row.symbol : null;
    const key = symbol === null ? `unknown:${index}` : `symbol:${symbol}`;
    const group = groups.get(key) ?? { key, symbol: symbol ?? "代號未提供", rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  });
  return [...groups.values()];
}

export const inventoryTypes = [["cash", "現股"], ["margin", "融資"], ["short_selling", "融券"]] as const;
type InventoryType = typeof inventoryTypes[number][0];
export type InventoryEntry = { symbol: unknown; type: InventoryType; name: string; row: UnknownRecord; balance: "nonzero" | "zero" | "unknown" };

function reportedShares(value: unknown): number | null {
  if (!(typeof value === "number" || typeof value === "string" && /^-?\d+$/.test(value))) return null;
  return Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

export function inventoryPresentation(inventory: UnknownRecord) {
  const entries: InventoryEntry[] = [];
  for (const [type, name] of inventoryTypes) {
    const part = isRecord(inventory[type]) ? inventory[type] : {};
    if (!Array.isArray(part.items)) continue;
    for (const item of part.items) {
      const row = isRecord(item) ? item : {};
      const fields = [row.reported_total_shares, row.closeable_shares, row.orderable_shares,
        ...(type === "cash" ? [row.odd_shares, row.odd_closeable_shares] : [])].map(reportedShares);
      const balance = fields.some(value => value !== null && value !== 0) ? "nonzero"
        : fields.every(value => value === 0) ? "zero" : "unknown";
      entries.push({ symbol: row.symbol, type, name, row, balance });
    }
  }
  const groups = stockGroups(entries);
  return {
    nonzero: groups.filter(group => group.rows.some(entry => entry.balance === "nonzero")),
    unknown: groups.filter(group => !group.rows.some(entry => entry.balance === "nonzero") && group.rows.some(entry => entry.balance === "unknown")),
    zero: groups.filter(group => group.rows.every(entry => entry.balance === "zero")),
  };
}
