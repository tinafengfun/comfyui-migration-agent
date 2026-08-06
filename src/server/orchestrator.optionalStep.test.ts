import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config";
import { ensureDir } from "./fsUtils";
import { MigrationOrchestrator } from "./orchestrator";
import { StateStore } from "./state";

// Integration test for the real requirement: Step 13 self-improvement is
// optional -- a migration should count as done once its required steps
// finish, without needing the optional step to run or complete. Uses a
// synthetic step marked optional (rather than driving the real Step 13,
// which has its own separate multi-round approval-gate machinery orthogonal
// to this generic mechanism) to isolate exactly what's under test: does
// completing every non-optional step alone flip task.status to "completed".
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

describe("orchestrator task completion with an optional trailing step", () => {
  it("reports task.status === completed once the only required step finishes, even though the optional trailing step is still pending", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-optional-step-${Date.now()}`);
    const config = makeConfig(root);
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const orchestrator = new MigrationOrchestrator(
      config,
      store,
      [
        { id: "00", name: "Intake", requiredOutput: "00-intake-preflight.md", humanIntervention: "x" },
        { id: "12b", name: "Final delivery", requiredOutput: "12b-final-delivery.md", humanIntervention: "x", optional: true }
      ],
      {
        async runStep() {
          return { sessionId: "unused", summary: "unused" };
        }
      }
    );

    const task = await orchestrator.createTask({
      name: "OptionalTrailingStepTest",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });

    expect(task.steps.find((s) => s.id === "12b")?.optional).toBe(true);

    await fs.writeFile(path.join(task.artifactPath, "00-intake-preflight.md"), "# intake\n", "utf8");
    await orchestrator.runStep(task.id, "00");

    const updated = await store.getTask(task.id);
    expect(updated?.steps.find((s) => s.id === "00")?.status).toBe("completed");
    expect(updated?.steps.find((s) => s.id === "12b")?.status).toBe("pending");
    expect(updated?.status).toBe("completed");
  });
});
