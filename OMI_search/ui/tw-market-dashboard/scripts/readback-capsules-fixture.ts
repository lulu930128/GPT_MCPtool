import type { UnknownRecord } from "../src/state";

// User-supplied examples reproduced in memory, never broker/account identities.
export function fixtureReadbackCapsules() {
  const part = (items: UnknownRecord[]) => ({ quality: "PARTIAL", complete: false, empty_confirmed: null,
    queried_at: "2026-11-18T10:20:00+08:00", source_as_of: null, items });
  const balance = (symbol: string, shares: number) => ({ symbol, reported_total_shares: shares,
    closeable_shares: shares, orderable_shares: shares, odd_shares: 0, odd_closeable_shares: 0 });
  const fill = (symbol: string, action: string, date: string | null, price: string | null, quantity: number | null, id: string) => ({
    symbol, action, condition: "CASH", lot: "Odd", broker_key: { trade_date: date, order_id: `fixture-${id}` },
    fill_id: `fixture-${id}`, quantity_shares: quantity, price,
  });
  return { contract: "omi.execution-desk.v1", trade_date: "2026-11-18", quality: "PARTIAL", sources: [], unparsed_reports: [], fill_history_complete: false,
    fills: [fill("2330", "Buy", "2026-11-06", "2140", 1, "2330-buy"), fill("8227", "Buy", "2026-11-09", null, null, "8227-buy"),
      fill("2330", "Sell", "2026-11-09", "2240", 1, "2330-sell"), fill("8227", "Sell", "2026-11-10", null, null, "8227-sell")],
    inventory: { cash: part([balance("2637", 0), balance("3702", 1000)]), margin: part([balance("2637", 0), balance("3702", 0)]), short_selling: part([balance("2637", 0), balance("3702", 0)]) },
  };
}
