import { describe, expect, it } from "vitest";
import type {
  AgentEvent,
  ArtifactRecord,
  HumanDecision,
  MigrationStepDefinition,
  MigrationTask
} from "../shared/types";
import { buildProgressNarrative } from "./progressNarrative";

const steps: MigrationStepDefinition[] = [
  {
    id: "00",
    name: "Intake",
    requiredOutput: "00-intake-preflight.md",
    humanIntervention: "Provide missing sources"
  },
  {
    id: "01",
    name: "Asset resolution",
    requiredOutput: "01-asset-prep.md",
    humanIntervention: "Approve source-identical substitutions"
  }
];

describe("progress narrative", () => {
  it("turns a human gate event into a decision-oriented progress summary", () => {
    const task = taskFixture("waiting_for_human");
    const events: AgentEvent[] = [
      eventFixture({
        id: "e1",
        type: "step_started",
        stepId: "00",
        message: "Step 00 Intake started."
      }),
      eventFixture({
        id: "q1",
        type: "human_question",
        stepId: "00",
        message: "Need source model path",
        data: {
          question: "Provide the local source-identical checkpoint path.",
          choices: ["Use /home/intel/hf_models/model.safetensors"],
          allowFreeform: true,
          blockingReason: "missing_asset"
        }
      })
    ];

    const narrative = buildProgressNarrative({
      task,
      steps,
      events,
      artifacts: [],
      decisions: []
    });

    expect(narrative.headline).toBe("Waiting for a human decision");
    expect(narrative.humanActionRequired).toBe("Provide the local source-identical checkpoint path.");
    expect(narrative.currentAction).toContain("Waiting for your decision");
    expect(narrative.nextStep).toBe("Answer the gate, then resume Step 00.");
    expect(narrative.blockers[0]).toEqual({
      title: "Human decision needed",
      detail: "Provide the local source-identical checkpoint path."
    });
  });

  it("summarizes completed steps, current action, evidence, and Phase 1 next recommendation", () => {
    const task = taskFixture("running");
    task.steps[0] = {
      ...task.steps[0],
      status: "completed",
      summary: "Source workflow inventory captured."
    };
    task.steps[1] = { ...task.steps[1], status: "running", startedAt: "2026-05-19T10:00:00.000Z" };
    const artifact = artifactFixture("artifacts/01-asset-prep.md");
    const events = [
      eventFixture({
        id: "a1",
        type: "artifact_created",
        stepId: "01",
        message: "Created deterministic Step 01 asset prep artifact.",
        data: { path: "/tmp/workspace/artifacts/01-asset-prep.md" }
      })
    ];

    const narrative = buildProgressNarrative({
      task,
      steps,
      events,
      artifacts: [artifact],
      decisions: [],
      phase1State: {
        schema_version: 1,
        agent: "phase1-monolithic-copilot-driver",
        mode: "monolithic_driver",
        task_id: task.id,
        status: "running",
        current_step_id: "01",
        workflow_path: task.workflowPath,
        workspace_path: task.workspacePath,
        artifact_path: task.artifactPath,
        updated_at: "2026-05-19T10:00:00.000Z",
        steps: [
          { id: "00", status: "completed", summary: "Source workflow inventory captured." },
          {
            id: "01",
            status: "running",
            summary: "Searching configured local model roots.",
            completion_decision: {
              next_step_recommendation: {
                recommended_step_id: "02",
                edge_type: "forward",
                reason: "Asset inventory is sufficient."
              }
            }
          }
        ],
        human_decisions: [],
        claim_boundary: {},
        compaction: {
          running_summary: "",
          context_debt: "",
          phase3_extraction_candidates: "",
          context_budget: "",
          step_handoffs: "",
          compact_checkpoints: "",
          required_after_each_step: true
        }
      }
    });

    expect(narrative.headline).toBe("Working on Step 01: Asset resolution");
    expect(narrative.currentAction).toBe("Searching configured local model roots.");
    expect(narrative.completed[0].detail).toBe("Source workflow inventory captured.");
    expect(narrative.nextStep).toContain("Recommended next step: 02");
    expect(narrative.evidence[0]).toMatchObject({
      label: "01 asset prep",
      relativePath: "artifacts/01-asset-prep.md"
    });
  });
});

function taskFixture(status: MigrationTask["status"]): MigrationTask {
  return {
    id: "task-1",
    name: "Demo",
    status,
    workflowPath: "/tmp/workspace/source/workflow.json",
    workspacePath: "/tmp/workspace",
    artifactPath: "/tmp/workspace/artifacts",
    createdAt: "2026-05-19T10:00:00.000Z",
    updatedAt: "2026-05-19T10:00:00.000Z",
    steps: [
      { id: "00", status },
      { id: "01", status: "pending" }
    ]
  };
}

function eventFixture(input: Partial<AgentEvent> & Pick<AgentEvent, "id" | "type" | "message">): AgentEvent {
  return {
    taskId: "task-1",
    createdAt: "2026-05-19T10:00:00.000Z",
    ...input
  };
}

function artifactFixture(relativePath: string): ArtifactRecord {
  return {
    id: "artifact-1",
    taskId: "task-1",
    path: `/tmp/workspace/${relativePath}`,
    relativePath,
    kind: "markdown",
    createdAt: "2026-05-19T10:00:00.000Z"
  };
}

const _decisions: HumanDecision[] = [];
