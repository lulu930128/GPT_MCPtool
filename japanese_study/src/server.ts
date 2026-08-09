import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  HubApiError,
  JapaneseStudyHubClient,
  type ApplyPracticeResolutionInput,
  type ListPracticeSessionsInput,
  type PracticeSubmissionInput,
  type PracticeTargetInput,
  type RecordAttemptInput,
  type SearchItemsInput,
  type SetManualLabelInput,
  type SupersedePracticeSessionInput,
} from "./api-client.js";
import type { JapaneseStudyMcpConfig } from "./config.js";

export const JAPANESE_STUDY_MCP_VERSION = "0.3.1";
export const JAPANESE_STUDY_CONTRACT_VERSION = "practice-resolution-v4.1";
export const JAPANESE_STUDY_TOOL_COUNT = 14;

const kindSchema = z.enum(["vocab", "grammar", "question"]);
const labelSchema = z.enum(["known", "unknown", "uncertain", "suspended"]);
const attemptResultSchema = z.enum(["seen", "correct", "wrong", "easy", "again"]);
const targetKindSchema = z.enum(["vocab", "grammar"]);
const targetRoleSchema = z.enum(["primary", "secondary", "context"]);
const questionValiditySchema = z.enum(["valid", "void", "unscored"]);
const answerResultSchema = z.enum(["correct", "partial", "wrong", "skipped"]);
const offsetDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .describe("RFC 3339 timestamp with Z or an explicit UTC offset.");
const toolErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  status: z.number().int(),
  retryable: z.boolean(),
  details: z.unknown().optional(),
});
const baseOutputSchema = {
  ok: z.boolean(),
  error: toolErrorSchema.optional(),
} as const;
const practiceSelectorSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("item_id"),
      itemId: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      type: z.literal("grammar_identity"),
      pattern: z.string().min(1).max(200),
      senseKey: z.string().min(1).max(100).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("vocab_identity"),
      surface: z.string().min(1).max(200),
      reading: z.string().min(1).max(200).optional(),
      partOfSpeech: z.string().min(1).max(100).optional(),
      jlptLevel: z.string().min(1).max(20).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("search"),
      query: z.string().min(1).max(200),
    })
    .strict(),
]);
const practiceTargetSchema = z
  .object({
    targetKey: z.string().min(1).max(200),
    targetKind: targetKindSchema,
    selector: practiceSelectorSchema.optional(),
    itemId: z.string().min(1).max(128).optional(),
    canonicalKey: z.string().min(1).max(500).optional(),
    pattern: z.string().min(1).max(200).optional(),
    senseKey: z.string().min(1).max(100).optional(),
    role: targetRoleSchema.optional(),
    componentKey: z.string().max(100).optional(),
    weight: z.number().gt(0).max(1).optional(),
    affectsPlanning: z.boolean().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict()
  .refine(
    (value) =>
      Boolean(
        value.selector ||
          value.itemId ||
          value.canonicalKey ||
          (value.pattern && value.senseKey),
      ),
    "A target requires selector, itemId, canonicalKey, or both pattern and senseKey.",
  )
  .refine(
    (value) => Boolean(value.pattern) === Boolean(value.senseKey),
    "pattern and senseKey must be provided together.",
  )
  .refine(
    (value) =>
      !value.selector ||
      !Boolean(value.itemId || value.canonicalKey || value.pattern || value.senseKey),
    "selector cannot be combined with legacy target fields.",
  )
  .refine(
    (value) =>
      value.selector?.type !== "grammar_identity" || value.targetKind === "grammar",
    "grammar_identity requires targetKind=grammar.",
  )
  .refine(
    (value) =>
      value.selector?.type !== "vocab_identity" || value.targetKind === "vocab",
    "vocab_identity requires targetKind=vocab.",
  );
const practiceResponseSchema = z
  .object({
    answer: z.record(z.unknown()),
    answerResult: answerResultSchema,
    awardedPoints: z.number().min(0).max(1000).optional(),
    submittedAt: offsetDateTimeSchema,
    durationMs: z.number().int().min(0).max(86_400_000).optional(),
    learnerNote: z.string().max(2000).optional(),
    diagnoses: z.array(z.string().min(1).max(100)).max(20).optional(),
    grading: z.record(z.unknown()).optional(),
    gradingOverrideReason: z
      .string()
      .max(1000)
      .optional()
      .describe(
        "Required when answerResult and awardedPoints intentionally differ from the default scoring policy.",
      ),
  })
  .strict();
const practiceQuestionSchema = z
  .object({
    questionKey: z.string().min(1).max(100),
    position: z.number().int().min(1).max(1000),
    questionItemId: z.string().min(1).max(128).optional(),
    snapshot: z.record(z.unknown()),
    validity: questionValiditySchema.optional(),
    voidReason: z.string().max(200).optional(),
    maxPoints: z.number().min(0).max(1000).optional(),
    targets: z.array(practiceTargetSchema).max(20).optional(),
    response: practiceResponseSchema,
  })
  .strict();
const practiceSubmissionSchema = z
  .object({
    submissionId: z.string().min(8).max(128),
    schemaVersion: z.literal(1).optional(),
    session: z
      .object({
        sessionId: z.string().min(8).max(128),
        schemaVersion: z.literal(1).optional(),
        title: z.string().min(1).max(200),
        practiceType: z.string().min(1).max(50),
        requestedLevel: z.string().max(50).optional(),
        status: z.enum(["completed", "abandoned"]).optional(),
        startedAt: offsetDateTimeSchema,
        completedAt: offsetDateTimeSchema,
        timezoneName: z.string().min(1).max(100).optional(),
        source: z.string().min(1).max(100).optional(),
        scoringPolicy: z.record(z.unknown()).optional(),
        metadata: z.record(z.unknown()).optional(),
      })
      .strict(),
    questions: z.array(practiceQuestionSchema).min(1).max(100),
  })
  .strict();

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const retrySafeWriteAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
} as const;

export function createJapaneseStudyMcpServer(config: JapaneseStudyMcpConfig): McpServer {
  const client = new JapaneseStudyHubClient(config);
  const server = new McpServer(
    { name: "japanese-study-mcp", version: JAPANESE_STUDY_MCP_VERSION },
    {
      instructions:
        "Private Japanese study tools backed by Japanese Study Hub. Search or preview target candidates before mutations. Use exact stable item ids for labels, attempts, and target overrides. Practice target search is candidate-only and never auto-applies. Preview a session resolution and preserve its fingerprint before an explicitly confirmed item-id override. This server has no delete, reset, file, SQL, shell, general batch resolver, catalog import, Anki-write, or legacy-migration tools.",
    },
  );

  server.registerTool(
    "study_get_summary",
    {
      title: "取得日文學習摘要",
      description:
        "Use this when the user asks for current Japanese study totals, manual-label counts, or attempt counts without modifying progress.",
      annotations: readOnlyAnnotations,
      inputSchema: {},
      outputSchema: {
        ...baseOutputSchema,
        summary: z.record(z.unknown()).optional(),
      },
    },
    async () => safeResult(() => client.summary(), "已取得日文學習摘要。"),
  );

  server.registerTool(
    "study_search_items",
    {
      title: "搜尋日文學習項目",
      description:
        "Use this when the user wants to find vocabulary, grammar, or questions and obtain exact stable item ids before another action.",
      annotations: readOnlyAnnotations,
      inputSchema: {
        query: z.string().max(200).optional().describe("Word, reading, or Traditional Chinese meaning."),
        kind: kindSchema.optional().describe("Optional item type filter."),
        jlptLevel: z.string().max(20).optional().describe("Optional JLPT level such as N3."),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum matches. Defaults to 20."),
      },
      outputSchema: {
        ...baseOutputSchema,
        count: z.number().int().nonnegative().optional(),
        items: z.array(z.record(z.unknown())).optional(),
      },
    },
    async (args) =>
      safeResult(
        () => client.searchItems(args as SearchItemsInput),
        "已完成日文學習項目搜尋。",
      ),
  );

  server.registerTool(
    "study_get_item",
    {
      title: "取得單一學習項目",
      description:
        "Use this when an exact stable study item id is already known and the user needs its current content, manual label, and attempt evidence.",
      annotations: readOnlyAnnotations,
      inputSchema: {
        itemId: z.string().min(1).max(128).describe("Exact stable item id returned by search or a study plan."),
      },
      outputSchema: {
        ...baseOutputSchema,
        item: z.record(z.unknown()).optional(),
      },
    },
    async ({ itemId }) => safeResult(() => client.getItem(itemId), "已取得指定學習項目。"),
  );

  server.registerTool(
    "study_get_plan",
    {
      title: "取得今日學習計畫",
      description:
        "Use this when the user wants a bounded prioritized list for Japanese study or review without changing any progress.",
      annotations: readOnlyAnnotations,
      inputSchema: {
        kind: kindSchema.optional().describe("Optional item type filter."),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum items. Defaults to 20."),
      },
      outputSchema: {
        ...baseOutputSchema,
        count: z.number().int().nonnegative().optional(),
        items: z.array(z.record(z.unknown())).optional(),
      },
    },
    async (args) => safeResult(() => client.studyPlan(args), "已取得優先學習項目。"),
  );

  server.registerTool(
    "study_set_manual_labels",
    {
      title: "設定人工熟悉度分類",
      description:
        "Use this when the user explicitly wants exact study item ids marked as known, unknown, uncertain, or suspended. Repeating the same labels is safe.",
      annotations: retrySafeWriteAnnotations,
      inputSchema: {
        labels: z
          .array(
            z.object({
              itemId: z.string().min(1).max(128),
              label: labelSchema,
              note: z.string().max(1000).optional(),
            }),
          )
          .min(1)
          .max(100),
      },
      outputSchema: {
        ...baseOutputSchema,
        result: z.record(z.unknown()).optional(),
      },
    },
    async ({ labels }) =>
      safeResult(
        () => client.setManualLabels(labels as SetManualLabelInput[]),
        "已更新人工熟悉度分類。",
      ),
  );

  server.registerTool(
    "study_record_attempt",
    {
      title: "記錄一次答題結果",
      description:
        "Use this when the user has completed one exact study item attempt. eventId must uniquely identify that attempt and must be reused on retry.",
      annotations: retrySafeWriteAnnotations,
      inputSchema: {
        eventId: z.string().min(8).max(128).describe("Caller-generated idempotency id for this one attempt."),
        itemId: z.string().min(1).max(128).describe("Exact stable study item id."),
        result: attemptResultSchema,
        occurredAt: z.string().datetime().optional(),
        sessionId: z.string().max(128).optional(),
        metadata: z.record(z.unknown()).optional(),
      },
      outputSchema: {
        ...baseOutputSchema,
        result: z.record(z.unknown()).optional(),
      },
    },
    async (args) =>
      safeResult(
        () => client.recordAttempt(args as RecordAttemptInput),
        "已記錄答題結果；相同 eventId 的重試不會重複計入。",
      ),
  );

  server.registerTool(
    "study_preview_practice_record",
    {
      title: "預覽練習寫入結果",
      description:
        "Use this before recording a completed multi-question practice session. It validates targets, scoring, and unresolved references without writing progress.",
      annotations: readOnlyAnnotations,
      inputSchema: practiceSubmissionSchema.shape,
      outputSchema: {
        ...baseOutputSchema,
        preview: z.record(z.unknown()).optional(),
      },
    },
    async (args) =>
      safeResult(
        () => client.previewPractice(args as PracticeSubmissionInput),
        "已預覽練習寫入；尚未修改學習資料。",
      ),
  );

  server.registerTool(
    "study_record_practice",
    {
      title: "寫入完整練習紀錄",
      description:
        "Use this only after the user completed a multi-question practice session and asked to save it. Preview first, preserve void or partial results, and reuse the same submissionId on retry.",
      annotations: retrySafeWriteAnnotations,
      inputSchema: practiceSubmissionSchema.shape,
      outputSchema: {
        ...baseOutputSchema,
        duplicate: z.boolean().optional(),
        submission_id: z.string().optional(),
        session_id: z.string().optional(),
        payload_hash: z.string().optional(),
        stored: z.record(z.unknown()).optional(),
        score: z.record(z.unknown()).optional(),
        warnings: z.array(z.unknown()).optional(),
        unresolved_targets: z.array(z.unknown()).optional(),
      },
    },
    async (args) =>
      safeResult(
        () => client.recordPractice(args as PracticeSubmissionInput),
        "已寫入完整練習紀錄；相同 submissionId 的相同內容重試不會重複計入。",
      ),
  );

  server.registerTool(
    "study_preview_target_resolution",
    {
      title: "預覽考點解析候選",
      description:
        "Use this read-only tool to normalize grammar or vocabulary selectors and inspect exact or ambiguous candidates before recording a practice session. A search selector only returns candidates and is never treated as resolved.",
      annotations: readOnlyAnnotations,
      inputSchema: {
        targets: z.array(practiceTargetSchema).min(1).max(100),
      },
      outputSchema: {
        ...baseOutputSchema,
        resolver_version: z.string().optional(),
        targets: z.array(z.record(z.unknown())).optional(),
        counts: z.record(z.unknown()).optional(),
      },
    },
    async ({ targets }) =>
      safeResult(
        () => client.previewTargetSelectors(targets as PracticeTargetInput[]),
        "已預覽考點解析候選；尚未修改學習資料。",
      ),
  );

  server.registerTool(
    "study_list_practice_sessions",
    {
      title: "列出練習歷史",
      description:
        "Use this read-only tool to list recent practice sessions with bounded filters, authoritative score summaries, unresolved counts, revision state, and cursor pagination.",
      annotations: readOnlyAnnotations,
      inputSchema: {
        dateFrom: z.string().date().optional(),
        dateTo: z.string().date().optional(),
        practiceType: z.string().max(50).optional(),
        requestedLevel: z.string().max(50).optional(),
        hasUnresolvedTargets: z.boolean().optional(),
        includeSuperseded: z.boolean().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        cursor: z.string().max(1000).optional(),
      },
      outputSchema: {
        ...baseOutputSchema,
        count: z.number().int().nonnegative().optional(),
        items: z.array(z.record(z.unknown())).optional(),
        next_cursor: z.string().nullable().optional(),
      },
    },
    async (args) =>
      safeResult(
        () => client.listPracticeSessions(args as ListPracticeSessionsInput),
        "已取得練習歷史清單。",
      ),
  );

  server.registerTool(
    "study_preview_practice_target_resolution",
    {
      title: "預覽既有考試考點回填",
      description:
        "Use this read-only tool for one existing session before any target repair. It returns a state fingerprint, exact or ambiguous candidates, evidence impact, and possible duplicate attempts without writing.",
      annotations: readOnlyAnnotations,
      inputSchema: {
        sessionId: z.string().min(1).max(128),
        targetKeys: z.array(z.string().min(1).max(200)).max(100).optional(),
      },
      outputSchema: {
        ...baseOutputSchema,
        session_id: z.string().optional(),
        resolver_version: z.string().optional(),
        fingerprint: z.string().optional(),
        counts: z.record(z.unknown()).optional(),
        evidence_to_create: z.number().int().nonnegative().optional(),
        evidence_already_exists: z.number().int().nonnegative().optional(),
        targets: z.array(z.record(z.unknown())).optional(),
      },
    },
    async ({ sessionId, targetKeys }) =>
      safeResult(
        () => client.previewPracticeTargetResolution(sessionId, targetKeys),
        "已預覽既有考試考點回填；尚未修改學習資料。",
      ),
  );

  server.registerTool(
    "study_apply_practice_target_overrides",
    {
      title: "套用明確考點回填",
      description:
        "Use this only after the user explicitly confirms target repair for one existing session. Every override must provide an exact stable itemId from preview, plus the unchanged preview fingerprint and a retry-stable operationId. It cannot search, guess, or replace an already resolved target.",
      annotations: retrySafeWriteAnnotations,
      inputSchema: {
        sessionId: z.string().min(1).max(128),
        operationId: z.string().min(8).max(128),
        expectedFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
        overrides: z
          .array(
            z
              .object({
                questionKey: z.string().min(1).max(100),
                targetKey: z.string().min(1).max(200),
                itemId: z.string().min(1).max(128),
              })
              .strict(),
          )
          .min(1)
          .max(50),
      },
      outputSchema: {
        ...baseOutputSchema,
        duplicate: z.boolean().optional(),
        operation_id: z.string().optional(),
        session_id: z.string().optional(),
        applied: z.array(z.record(z.unknown())).optional(),
        evidence_created: z.number().int().nonnegative().optional(),
        attempts_suppressed: z.number().int().nonnegative().optional(),
      },
    },
    async (args) =>
      safeResult(
        () =>
          client.applyPracticeTargetOverrides({
            ...(args as ApplyPracticeResolutionInput),
            actor: "chatgpt_mcp",
          }),
        "已依明確 itemId 套用考點回填；相同 operationId 的重試不會重複寫入。",
      ),
  );

  server.registerTool(
    "study_supersede_practice_session",
    {
      title: "建立練習修正版關係",
      description:
        "Use this only after a corrected replacement session has already been recorded and the user explicitly asks to supersede the original. It keeps both immutable sessions and adds an auditable retry-safe revision relation.",
      annotations: retrySafeWriteAnnotations,
      inputSchema: {
        originalSessionId: z.string().min(8).max(128),
        revisionId: z.string().min(8).max(128),
        replacementSessionId: z.string().min(8).max(128),
        reason: z.string().min(1).max(1000),
        changedQuestionKeys: z.array(z.string().min(1).max(100)).max(100).optional(),
      },
      outputSchema: {
        ...baseOutputSchema,
        duplicate: z.boolean().optional(),
        revision: z.record(z.unknown()).optional(),
      },
    },
    async (args) =>
      safeResult(
        () =>
          client.supersedePracticeSession({
            ...(args as SupersedePracticeSessionInput),
            actor: "chatgpt_mcp",
          }),
        "已建立練習修正版關係；原始與替代 session 皆保留。",
      ),
  );

  server.registerTool(
    "study_get_practice_session",
    {
      title: "取得練習歷史",
      description:
        "Use this when an exact practice session id is known and the user wants its immutable questions, answers, targets, evidence, and score summary.",
      annotations: readOnlyAnnotations,
      inputSchema: {
        sessionId: z.string().min(1).max(128),
      },
      outputSchema: {
        ...baseOutputSchema,
        session: z.record(z.unknown()).optional(),
        questions: z.array(z.record(z.unknown())).optional(),
        summary: z.record(z.unknown()).optional(),
      },
    },
    async ({ sessionId }) =>
      safeResult(
        () => client.getPracticeSession(sessionId),
        "已取得指定練習歷史。",
      ),
  );

  return server;
}

async function safeResult(read: () => Promise<unknown>, message: string) {
  try {
    const value = await read();
    return {
      structuredContent: asObject(value),
      content: [{ type: "text" as const, text: message }],
    };
  } catch (error) {
    const toolError = toToolError(error);
    return {
      isError: true,
      structuredContent: {
        ok: false,
        error: toolError,
      },
      content: [
        {
          type: "text" as const,
          text: `Japanese Study Hub error (${toolError.status} ${toolError.code}): ${toolError.message}`,
        },
      ],
    };
  }
}

function toToolError(error: unknown): {
  code: string;
  message: string;
  status: number;
  retryable: boolean;
  details?: unknown;
} {
  if (error instanceof HubApiError) {
    const payload = asRecord(error.details);
    const domainError = asRecord(payload?.error);
    return {
      code:
        typeof domainError?.code === "string"
          ? domainError.code
          : error.status >= 500
            ? "HUB_UNAVAILABLE"
            : "HUB_REQUEST_FAILED",
      message:
        typeof domainError?.message === "string"
          ? domainError.message
          : error.message,
      status: error.status,
      retryable:
        typeof domainError?.retryable === "boolean"
          ? domainError.retryable
          : error.status >= 500,
      details: domainError?.details ?? error.details,
    };
  }
  return {
    code: "MCP_ADAPTER_ERROR",
    message: error instanceof Error ? error.message : String(error),
    status: 500,
    retryable: false,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HubApiError("Japanese Study Hub returned an invalid object response.", 502);
  }
  return value as Record<string, unknown>;
}
