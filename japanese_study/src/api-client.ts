import type { JapaneseStudyMcpConfig } from "./config.js";

export type StudyKind = "vocab" | "grammar" | "question";
export type ManualLabel = "known" | "unknown" | "uncertain" | "suspended";
export type AttemptResult = "seen" | "correct" | "wrong" | "easy" | "again";
export type PracticeTargetKind = "vocab" | "grammar";
export type PracticeTargetRole = "primary" | "secondary" | "context";
export type PracticeQuestionValidity = "valid" | "void" | "unscored";
export type PracticeAnswerResult = "correct" | "partial" | "wrong" | "skipped";
export type PracticeTargetSelector =
  | { type: "item_id"; itemId: string }
  | { type: "grammar_identity"; pattern: string; senseKey?: string }
  | {
      type: "vocab_identity";
      surface: string;
      reading?: string;
      partOfSpeech?: string;
      jlptLevel?: string;
    }
  | { type: "search"; query: string };

export interface SearchItemsInput {
  query?: string;
  kind?: StudyKind;
  jlptLevel?: string;
  limit?: number;
}

export interface SetManualLabelInput {
  itemId: string;
  label: ManualLabel;
  note?: string;
  source?: string;
}

export interface RecordAttemptInput {
  eventId: string;
  itemId: string;
  result: AttemptResult;
  occurredAt?: string;
  sessionId?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface PracticeSessionInput {
  sessionId: string;
  schemaVersion?: number;
  title: string;
  practiceType: string;
  requestedLevel?: string;
  status?: "completed" | "abandoned";
  startedAt: string;
  completedAt: string;
  timezoneName?: string;
  source?: string;
  scoringPolicy?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface PracticeTargetInput {
  targetKey: string;
  targetKind: PracticeTargetKind;
  selector?: PracticeTargetSelector;
  itemId?: string;
  canonicalKey?: string;
  pattern?: string;
  senseKey?: string;
  role?: PracticeTargetRole;
  componentKey?: string;
  weight?: number;
  affectsPlanning?: boolean;
  metadata?: Record<string, unknown>;
}

export interface PracticeResponseInput {
  answer: Record<string, unknown>;
  answerResult: PracticeAnswerResult;
  awardedPoints?: number;
  submittedAt: string;
  durationMs?: number;
  learnerNote?: string;
  diagnoses?: string[];
  grading?: Record<string, unknown>;
  gradingOverrideReason?: string;
}

export interface PracticeQuestionInput {
  questionKey: string;
  position: number;
  questionItemId?: string;
  snapshot: Record<string, unknown>;
  validity?: PracticeQuestionValidity;
  voidReason?: string;
  maxPoints?: number;
  targets?: PracticeTargetInput[];
  response: PracticeResponseInput;
}

export interface PracticeSubmissionInput {
  submissionId: string;
  schemaVersion?: number;
  session: PracticeSessionInput;
  questions: PracticeQuestionInput[];
}

export interface ListPracticeSessionsInput {
  dateFrom?: string;
  dateTo?: string;
  practiceType?: string;
  requestedLevel?: string;
  hasUnresolvedTargets?: boolean;
  includeSuperseded?: boolean;
  limit?: number;
  cursor?: string;
}

export interface PracticeResolutionOverrideInput {
  questionKey: string;
  targetKey: string;
  itemId: string;
}

export interface ApplyPracticeResolutionInput {
  sessionId: string;
  operationId: string;
  expectedFingerprint: string;
  overrides: PracticeResolutionOverrideInput[];
  actor?: string;
}

export interface SupersedePracticeSessionInput {
  originalSessionId: string;
  revisionId: string;
  replacementSessionId: string;
  reason: string;
  changedQuestionKeys?: string[];
  actor?: string;
}

export class HubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HubApiError";
  }
}

export class JapaneseStudyHubClient {
  constructor(private readonly config: Pick<JapaneseStudyMcpConfig, "hubBaseUrl" | "hubApiToken" | "hubTimeoutMs">) {}

  summary(): Promise<unknown> {
    return this.request("/api/v1/summary");
  }

