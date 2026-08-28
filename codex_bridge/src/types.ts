export type ExecutionMode = "plan" | "workspace_write";

export type ApprovalReviewer = "user" | "auto_review";

export type DataClassification = "personal" | "public" | "company_approved";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type JobStatus =
  | "queued"
  | "preparing"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";

export interface BridgeProject {
  id: string;
  name: string;
  path: string;
}

export interface WorkPackage {
  projectId: string;
  title: string;
  objective: string;
  context: string;
  acceptanceCriteria: string[];
  constraints: string[];
  executionMode: ExecutionMode;
  approvalReviewer: ApprovalReviewer;
  dataClassification: DataClassification;
  model?: string;
  effort?: ReasoningEffort;
  inputBundleIds: string[];
}

export interface TextArtifactSummary {
  id: string;
  fileName: string;
  mimeType: string;
  sha256: string;
  chars: number;
  bytes: number;
}

export interface StagedTextArtifact extends TextArtifactSummary {
  content: string;
}

export interface MaterializedTextArtifact extends StagedTextArtifact {
  localPath: string;
}

export type JobArtifactKind = "request" | "response" | "diff";

export interface JobArtifactDescriptor {
  id: JobArtifactKind;
  name: string;
  mimeType: string;
  chars: number;
  bytes: number;
  sha256: string;
}

export interface JobArtifactChunk extends JobArtifactDescriptor {
  cursor: number;
  nextCursor?: number;
  done: boolean;
  content: string;
}

export interface CodexReasoningEffortOption {
  reasoningEffort: ReasoningEffort;
  description?: string;
}

export interface CodexModelOption {
  id: string;
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort?: ReasoningEffort;
  supportedReasoningEfforts: CodexReasoningEffortOption[];
}

export interface ConversationMessage {
  id: string;
  clientMessageId?: string;
  role: "user" | "assistant";
  content: string;
  context?: string;
  at: string;
  turnId?: string;
  executionMode?: ExecutionMode;
  approvalReviewer?: ApprovalReviewer;
  dataClassification?: DataClassification;
  model?: string;
  effort?: ReasoningEffort;
  resultStatus?: JobResult["status"];
  inputArtifacts?: TextArtifactSummary[];
}

export type ConversationProjectionItemType =
  | "userMessage"
  | "agentMessage"
  | "plan"
  | "reasoningSummary"
  | "commandExecution"
  | "fileChange"
  | "mcpToolCall"
  | "diff"
  | "approval"
  | "error"
  | "activity";

export interface ConversationFileChangeProjection {
  path: string;
  kind: string;
  diffPreview?: string;
  diffTruncated?: boolean;
}

export interface ConversationItemProjection {
  id: string;
  turnId: string;
  type: ConversationProjectionItemType;
  status: string;
  isStreaming: boolean;
  createdAt?: string;
  updatedAt?: string;
  text?: string;
  context?: string;
  clientMessageId?: string;
  inputArtifacts?: TextArtifactSummary[];
  command?: string;
  cwd?: string;
  output?: string;
  outputTruncated?: boolean;
  exitCode?: number;
  durationMs?: number;
  changes?: ConversationFileChangeProjection[];
  server?: string;
  tool?: string;
  progress?: string;
  error?: string;
  activityType?: string;
  approvalId?: string;
  approvalState?: ApprovalState;
  lastDelta?: string;
}

export interface ConversationTurnProjection {
  turnId: string;
  status: string;
  items: ConversationItemProjection[];
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

export interface ConversationThreadProjection {
  schemaVersion: 1;
  threadId?: string;
  status: "unknown" | "notLoaded" | "idle" | "active" | "systemError";
  turns: ConversationTurnProjection[];
  revision: number;
  updatedAt: string;
  hydratedAt?: string;
}

export interface ConversationProjectionPatch {
  revision: number;
  at: string;
  threadId?: string;
  status?: ConversationThreadProjection["status"];
  hydratedAt?: string;
  turns: ConversationTurnProjection[];
}

export interface JobEvent {
  seq: number;
  at: string;
  type: string;
  message: string;
  data?: Record<string, unknown>;
}

export type ApprovalKind = "command" | "file_change" | "permissions" | "user_input" | "elicitation";
export type ApprovalState = "pending" | "accepted" | "declined" | "cancelled" | "expired";

export interface PendingApproval {
  id: string;
  kind: ApprovalKind;
  state: ApprovalState;
  method: string;
  createdAt: string;
  resolvedAt?: string;
  summary: Record<string, unknown>;
}

export interface JobResult {
  status: "completed" | "failed" | "interrupted" | "cancelled";
  message: string;
  output?: string;
  completedAt: string;
  threadId?: string;
  turnId?: string;
}

export interface JobRecord {
  schemaVersion: 1;
  id: string;
  idempotencyKey: string;
  previewDigest: string;
  project: BridgeProject;
  workPackage: WorkPackage;
  status: JobStatus;
  stateVersion: number;
  lastEventSeq: number;
  createdAt: string;
  updatedAt: string;
  threadId?: string;
  turnId?: string;
  currentExecutionMode?: ExecutionMode;
  currentApprovalReviewer?: ApprovalReviewer;
  currentDataClassification?: DataClassification;
  model?: string;
  effort?: ReasoningEffort;
  approvals: PendingApproval[];
  inputArtifacts?: TextArtifactSummary[];
  result?: JobResult;
}

export interface JobSummary {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  objective: string;
  executionMode: ExecutionMode;
  approvalReviewer: ApprovalReviewer;
  dataClassification: DataClassification;
  status: JobStatus;
  stateVersion: number;
  createdAt: string;
  updatedAt: string;
  threadId?: string;
  turnId?: string;
  model?: string;
  effort?: ReasoningEffort;
  pendingApprovalCount: number;
  result?: JobResult;
}

export interface ConversationListPage {
  data: JobSummary[];
  nextCursor?: string;
}

export interface LocalThreadSummary {
  source: "local";
  threadId: string;
  projectId: string;
  projectName: string;
  title: string;
  preview: string;
  createdAt: string;
  updatedAt: string;
  threadStatus: string;
  isPinned: boolean;
  historyOnly: boolean;
}

export interface LocalThreadListPage {
  threads: LocalThreadSummary[];
  nextCursor?: string;
  complete: boolean;
}

export interface JobSnapshot extends JobSummary {
  messages: ConversationMessage[];
  conversation?: ConversationThreadProjection;
  conversationChanges: ConversationProjectionPatch[];
  nextConversationRevision: number;
  serverConversationRevision: number;
  conversationHasMore: boolean;
  events: JobEvent[];
  nextEventSeq: number;
  serverLastEventSeq: number;
  hasMore: boolean;
  approvals: PendingApproval[];
  hasDiff: boolean;
  hasResult: boolean;
  inputArtifacts: TextArtifactSummary[];
  artifacts: JobArtifactDescriptor[];
}

export interface LocalThreadSnapshot extends JobSnapshot {
  source: "local";
  readOnly: boolean;
  localThreadId: string;
  threadStatus: string;
}

export interface BridgeStatus {
  ok: boolean;
  service: string;
  version: string;
  buildId: string;
  controller: "idle" | "starting" | "ready" | "unavailable";
  projects: Array<Pick<BridgeProject, "id" | "name">>;
  models: CodexModelOption[];
  recentJobs: JobSummary[];
  conversationNextCursor?: string;
  stateVersion: number;
}
