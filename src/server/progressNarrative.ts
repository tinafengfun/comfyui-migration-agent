import type {
  AgentEvent,
  ArtifactRecord,
  HumanDecision,
  MigrationStepDefinition,
  MigrationTask,
  ProgressNarrative,
  ProgressNarrativeLine,
  ProgressNarrativeStep
} from "../shared/types";
import type { Phase1TaskState } from "./phase1Agent";

interface BuildProgressNarrativeInput {
  task: MigrationTask;
  steps: MigrationStepDefinition[];
  events: AgentEvent[];
  artifacts: ArtifactRecord[];
  decisions: HumanDecision[];
  phase1State?: Phase1TaskState;
}

type CandidateStep = MigrationTask["steps"][number] | undefined;

export function buildProgressNarrative(input: BuildProgressNarrativeInput): ProgressNarrative {
  const stepDefinitions = new Map(input.steps.map((step) => [step.id, step]));
  const currentTaskStep = selectCurrentTaskStep(input.task);
  const phase1CurrentStep = selectPhase1CurrentStep(input.phase1State);
  const currentStepId = phase1CurrentStep?.id ?? currentTaskStep?.id;
  const currentStep = currentStepId
    ? buildCurrentStep({
        stepId: currentStepId,
        task: input.task,
        stepDefinitions,
        phase1State: input.phase1State
      })
    : undefined;
  const latestOpenQuestion = latestUnansweredHumanQuestion(input.events, input.decisions);
  const blockers = buildBlockers({
    task: input.task,
    currentStep,
    latestOpenQuestion,
    latestHardStop: latestEvent(input.events, "hard_stop"),
    latestFailure: latestEvent(input.events, "step_failed")
  });
  const humanActionRequired = latestOpenQuestion
    ? questionText(latestOpenQuestion) ?? latestOpenQuestion.message
    : undefined;

  return {
    taskId: input.task.id,
    generatedAt: new Date().toISOString(),
    headline: buildHeadline(input.task, currentStep, blockers, humanActionRequired),
    statusLabel: statusLabel(input.task.status),
    currentStep,
    currentAction: buildCurrentAction({
      task: input.task,
      currentStep,
      events: input.events,
      phase1State: input.phase1State,
      humanActionRequired
    }),
    humanActionRequired,
    nextStep: buildNextStep({
      task: input.task,
      currentStep,
      steps: input.steps,
      phase1State: input.phase1State,
      humanActionRequired,
      blockers
    }),
    completed: buildCompleted(input.task, stepDefinitions, input.phase1State),
    blockers,
    evidence: buildEvidence(input.artifacts, input.events),
    signals: buildSignals(input.events, input.phase1State),
    debug: {
      eventCount: input.events.length,
      artifactCount: input.artifacts.length,
      decisionCount: input.decisions.length
    }
  };
}

function selectCurrentTaskStep(task: MigrationTask): CandidateStep {
  return (
    task.steps.find((step) =>
      ["running", "waiting_for_human", "paused", "failed", "hard_stopped"].includes(step.status)
    ) ??
    task.steps.find((step) => step.status === "pending") ??
    [...task.steps].reverse().find((step) => step.status === "completed")
  );
}

function selectPhase1CurrentStep(state?: Phase1TaskState) {
  if (!state) return undefined;
  return (
    state.steps.find((step) => step.id === state.current_step_id) ??
    state.steps.find((step) =>
      ["running", "waiting_for_human", "paused", "human_gate_reached", "failed", "hard_stop"].includes(
        step.status
      )
    )
  );
}