  searchItems(input: SearchItemsInput): Promise<unknown> {
    const query = new URLSearchParams();
    if (input.query) query.set("query", input.query);
    if (input.kind) query.set("kind", input.kind);
    if (input.jlptLevel) query.set("jlpt_level", input.jlptLevel);
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    const suffix = query.size ? `?${query.toString()}` : "";
    return this.request(`/api/v1/items${suffix}`);
  }

  getItem(itemId: string): Promise<unknown> {
    return this.request(`/api/v1/items/${encodeURIComponent(itemId)}`);
  }

  studyPlan(input: { kind?: StudyKind; limit?: number }): Promise<unknown> {
    const query = new URLSearchParams();
    if (input.kind) query.set("kind", input.kind);
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    const suffix = query.size ? `?${query.toString()}` : "";
    return this.request(`/api/v1/study/plan${suffix}`);
  }

  setManualLabels(labels: SetManualLabelInput[]): Promise<unknown> {
    return this.request("/api/v1/mastery/labels", {
      method: "POST",
      body: JSON.stringify({
        labels: labels.map((entry) => ({
          item_id: entry.itemId,
          label: entry.label,
          note: entry.note || "",
          source: entry.source || "chatgpt_mcp",
        })),
      }),
    });
  }

  recordAttempt(input: RecordAttemptInput): Promise<unknown> {
    return this.request("/api/v1/attempts", {
      method: "POST",
      body: JSON.stringify({
        event_id: input.eventId,
        item_id: input.itemId,
        result: input.result,
        occurred_at: input.occurredAt,
        session_id: input.sessionId || "",
        source: input.source || "chatgpt_mcp",
        metadata: input.metadata || {},
      }),
    });
  }

  previewPractice(input: PracticeSubmissionInput): Promise<unknown> {
    return this.request("/api/v1/practice/submissions/preview", {
      method: "POST",
      body: JSON.stringify(toHubPracticePayload(input)),
    });
  }

  recordPractice(input: PracticeSubmissionInput): Promise<unknown> {
    return this.request("/api/v1/practice/submissions", {
      method: "POST",
      body: JSON.stringify(toHubPracticePayload(input)),
    });
  }

  getPracticeSession(sessionId: string): Promise<unknown> {
    return this.request(`/api/v1/practice/sessions/${encodeURIComponent(sessionId)}`);
  }

  listPracticeSessions(input: ListPracticeSessionsInput): Promise<unknown> {
    const query = new URLSearchParams();
    if (input.dateFrom) query.set("date_from", input.dateFrom);
    if (input.dateTo) query.set("date_to", input.dateTo);
    if (input.practiceType) query.set("practice_type", input.practiceType);
    if (input.requestedLevel) query.set("requested_level", input.requestedLevel);
    if (input.hasUnresolvedTargets !== undefined) {
      query.set("has_unresolved_targets", String(input.hasUnresolvedTargets));
    }
    if (input.includeSuperseded !== undefined) {
      query.set("include_superseded", String(input.includeSuperseded));
    }
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    if (input.cursor) query.set("cursor", input.cursor);
    const suffix = query.size ? `?${query.toString()}` : "";
    return this.request(`/api/v1/practice/sessions${suffix}`);
  }

  previewTargetSelectors(targets: PracticeTargetInput[]): Promise<unknown> {
    return this.request("/api/v1/practice/targets/preview", {
      method: "POST",
      body: JSON.stringify({
        targets: targets.map(toHubPracticeTarget),
      }),
    });
  }

  previewPracticeTargetResolution(
    sessionId: string,
    targetKeys: string[] = [],
  ): Promise<unknown> {
    return this.request(
      `/api/v1/practice/sessions/${encodeURIComponent(sessionId)}/target-resolution/preview`,
      {
        method: "POST",
        body: JSON.stringify({ target_keys: targetKeys }),
      },
    );
  }

  applyPracticeTargetOverrides(input: ApplyPracticeResolutionInput): Promise<unknown> {
    return this.request(
      `/api/v1/practice/sessions/${encodeURIComponent(input.sessionId)}/target-resolution/apply`,
      {
        method: "POST",
        body: JSON.stringify({
          operation_id: input.operationId,
          expected_fingerprint: input.expectedFingerprint,
          overrides: input.overrides.map((override) => ({
            question_key: override.questionKey,
            target_key: override.targetKey,
            item_id: override.itemId,
          })),
          actor: input.actor || "chatgpt_mcp",
        }),
      },
    );
  }

