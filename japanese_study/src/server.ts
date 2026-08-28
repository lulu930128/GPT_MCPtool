import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  HubApiError,
  JapaneseStudyHubClient,
  type ApplyItemLifecycleInput,
  type ApplyItemRevisionInput,
  type ApplyPracticeResolutionInput,
  type CreateItemInput,
  type DiagnosisCatalogInput,
  type ItemDraftInput,
  type ItemLifecycleInput,
  type LearningContextInput,
  type ListPracticeSessionsInput,
  type PreviewItemRevisionInput,
  type PracticeSubmissionInput,
  type PracticeTargetInput,
  type QualityInboxInput,
  type QuestionCandidatePromotionInput,
  type QuestionCandidateRetireInput,
  type QuestionCandidateSaveInput,
  type RecordAttemptInput,
  type RecordPracticeRevisionInput,
  type SearchItemsInput,
  type SetManualLabelInput,
  type SetLearnerPolicyInput,
  type StudyListCreateInput,
  type StudyListItemsInput,
  type SupersedePracticeSessionInput,
} from "./api-client.js";
import type { JapaneseStudyMcpConfig } from "./config.js";

export const JAPANESE_STUDY_MCP_VERSION = "1.2.1";
export const JAPANESE_STUDY_CONTRACT_VERSION = "learning-content-v8.1";
export const JAPANESE_STUDY_TOOL_COUNT = 34;

const kindSchema = z.enum(["vocab", "grammar", "question"]);
const labelSchema = z.enum(["known", "unknown", "uncertain", "suspended"]);
const attemptResultSchema = z.enum(["seen", "correct", "wrong", "easy", "again"]);
const targetKindSchema = z.enum(["vocab", "grammar"]);
const targetRoleSchema = z.enum(["primary", "secondary", "context"]);
const questionValiditySchema = z.enum(["valid", "void", "unscored"]);
const answerResultSchema = z.enum(["correct", "partial", "wrong", "skipped"]);
const targetAssessmentResultSchema = z.enum([
  "correct",
  "partial",
  "wrong",
  "skipped",
  "unassessed",
]);
const createPracticeDiagnosisSchema = () =>
  z.object({
    code: z.string().min(1).max(100),
    occurrenceKey: z.string().min(1).max(100).optional(),
    severity: z.number().gt(0).max(10).optional(),
    confidence: z.number().min(0).max(1).optional(),
    componentKey: z.string().max(100).optional(),
    sourceType: z.enum(["ai_grading", "deterministic", "manual"]).optional(),
    metadata: z.record(z.unknown()).optional(),
  }).strict();
const practiceTargetAssessmentSchema = z
  .object({
    result: targetAssessmentResultSchema,
    confidence: z.number().min(0).max(1).optional(),
    affectsPlanning: z.boolean().optional(),
    diagnoses: z.array(createPracticeDiagnosisSchema()).max(20).optional(),
    grading: z.record(z.unknown()).optional(),
  })
  .strict();
const itemDraftSchema = z
  .object({
    kind: z.enum(["vocab", "grammar"]),
    title: z.string().min(1).max(200),
    reading: z.string().max(200).optional(),
    meaningTc: z.string().max(2000).optional(),
    jlptLevel: z.string().max(20).optional(),
    partOfSpeech: z.string().max(100).optional(),
    senseKey: z.string().min(1).max(100).optional(),
    content: z.record(z.unknown()).optional(),
    tags: z.array(z.string().min(1).max(50)).max(30).optional(),
    provenance: z.enum(["manual", "chatgpt_proposed", "external_proposed"]).optional(),
    addToInbox: z.boolean().optional(),
    createNewSense: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "grammar" && !value.senseKey) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["senseKey"],
        message: "Grammar drafts require an explicit senseKey.",
      });
    }
  });