function buildCurrentStep(input: {
  stepId: string;
  task: MigrationTask;
  stepDefinitions: Map<string, MigrationStepDefinition>;
  phase1State?: Phase1TaskState;
}): ProgressNarrativeStep | undefined {
  const definition = input.stepDefinitions.get(input.stepId);
  const taskStep = input.task.steps.find((step) => step.id === input.stepId);
  const phase1Step = input.phase1State?.steps.find((step) => step.id === input.stepId);
  const status = taskStep?.status ?? normalizeNarrativeStatus(phase1Step?.status);
  if (!definition || !status) return undefined;
  return {
    id: definition.id,
    name: definition.name,
    status,
    goal: `Produce ${definition.requiredOutput}. Human gate: ${definition.humanIntervention}`
  };
}

function normalizeNarrativeStatus(status?: string): ProgressNarrativeStep["status"] | undefined {
  switch (status) {
    case "pending":
    case "running":
    case "waiting_for_human":
    case "paused":
    case "hard_stopped":
    case "completed":
    case "failed":
    case "terminated":
      return status;
    case "human_gate_reached":
      return "waiting_for_human";
    case "hard_stop":
      return "hard_stopped";
    default:
      return undefined;
  }
}

function buildHeadline(
  task: MigrationTask,
  currentStep: ProgressNarrativeStep | undefined,
  blockers: ProgressNarrativeLine[],
  humanActionRequired?: string
) {
  if (humanActionRequired) return "Waiting for a human decision";
  if (blockers.length > 0) return "Blocked until the issue is resolved";
  if (task.status === "completed") return "Migration workflow completed";
  if (task.status === "terminated") return "Migration workflow was stopped";
  if (!currentStep) return "No migration task is active";
  if (currentStep.status === "pending") return `Ready to start Step ${currentStep.id}`;
  if (currentStep.status === "running") return `Working on Step ${currentStep.id}: ${currentStep.name}`;
  if (currentStep.status === "completed") return `Latest completed step: ${currentStep.id}`;
  return `Step ${currentStep.id}: ${statusLabel(currentStep.status)}`;
}

function statusLabel(status: string) {
  return status.replace(/_/g, " ");
}

function buildCurrentAction(input: {
  task: MigrationTask;
  currentStep?: ProgressNarrativeStep;
  events: AgentEvent[];
  phase1State?: Phase1TaskState;
  humanActionRequired?: string;
}) {
  if (input.humanActionRequired) return `Waiting for your decision: ${input.humanActionRequired}`;
  if (input.task.status === "completed") return "All configured migration steps have completed.";
  if (input.task.status === "terminated") return "The active run has been terminated and must be resumed manually.";
  if (!input.currentStep) return "Create or select a task to see progress.";

  const phase1Step = input.phase1State?.steps.find((step) => step.id === input.currentStep?.id);
  if (phase1Step?.summary) return phase1Step.summary;

  const event = [...input.events]
    .reverse()
    .find((item) => item.stepId === input.currentStep?.id && isNarrativeEvent(item));
  const eventAction = event ? eventToAction(event) : undefined;
  if (eventAction) return eventAction;

  if (input.currentStep.status === "pending") return `Ready to run Step ${input.currentStep.id}.`;
  if (input.currentStep.status === "running") {
    return `The agent is executing ${input.currentStep.name} and collecting evidence artifacts.`;
  }
  return `Step ${input.currentStep.id} is ${statusLabel(input.currentStep.status)}.`;
}

function buildNextStep(input: {
  task: MigrationTask;
  currentStep?: ProgressNarrativeStep;
  steps: MigrationStepDefinition[];
  phase1State?: Phase1TaskState;
  humanActionRequired?: string;
  blockers: ProgressNarrativeLine[];
}) {
  if (input.humanActionRequired && input.currentStep) {
    return `Answer the gate, then resume Step ${input.currentStep.id}.`;
  }
  if (input.blockers.length > 0) return "Resolve the blocker before continuing.";

  const phaseRecommendation = phase1NextStepRecommendation(input.phase1State, input.currentStep?.id);
  if (phaseRecommendation) return phaseRecommendation;

  const pendingStep = input.steps.find((step) => {
    const state = input.task.steps.find((item) => item.id === step.id);
    return !state || state.status === "pending";
  });
  if (pendingStep) return `Next: Step ${pendingStep.id} - ${pendingStep.name}.`;
  if (input.task.status === "completed") return "Review delivery and GUI acceptance artifacts.";
  return "No pending step is currently available.";
}

