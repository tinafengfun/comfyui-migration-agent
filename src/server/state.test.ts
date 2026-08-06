import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config";
import { ensureDir } from "./fsUtils";
import { StateStore } from "./state";

function makeConfig(root: string): AppConfig {
  return {
    port: 0,
    projectRoot: root,
    workspaceRoot: path.join(root, "workspaces"),
    stateRoot: path.join(root, "state"),
    draftDocRoot: root,
    comfyuiRoot: "/tmp/comfy",
    modelRoots: ["/home/intel/hf_models"],
    gpuNodesPath: path.join(root, "gpu-nodes.json"),
    workflowArchiveRoot: path.join(root, "nfs-workflows"),
    taskArchiveRoot: path.join(root, "task-archive"),
    assetResolutionLedgerPath: path.join(root, "asset-resolutions.jsonl"),
    answerLogPath: path.join(root, "answer-log.jsonl"),
    answerDefaultsPath: path.join(root, "answer-defaults.jsonl"),
    answerDefaultsEnabled: false,
    autoApproveAgentPermissions: false
  };
}

describe("optional steps do not gate aggregate task status (real requirement: Step 13 self-improvement is optional -- migration counts as done once required steps finish, without requiring Step 13 to run or complete)", () => {
  it("marks task.status completed once every non-optional step is completed, while the optional step's own state stays pending", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `state-optional-${Date.now()}`);
    await ensureDir(root);
    const store = new StateStore(makeConfig(root));
    await store.initialize();

    let task = await store.createTask({
      name: "OptionalStepTest",
      workflowPath: path.join(root, "workflow.json"),
      workspacePath: root,
      artifactPath: path.join(root, "artifacts"),
      steps: [
        { id: "00", name: "Intake", requiredOutput: "00.md", humanIntervention: "x" },
        { id: "13", name: "Agent improvement", requiredOutput: "13.md", humanIntervention: "x", optional: true }
      ]
    });

    expect(task.steps.find((s) => s.id === "13")?.optional).toBe(true);
    expect(task.status).toBe("pending");

    task = await store.updateStep(task.id, "00", "completed");

    expect(task.status).toBe("completed");
    expect(task.steps.find((s) => s.id === "13")?.status).toBe("pending");

    // No regression: if the optional step is later completed too, status stays completed.
    task = await store.updateStep(task.id, "13", "completed");
    expect(task.status).toBe("completed");
  });

  it("does not report completed while a required (non-optional) step is still pending", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `state-optional-required-${Date.now()}`);
    await ensureDir(root);
    const store = new StateStore(makeConfig(root));
    await store.initialize();

    const task = await store.createTask({
      name: "RequiredStepPendingTest",
      workflowPath: path.join(root, "workflow.json"),
      workspacePath: root,
      artifactPath: path.join(root, "artifacts"),
      steps: [
        { id: "00", name: "Intake", requiredOutput: "00.md", humanIntervention: "x" },
        { id: "01", name: "Assets", requiredOutput: "01.md", humanIntervention: "x" },
        { id: "13", name: "Agent improvement", requiredOutput: "13.md", humanIntervention: "x", optional: true }
      ]
    });

    const updated = await store.updateStep(task.id, "00", "completed");
    expect(updated.status).not.toBe("completed");
  });
});
