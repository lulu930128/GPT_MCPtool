import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  EnglishStudyHubClient,
  HubApiError,
  type ItemDraftInput,
  type PracticeSubmissionInput,
} from "./api-client.js";
import type { EnglishStudyMcpConfig } from "./config.js";

export const ENGLISH_STUDY_MCP_VERSION = "0.2.0";
export const ENGLISH_STUDY_CONTRACT_VERSION = "english-learning-v1";
export const ENGLISH_STUDY_TOOL_COUNT = 12;

const itemKindSchema = z.enum(["vocab", "phrase", "grammar", "question"]);
const targetKindSchema = z.enum(["vocab", "phrase", "grammar"]);
const offsetDateTimeSchema = z.string().datetime({ offset: true });
const itemDraftSchema = z.object({
  kind: itemKindSchema,
  title: z.string().min(1).max(200),
  lemma: z.string().max(200).optional(),
  partOfSpeech: z.string().max(80).optional(),
  senseKey: z.string().min(1).max(100),
  meaningTc: z.string().max(2000).optional(),
  cefrLevel: z.enum(["A1", "A2", "B1", "B2", "C1", "C2"]).optional(),
  ipa: z.string().max(300).optional(),
  usageNotes: z.string().max(4000).optional(),
  content: z.record(z.unknown()).optional(),
  tags: z.array(z.string().min(1).max(100)).max(50).optional(),
  sourceName: z.string().min(1).max(120).optional(),
  sourceRef: z.string().max(500).optional(),
  sourceVersion: z.string().max(120).optional(),
}).strict().superRefine((value, context) => {
  if (["vocab", "phrase"].includes(value.kind) && !value.partOfSpeech?.trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["partOfSpeech"], message: "Vocabulary and phrases require partOfSpeech." });
  }
});
const practiceTargetSchema = z.object({
  targetKey: z.string().min(1).max(120),
  itemId: z.string().min(8).max(120),
  targetKind: targetKindSchema,
  weight: z.number().positive().max(10).optional(),
}).strict();
const practiceQuestionSchema = z.object({
  questionKey: z.string().min(1).max(120),
  position: z.number().int().positive().max(1000),
  prompt: z.string().min(1).max(8000),
  expectedAnswer: z.record(z.unknown()).optional(),
  answer: z.record(z.unknown()).optional(),
  answerResult: z.enum(["correct", "partial", "wrong", "void", "unscored"]),
  awardedPoints: z.number().nonnegative().max(1000),
  maxPoints: z.number().positive().max(1000),
  gradingRationale: z.string().max(4000).optional(),
  submittedAt: offsetDateTimeSchema,
  targets: z.array(practiceTargetSchema).max(20).optional(),
  metadata: z.record(z.unknown()).optional(),
}).strict();
const practiceSubmissionSchema = z.object({
  submissionId: z.string().min(8).max(160),
  session: z.object({
    sessionId: z.string().min(8).max(160),
    title: z.string().min(1).max(300),
    practiceType: z.string().min(1).max(80),
    startedAt: offsetDateTimeSchema,
    completedAt: offsetDateTimeSchema,
    timezoneName: z.string().min(1).max(80).optional(),
  }).strict(),
  questions: z.array(practiceQuestionSchema).min(1).max(100),
}).strict();
const toolErrorSchema = z.object({
  code: z.string(), message: z.string(), status: z.number().int(), retryable: z.boolean(), details: z.unknown().optional(),
});
const baseOutputSchema = { ok: z.boolean(), error: toolErrorSchema.optional() };
const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const retrySafeWriteAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true } as const;

