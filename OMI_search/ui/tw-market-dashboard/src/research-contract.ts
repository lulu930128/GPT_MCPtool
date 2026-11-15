import { CallError } from "./candidate-state";
import { stageRecord } from "./desk-contract";
import { isRecord, type UnknownRecord } from "./state";

export type ResearchSummary = UnknownRecord & {
  creation_id: string; revision_id: string; revision: number; market: "TW" | "US";
  symbol: string; direction: "long" | "short"; workflow_origin: string | null;
};
export type ResearchDetail = UnknownRecord & { proposal: ResearchSummary & { strategy: UnknownRecord; costs: UnknownRecord } };
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

// Decode the Backend's list projection. A summary is never execution evidence.
export function researchList(value: unknown, market: string, offset: number) {
  if (!isRecord(value) || value.projection !== "research.proposal_list.summary.v1" || value.evidence_included !== false
    || value.execution_ready !== false || !Array.isArray(value.items) || typeof value.has_more !== "boolean" || value.offset !== offset)
    throw Error("研究清單格式與目前介面不符，請重新讀取或更新元件。");
  const ids = new Set<string>();
  const items = value.items.map(item => {
    if (!isRecord(item) || !nonempty(item.creation_id) || !nonempty(item.revision_id) || !Number.isSafeInteger(item.revision)
      || Number(item.revision) < 1 || item.market !== market || !nonempty(item.symbol) || !["long", "short"].includes(String(item.direction))
      || !["AI_NOMINATION", "OMI_SCREEN", null].includes(item.workflow_origin as string | null) || ids.has(item.creation_id))
      throw Error("研究清單含缺少身分、版本或市場不符的資料，暫停操作。");
    ids.add(item.creation_id);
    return item as ResearchSummary;
  });
  return { items, hasMore: value.has_more };
}

export function researchDetail(value: unknown, expected?: ResearchSummary, exactRevision = true): ResearchDetail {
  const p = isRecord(value) && isRecord(value.proposal) ? value.proposal : {};
  if (!isRecord(value) || !nonempty(p.creation_id) || !nonempty(p.revision_id) || !Number.isSafeInteger(p.revision)
    || !["TW", "US"].includes(String(p.market)) || !nonempty(p.symbol) || !isRecord(p.strategy) || !isRecord(p.costs)
    || (expected && (p.creation_id !== expected.creation_id || p.market !== expected.market || p.symbol !== expected.symbol
      || Number(p.revision) < expected.revision || (exactRevision && p.revision_id !== expected.revision_id))))
    throw Error("研究版本已變更或明細身分不符，請重新讀取清單後核對。");
  return value as ResearchDetail;
}

export function researchDeleted(value: unknown, expected: ResearchSummary) {
  if (!isRecord(value) || value.creation_id !== expected.creation_id || value.status !== "deleted"
    || !nonempty(value.revision_id) || value.revision_id === expected.revision_id || !nonempty(value.deleted_at))
    throw Error("刪除回應尚未確認，保留原研究並讀回狀態。");
}

export function researchStaged(value: unknown, expected: { id: string; revision: string; intent: string; market: string; symbol: string }) {
  const row = stageRecord(value), raw = row.raw as UnknownRecord;
  const source = isRecord(raw.research_proposal) ? raw.research_proposal : {};
  if (raw.client_intent_id !== expected.intent || source.creation_id !== expected.id || source.revision_id !== expected.revision
      || source.workflow_origin !== "AI_NOMINATION" || source.market !== expected.market || (raw.market === undefined ? "TW" : raw.market) !== expected.market || raw.symbol !== expected.symbol)
    throw Error("待送單回應未對應原研究與意圖，請讀回確認。");
  return row;
}

// This classification is restricted to local Research/Candidate mutations.
// It must never be used to unlock a formal submission attempt.
export function localRejection(error: unknown, tool: string) {
  return error instanceof CallError && error.tool === tool && error.uncertain === false
    && [400, 403, 404, 405, 409, 410, 422].includes(error.httpStatus ?? 0);
}

export function deletedResearchRead(error: unknown) {
  if (!(error instanceof CallError) || error.httpStatus !== 410 || error.tool !== "omi_read_research_proposal") return false;
  const body = isRecord(error.backendError) ? error.backendError : {};
  const detail = isRecord(body.error) ? body.error : isRecord(body.detail) ? body.detail : {};
  return detail.code === "PROPOSAL_DELETED";
}
