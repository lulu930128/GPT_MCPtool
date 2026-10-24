import { z } from "zod";
import type { Config } from "./config.js";
// Bound the adapter envelope; Trainer remains the full JLPT schema authority.
export const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);
export const setId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{2,80}$/);
export const questionInput = z.object({ setId, questionId: id }).strict();
export const typedAnswer = z.object({ type: z.enum(["single_choice", "multiple_choice", "text", "number", "matching"]),
  value: z.union([z.string().max(1000), z.array(z.string().max(40)).max(20), z.record(z.string().max(40), z.string().max(40)).refine(v => Object.keys(v).length <= 20)]) }).strict();
export const answerInput = z.object({ setId, attemptId: id, submissionId: id,
  answers: z.record(id, z.union([z.number().int().min(1).max(4), typedAnswer, z.null()])).refine(v => Object.keys(v).length > 0 && Object.keys(v).length <= 40),
  finalize: z.boolean().optional(),
}).strict();
export function createInput(config: Config) {
  return z.object({ language: z.enum(["ja", "en"]).default("ja"),
    presentation: z.enum(["text_options", "audio_only"]).default("text_options"),
    set: z.object({ schema_version: z.enum(["1.2", "2.0"]), set_id: setId,
      question_count: z.number().int().min(1).max(config.maxQuestions),
      questions: z.array(z.object({ id,
        audio_script: z.array(z.object({ text: z.string().min(1).max(config.maxTextLength) }).passthrough())
          .min(1).max(40)
      }).passthrough()).min(1).max(config.maxQuestions)
    }).passthrough().superRefine((value, ctx) => {
      if (value.question_count !== value.questions.length || new Set(value.questions.map(q => q.id)).size !== value.questions.length ||
        value.questions.some(q => q.audio_script.reduce((n, s) => n + s.text.length, 0) > config.maxTextLength) ||
        Buffer.byteLength(JSON.stringify(value)) > 262144) {
        ctx.addIssue({ code: "custom", message: "Invalid set bounds, count, or duplicate question IDs." });
      }
    })
  }).strict();
}
const japaneseQuestion = z.object({ ok: z.literal(true), setId, questionId: id,
  position: z.number().int().positive(), questionCount: z.number().int().min(1).max(20),
  language: z.literal("ja"), presentation: z.enum(["text_options", "audio_only"]),
  options: z.array(z.object({ key: z.number().int().min(1).max(4), text: z.string().max(5000).optional() }).strip()).length(4),
  audio: z.object({ state: z.enum(["missing", "stale", "ready"]), bytes: z.number().int().min(0) }).strip()
}).strip();
const englishQuestion = z.object({ ok: z.literal(true), setId, questionId: id,
  position: z.number().int().positive(), questionCount: z.number().int().min(1).max(40),
  language: z.literal("en"), presentation: z.enum(["text_options", "audio_only"]),
  prompt: z.string().max(8000), answerType: z.enum(["single_choice", "multiple_choice", "text", "number", "matching"]),
  section: z.number().int().min(1).max(4), selectionCount: z.number().int().min(1).max(20).nullable(),
  matchingKeys: z.array(z.string().max(40)).max(20),
  wordLimit: z.object({max_words: z.number().int().min(0).max(20), max_numbers: z.number().int().min(0).max(20)}).strip().nullable(),
  options: z.array(z.object({key: z.string().max(40), text: z.string().max(1000).optional()}).strip()).max(20),
  audio: z.object({state: z.enum(["missing", "stale", "ready"]), bytes: z.number().int().nonnegative()}).strip(),
}).strip();
export const safeQuestion = z.discriminatedUnion("language", [japaneseQuestion, englishQuestion]);
export const examResult = z.object({ ok: z.literal(true), setId, questionCount: z.number().int().min(1).max(40),
  questionIds: z.array(id).min(1).max(40), language: z.enum(["ja", "en"]),
  presentation: z.enum(["text_options", "audio_only"]), reused: z.boolean() }).strip();
export const healthResult = z.object({ ok: z.literal(true), contractVersion: z.literal("listening-trainer-v1"),
  languages: z.array(z.enum(["ja", "en"])).min(1).max(2),
  tts: z.object({ listenerRunning: z.boolean(), readiness: z.literal("listener_only"),
    mode: z.enum(["central", "legacy"]).optional(),
    serviceStatus: z.enum(["available", "busy", "unavailable"]).optional(),
    profiles: z.array(z.object({ name: z.enum(["male", "female", "narrator"]), listenerRunning: z.boolean() }).strip()).max(3)
  }).strip() }).strip();
// Explanation remains Trainer-owned content, bounded recursively by the HTTP byte limit.
// Only named educational fields can cross the boundary; session/path metadata cannot.
const japaneseAnswerResult = z.object({ ok: z.literal(true), setId, attemptId: id, submissionId: id,
  score: z.number().int().min(0), answeredCount: z.number().int().min(1).max(20),
  questionCount: z.number().int().min(1).max(20),
  details: z.array(z.object({ questionId: id, chosen: z.number().int().min(1).max(4), correct: z.boolean(),
    correctOption: z.number().int().min(1).max(4), transcript: z.string().max(10000),
    explanation: z.object({ summary: z.string().max(10000), evidence: z.string().max(10000),
      translation: z.string().max(10000) }).strip()
  }).strip()).min(1).max(20)
}).strip();
export const completedResult = z.object({
  ok: z.literal(true), contractVersion: z.literal("listening-result-v2"), language: z.literal("en"), examSystem: z.literal("IELTS"),
  setId, attemptId: id, submissionId: id.optional(), title: z.string().max(300), sourceRef: z.string().max(500),
  sourceKind: z.literal("generated_practice"), scope: z.enum(["section", "skill"]), status: z.enum(["in_progress", "completed"]),
  startedAt: z.string().datetime({offset: true}), completedAt: z.string().datetime({offset: true}).nullable(),
  gradingPolicyVersion: z.literal("ielts-listening-answer-v2"), rawScore: z.number().int().min(0).max(40),
  maxScore: z.number().int().min(1).max(40), questionCount: z.number().int().min(1).max(40), answeredCount: z.number().int().min(0).max(40),
  details: z.array(z.object({questionId: id, position: z.number().int().min(1).max(40), prompt: z.string().max(8000),
    answer: typedAnswer.nullable(), expectedAnswers: z.array(typedAnswer).min(1).max(20),
    awardedPoints: z.number().int().min(0).max(40), maxPoints: z.number().int().min(1).max(40),
    submittedAt: z.string().datetime({offset: true}), section: z.number().int().min(1).max(4), explanation: z.string().max(4000),
  }).strip()).max(40),
}).strip();
export const answerResult = z.union([completedResult, japaneseAnswerResult]);