export function createEnglishStudyMcpServer(config: EnglishStudyMcpConfig): McpServer {
  const client = new EnglishStudyHubClient(config);
  const server = new McpServer(
    { name: "english-study-mcp", version: ENGLISH_STUDY_MCP_VERSION },
    { instructions: "Private English study tools backed by an independent English Study Hub. Preview item creation and complete practice before writes. Reuse operation, event, and submission ids only for exact retries. Vocabulary and phrase identity requires lemma, part of speech, and explicit sense key. This server has no delete, reset, file, SQL, shell, unrestricted import, audio, speech-recognition, Anki, or migration/admin tools." },
  );

  server.registerTool("english_get_summary", {
    title: "取得英文學習摘要",
    description: "Read bounded English study totals without modifying progress.",
    annotations: readOnlyAnnotations,
    inputSchema: {},
    outputSchema: { ...baseOutputSchema, summary: z.record(z.unknown()).optional() },
  }, async () => safeResult(() => client.summary(), "已取得英文學習摘要。"));

  server.registerTool("english_search_items", {
    title: "搜尋英文教材",
    description: "Find vocabulary, phrases, grammar, or questions and return stable item ids. Search results are candidates and do not authorize a write.",
    annotations: readOnlyAnnotations,
    inputSchema: {
      query: z.string().max(200).optional(), kind: itemKindSchema.optional(),
      cefrLevel: z.enum(["A1", "A2", "B1", "B2", "C1", "C2"]).optional(),
      limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().nonnegative().optional(),
    },
    outputSchema: { ...baseOutputSchema, count: z.number().int().nonnegative().optional(), total: z.number().int().nonnegative().optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional(), has_more: z.boolean().optional(), items: z.array(z.record(z.unknown())).optional() },
  }, async (args) => safeResult(() => client.searchItems(args), "已取得英文教材候選。"));

  server.registerTool("english_get_item", {
    title: "取得英文教材詳情",
    description: "Read one exact English study item, content, tags, and review schedule by stable item id.",
    annotations: readOnlyAnnotations,
    inputSchema: { itemId: z.string().min(8).max(120) },
    outputSchema: { ...baseOutputSchema, item: z.record(z.unknown()).optional() },
  }, async ({ itemId }) => safeResult(() => client.getItem(itemId), "已取得英文教材詳情。"));

  server.registerTool("english_preview_item_creation", {
    title: "預覽新增英文教材",
    description: "Normalize an English item identity and inspect exact or possible duplicates. Preview never writes.",
    annotations: readOnlyAnnotations,
    inputSchema: { draft: itemDraftSchema },
    outputSchema: { ...baseOutputSchema, contract_version: z.string().optional(), candidate: z.record(z.unknown()).optional(), can_create: z.boolean().optional(), exact_duplicate_item_id: z.string().nullable().optional(), possible_duplicate_ids: z.array(z.string()).optional(), possible_duplicates: z.array(z.record(z.unknown())).optional(), warnings: z.array(z.string()).optional(), fingerprint: z.string().optional() },
  }, async ({ draft }) => safeResult(() => client.previewItemCreation(draft as ItemDraftInput), "已預覽英文教材 identity 與重複候選。"));

  server.registerTool("english_create_item", {
    title: "新增英文教材",
    description: "Create one user-confirmed item from an unchanged preview. Use only after explicit confirmation and reuse operationId only for an exact retry.",
    annotations: retrySafeWriteAnnotations,
    inputSchema: { operationId: z.string().min(8).max(160), expectedFingerprint: z.string().regex(/^[0-9a-f]{64}$/), draft: itemDraftSchema },
    outputSchema: { ...baseOutputSchema, item: z.record(z.unknown()).optional(), replayed: z.boolean().optional() },
  }, async (args) => safeResult(() => client.createItem(args as { operationId: string; expectedFingerprint: string; draft: ItemDraftInput }), "已保存經確認的英文教材。"));

  server.registerTool("english_get_due_reviews", {
    title: "取得英文到期複習",
    description: "Read the bounded English SRS due queue without changing schedules.",
    annotations: readOnlyAnnotations,
    inputSchema: { limit: z.number().int().min(1).max(100).optional() },
    outputSchema: { ...baseOutputSchema, count: z.number().int().nonnegative().optional(), items: z.array(z.record(z.unknown())).optional() },
  }, async ({ limit }) => safeResult(() => client.dueReviews(limit), "已取得英文到期複習。"));

  server.registerTool("english_get_plan", {
    title: "取得英文學習計畫",
    description: "Read a bounded prioritized English study plan with explicit ranking reasons.",
    annotations: readOnlyAnnotations,
    inputSchema: { limit: z.number().int().min(1).max(100).optional() },
    outputSchema: { ...baseOutputSchema, count: z.number().int().nonnegative().optional(), items: z.array(z.record(z.unknown())).optional() },
  }, async ({ limit }) => safeResult(() => client.studyPlan(limit), "已取得英文學習計畫。"));

  server.registerTool("english_set_manual_labels", {
    title: "設定英文人工熟悉度",
    description: "Persist explicit user judgments for exact item ids. Never infer a label merely from conversation or one answer.",
    annotations: retrySafeWriteAnnotations,
    inputSchema: { operationId: z.string().min(8).max(160), labels: z.array(z.object({ itemId: z.string().min(8).max(120), label: z.enum(["known", "unknown", "uncertain", "suspended"]), note: z.string().max(2000).optional() }).strict()).min(1).max(100) },
    outputSchema: { ...baseOutputSchema, operation_id: z.string().optional(), updated_count: z.number().int().nonnegative().optional(), replayed: z.boolean().optional() },
  }, async (args) => safeResult(() => client.setManualLabels(args), "已依使用者明確要求保存英文人工熟悉度。"));

  server.registerTool("english_record_attempt", {
    title: "記錄英文單題作答",
    description: "Append one completed English review event for an exact item. Use only when saving is authorized; reuse eventId only for an exact retry.",
    annotations: retrySafeWriteAnnotations,
    inputSchema: { eventId: z.string().min(8).max(160), itemId: z.string().min(8).max(120), result: z.enum(["seen", "correct", "wrong", "easy", "again"]), occurredAt: offsetDateTimeSchema.optional(), sessionId: z.string().max(160).optional(), metadata: z.record(z.unknown()).optional() },
    outputSchema: { ...baseOutputSchema, event_id: z.string().optional(), inserted: z.boolean().optional(), replayed: z.boolean().optional() },
  }, async (args) => safeResult(() => client.recordAttempt(args), "已保存英文單題作答。"));

  server.registerTool("english_preview_practice_record", {
    title: "預覽英文練習紀錄",
    description: "Validate and score one complete English practice without writing. Preserve partial, void, unscored, and missing-target states.",
    annotations: readOnlyAnnotations,
    inputSchema: { submission: practiceSubmissionSchema },
    outputSchema: { ...baseOutputSchema, can_record: z.boolean().optional(), missing_item_ids: z.array(z.string()).optional(), summary: z.record(z.unknown()).optional(), fingerprint: z.string().optional(), contract_version: z.string().optional(), scoring_policy_version: z.string().optional() },
  }, async ({ submission }) => safeResult(() => client.previewPractice(submission as PracticeSubmissionInput), "已預覽完整英文練習紀錄。"));

  server.registerTool("english_record_practice", {
    title: "保存英文練習紀錄",
    description: "Atomically save one completed, previewed English practice. Use only after recording is authorized and reuse submissionId only for an exact retry.",
    annotations: retrySafeWriteAnnotations,
    inputSchema: { expectedFingerprint: z.string().regex(/^[0-9a-f]{64}$/), submission: practiceSubmissionSchema },
    outputSchema: { ...baseOutputSchema, submission_id: z.string().optional(), session_id: z.string().optional(), inserted: z.boolean().optional(), replayed: z.boolean().optional(), summary: z.record(z.unknown()).optional() },
  }, async (args) => safeResult(() => client.recordPractice(args as { expectedFingerprint: string; submission: PracticeSubmissionInput }), "已原子保存完整英文練習。"));

  server.registerTool("english_get_practice_session", {
    title: "取得英文練習歷史",
    description: "Read one immutable English practice session including question and response snapshots.",
    annotations: readOnlyAnnotations,
    inputSchema: { sessionId: z.string().min(8).max(160) },
    outputSchema: { ...baseOutputSchema, session: z.record(z.unknown()).optional() },
  }, async ({ sessionId }) => safeResult(() => client.getPracticeSession(sessionId), "已取得英文練習歷史。"));

  return server;
}

