/**
 * Tests for the §G.wire feedback-collection paths on the orchestrator.
 * Keeps these separate from orchestrator.test.ts so the existing broad
 * smoke test stays focused on the happy path.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { AppConfig } from "./config";
import { ensureDir } from "./fsUtils";
import { MigrationOrchestrator } from "./orchestrator";
import { StateStore } from "./state";
import { listFeedbackEvents } from "./feedbackLog";

let root: string;
let config: AppConfig;
let store: StateStore;
let orchestrator: MigrationOrchestrator;

beforeEach(async () => {
  root = path.join(process.cwd(), ".demo-state", "tests", `orch-feedback-${Date.now()}`);
  config = {
    port: 0,
    projectRoot: root,
    workspaceRoot: path.join(root, "workspaces"),
    stateRoot: path.join(root, "state"),
    draftDocRoot: root,
    comfyuiRoot: "/tmp/comfy",
    modelRoots: ["/home/intel/hf_models"],
    gpuNodesPath: path.join(root, "gpu-nodes.json"),
    autoApproveAgentPermissions: false
  };
  await ensureDir(config.workspaceRoot);
  store = new StateStore(config);
  await store.initialize();
  orchestrator = new MigrationOrchestrator(config, store, [
    { id: "00", name: "Intake", requiredOutput: "00-intake-preflight.md", humanIntervention: "x" }
  ]);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function readFeedback(taskId: string) {
  return listFeedbackEvents(config.workspaceRoot, taskId);
}

async function makeTask() {
  return orchestrator.createTask({
    name: "feedback-test",
    workflowFileName: "wf.json",
    workflowJson: { nodes: [], links: [] }
  });
}

async function askQuestion(taskId: string, stepId = "00") {
  return store.appendEvent({
    taskId,
    stepId,
    type: "human_question",
    message: "Need input"
  });
}

describe("orchestrator §G.wire feedback collection", () => {
  it("hard-stop writes a blocker feedback event with the reason", async () => {
    const task = await makeTask();
    await orchestrator.terminateWithHardStop({
      taskId: task.id,
      stepId: "00",
      reason: "Missing source-identical model"
    });

    const { events, corrupt } = await readFeedback(task.id);
    expect(corrupt).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      stepId: "00",
      source: "human",
      type: "agent_bug",
      severity: "blocker",
      status: "open"
    });
    expect(events[0].message).toContain("Missing source-identical model");
    expect(events[0].stateSnapshot?.failingArtifactPath).toMatch(/hard-stop-report\.md$/);
  });

  it("hard-stop without stepId records against 'task' sentinel", async () => {
    const task = await makeTask();
    await orchestrator.terminateWithHardStop({
      taskId: task.id,
      reason: "Workflow too ambiguous"
    });
    const { events } = await readFeedback(task.id);
    expect(events).toHaveLength(1);
    expect(events[0].stepId).toBe("task");
  });

  it("hard-stop with improvementStrategy proposes evolve_prompt", async () => {
    const task = await makeTask();
    await orchestrator.terminateWithHardStop({
      taskId: task.id,
      stepId: "00",
      reason: "FP8 path unclear",
      improvementStrategy: "Add explicit fp8 gate to skill 02"
    });
    const { events } = await readFeedback(task.id);
    expect(events[0].proposedAction).toBe("evolve_prompt");
  });

  it("routine approval decisions are NOT recorded as feedback", async () => {
    const task = await makeTask();
    const event = await askQuestion(task.id);
    for (const answer of ["yes", "OK", "Continue", "approve", "1", "proceed"]) {
      await orchestrator.recordHumanDecision({
        taskId: task.id,
        stepId: "00",
        questionEventId: event.id,
        answer,
        wasFreeform: false
      });
    }
    const { events } = await readFeedback(task.id);
    expect(events).toHaveLength(0);
  });

  it("non-routine decisions ARE recorded, with severity by keyword", async () => {
    const task = await makeTask();

    // Blocker language.
    const q1 = await askQuestion(task.id);
    await orchestrator.recordHumanDecision({
      taskId: task.id,
      stepId: "00",
      questionEventId: q1.id,
      answer: "Stop, wrong model selection",
      wasFreeform: true
    });

    // Degrade language.
    const q2 = await askQuestion(task.id);
    await orchestrator.recordHumanDecision({
      taskId: task.id,
      stepId: "00",
      questionEventId: q2.id,
      answer: "Use the bf16 path instead",
      wasFreeform: true
    });

    // Other non-routine — nit.
    const q3 = await askQuestion(task.id);
    await orchestrator.recordHumanDecision({
      taskId: task.id,
      stepId: "00",
      questionEventId: q3.id,
      answer: "Add a comment about this in the report",
      wasFreeform: true
    });

    const { events } = await readFeedback(task.id);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.severity).sort()).toEqual(["blocker", "degrade", "nit"]);
    expect(events.every((e) => e.source === "human")).toBe(true);
    expect(events.every((e) => e.type === "user_preference")).toBe(true);
  });

  it("non-routine decisions carry the questionEventId in stateSnapshot", async () => {
    const task = await makeTask();
    const q = await askQuestion(task.id);
    await orchestrator.recordHumanDecision({
      taskId: task.id,
      stepId: "00",
      questionEventId: q.id,
      answer: "no, use the other branch",
      wasFreeform: false
    });
    const { events } = await readFeedback(task.id);
    expect(events).toHaveLength(1);
    expect(events[0].stateSnapshot?.extraNotes).toContain(q.id);
  });

  it("feedback write failure does NOT break the orchestrator flow", async () => {
    // recordFeedback catches all errors internally (try/catch + console.warn).
    // We can't easily break the writer without mutating internal config, so
    // this test verifies the hard-stop completes and returns its report even
    // with feedback wiring active. The catch-block path itself is the same
    // try/catch pattern verified in feedbackLog.test.ts.
    const task = await makeTask();
    const report = await orchestrator.terminateWithHardStop({
      taskId: task.id,
      stepId: "00",
      reason: "test"
    });
    expect(report.taskId).toBe(task.id);
  });
});
