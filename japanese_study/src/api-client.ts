import type { JapaneseStudyMcpConfig } from "./config.js";

export type StudyKind = "vocab" | "grammar" | "question";
export type ManualLabel = "known" | "unknown" | "uncertain" | "suspended";
export type AttemptResult = "seen" | "correct" | "wrong" | "easy" | "again";
export type PracticeTargetKind = "vocab" | "grammar";
export type PracticeTargetRole = "primary" | "secondary" | "context";
export type PracticeQuestionValidity = "valid" | "void" | "unscored";
export type PracticeAnswerResult = "correct" | "partial" | "wrong" | "skipped";
export type PracticeTargetAssessmentResult =
  | "correct"
  | "partial"
  | "wrong"
  | "skipped"
  | "unassessed";
export interface PracticeDiagnosisInput {
  code: string;
  occurrenceKey?: string;
  severity?: number;
  confidence?: number;
  componentKey?: string;
  sourceType?: "ai_grading" | "deterministic" | "manual";
  metadata?: Record<string, unknown>;
}
export interface PracticeTargetAssessmentInput {
  result: PracticeTargetAssessmentResult;
  confidence?: number;
  affectsPlanning?: boolean;
  diagnoses?: PracticeDiagnosisInput[];
  grading?: Record<string, unknown>;
}
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
  tag?: string;
  limit?: number;
}

export interface ItemDraftInput {
  kind: "vocab" | "grammar";
  title: string;
  reading?: string;
  meaningTc?: string;
  jlptLevel?: string;
  partOfSpeech?: string;
  senseKey?: string;
  content?: Record<string, unknown>;
  tags?: string[];
  provenance?: "manual" | "chatgpt_proposed" | "external_proposed";
  addToInbox?: boolean;
  createNewSense?: boolean;
}

export interface CreateItemInput {
  operationId: string;
  expectedFingerprint: string;
  draft: ItemDraftInput;
  actor?: string;
}

export interface ItemRevisionChangesInput {
  meaningTc?: string;
  content?: Record<string, unknown>;
  tags?: string[];
}

export interface PreviewItemRevisionInput {
  itemId: string;
  changes: ItemRevisionChangesInput;
  reason: string;
}

export interface ApplyItemRevisionInput extends PreviewItemRevisionInput {
  operationId: string;
  expectedFingerprint: string;
  actor?: string;
}

export interface ItemLifecycleInput {
  itemId: string;
  action: "retire" | "restore";
  reason: string;
  replacementItemId?: string;
}

export interface ApplyItemLifecycleInput extends ItemLifecycleInput {
  operationId: string;
  expectedFingerprint: string;
  actor?: string;
}

export interface QualityInboxInput {
  issueType?: string;
  kind?: "vocab" | "grammar";
  limit?: number;
  offset?: number;
}

export interface StudyListCreateInput {
  operationId: string;
  listId: string;
  kind: StudyKind;
  title: string;
  description?: string;
  actor?: string;
}

export interface StudyListItemsInput {
  listId: string;
  operationId: string;
  items: Array<{ itemId: string; priority?: number; note?: string }>;
  actor?: string;
}

export interface QuestionCandidateSaveInput {
  operationId: string;
  expectedFingerprint: string;
  candidate: Record<string, unknown>;
  actor?: string;
}

export interface QuestionCandidatePromotionInput {
  candidateId: string;
  operationId: string;
  expectedPayloadHash: string;
  reviewNote: string;
  actor?: string;
}

export interface QuestionCandidateRetireInput {
  candidateId: string;
  operationId: string;
  reason: string;
  actor?: string;
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
  assessment?: PracticeTargetAssessmentInput;
}