async function safeResult(read: () => Promise<unknown>, message: string) {
  try {
    return { structuredContent: asObject(await read()), content: [{ type: "text" as const, text: message }] };
  } catch (error) {
    const toolError = toToolError(error);
    return {
      isError: true,
      structuredContent: { ok: false, error: toolError },
      content: [{ type: "text" as const, text: `English Study Hub error (${toolError.status} ${toolError.code}): ${toolError.message}` }],
    };
  }
}

function toToolError(error: unknown): { code: string; message: string; status: number; retryable: boolean; details?: unknown } {
  if (error instanceof HubApiError) {
    const payload = asRecord(error.details);
    const domain = asRecord(payload?.error);
    return {
      code: typeof domain?.code === "string" ? domain.code : error.status >= 500 ? "HUB_UNAVAILABLE" : "HUB_REQUEST_FAILED",
      message: typeof domain?.message === "string" ? domain.message : error.message,
      status: error.status,
      retryable: typeof domain?.retryable === "boolean" ? domain.retryable : error.status >= 500,
      details: domain?.details ?? error.details,
    };
  }
  return { code: "MCP_ADAPTER_ERROR", message: error instanceof Error ? error.message : String(error), status: 500, retryable: false };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asObject(value: unknown): Record<string, unknown> {
  const object = asRecord(value);
  if (!object) throw new HubApiError("English Study Hub returned an invalid object response.", 502);
  return object;
}