  supersedePracticeSession(input: SupersedePracticeSessionInput): Promise<unknown> {
    return this.request(
      `/api/v1/practice/sessions/${encodeURIComponent(input.originalSessionId)}/supersede`,
      {
        method: "POST",
        body: JSON.stringify({
          revision_id: input.revisionId,
          replacement_session_id: input.replacementSessionId,
          reason: input.reason,
          changed_question_keys: input.changedQuestionKeys || [],
          actor: input.actor || "chatgpt_mcp",
        }),
      },
    );
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.hubTimeoutMs);
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    if (this.config.hubApiToken) {
      headers.set("authorization", `Bearer ${this.config.hubApiToken}`);
    }

    try {
      const response = await fetch(`${this.config.hubBaseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: unknown = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { raw: text.slice(0, 500) };
        }
      }
      if (!response.ok) {
        throw new HubApiError(`Japanese Study Hub returned HTTP ${response.status}.`, response.status, payload);
      }
      return payload;
    } catch (error) {
      if (error instanceof HubApiError) {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new HubApiError("Japanese Study Hub request timed out.", 504);
      }
      throw new HubApiError(
        `Japanese Study Hub is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        503,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function toHubPracticePayload(input: PracticeSubmissionInput): Record<string, unknown> {
  return {
    submission_id: input.submissionId,
    schema_version: input.schemaVersion ?? 1,
    session: {
      session_id: input.session.sessionId,
      schema_version: input.session.schemaVersion ?? 1,
      title: input.session.title,
      practice_type: input.session.practiceType,
      requested_level: input.session.requestedLevel ?? "",
      status: input.session.status ?? "completed",
      started_at: input.session.startedAt,
      completed_at: input.session.completedAt,
      timezone_name: input.session.timezoneName ?? "Asia/Taipei",
      source: input.session.source ?? "chatgpt_mcp",
      scoring_policy: input.session.scoringPolicy ?? {
        policy_version: "practice-scoring-v1",
        void_policy: "exclude_from_denominator",
      },
      metadata: input.session.metadata ?? {},
    },
    questions: input.questions.map((question) => ({
      question_key: question.questionKey,
      position: question.position,
      question_item_id: question.questionItemId,
      snapshot: question.snapshot,
      validity: question.validity ?? "valid",
      void_reason: question.voidReason ?? "",
      max_points: question.maxPoints ?? 1,
      targets: (question.targets ?? []).map(toHubPracticeTarget),
      response: {
        answer: question.response.answer,
        answer_result: question.response.answerResult,
        awarded_points: question.response.awardedPoints ?? 0,
        submitted_at: question.response.submittedAt,
        duration_ms: question.response.durationMs,
        learner_note: question.response.learnerNote ?? "",
        diagnoses: question.response.diagnoses ?? [],
        grading: question.response.grading ?? {},
        grading_override_reason: question.response.gradingOverrideReason ?? "",
      },
    })),
  };
}

function toHubPracticeTarget(target: PracticeTargetInput): Record<string, unknown> {
  return {
    target_key: target.targetKey,
    target_kind: target.targetKind,
    selector: target.selector ? toHubSelector(target.selector) : undefined,
    item_id: target.itemId,
    canonical_key: target.canonicalKey,
    pattern: target.pattern,
    sense_key: target.senseKey,
    role: target.role ?? "primary",
    component_key: target.componentKey ?? "",
    weight: target.weight ?? 1,
    affects_planning: target.affectsPlanning,
    metadata: target.metadata ?? {},
  };
}

function toHubSelector(selector: PracticeTargetSelector): Record<string, unknown> {
  if (selector.type === "item_id") {
    return { type: selector.type, item_id: selector.itemId };
  }
  if (selector.type === "grammar_identity") {
    return {
      type: selector.type,
      pattern: selector.pattern,
      sense_key: selector.senseKey,
    };
  }
  if (selector.type === "vocab_identity") {
    return {
      type: selector.type,
      surface: selector.surface,
      reading: selector.reading,
      part_of_speech: selector.partOfSpeech,
      jlpt_level: selector.jlptLevel,
    };
  }
  return { type: selector.type, query: selector.query };
}
