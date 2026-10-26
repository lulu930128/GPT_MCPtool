import { z } from "zod";
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);
const setId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{2,80}$/);
export const typedAnswer = z.object({ type: z.enum(["single_choice", "multiple_choice", "text", "number", "matching"]),
  value: z.union([z.string().max(1000), z.array(z.string().max(40)).max(20), z.record(z.string().max(40), z.string().max(40)).refine(v => Object.keys(v).length <= 20)]) }).strict();
export const listeningResultSchema = z.object({
  ok: z.literal(true), contractVersion: z.literal("listening-result-v2"), language: z.literal("en"), examSystem: z.literal("IELTS"),
  setId, attemptId: id, submissionId: id.optional(), title: z.string().max(300), sourceRef: z.string().max(500),
  sourceKind: z.literal("generated_practice"), scope: z.enum(["section", "skill"]), status: z.literal("completed"),
  startedAt: z.string().datetime({offset: true}), completedAt: z.string().datetime({offset: true}),
  gradingPolicyVersion: z.literal("ielts-listening-answer-v2"), rawScore: z.number().int().min(0).max(40),
  maxScore: z.number().int().min(1).max(40), questionCount: z.number().int().min(1).max(40), answeredCount: z.number().int().min(0).max(40),
  details: z.array(z.object({questionId: id, position: z.number().int().min(1).max(40), prompt: z.string().max(8000),
    answer: typedAnswer.nullable(), expectedAnswers: z.array(typedAnswer).min(1).max(20),
    awardedPoints: z.number().int().min(0).max(40), maxPoints: z.number().int().min(1).max(40),
    submittedAt: z.string().datetime({offset: true}), section: z.number().int().min(1).max(4), explanation: z.string().max(4000),
  }).strip()).max(40),
}).strict();
export type ListeningResultInput = z.infer<typeof listeningResultSchema>;
