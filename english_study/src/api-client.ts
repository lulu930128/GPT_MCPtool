import type { EnglishStudyMcpConfig } from "./config.js";

export type ItemKind = "vocab" | "phrase" | "grammar" | "question";
export type TargetKind = "vocab" | "phrase" | "grammar";

export interface ItemDraftInput {
  kind: ItemKind;
  title: string;
  lemma?: string;
  partOfSpeech?: string;
  senseKey: string;
  meaningTc?: string;
  cefrLevel?: string;
  ipa?: string;
  usageNotes?: string;
  content?: Record<string, unknown>;
  tags?: string[];
  sourceName?: string;
  sourceRef?: string;
  sourceVersion?: string;
}

export interface PracticeTargetInput {
  targetKey: string;
  itemId: string;
  targetKind: TargetKind;
  weight?: number;
}

export interface PracticeQuestionInput {
  questionKey: string;
  position: number;
  prompt: string;
  expectedAnswer?: Record<string, unknown>;
  answer?: Record<string, unknown>;
  answerResult: "correct" | "partial" | "wrong" | "void" | "unscored";
  awardedPoints: number;
  maxPoints: number;
  gradingRationale?: string;
  submittedAt: string;
  targets?: PracticeTargetInput[];
  metadata?: Record<string, unknown>;
}

export interface PracticeSubmissionInput {
  submissionId: string;
  session: {
    sessionId: string;
    title: string;
    practiceType: string;
    startedAt: string;
    completedAt: string;
    timezoneName?: string;
  };
  questions: PracticeQuestionInput[];
}

export class HubApiError extends Error {
  constructor(message: string, readonly status: number, readonly details?: unknown) {
    super(message);
    this.name = "HubApiError";
  }
}

export class EnglishStudyHubClient {
  constructor(private readonly config: Pick<EnglishStudyMcpConfig, "hubBaseUrl" | "hubApiToken" | "hubTimeoutMs">) {}

  summary() { return this.request("GET", "/api/v1/summary"); }

  searchItems(input: { query?: string; kind?: ItemKind; cefrLevel?: string; limit?: number; offset?: number }) {
    const query = new URLSearchParams();
    if (input.query) query.set("query", input.query);
    if (input.kind) query.set("kind", input.kind);
    if (input.cefrLevel) query.set("cefr_level", input.cefrLevel);
    query.set("limit", String(input.limit ?? 20));
    query.set("offset", String(input.offset ?? 0));
    return this.request("GET", `/api/v1/items?${query}`);
  }

