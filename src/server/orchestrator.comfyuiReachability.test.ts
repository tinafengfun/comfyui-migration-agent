import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config";
import { ensureDir } from "./fsUtils";
import { StateStore } from "./state";

const ensureComfyUiUpMock = vi.fn();
vi.mock("./comfyuiLifecycle", () => ({
  ensureComfyUiUp: (...args: any[]) => ensureComfyUiUpMock(...args)
}));

// Integration tests for the automatic pre-Step07/08 reachability check wired
// into updateStepAndPersist's caller (see comfyuiLifecycle.ts's own doc
// comment for the real incident this closes: an SDK session's own ad hoc
// docker run got the launch command wrong under time pressure). These mock
// ensureComfyUiUp itself (already covered directly by
// comfyuiLifecycle.test.ts) so the test controls the outcome precisely and
// fast, instead of depending on real docker/network behavior.
function makeConfig(root: string, gpuNodesPath: string): AppConfig {
  return {
    port: 0,
    projectRoot: root,
    workspaceRoot: path.join(root, "workspaces"),
    stateRoot: path.join(root, "state"),
    draftDocRoot: root,
    comfyuiRoot: "/tmp/comfy",
    modelRoots: ["/home/intel/hf_models"],
    gpuNodesPath,
    workflowArchiveRoot: path.join(root, "nfs-workflows"),
    taskArchiveRoot: path.join(root, "task-archive"),
    assetResolutionLedgerPath: path.join(root, "asset-resolutions.jsonl"),
    answerLogPath: path.join(root, "answer-log.jsonl"),
    answerDefaultsPath: path.join(root, "answer-defaults.jsonl"),
    answerDefaultsEnabled: false,
    autoApproveAgentPermissions: false
  };
}

describe("automatic ComfyUI reachability check before Step 07/08", () => {
  it("hard-stops BEFORE the SDK session runs when the endpoint can't be reached, even after the correct relaunch attempt", async () => {
    ensureComfyUiUpMock.mockReset();
    ensureComfyUiUpMock.mockResolvedValue({ ok: false, action: "failed", detail: "did not bring up /system_stats within 150s" });
    const { MigrationOrchestrator } = await import("./orchestrator");

    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-reachability-fail-${Date.now()}`);
    const gpuNodesPath = path.join(root, "gpu-nodes.json");
    await ensureDir(root);
    await fs.writeFile(
      gpuNodesPath,
      JSON.stringify({
        default_node: "test-node",
        nodes: [
          {
            name: "test-node",
            kind: "local",
            runtime: "docker",
            docker_image: "intel/llm-scaler-omni:0.1.0-b7",
            comfyui_root: "/nfs_share/comfyui-core",
            venv_python: "/nfs_share/venv-container-xpu/bin/python3",
            model_roots: ["/nfs_share"],
            api_host: "127.0.0.1",
            api_port: 8188
          }
        ]
      }),
      "utf8"
    );
    const config = makeConfig(root, gpuNodesPath);
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();

    let sdkRunnerCalled = false;
    const orchestrator = new MigrationOrchestrator(
      config,
      store,
      [{ id: "07", name: "Branch smoke", requiredOutput: "07-branch-smoke.md", humanIntervention: "Approve" }],
      {
        runStep: async () => {
          sdkRunnerCalled = true;
          return { sessionId: "unused", summary: "should never get here" };
        }
      }
    );
    const task = await orchestrator.createTask({
      name: "ReachabilityFailTest",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });

    await orchestrator.runStep(task.id, "07");

    expect(sdkRunnerCalled).toBe(false);
    expect(ensureComfyUiUpMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiUrl: "http://127.0.0.1:8188", container: `comfyui-${task.id}` })
    );
    const updated = await store.getTask(task.id);
    expect(updated?.steps.find((s) => s.id === "07")?.status).toBe("hard_stopped");
    expect(updated?.steps.find((s) => s.id === "07")?.error).toContain("infrastructure hard stop");
  });

  it("proceeds to the SDK session normally when the endpoint is already reachable", async () => {
    ensureComfyUiUpMock.mockReset();
    ensureComfyUiUpMock.mockResolvedValue({ ok: true, action: "already_up", detail: "already reachable" });
    const { MigrationOrchestrator } = await import("./orchestrator");

    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-reachability-ok-${Date.now()}`);
    const gpuNodesPath = path.join(root, "gpu-nodes.json");
    await ensureDir(root);
    await fs.writeFile(
      gpuNodesPath,
      JSON.stringify({
        default_node: "test-node",
        nodes: [{ name: "test-node", kind: "local", api_host: "127.0.0.1", api_port: 8188 }]
      }),
      "utf8"
    );
    const config = makeConfig(root, gpuNodesPath);
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();

    let sdkRunnerCalled = false;
    const orchestrator = new MigrationOrchestrator(
      config,
      store,
      [{ id: "07", name: "Branch smoke", requiredOutput: "07-branch-smoke.md", humanIntervention: "Approve" }],
      {
        runStep: async () => {
          sdkRunnerCalled = true;
          return { sessionId: "s", summary: "Step 07 complete." };
        }
      }
    );
    const task = await orchestrator.createTask({
      name: "ReachabilityOkTest",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });

    await orchestrator.runStep(task.id, "07");

    expect(sdkRunnerCalled).toBe(true);
    const updated = await store.getTask(task.id);
    expect(updated?.steps.find((s) => s.id === "07")?.status).not.toBe("hard_stopped");
  });

  it("never calls ensureComfyUiUp when no real gpu-nodes.json is configured (synthesized dev default)", async () => {
    ensureComfyUiUpMock.mockReset();
    const { MigrationOrchestrator } = await import("./orchestrator");

    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-reachability-nonode-${Date.now()}`);
    const gpuNodesPath = path.join(root, "gpu-nodes.json"); // deliberately never created
    const config = makeConfig(root, gpuNodesPath);
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();

    const orchestrator = new MigrationOrchestrator(
      config,
      store,
      [{ id: "07", name: "Branch smoke", requiredOutput: "07-branch-smoke.md", humanIntervention: "Approve" }],
      { runStep: async () => ({ sessionId: "s", summary: "Step 07 complete." }) }
    );
    const task = await orchestrator.createTask({
      name: "NoGpuNodesConfigTest",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });

    await orchestrator.runStep(task.id, "07");

    expect(ensureComfyUiUpMock).not.toHaveBeenCalled();
  });
});
