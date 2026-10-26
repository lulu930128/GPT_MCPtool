import { z } from "zod";

export const skillSchema = z.enum(["listening", "reading", "writing", "speaking"]);
export const moduleSchema = z.enum(["academic", "general_training", "not_applicable"]);
// New assessment subdocuments preserve the Hub's canonical field names.
// The Hub owns scoring policy and cross-field validation.
export const assessmentSchema = z.object({
  assessment_id: z.string().min(8).max(160), system: z.literal("IELTS").default("IELTS"),
  module: moduleSchema, skill: skillSchema, scope: z.enum(["task", "section", "skill"]),
  question_keys: z.array(z.string().min(1).max(120)).min(1).max(100),
  completeness: z.enum(["complete", "partial"]),
  source_kind: z.enum(["generated_practice", "published_practice", "teacher_assessment", "official_result"]),
  source_ref: z.string().min(1).max(500),
  scoring_method: z.enum(["model_estimate", "human_estimate", "deterministic", "reported_official"]),
  assessor: z.string().min(1).max(200), estimated: z.boolean(),
  overall_score: z.number().finite().min(0).max(9).multipleOf(0.5).nullable().optional(),
  score_scale: z.literal("ielts_band").optional(),
  rubric: z.record(z.string().max(80), z.number().finite().min(0).max(9).multipleOf(0.5)).optional(),
  rubric_version: z.string().min(1).max(120),
  metrics: z.object({
    task_type: z.enum(["task_1", "task_2"]).nullable().optional(),
    word_count: z.number().int().min(0).max(100000).nullable().optional(),
    duration_seconds: z.number().int().min(0).max(86400).nullable().optional(),
    raw_score: z.number().int().min(0).max(100).nullable().optional(),
    max_raw_score: z.number().int().min(1).max(100).nullable().optional(),
  }).strict().optional(),
  diagnostics: z.array(z.object({ tag: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
    kind: z.enum(["observed", "hypothesis"]), question_keys: z.array(z.string().min(1).max(120)).min(1).max(100),
    evidence: z.string().min(1).max(2000), feedback: z.string().max(2000).optional(),
  }).strict()).max(100).optional(),
  feedback: z.string().max(12000).optional(), grading_policy_version: z.string().min(1).max(120),
  assessed_at: z.string().datetime({ offset: true }),
}).strict();
export type AssessmentInput = z.infer<typeof assessmentSchema>;

export const historyFilter = {
  practiceType: z.string().min(1).max(80).optional(), assessmentSystem: z.literal("IELTS").optional(),
  skill: skillSchema.optional(), module: moduleSchema.optional(),
  dateFrom: z.string().datetime({ offset: true }).optional(), dateTo: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().nonnegative().optional(),
};
