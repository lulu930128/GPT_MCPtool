export type ExecutionMode = "plan" | "workspace_write";

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
  dataClassification?: DataClassification;
  model?: string;
  effort?: ReasoningEffort;
  resultStatus?: JobResult["status"];
  inputArtifacts?: TextArtifactSummary[];
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

export interface JobSnapshot extends JobSummary {
  messages: ConversationMessage[];
  events: JobEvent[];
  nextEventSeq: number;
  approvals: PendingApproval[];
  hasDiff: boolean;
  hasResult: boolean;
  inputArtifacts: TextArtifactSummary[];
  artifacts: JobArtifactDescriptor[];
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
  stateVersion: number;
}
