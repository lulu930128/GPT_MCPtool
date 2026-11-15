// Consumer fixtures follow ProposalSummaryListRead / ProposalRead, not a UI-shaped mock.
import type { UnknownRecord } from "../src/state";
export function fixtureResearch(market = "TW", revision = 1, origin = "AI_NOMINATION") {
  return { creation_id: `research-${market}`, revision_id: `revision-${revision}`, revision, market,
    symbol: market === "US" ? "NVDA" : "3481", stock_name: market === "TW" ? "研究測試" : null,
    direction: "long", status: "proposed", workflow_origin: origin, as_of_trade_date: "2026-11-05",
    cutoff: "2026-11-05T00:00:00Z", recorded_at: "2026-11-05T00:00:00Z", effective_at: "2026-11-05T00:00:00Z",
    assessment_status: "eligible", reason_codes: [], evidence_hash: "a".repeat(64) };
}
export function fixtureResearchList(items: UnknownRecord[], offset = 0, has_more = false) {
  return { projection: "research.proposal_list.summary.v1", evidence_included: false, execution_ready: false,
    as_of: "2026-11-06T00:00:00Z", limit: 25, offset, has_more, items };
}
export function fixtureResearchDetail(summary: UnknownRecord, strategy: UnknownRecord = {}) {
  return { workflow_origin: summary.workflow_origin, currency: summary.market === "US" ? "USD" : "TWD", status: "proposed",
    proposal: { ...summary, strategy: { version: "v1", direction: 1, mode: "confirmed", entry_rule: "next_open", entry_price: 100,
      stop_price: 95, shares: 10, thesis: "研究條件", targets: [{ price: 110, fraction: 0.5 }, { price: 120, fraction: 0.5 }], ...strategy }, costs: { version: "v1", commission_rate: null } } };
}