export interface PracticeResponseInput {
  answer: Record<string, unknown>;
  answerResult: PracticeAnswerResult;
  awardedPoints?: number;
  submittedAt: string;
  durationMs?: number;
  learnerNote?: string;
  diagnoses?: string[];
  diagnosisEvents?: PracticeDiagnosisInput[];
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
  practiceContractVersion?: 1 | 2;
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

export interface LearnerPolicyInput {
  schemaVersion: 1;
  practice: {
    autoRecordCompletedPractice: boolean;
    preservePartial: true;
    preserveVoid: true;
    preserveUnscored: true;
  };
  answerNotation: {
    chineseParentheses: "production_gap";
    emptyAnswer: "skipped";
  };
  questionGeneration: {
    generator: "ai";
    useLearningContext: boolean;
    preferWeakTargets: boolean;
    avoidFullCatalogDump: true;
  };
}

export interface SetLearnerPolicyInput {
  operationId: string;
  policy: LearnerPolicyInput;
  actor?: string;
}

export interface LearningContextInput {
  practiceType?: string;
  requestedLevel?: string;
  targetLevels?: string[];
  kind?: "vocab" | "grammar";
  targetLimit?: number;
  recentSessionLimit?: number;
  diagnosisLimit?: number;
}

export interface DiagnosisCatalogInput {
  query?: string;
  skillKey?: string;
  polarity?: "weakness" | "strength" | "observation" | "blocker";
  active?: boolean;
  limit?: number;
}

export interface RecordPracticeRevisionInput {
  originalSessionId: string;
  revisionId: string;
  reason: string;
  changedQuestionKeys?: string[];
  submission: PracticeSubmissionInput;
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
    if (input.tag) query.set("tag", input.tag);
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    const suffix = query.size ? `?${query.toString()}` : "";
    return this.request(`/api/v1/items${suffix}`);
  }

  getItem(itemId: string): Promise<unknown> {
    return this.request(`/api/v1/items/${encodeURIComponent(itemId)}`);
  }

  previewItemCreation(draft: ItemDraftInput): Promise<unknown> {
    return this.request("/api/v1/items/creation/preview", {
      method: "POST",
      body: JSON.stringify({ draft: toHubItemDraft(draft) }),
    });
  }

  createItem(input: CreateItemInput): Promise<unknown> {
    return this.request("/api/v1/items", {
      method: "POST",
      body: JSON.stringify({
        operation_id: input.operationId,
        expected_fingerprint: input.expectedFingerprint,
        draft: toHubItemDraft(input.draft),
        actor: input.actor || "chatgpt_mcp",
      }),
    });
  }

  previewItemRevision(input: PreviewItemRevisionInput): Promise<unknown> {
    return this.request(`/api/v1/items/${encodeURIComponent(input.itemId)}/revision/preview`, {
      method: "POST",
      body: JSON.stringify({ changes: toHubRevisionChanges(input.changes), reason: input.reason }),
    });
  }

  applyItemRevision(input: ApplyItemRevisionInput): Promise<unknown> {
    return this.request(`/api/v1/items/${encodeURIComponent(input.itemId)}/revision/apply`, {
      method: "POST",
      body: JSON.stringify({
        operation_id: input.operationId,
        expected_fingerprint: input.expectedFingerprint,
        changes: toHubRevisionChanges(input.changes),
        reason: input.reason,
        actor: input.actor || "chatgpt_mcp",
      }),
    });
  }

  previewItemLifecycle(input: ItemLifecycleInput): Promise<unknown> {
    return this.request(`/api/v1/items/${encodeURIComponent(input.itemId)}/lifecycle/preview`, {
      method: "POST",
      body: JSON.stringify({
        action: input.action,
        reason: input.reason,
        replacement_item_id: input.replacementItemId,
      }),
    });
  }

  applyItemLifecycle(input: ApplyItemLifecycleInput): Promise<unknown> {
    return this.request(`/api/v1/items/${encodeURIComponent(input.itemId)}/lifecycle/apply`, {
      method: "POST",
      body: JSON.stringify({
        operation_id: input.operationId,
        expected_fingerprint: input.expectedFingerprint,
        action: input.action,
        reason: input.reason,
        replacement_item_id: input.replacementItemId,
        actor: input.actor || "chatgpt_mcp",
      }),
    });
  }

  qualityInbox(input: QualityInboxInput): Promise<unknown> {
    const query = new URLSearchParams();
    if (input.issueType) query.set("issue_type", input.issueType);
    if (input.kind) query.set("kind", input.kind);
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    if (input.offset !== undefined) query.set("offset", String(input.offset));
    const suffix = query.size ? `?${query.toString()}` : "";
    return this.request(`/api/v1/quality/inbox${suffix}`);
  }