function phase1NextStepRecommendation(state?: Phase1TaskState, currentStepId?: string) {
  if (!state || !currentStepId) return undefined;
  const step = state.steps.find((item) => item.id === currentStepId);
  const recommendation = step?.completion_decision?.next_step_recommendation;
  if (!isRecord(recommendation)) return undefined;
  const recommendedStepId = stringValue(recommendation.recommended_step_id);
  const edgeType = stringValue(recommendation.edge_type);
  const reason = stringValue(recommendation.reason);
  const parts = [
    recommendedStepId ? `Recommended next step: ${recommendedStepId}` : undefined,
    edgeType ? `path: ${edgeType}` : undefined,
    reason
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(". ") : undefined;
}

function buildCompleted(
  task: MigrationTask,
  stepDefinitions: Map<string, MigrationStepDefinition>,
  phase1State?: Phase1TaskState
): ProgressNarrativeLine[] {
  const completed = task.steps
    .filter((step) => step.status === "completed")
    .slice(-4)
    .map((step) => {
      const definition = stepDefinitions.get(step.id);
      const phase1Step = phase1State?.steps.find((item) => item.id === step.id);
      return {
        title: `Step ${step.id}${definition ? ` - ${definition.name}` : ""}`,
        detail: phase1Step?.summary ?? step.summary ?? definition?.requiredOutput
      };
    });
  return completed.length > 0
    ? completed
    : [{ title: "No step completed yet", detail: "Run the first migration step to produce evidence." }];
}

function buildBlockers(input: {
  task: MigrationTask;
  currentStep?: ProgressNarrativeStep;
  latestOpenQuestion?: AgentEvent;
  latestHardStop?: AgentEvent;
  latestFailure?: AgentEvent;
}): ProgressNarrativeLine[] {
  const blockers: ProgressNarrativeLine[] = [];
  if (input.latestOpenQuestion) {
    blockers.push({
      title: "Human decision needed",
      detail: questionText(input.latestOpenQuestion) ?? input.latestOpenQuestion.message
    });
  }
  if (input.latestHardStop) {
    blockers.push({ title: "Hard stop", detail: input.latestHardStop.message });
  }
  if (input.latestFailure) {
    blockers.push({ title: "Step failure", detail: input.latestFailure.message });
  }
  const failedStep = input.task.steps.find((step) =>
    ["failed", "hard_stopped", "terminated"].includes(step.status)
  );
  if (failedStep && !blockers.some((blocker) => blocker.detail === failedStep.error)) {
    blockers.push({
      title: `Step ${failedStep.id} is ${statusLabel(failedStep.status)}`,
      detail: failedStep.error
    });
  }
  if (input.currentStep?.status === "waiting_for_human" && blockers.length === 0) {
    blockers.push({ title: "Human gate reached", detail: "The agent is waiting for a decision." });
  }
  return blockers;
}

function buildEvidence(artifacts: ArtifactRecord[], events: AgentEvent[]) {
  const eventPaths = [...events]
    .reverse()
    .map((event) => pathFromEvent(event))
    .filter((path): path is string => Boolean(path));
  const artifactEvidence = [...artifacts]
    .reverse()
    .slice(0, 5)
    .map((artifact) => ({
      label: friendlyArtifactLabel(artifact.relativePath),
      relativePath: artifact.relativePath,
      kind: artifact.kind
    }));
  const eventEvidence = eventPaths.slice(0, 3).map((path) => ({
    label: friendlyArtifactLabel(path),
    relativePath: path
  }));
  const seen = new Set<string>();
  return [...artifactEvidence, ...eventEvidence].filter((item) => {
    const key = item.relativePath ?? item.label;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildSignals(events: AgentEvent[], phase1State?: Phase1TaskState): ProgressNarrativeLine[] {
  const signals: ProgressNarrativeLine[] = [];
  if (phase1State) {
    signals.push({
      title: "Phase 1 state",
      detail: `status: ${phase1State.status}; current step: ${phase1State.current_step_id ?? "n/a"}`
    });
  }
  for (const event of [...events].reverse()) {
    if (!isNarrativeEvent(event)) continue;
    const action = eventToAction(event);
    if (!action) continue;
    signals.push({
      title: event.stepId ? `Step ${event.stepId}` : humanizeEventType(event.type),
      detail: action
    });
    if (signals.length >= 4) break;
  }
  return signals;
}

function latestUnansweredHumanQuestion(events: AgentEvent[], decisions: HumanDecision[]) {
  const answered = new Set(decisions.map((decision) => decision.questionEventId));
  return [...events]
    .reverse()
    .find((event) => event.type === "human_question" && !answered.has(event.id));
}

function latestEvent(events: AgentEvent[], type: AgentEvent["type"]) {
  return [...events].reverse().find((event) => event.type === type);
}

function isNarrativeEvent(event: AgentEvent) {
  if (event.type !== "progress") return true;
  const sdkType = isRecord(event.data) ? stringValue(event.data.type) : undefined;
  return !["session.usage_info", "hook.start", "hook.end", "assistant.usage", "progress"].includes(
    sdkType ?? event.message
  );
}

function eventToAction(event: AgentEvent): string | undefined {
  if (event.type === "step_started") return event.message;
  if (event.type === "step_completed") return event.message;
  if (event.type === "step_failed") return `Failed: ${event.message}`;
  if (event.type === "hard_stop") return `Hard stop: ${event.message}`;
  if (event.type === "human_question") return `Needs human input: ${questionText(event) ?? event.message}`;
  if (event.type === "reflection_proposed") return "Generated a reflection proposal for agent improvement.";
  if (event.type === "artifact_created" || event.type === "file_changed") {
    const artifactPath = pathFromEvent(event);
    return artifactPath ? `Updated evidence artifact ${artifactPath}.` : event.message;
  }
  const semantic = semanticText(event.data);
  return semantic ?? event.message;
}

function questionText(event: AgentEvent): string | undefined {
  if (!isRecord(event.data)) return undefined;
  return stringValue(event.data.question);
}

function pathFromEvent(event: AgentEvent): string | undefined {
  if (!isRecord(event.data)) return undefined;
  const rawPath = stringValue(event.data.relativePath) ?? stringValue(event.data.path) ?? stringValue(event.data.reportPath);
  if (!rawPath) return undefined;
  const artifactsIndex = rawPath.lastIndexOf("/artifacts/");
  if (artifactsIndex >= 0) return rawPath.slice(artifactsIndex + 1);
  const sourceIndex = rawPath.lastIndexOf("/source/");
  if (sourceIndex >= 0) return rawPath.slice(sourceIndex + 1);
  return rawPath.split("/").slice(-2).join("/");
}

function friendlyArtifactLabel(relativePath: string) {
  const leaf = relativePath.split("/").filter(Boolean).at(-1) ?? relativePath;
  return leaf.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
}

function semanticText(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const direct = stringValue(data.semanticProgress) ?? stringValue(data.contentPreview);
  if (direct) return truncate(direct);
  const nested = isRecord(data.data) ? data.data : undefined;
  const result = nested && isRecord(nested.result) ? nested.result : undefined;
  const value =
    stringValue(nested?.deltaContent) ??
    stringValue(nested?.toolName) ??
    stringValue(result?.content) ??
    stringValue(result?.detailedContent);
  return value ? truncate(value) : undefined;
}

function truncate(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function humanizeEventType(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