  getItem(itemId: string) { return this.request("GET", `/api/v1/items/${encodeURIComponent(itemId)}`); }
  searchReferenceEntries(input: { query: string; sourceId?: string; partOfSpeech?: string; limit?: number; offset?: number }) {
    const query = new URLSearchParams({ query: input.query });
    if (input.sourceId) query.set("source_id", input.sourceId);
    if (input.partOfSpeech) query.set("part_of_speech", input.partOfSpeech);
    query.set("limit", String(input.limit ?? 20));
    query.set("offset", String(input.offset ?? 0));
    return this.request("GET", `/api/v1/reference/entries?${query}`);
  }
  getReferenceEntry(entryId: string) {
    return this.request("GET", `/api/v1/reference/entries/${encodeURIComponent(entryId)}`);
  }
  previewItemEnrichment(input: { itemId: string; referenceEntryIds?: string[] }) {
    return this.request("POST", "/api/v1/reference/enrichment/preview", {
      item_id: input.itemId,
      reference_entry_ids: input.referenceEntryIds ?? [],
    });
  }
  previewItemCreation(draft: ItemDraftInput) {
    return this.request("POST", "/api/v1/items/creation/preview", mapDraft(draft));
  }
  createItem(input: { operationId: string; expectedFingerprint: string; draft: ItemDraftInput }) {
    return this.request("POST", "/api/v1/items", {
      operation_id: input.operationId,
      expected_fingerprint: input.expectedFingerprint,
      actor: "chatgpt_mcp",
      draft: mapDraft(input.draft),
    });
  }
  dueReviews(limit = 20) { return this.request("GET", `/api/v1/reviews/due?limit=${limit}`); }
  studyPlan(limit = 20) { return this.request("GET", `/api/v1/study/plan?limit=${limit}`); }
  setManualLabels(input: { operationId: string; labels: Array<{ itemId: string; label: string; note?: string }> }) {
    return this.request("POST", "/api/v1/mastery/labels", {
      operation_id: input.operationId,
      actor: "chatgpt_mcp",
      labels: input.labels.map((entry) => ({ item_id: entry.itemId, label: entry.label, note: entry.note ?? "" })),
    });
  }
  recordAttempt(input: { eventId: string; itemId: string; result: string; occurredAt?: string; sessionId?: string; metadata?: Record<string, unknown> }) {
    return this.request("POST", "/api/v1/attempts", {
      event_id: input.eventId,
      item_id: input.itemId,
      result: input.result,
      occurred_at: input.occurredAt,
      session_id: input.sessionId ?? "",
      source: "chatgpt_mcp",
      metadata: input.metadata ?? {},
    });
  }
  previewPractice(submission: PracticeSubmissionInput) {
    return this.request("POST", "/api/v1/practice/submissions/preview", mapSubmission(submission));
  }
  recordPractice(input: { expectedFingerprint: string; submission: PracticeSubmissionInput }) {
    return this.request("POST", "/api/v1/practice/submissions", {
      expected_fingerprint: input.expectedFingerprint,
      actor: "chatgpt_mcp",
      submission: mapSubmission(input.submission),
    });
  }
  getPracticeSession(sessionId: string) {
    return this.request("GET", `/api/v1/practice/sessions/${encodeURIComponent(sessionId)}`);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.hubTimeoutMs);
    try {
      const response = await fetch(`${this.config.hubBaseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(this.config.hubApiToken ? { authorization: `Bearer ${this.config.hubApiToken}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json().catch(() => undefined);
      if (!response.ok) throw new HubApiError(`English Study Hub returned HTTP ${response.status}.`, response.status, payload);
      return payload;
    } catch (error) {
      if (error instanceof HubApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw new HubApiError("English Study Hub request timed out.", 504);
      throw new HubApiError(`English Study Hub is unavailable: ${error instanceof Error ? error.message : String(error)}`, 503);
    } finally {
      clearTimeout(timer);
    }
  }
}

function mapDraft(draft: ItemDraftInput): Record<string, unknown> {
  return {
    kind: draft.kind,
    title: draft.title,
    lemma: draft.lemma ?? "",
    part_of_speech: draft.partOfSpeech ?? "",
    sense_key: draft.senseKey,
    meaning_tc: draft.meaningTc ?? "",
    cefr_level: draft.cefrLevel ?? "",
    ipa: draft.ipa ?? "",
    usage_notes: draft.usageNotes ?? "",
    content: draft.content ?? {},
    tags: draft.tags ?? [],
    source_name: draft.sourceName ?? "chatgpt_mcp",
    source_ref: draft.sourceRef ?? "",
    source_version: draft.sourceVersion ?? "",
  };
}

function mapSubmission(input: PracticeSubmissionInput): Record<string, unknown> {
  return {
    submission_id: input.submissionId,
    session: {
      session_id: input.session.sessionId,
      title: input.session.title,
      practice_type: input.session.practiceType,
      started_at: input.session.startedAt,
      completed_at: input.session.completedAt,
      timezone_name: input.session.timezoneName ?? "Asia/Taipei",
    },
    questions: input.questions.map((question) => ({
      question_key: question.questionKey,
      position: question.position,
      prompt: question.prompt,
      expected_answer: question.expectedAnswer ?? {},
      answer: question.answer ?? {},
      answer_result: question.answerResult,
      awarded_points: question.awardedPoints,
      max_points: question.maxPoints,
      grading_rationale: question.gradingRationale ?? "",
      submitted_at: question.submittedAt,
      metadata: question.metadata ?? {},
      targets: (question.targets ?? []).map((target) => ({
        target_key: target.targetKey,
        item_id: target.itemId,
        target_kind: target.targetKind,
        weight: target.weight ?? 1,
      })),
    })),
  };
}