const itemRevisionChangesSchema = z
  .object({
    meaningTc: z.string().max(2000).optional(),
    content: z.record(z.unknown()).optional(),
    tags: z.array(z.string().min(1).max(50)).max(30).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one revision field is required.");
const questionTypeSchema = z.enum(["recall", "reading", "meaning", "cloze"]);
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
    assessment: practiceTargetAssessmentSchema.optional(),
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
    diagnosisEvents: z.array(createPracticeDiagnosisSchema()).max(20).optional(),
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

const levelScopeSchema = z
  .object({
    practice_profile: z.string().nullable(),
    target_levels: z.array(z.enum(["N1", "N2", "N3", "N4", "N5"])).nullable(),
    source: z.enum(["explicit", "profile_default", "unrestricted"]),
  })
  .strict();

const diagnosisCatalogItemSchema = z
  .object({
    code: z.string(),
    skill_key: z.string().nullable(),
    skill_title: z.string().nullable(),
    polarity: z.enum(["weakness", "strength", "observation", "blocker"]),
    default_severity: z.number().gt(0).max(10),
    affects_planning: z.boolean(),
    title: z.string(),
    description_tc: z.string(),
    active: z.boolean(),
    definition_version: z.string(),
  })
  .strict();
const practiceSubmissionObjectSchema = z
  .object({
    submissionId: z.string().min(8).max(128),
    schemaVersion: z.literal(1).optional(),
    practiceContractVersion: z.union([z.literal(1), z.literal(2)]).optional(),
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
const practiceSubmissionSchema = practiceSubmissionObjectSchema.superRefine(
  (value, context) => {
    const contractVersion = value.practiceContractVersion ?? 1;
    for (const [questionIndex, question] of value.questions.entries()) {
      if (contractVersion === 2) {
        if ((question.response.diagnoses ?? []).length > 0) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["questions", questionIndex, "response", "diagnoses"],
            message: "Contract v2 requires diagnosisEvents instead of legacy diagnoses.",
          });
        }
        for (const [targetIndex, target] of (question.targets ?? []).entries()) {
          if (!target.assessment) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["questions", questionIndex, "targets", targetIndex, "assessment"],
              message: "Contract v2 requires an assessment for every target.",
            });
          }
        }
      } else if (
        (question.response.diagnosisEvents ?? []).length > 0 ||
        (question.targets ?? []).some((target) => target.assessment)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["practiceContractVersion"],
          message: "Structured diagnoses and target assessments require contract v2.",
        });
      }
    }
  },
);
const learnerPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    practice: z
      .object({
        autoRecordCompletedPractice: z.boolean(),
        preservePartial: z.literal(true),
        preserveVoid: z.literal(true),
        preserveUnscored: z.literal(true),
      })
      .strict(),
    answerNotation: z
      .object({
        chineseParentheses: z.literal("production_gap"),
        emptyAnswer: z.literal("skipped"),
      })
      .strict(),
    questionGeneration: z
      .object({
        generator: z.literal("ai"),
        useLearningContext: z.boolean(),
        preferWeakTargets: z.boolean(),
        avoidFullCatalogDump: z.literal(true),
      })
      .strict(),
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
        "Private Japanese study tools backed by Japanese Study Hub. Preview item creation, revision, lifecycle, question candidates, and target resolution before writes. Reuse operation ids only for exact retries. Stable identity fields cannot be revised: create a corrected item and retire the old one instead. Proposed content remains visible in the quality inbox until reviewed. This server has no delete, reset, file, SQL, shell, unrestricted import, Anki-write, or legacy-migration tools.",
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
    "study_get_learner_policy",
    {
      title: "取得日文學習規則",
      description:
        "Use this before interpreting answer notation or deciding whether a completed practice may be recorded. The policy is typed and does not itself authorize a write.",
      annotations: readOnlyAnnotations,
      inputSchema: {},
      outputSchema: {
        ...baseOutputSchema,
        contract_version: z.string().optional(),
        policy_id: z.string().optional(),
        version: z.number().int().nonnegative().optional(),
        policy: z.record(z.unknown()).optional(),
        persisted: z.boolean().optional(),
        updated_at: z.string().nullable().optional(),
        updated_by: z.string().nullable().optional(),
      },
    },
    async () => safeResult(() => client.getLearnerPolicy(), "已取得日文學習規則。"),
  );

  server.registerTool(
    "study_set_learner_policy",
    {
      title: "設定日文學習規則",
      description:
        "Use only when the user explicitly asks to persist a complete typed learning policy. Reuse operationId only for an exact retry; this tool cannot add arbitrary policy keys.",
      annotations: retrySafeWriteAnnotations,
      inputSchema: {
        operationId: z.string().min(8).max(128),
        policy: learnerPolicySchema,
      },
      outputSchema: {
        ...baseOutputSchema,
        contract_version: z.string().optional(),
        policy_id: z.string().optional(),
        version: z.number().int().nonnegative().optional(),
        policy: z.record(z.unknown()).optional(),
        persisted: z.boolean().optional(),
        changed: z.boolean().optional(),
        duplicate: z.boolean().optional(),
        updated_at: z.string().nullable().optional(),
        updated_by: z.string().nullable().optional(),
        operation_id: z.string().optional(),
      },
    },
    async (args) =>
      safeResult(
        () => client.setLearnerPolicy({ ...(args as SetLearnerPolicyInput), actor: "chatgpt_mcp" }),
        "已依使用者要求保存 typed 日文學習規則。",
      ),
  );

  server.registerTool(
    "study_get_learning_context",
    {
      title: "取得個人化出題脈絡",
      description:
        "Use this before generating personalized Japanese practice. It returns bounded item targets, cross-item skill weaknesses, strengths, observations, active-revision diagnoses, and recent practice; it never generates questions or returns the full catalog.",
      annotations: readOnlyAnnotations,
      inputSchema: {
        practiceType: z.string().min(1).max(50).optional(),
        requestedLevel: z.string().min(1).max(50).optional(),
        targetLevels: z.array(z.enum(["N1", "N2", "N3", "N4", "N5"])).min(1).max(5).optional(),
        kind: z.enum(["vocab", "grammar"]).optional(),
        targetLimit: z.number().int().min(1).max(50).optional(),
        recentSessionLimit: z.number().int().min(1).max(20).optional(),
        diagnosisLimit: z.number().int().min(1).max(50).optional(),
      },
      outputSchema: {
        ...baseOutputSchema,
        contract_version: z.string().optional(),
        policy: z.record(z.unknown()).optional(),
        policy_version: z.number().int().nonnegative().optional(),
        policy_persisted: z.boolean().optional(),
        recommended_targets: z.array(z.record(z.unknown())).optional(),
        active_weaknesses: z.array(z.record(z.unknown())).optional(),
        recent_strengths: z.array(z.record(z.unknown())).optional(),
        recent_observations: z.array(z.record(z.unknown())).optional(),
        recent_diagnoses: z.array(z.record(z.unknown())).optional(),
        recent_practice: z.array(z.record(z.unknown())).optional(),
        level_scope: levelScopeSchema.optional(),
        generation_guidance: z.record(z.unknown()).optional(),
        limits: z.record(z.unknown()).optional(),
      },
    },
    async (args) =>
      safeResult(
        () => client.learningContext(args as LearningContextInput),
        "已取得 bounded 個人化日文學習脈絡；尚未生成或寫入題目。",
      ),
  );

  server.registerTool(
    "study_get_diagnosis_catalog",
    {
      title: "查詢診斷代碼目錄",
      description:
        "Use this bounded read-only tool when canonical diagnosis codes would reduce grading taxonomy drift. The Hub owns code-to-skill, polarity, and planning semantics; this tool cannot mutate definitions and is not required before every practice.",
      annotations: readOnlyAnnotations,
      inputSchema: {
        query: z.string().max(100).optional(),
        skillKey: z.string().max(100).optional(),
        polarity: z.enum(["weakness", "strength", "observation", "blocker"]).optional(),
        active: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      outputSchema: {
        ...baseOutputSchema,
        contract_version: z.string().optional(),
        count: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        filters: z.record(z.unknown()).optional(),
        items: z.array(diagnosisCatalogItemSchema).optional(),
      },
    },
    async (args) =>
      safeResult(
        () => client.diagnosisCatalog(args as DiagnosisCatalogInput),
        "已取得 bounded canonical 診斷代碼目錄；未修改 taxonomy 或學習資料。",
      ),
  );

  server.registerTool(
    "study_search_items",
    {
      title: "搜尋日文學習項目",
      description:
        "Use this when the user wants to find vocabulary, grammar, or questions and obtain exact stable item ids before another action. Search includes canonical content plus reviewable proposals, aliases, and components, but results remain item-level candidates.",
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
        total: z.number().int().nonnegative().optional(),
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().optional(),
        has_more: z.boolean().optional(),
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
        "Use this when an exact stable study item id is already known and the user needs canonical content, separately labelled proposals, verified aliases/components, manual label, and attempt evidence.",
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
    "study_preview_item_creation",
    {
      title: "預覽新增日語教材",
      description:
        "Use this before creating a vocabulary or grammar item. It computes the stable identity and shows exact or possible duplicates without writing.",
      annotations: readOnlyAnnotations,
      inputSchema: { draft: itemDraftSchema },
      outputSchema: {
        ...baseOutputSchema,
        contract_version: z.string().optional(),
        candidate: z.record(z.unknown()).optional(),
        can_create: z.boolean().optional(),
        exact_duplicate_item_id: z.string().nullable().optional(),
        possible_duplicate_ids: z.array(z.string()).optional(),
        possible_duplicates: z.array(z.record(z.unknown())).optional(),
        warnings: z.array(z.string()).optional(),
        fingerprint: z.string().optional(),
      },
    },
    async ({ draft }) =>
      safeResult(
        () => client.previewItemCreation(draft as ItemDraftInput),
        "已預覽教材 identity 與重複候選；尚未新增。",
      ),
  );

  server.registerTool(
    "study_create_item",
    {
      title: "新增日語教材",
      description:
        "Use only after the user confirms a creation preview. Preserve the exact draft and fingerprint, and reuse operationId only for the same retry.",
      annotations: retrySafeWriteAnnotations,
      inputSchema: {
        operationId: z.string().min(8).max(128),
        expectedFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
        draft: itemDraftSchema,
      },
      outputSchema: {
        ...baseOutputSchema,
        operation_id: z.string().optional(),
        item_id: z.string().optional(),
        revision_number: z.number().int().nonnegative().optional(),
        created: z.boolean().optional(),
        duplicate: z.boolean().optional(),
        item: z.record(z.unknown()).optional(),
      },
    },
    async (args) =>
      safeResult(
        () => client.createItem({ ...(args as CreateItemInput), actor: "chatgpt_mcp" }),
        "已新增教材並建立來源、revision、待學清單與 SRS 排程。",
      ),
  );

  server.registerTool(
    "study_preview_item_revision",
    {
      title: "預覽教材修訂",
      description:
        "Use this before revising an exact item. Only meaning, content, and tags can change; stable identity fields remain locked.",
      annotations: readOnlyAnnotations,
      inputSchema: {
        itemId: z.string().min(1).max(128),
        changes: itemRevisionChangesSchema,
        reason: z.string().min(1).max(1000),
      },
      outputSchema: {
        ...baseOutputSchema,
        contract_version: z.string().optional(),
        item_id: z.string().optional(),
        expected_revision: z.number().int().nonnegative().optional(),
        before: z.record(z.unknown()).optional(),
        after: z.record(z.unknown()).optional(),
        reason: z.string().optional(),
        fingerprint: z.string().optional(),
      },
    },
    async (args) =>
      safeResult(
        () => client.previewItemRevision(args as PreviewItemRevisionInput),
        "已預覽教材修訂前後內容；尚未寫入。",
      ),
  );

  server.registerTool(
    "study_apply_item_revision",
    {
      title: "套用教材修訂",
      description:
        "Use only after the user confirms the before/after preview. Preserve its fingerprint and use a retry-stable operationId.",
      annotations: retrySafeWriteAnnotations,
      inputSchema: {
        itemId: z.string().min(1).max(128),
        operationId: z.string().min(8).max(128),
        expectedFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
        changes: itemRevisionChangesSchema,
        reason: z.string().min(1).max(1000),
      },
      outputSchema: {
        ...baseOutputSchema,
        operation_id: z.string().optional(),
        item_id: z.string().optional(),
        revision_number: z.number().int().nonnegative().optional(),
        updated: z.boolean().optional(),
        duplicate: z.boolean().optional(),
        item: z.record(z.unknown()).optional(),
      },
    },
    async (args) =>
      safeResult(
        () => client.applyItemRevision({ ...(args as ApplyItemRevisionInput), actor: "chatgpt_mcp" }),
        "已套用教材修訂並保留 audit revision。",
      ),
  );

  server.registerTool(
    "study_preview_item_lifecycle",
    {
      title: "預覽教材退役或還原",
      description:
        "Use this before retiring or restoring an exact item. Retirement is reversible and may point to a confirmed replacement of the same kind.",
      annotations: readOnlyAnnotations,
      inputSchema: {
        itemId: z.string().min(1).max(128),
        action: z.enum(["retire", "restore"]),
        reason: z.string().min(1).max(1000),
        replacementItemId: z.string().min(1).max(128).optional(),
      },
      outputSchema: {
        ...baseOutputSchema,
        contract_version: z.string().optional(),
        item_id: z.string().optional(),
        expected_revision: z.number().int().nonnegative().optional(),
        action: z.enum(["retire", "restore"]).optional(),
        from_status: z.string().optional(),
        to_status: z.string().optional(),
        reason: z.string().optional(),
        replacement_item_id: z.string().nullable().optional(),
        replacement: z.record(z.unknown()).nullable().optional(),
        fingerprint: z.string().optional(),
      },
    },
    async (args) =>
      safeResult(
        () => client.previewItemLifecycle(args as ItemLifecycleInput),
        "已預覽教材 lifecycle 變更；尚未寫入。",
      ),
  );

  server.registerTool(
    "study_apply_item_lifecycle",
    {
      title: "套用教材退役或還原",
      description:
        "Use only after explicit confirmation of a lifecycle preview. It never deletes the item or its history.",
      annotations: retrySafeWriteAnnotations,
      inputSchema: {
        itemId: z.string().min(1).max(128),
        operationId: z.string().min(8).max(128),
        expectedFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
        action: z.enum(["retire", "restore"]),
        reason: z.string().min(1).max(1000),
        replacementItemId: z.string().min(1).max(128).optional(),
      },
      outputSchema: {
        ...baseOutputSchema,
        operation_id: z.string().optional(),
        item_id: z.string().optional(),
        lifecycle_status: z.string().optional(),
        revision_number: z.number().int().nonnegative().optional(),
        duplicate: z.boolean().optional(),
        item: z.record(z.unknown()).optional(),
      },
    },
    async (args) =>
      safeResult(
        () => client.applyItemLifecycle({ ...(args as ApplyItemLifecycleInput), actor: "chatgpt_mcp" }),
        "已套用教材 lifecycle 變更；教材與歷史均未刪除。",
      ),
  );

  server.registerTool(
    "study_get_quality_inbox",
    {
      title: "取得教材品質待辦",
      description:
        "Use this to inspect missing translations, pending meaning/alias/component proposals, incomplete vocabulary, content-review items, and unresolved practice targets without modifying data.",
      annotations: readOnlyAnnotations,
      inputSchema: {
        issueType: z.string().max(100).optional(),
        kind: z.enum(["vocab", "grammar"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).max(1_000_000).optional(),
      },
      outputSchema: {
        ...baseOutputSchema,
        count: z.number().int().nonnegative().optional(),
        total: z.number().int().nonnegative().optional(),
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().optional(),
        has_more: z.boolean().optional(),
        summary: z.record(z.unknown()).optional(),
        items: z.array(z.record(z.unknown())).optional(),
      },
    },
    async (args) =>
      safeResult(
        () => client.qualityInbox(args as QualityInboxInput),
        "已取得教材品質待辦。",
      ),
  );

  server.registerTool(
    "study_get_due_reviews",
    {
      title: "取得到期複習",
      description:
        "Use this to read the bounded SRS due queue. It returns only items actually enrolled in SRS; catalog membership alone never makes an item due. It does not mark any item reviewed.",
      annotations: readOnlyAnnotations,
      inputSchema: {
        kind: z.enum(["vocab", "grammar"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      outputSchema: {
        ...baseOutputSchema,
        as_of: z.string().optional(),
        count: z.number().int().nonnegative().optional(),
        items: z.array(z.record(z.unknown())).optional(),
      },
    },
    async (args) => safeResult(() => client.dueReviews(args), "已取得到期複習項目。"),
  );

  server.registerTool(
    "study_list_study_lists",
    {
      title: "列出學習清單",
      description: "Use this to inspect custom, imported, or manual-inbox study lists.",
      annotations: readOnlyAnnotations,
      inputSchema: {
        kind: kindSchema.optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      outputSchema: {
        ...baseOutputSchema,
        count: z.number().int().nonnegative().optional(),
        items: z.array(z.record(z.unknown())).optional(),
      },
    },
    async (args) => safeResult(() => client.listStudyLists(args), "已取得學習清單。"),
  );

  server.registerTool(
    "study_create_study_list",
    {
      title: "建立自訂學習清單",
      description:
        "Use when the user explicitly asks to create one bounded custom list. A list accepts only items of its declared kind.",
      annotations: retrySafeWriteAnnotations,
      inputSchema: {
        operationId: z.string().min(8).max(128),
        listId: z.string().min(1).max(128),
        kind: kindSchema,
        title: z.string().min(1).max(200),
        description: z.string().max(1000).optional(),
      },
      outputSchema: {
        ...baseOutputSchema,
        operation_id: z.string().optional(),
        list_id: z.string().optional(),
        created: z.boolean().optional(),
        duplicate: z.boolean().optional(),
        list: z.record(z.unknown()).optional(),
      },
    },
    async (args) =>
      safeResult(
        () => client.createStudyList({ ...(args as StudyListCreateInput), actor: "chatgpt_mcp" }),
        "已建立自訂學習清單。",
      ),
  );

  server.registerTool(
    "study_add_study_list_items",
    {
      title: "加入教材至學習清單",
      description:
        "Use when the user confirms exact stable item ids to add to one existing list. Kind mismatches are rejected.",
      annotations: retrySafeWriteAnnotations,
      inputSchema: {
        listId: z.string().min(1).max(128),
        operationId: z.string().min(8).max(128),
        items: z.array(z.object({
          itemId: z.string().min(1).max(128),
          priority: z.number().int().min(1).max(1_000_000).optional(),
          note: z.string().max(1000).optional(),
        }).strict()).min(1).max(200),
      },
      outputSchema: {
        ...baseOutputSchema,
        operation_id: z.string().optional(),
        list_id: z.string().optional(),
        items_changed: z.number().int().nonnegative().optional(),
        duplicate: z.boolean().optional(),
        list: z.record(z.unknown()).optional(),
      },
    },
    async (args) =>
      safeResult(
        () => client.addStudyListItems({ ...(args as StudyListItemsInput), actor: "chatgpt_mcp" }),
        "已將教材加入學習清單。",
      ),
  );

  server.registerTool(
    "study_preview_question_candidates",
    {
      title: "預覽題庫候選",
      description:
        "Use this to deterministically generate bounded question candidates from exact item ids. Candidates require human review and are not saved or promoted by preview.",
      annotations: readOnlyAnnotations,
      inputSchema: {
        itemIds: z.array(z.string().min(1).max(128)).min(1).max(50),
        questionTypes: z.array(questionTypeSchema).min(1).max(4),
      },
      outputSchema: {
        ...baseOutputSchema,
        contract_version: z.string().optional(),
        count: z.number().int().nonnegative().optional(),
        candidates: z.array(z.record(z.unknown())).optional(),
        fingerprint: z.string().optional(),
      },
    },
    async ({ itemIds, questionTypes }) =>
      safeResult(
        () => client.previewQuestionCandidates(itemIds, questionTypes),
        "已產生題庫候選；尚未儲存或 promotion。",
      ),
  );

  server.registerTool(
    "study_save_question_candidate",
    {
      title: "儲存題庫候選",
      description:
        "Use after the user confirms one unchanged deterministic candidate. Saving keeps it pending and does not make it a formal question.",
      annotations: retrySafeWriteAnnotations,
      inputSchema: {
        operationId: z.string().min(8).max(128),
        expectedFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
        candidate: z.record(z.unknown()),
      },
      outputSchema: {
        ...baseOutputSchema,
        operation_id: z.string().optional(),
        candidate_id: z.string().optional(),
        payload_hash: z.string().optional(),
        duplicate: z.boolean().optional(),
        candidate: z.record(z.unknown()).optional(),
      },
    },
    async (args) =>
      safeResult(
        () => client.saveQuestionCandidate({ ...(args as QuestionCandidateSaveInput), actor: "chatgpt_mcp" }),
        "已儲存 pending 題庫候選；尚未 promotion。",
      ),
  );

  server.registerTool(
    "study_promote_question_candidate",
    {
      title: "升級正式題目",
      description:
        "Use only after the user has manually reviewed the candidate answer and prompt. Requires its exact payload hash and an auditable review note.",
      annotations: retrySafeWriteAnnotations,
      inputSchema: {
        candidateId: z.string().min(1).max(128),
        operationId: z.string().min(8).max(128),
        expectedPayloadHash: z.string().regex(/^[0-9a-f]{64}$/),
        reviewNote: z.string().min(1).max(1000),
      },
      outputSchema: {
        ...baseOutputSchema,
        operation_id: z.string().optional(),
        candidate_id: z.string().optional(),
        question_item_id: z.string().optional(),
        promoted: z.boolean().optional(),
        duplicate: z.boolean().optional(),
        candidate: z.record(z.unknown()).optional(),
        question_item: z.record(z.unknown()).optional(),
      },
    },
    async (args) =>
      safeResult(
        () => client.promoteQuestionCandidate({ ...(args as QuestionCandidatePromotionInput), actor: "chatgpt_mcp" }),
        "已將人工核對過的候選升級為正式題目。",
      ),
  );

  server.registerTool(
    "study_retire_question_candidate",
    {
      title: "退役題庫候選",
      description:
        "Use when the user explicitly rejects one exact pending candidate. It is retained for audit and cannot be promoted afterward.",
      annotations: retrySafeWriteAnnotations,
      inputSchema: {
        candidateId: z.string().min(1).max(128),
        operationId: z.string().min(8).max(128),
        reason: z.string().min(1).max(1000),
      },
      outputSchema: {
        ...baseOutputSchema,
        operation_id: z.string().optional(),
        candidate_id: z.string().optional(),
        retired: z.boolean().optional(),
        duplicate: z.boolean().optional(),
        candidate: z.record(z.unknown()).optional(),
      },
    },
    async (args) =>
      safeResult(
        () => client.retireQuestionCandidate({ ...(args as QuestionCandidateRetireInput), actor: "chatgpt_mcp" }),
        "已退役題庫候選並保留稽核資料。",
      ),
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
        targetLevels: z
          .array(z.enum(["N1", "N2", "N3", "N4", "N5"]))
          .min(1)
          .max(5)
          .optional()
          .describe("Explicit catalog JLPT levels; never pass a practice profile here."),
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
      inputSchema: practiceSubmissionObjectSchema.shape,
      outputSchema: {
        ...baseOutputSchema,
        preview: z.record(z.unknown()).optional(),
      },
    },
    async (args) =>
      safeResult(
        () => client.previewPractice(parsePracticeSubmission(args)),
        "已預覽練習寫入；尚未修改學習資料。",
      ),
  );

  server.registerTool(
    "study_record_practice",
    {
      title: "寫入完整練習紀錄",
      description:
        "Use this only for a new completed multi-question practice session after the user or persisted learner policy authorizes saving. Preview first, preserve void or partial results, and reuse the same submissionId on retry. For a known correction, use study_record_practice_revision instead.",
      annotations: retrySafeWriteAnnotations,
      inputSchema: practiceSubmissionObjectSchema.shape,
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
        () => client.recordPractice(parsePracticeSubmission(args)),
        "已寫入完整練習紀錄；相同 submissionId 的相同內容重試不會重複計入。",
      ),
  );

  server.registerTool(
    "study_record_practice_revision",
    {
      title: "原子化修正練習紀錄",
      description:
        "Use when an already-recorded practice session must be corrected or enriched. The Hub atomically records the complete replacement session, links the immutable revision, and rebuilds affected SRS projections. Do not call study_record_practice first for a known correction.",
      annotations: retrySafeWriteAnnotations,
      inputSchema: {
        originalSessionId: z.string().min(8).max(128),
        revisionId: z.string().min(8).max(128),
        reason: z.string().min(1).max(1000),
        changedQuestionKeys: z.array(z.string().min(1).max(100)).max(100).optional(),
        submission: practiceSubmissionSchema,
      },
      outputSchema: {
        ...baseOutputSchema,
        duplicate: z.boolean().optional(),
        original_session_id: z.string().optional(),
        replacement_session_id: z.string().optional(),
        revision_id: z.string().optional(),
        affected_item_ids: z.array(z.string()).optional(),
        rebuilt_srs_count: z.number().int().nonnegative().optional(),
        score: z.record(z.unknown()).optional(),
        warnings: z.array(z.unknown()).optional(),
        record: z.record(z.unknown()).optional(),
        revision: z.record(z.unknown()).optional(),
      },
    },
    async (args) =>
      safeResult(
        () => client.recordPracticeRevision({ ...(args as RecordPracticeRevisionInput), actor: "chatgpt_mcp" }),
        "已原子化保存修正版練習、revision 關係與重建後的 SRS projection。",
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

function parsePracticeSubmission(input: unknown): PracticeSubmissionInput {
  const parsed = practiceSubmissionSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new HubApiError("Invalid practice submission contract.", 400, {
    error: {
      code: "INVALID_PRACTICE_CONTRACT",
      message: "The practice submission does not satisfy the selected contract version.",
      retryable: false,
      details: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      },
    },
  });
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