  dueReviews(input: { kind?: "vocab" | "grammar"; limit?: number }): Promise<unknown> {
    const query = new URLSearchParams();
    if (input.kind) query.set("kind", input.kind);
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    const suffix = query.size ? `?${query.toString()}` : "";
    return this.request(`/api/v1/reviews/due${suffix}`);
  }

  listStudyLists(input: { kind?: StudyKind; limit?: number }): Promise<unknown> {
    const query = new URLSearchParams();
    if (input.kind) query.set("kind", input.kind);
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    const suffix = query.size ? `?${query.toString()}` : "";
    return this.request(`/api/v1/lists${suffix}`);
  }

  createStudyList(input: StudyListCreateInput): Promise<unknown> {
    return this.request("/api/v1/lists", {
      method: "POST",
      body: JSON.stringify({
        operation_id: input.operationId,
        list_id: input.listId,
        kind: input.kind,
        title: input.title,
        description: input.description || "",
        actor: input.actor || "chatgpt_mcp",
      }),
    });
  }

  addStudyListItems(input: StudyListItemsInput): Promise<unknown> {
    return this.request(`/api/v1/lists/${encodeURIComponent(input.listId)}/items`, {
      method: "POST",
      body: JSON.stringify({
        operation_id: input.operationId,
        items: input.items.map((entry) => ({
          item_id: entry.itemId,
          priority: entry.priority ?? 1,
          note: entry.note || "",
        })),
        actor: input.actor || "chatgpt_mcp",
      }),
    });
  }

  previewQuestionCandidates(itemIds: string[], questionTypes: string[]): Promise<unknown> {
    return this.request("/api/v1/question-candidates/preview", {
      method: "POST",
      body: JSON.stringify({ item_ids: itemIds, question_types: questionTypes }),
    });
  }

  saveQuestionCandidate(input: QuestionCandidateSaveInput): Promise<unknown> {
    return this.request("/api/v1/question-candidates", {
      method: "POST",
      body: JSON.stringify({
        operation_id: input.operationId,
        expected_fingerprint: input.expectedFingerprint,
        candidate: input.candidate,
        actor: input.actor || "chatgpt_mcp",
      }),
    });
  }

  promoteQuestionCandidate(input: QuestionCandidatePromotionInput): Promise<unknown> {
    return this.request(`/api/v1/question-candidates/${encodeURIComponent(input.candidateId)}/promote`, {
      method: "POST",
      body: JSON.stringify({
        operation_id: input.operationId,
        expected_payload_hash: input.expectedPayloadHash,
        review_note: input.reviewNote,
        actor: input.actor || "chatgpt_mcp",
      }),
    });
  }

  retireQuestionCandidate(input: QuestionCandidateRetireInput): Promise<unknown> {
    return this.request(`/api/v1/question-candidates/${encodeURIComponent(input.candidateId)}/retire`, {
      method: "POST",
      body: JSON.stringify({
        operation_id: input.operationId,
        reason: input.reason,
        actor: input.actor || "chatgpt_mcp",
      }),
    });
  }

  studyPlan(input: { kind?: StudyKind; targetLevels?: string[]; limit?: number }): Promise<unknown> {
    const query = new URLSearchParams();
    if (input.kind) query.set("kind", input.kind);
    for (const level of input.targetLevels ?? []) query.append("target_levels", level);
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    const suffix = query.size ? `?${query.toString()}` : "";
    return this.request(`/api/v1/study/plan${suffix}`);
  }

  getLearnerPolicy(): Promise<unknown> {
    return this.request("/api/v1/learner-policy");
  }

  setLearnerPolicy(input: SetLearnerPolicyInput): Promise<unknown> {
    return this.request("/api/v1/learner-policy", {
      method: "PUT",
      body: JSON.stringify({
        operation_id: input.operationId,
        policy: toHubLearnerPolicy(input.policy),
        actor: input.actor || "chatgpt_mcp",
      }),
    });
  }

  learningContext(input: LearningContextInput): Promise<unknown> {
    const query = new URLSearchParams();
    if (input.practiceType) query.set("practice_type", input.practiceType);
    if (input.requestedLevel) query.set("requested_level", input.requestedLevel);
    for (const level of input.targetLevels ?? []) query.append("target_levels", level);
    if (input.kind) query.set("kind", input.kind);
    if (input.targetLimit !== undefined) query.set("target_limit", String(input.targetLimit));
    if (input.recentSessionLimit !== undefined) {
      query.set("recent_session_limit", String(input.recentSessionLimit));
    }
    if (input.diagnosisLimit !== undefined) {
      query.set("diagnosis_limit", String(input.diagnosisLimit));
    }
    const suffix = query.size ? `?${query.toString()}` : "";
    return this.request(`/api/v1/learning-context${suffix}`);
  }

