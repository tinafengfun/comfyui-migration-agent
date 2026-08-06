import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config";
import { ensureDir, writeJson } from "./fsUtils";
import { MigrationOrchestrator } from "./orchestrator";
import { StateStore } from "./state";

// Integration test for the real hook wired into updateStepAndPersist():
// completing Step 12b (not Step 12 itself -- Step 12b was inserted after
// Step 12 to render the richer final docker deployment guide, and the
// archive trigger moved with it so the archived bundle includes 12b's
// content) with an already-accepted Step 12 acceptance summary must
// publish the delivery bundle to the shared NFS archive via the actual
// MigrationOrchestrator class, not just the isolated archive function
// (covered separately in workflowArchive.test.ts).
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

describe("orchestrator Step 12b workflow archive integration", () => {
  it("archives the delivery bundle when Step 12b completes via the preRunArtifactCompletion shortcut with an accepted Step 12 summary", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-archive-${Date.now()}`);
    const config = makeConfig(root);
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const orchestrator = new MigrationOrchestrator(
      config,
      store,
      [{ id: "12b", name: "Final delivery", requiredOutput: "12b-final-delivery.md", humanIntervention: "x" }],
      { runStep: async () => ({ sessionId: "unused", summary: "unused" }) }
    );

    const task = await orchestrator.createTask({
      name: "ArchiveIntegrationTest",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });

    // Seed exactly what a real Step 12 + Step 12b run leaves behind before archiving is checked.
    await fs.writeFile(path.join(task.artifactPath, "12-gui-acceptance.md"), "# accepted\n", "utf8");
    await writeJson(path.join(task.artifactPath, "12-gui-acceptance-summary.json"), { manual_result: "accepted" });
    await fs.writeFile(path.join(task.artifactPath, "12b-final-delivery.md"), "# final delivery\n", "utf8");
    const deliveryWorkflowsDir = path.join(task.artifactPath, "11-delivery", "workflows");
    await ensureDir(deliveryWorkflowsDir);
    await fs.writeFile(path.join(deliveryWorkflowsDir, "runtime-policy-gui-workflow.json"), "{}\n", "utf8");

    await orchestrator.runStep(task.id, "12b");

    const updated = await store.getTask(task.id);
    expect(updated?.steps.find((s) => s.id === "12b")?.status).toBe("completed");

    const entries = await fs.readdir(config.workflowArchiveRoot).catch(() => []);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^ArchiveIntegrationTest_intel_\d{8}T\d{6}Z$/);
    const archivedFile = path.join(
      config.workflowArchiveRoot,
      entries[0],
      "workflows",
      "runtime-policy-gui-workflow.json"
    );
    await expect(fs.readFile(archivedFile, "utf8")).resolves.toBe("{}\n");
  });

  it("does not archive when Step 12's summary records a rejected result", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-archive-rejected-${Date.now()}`);
    const config = makeConfig(root);
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const orchestrator = new MigrationOrchestrator(
      config,
      store,
      [{ id: "12b", name: "Final delivery", requiredOutput: "12b-final-delivery.md", humanIntervention: "x" }],
      { runStep: async () => ({ sessionId: "unused", summary: "unused" }) }
    );

    const task = await orchestrator.createTask({
      name: "RejectedTest",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });

    await fs.writeFile(path.join(task.artifactPath, "12-gui-acceptance.md"), "# rejected\n", "utf8");
    await writeJson(path.join(task.artifactPath, "12-gui-acceptance-summary.json"), { manual_result: "rejected" });
    await fs.writeFile(path.join(task.artifactPath, "12b-final-delivery.md"), "# final delivery\n", "utf8");
    const deliveryWorkflowsDir = path.join(task.artifactPath, "11-delivery", "workflows");
    await ensureDir(deliveryWorkflowsDir);
    await fs.writeFile(path.join(deliveryWorkflowsDir, "runtime-policy-gui-workflow.json"), "{}\n", "utf8");

    await orchestrator.runStep(task.id, "12b");

    const updated = await store.getTask(task.id);
    expect(updated?.steps.find((s) => s.id === "12b")?.status).toBe("completed");
    await expect(fs.access(config.workflowArchiveRoot)).rejects.toThrow();
  });

  it("does NOT archive on bare Step 12 completion (regression test: the primary archive trigger must fire at Step 12b, not Step 12, so the archived bundle includes Step 12b's final deployment guide instead of shipping stale)", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-archive-step12-only-${Date.now()}`);
    const config = makeConfig(root);
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const orchestrator = new MigrationOrchestrator(
      config,
      store,
      [{ id: "12", name: "GUI acceptance", requiredOutput: "12-gui-acceptance.md", humanIntervention: "x" }],
      { runStep: async () => ({ sessionId: "unused", summary: "unused" }) }
    );

    const task = await orchestrator.createTask({
      name: "Step12OnlyTest",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });

    await fs.writeFile(path.join(task.artifactPath, "12-gui-acceptance.md"), "# accepted\n", "utf8");
    await writeJson(path.join(task.artifactPath, "12-gui-acceptance-summary.json"), { manual_result: "accepted" });
    const deliveryWorkflowsDir = path.join(task.artifactPath, "11-delivery", "workflows");
    await ensureDir(deliveryWorkflowsDir);
    await fs.writeFile(path.join(deliveryWorkflowsDir, "runtime-policy-gui-workflow.json"), "{}\n", "utf8");

    await orchestrator.runStep(task.id, "12");

    const updated = await store.getTask(task.id);
    expect(updated?.steps.find((s) => s.id === "12")?.status).toBe("completed");
    await expect(fs.access(config.workflowArchiveRoot)).rejects.toThrow();
  });
});
