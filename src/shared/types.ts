export type StepStatus =
  | "pending"
  | "running"
  | "waiting_for_human"
  | "paused"
  | "hard_stopped"
  | "completed"
  | "failed"
  | "terminated";

export type TaskStatus = StepStatus;

export type AgentEventType =
  | "step_started"
  | "progress"
  | "artifact_created"
  | "file_changed"
  | "human_question"
  | "hard_stop"
  | "retry_scheduled"
  | "step_summary"
  | "step_completed"
  | "step_failed"
  | "reflection_proposed";

export interface MigrationStepDefinition {
  id: string;
  name: string;
  promptPath?: string;
  skillPath?: string;
  requiredOutput: string;
  humanIntervention: string;
}

export interface MigrationStepState {
  id: string;
  status: StepStatus;
  summary?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface MigrationTask {
  id: string;
  name: string;
  status: TaskStatus;
  workflowPath: string;
  workspacePath: string;
  artifactPath: string;
  createdAt: string;
  updatedAt: string;
  steps: MigrationStepState[];
}

export interface ArtifactRecord {
  id: string;
  taskId: string;
  stepId?: string;
  path: string;
  relativePath: string;
  kind: "workflow" | "markdown" | "json" | "log" | "patch" | "media" | "other";
  createdAt: string;
}

export interface HumanQuestion {
  question: string;
  choices?: string[];
  allowFreeform: boolean;
  blockingReason:
    | "schema_change"
    | "missing_asset"
    | "hard_stop"
    | "quality_review"
    | "capacity_policy"
    | "permission"
    | "other";
  decisionContext?: HumanDecisionContext;
}

export interface HumanDecisionContext {
  formatVersion: "human-gate-v1";
  backgroundReasonScene: string;
  terminology: HumanDecisionTerm[];
  consequencesAndFollowUp: HumanDecisionConsequence[];
}

export interface HumanDecisionTerm {
  term: string;
  explanation: string;
}

export interface HumanDecisionConsequence {
  choice: string;
  consequence: string;
  followUp: string;
}

export interface HumanDecision {
  taskId: string;
  stepId?: string;
  questionEventId: string;
  answer: string;
  wasFreeform: boolean;
  decidedAt: string;
}

export interface HardStopReport {
  taskId: string;
  stepId?: string;
  reason: string;
  improvementStrategy: string;
  artifactPath: string;
  createdAt: string;
}

export interface AgentEvent {
  id: string;
  taskId: string;
  stepId?: string;
  type: AgentEventType;
  message: string;
  createdAt: string;
  data?: unknown;
}

export interface ProgressNarrativeLine {
  title: string;
  detail?: string;
}

export interface ProgressNarrativeEvidence {
  label: string;
  relativePath?: string;
  kind?: ArtifactRecord["kind"];
}

export interface ProgressNarrativeStep {
  id: string;
  name: string;
  status: StepStatus;
  goal: string;
}

export interface ProgressNarrative {
  taskId: string;
  generatedAt: string;
  headline: string;
  statusLabel: string;
  currentStep?: ProgressNarrativeStep;
  currentAction: string;
  humanActionRequired?: string;
  nextStep: string;
  completed: ProgressNarrativeLine[];
  blockers: ProgressNarrativeLine[];
  evidence: ProgressNarrativeEvidence[];
  signals: ProgressNarrativeLine[];
  debug: {
    eventCount: number;
    artifactCount: number;
    decisionCount: number;
  };
}

export type SubJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "waiting_for_human"
  | "blocked"
  | "failed";

export interface SubJobProgress {
  downloadedBytes?: number;
  totalBytes?: number;
  percent?: number;
  speedBytesPerSecond?: number;
  etaSeconds?: number;
}

export interface SubJob {
  id: string;
  taskId: string;
  stepId?: string;
  type: "provider_search" | "custom_node_search" | "download";
  title: string;
  status: SubJobStatus;
  provider?: string;
  assetName?: string;
  targetPath?: string;
  artifactPath?: string;
  candidateCount?: number;
  canStart?: boolean;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  error?: string;
  progress?: SubJobProgress;
  message?: string;
}

export interface StepJob {
  taskId: string;
  stepId: string;
  stepName: string;
  promptPath?: string;
  skillPath?: string;
  workspacePath: string;
  artifactPath: string;
  workflowPath: string;
  modelRoots: string[];
  comfyuiRoot: string;
  instructions: string;
  constraints: string[];
  requiredContext: Record<string, string | string[] | undefined>;
  expectedArtifacts: string[];
  humanGates: string[];
  hardStopRules: string[];
  resumeContext?: Record<string, unknown>;
  learnedRules?: string;
}

export interface CreateTaskRequest {
  name?: string;
  workflowFileName: string;
  workflowJson: unknown;
}

export interface CreateTaskResponse {
  task: MigrationTask;
}

export interface ArtifactPreview {
  relativePath: string;
  kind: ArtifactRecord["kind"];
  content: string;
}