  diagnosisCatalog(input: DiagnosisCatalogInput): Promise<unknown> {
    const query = new URLSearchParams();
    if (input.query) query.set("query", input.query);
    if (input.skillKey) query.set("skill_key", input.skillKey);
    if (input.polarity) query.set("polarity", input.polarity);
    if (input.active !== undefined) query.set("active", String(input.active));
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    const suffix = query.size ? `?${query.toString()}` : "";
    return this.request(`/api/v1/diagnosis-definitions${suffix}`);
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

  recordPracticeRevision(input: RecordPracticeRevisionInput): Promise<unknown> {
    return this.request(
      `/api/v1/practice/sessions/${encodeURIComponent(input.originalSessionId)}/revisions`,
      {
        method: "POST",
        body: JSON.stringify({
          revision_id: input.revisionId,
          reason: input.reason,
          changed_question_keys: input.changedQuestionKeys || [],
          submission: toHubPracticePayload(input.submission),
          actor: input.actor || "chatgpt_mcp",
        }),
      },
    );
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
    practice_contract_version: input.practiceContractVersion ?? 1,
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
        diagnosis_events: (question.response.diagnosisEvents ?? []).map(toHubDiagnosis),
        grading: question.response.grading ?? {},
        grading_override_reason: question.response.gradingOverrideReason ?? "",
      },
    })),
  };
}

function toHubLearnerPolicy(input: LearnerPolicyInput): Record<string, unknown> {
  return {
    schema_version: input.schemaVersion,
    practice: {
      auto_record_completed_practice: input.practice.autoRecordCompletedPractice,
      preserve_partial: input.practice.preservePartial,
      preserve_void: input.practice.preserveVoid,
      preserve_unscored: input.practice.preserveUnscored,
    },
    answer_notation: {
      chinese_parentheses: input.answerNotation.chineseParentheses,
      empty_answer: input.answerNotation.emptyAnswer,
    },
    question_generation: {
      generator: input.questionGeneration.generator,
      use_learning_context: input.questionGeneration.useLearningContext,
      prefer_weak_targets: input.questionGeneration.preferWeakTargets,
      avoid_full_catalog_dump: input.questionGeneration.avoidFullCatalogDump,
    },
  };
}

function toHubItemDraft(input: ItemDraftInput): Record<string, unknown> {
  return {
    kind: input.kind,
    title: input.title,
    reading: input.reading ?? "",
    meaning_tc: input.meaningTc ?? "",
    jlpt_level: input.jlptLevel ?? "",
    part_of_speech: input.partOfSpeech ?? "",
    sense_key: input.senseKey,
    content: input.content ?? {},
    tags: input.tags ?? [],
    provenance: input.provenance ?? "manual",
    add_to_inbox: input.addToInbox ?? true,
    create_new_sense: input.createNewSense ?? false,
  };
}

function toHubRevisionChanges(input: ItemRevisionChangesInput): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  if (input.meaningTc !== undefined) output.meaning_tc = input.meaningTc;
  if (input.content !== undefined) output.content = input.content;
  if (input.tags !== undefined) output.tags = input.tags;
  return output;
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
    assessment: target.assessment
      ? {
          result: target.assessment.result,
          confidence: target.assessment.confidence,
          affects_planning: target.assessment.affectsPlanning ?? true,
          diagnoses: (target.assessment.diagnoses ?? []).map(toHubDiagnosis),
          grading: target.assessment.grading ?? {},
        }
      : undefined,
  };
}

function toHubDiagnosis(diagnosis: PracticeDiagnosisInput): Record<string, unknown> {
  return {
    code: diagnosis.code,
    occurrence_key: diagnosis.occurrenceKey,
    severity: diagnosis.severity,
    confidence: diagnosis.confidence,
    component_key: diagnosis.componentKey ?? "",
    source_type: diagnosis.sourceType ?? "ai_grading",
    metadata: diagnosis.metadata ?? {},
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
