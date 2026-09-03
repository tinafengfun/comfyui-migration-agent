import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config";
import { ensureDir } from "./fsUtils";
import { StateStore } from "./state";

// Step 03b is fully deterministic (no SDK, no ComfyUI, no docker) — nothing to mock.

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

const STEP03B = {
  id: "03b",
  name: "Node localization (API → local model)",
  requiredOutput: "03b-node-localization.md",
  humanIntervention: "Approve/reject API-node substitution",
  optional: true
};

// A minimal but faithful GUI graph containing a GeminiNode (the Phase-0 target):
// LoadImage → images, PrimitiveString → prompt, GeminiNode.text → ShowText.
// audio is an unlinked drop-input. Mirrors the shape of the real Story workflow.
function geminiGraph() {
  return {
    last_node_id: 4,
    last_link_id: 103,
    nodes: [
      { id: 1, type: "LoadImage", inputs: [], outputs: [{ name: "IMAGE", type: "IMAGE", links: [101] }], widgets_values: [] },
      { id: 2, type: "PrimitiveString", inputs: [], outputs: [{ name: "STRING", type: "STRING", links: [102] }], widgets_values: ["describe the scene"] },
      {
        id: 3,
        type: "GeminiNode",
        inputs: [
          { name: "images", type: "IMAGE", link: 101 },
          { name: "prompt", type: "STRING", link: 102 },
          { name: "audio", type: "AUDIO", link: null }
        ],
        outputs: [{ name: "text", type: "STRING", links: [103] }],
        widgets_values: ["gemini-2.5-flash", "api-key-here"]
      },
      { id: 4, type: "ShowText", inputs: [{ name: "text", type: "STRING", link: 103 }], outputs: [], widgets_values: [] }
    ],
    links: [
      [101, 1, 0, 3, 0, "IMAGE"],
      [102, 2, 0, 3, 1, "STRING"],
      [103, 3, 0, 4, 0, "STRING"]
    ]
  };
}

async function makeOrchestratorWithGeminiTask(label: string) {
  const { MigrationOrchestrator } = await import("./orchestrator");
  const root = path.join(process.cwd(), ".demo-state", "tests", `step03b-${label}-${Date.now()}`);
  const gpuNodesPath = path.join(root, "gpu-nodes.json");
  await ensureDir(root);
  await fs.writeFile(
    gpuNodesPath,
    JSON.stringify({ default_node: "n", nodes: [{ name: "n", kind: "local", api_host: "127.0.0.1", api_port: 8188 }] }),
    "utf8"
  );
  const config = makeConfig(root, gpuNodesPath);
  await ensureDir(config.workspaceRoot);
  const store = new StateStore(config);
  await store.initialize();
  const orchestrator = new MigrationOrchestrator(config, store, [STEP03B], {
    runStep: async () => ({ sessionId: "s", summary: "unused" })
  });
  const task = await orchestrator.createTask({
    name: label,
    workflowFileName: "gemini-workflow.json",
    workflowJson: geminiGraph()
  });
  return { orchestrator, store, task };
}

function decisionFor(taskId: string, answer: string) {
  return { taskId, stepId: "03b", questionEventId: "q", answer, wasFreeform: false, decidedAt: new Date().toISOString() };
}

async function countType(workflowPath: string, type: string): Promise<number> {
  const g = JSON.parse(await fs.readFile(workflowPath, "utf8")) as { nodes: Array<{ type: string }> };
  return g.nodes.filter((n) => n.type === type).length;
}

describe("Step 03b node-localization decision (API-node → local-model substitution)", () => {
  it("APPROVE → rewrites task.workflowPath to the localized graph (0 GeminiNode, VLM subgraph in), backs up the original, writes provenance, completes", async () => {
    const { orchestrator, store, task } = await makeOrchestratorWithGeminiTask("approve");
    // Pre-condition: the API node is present in the graph on disk.
    expect(await countType(task.workflowPath, "GeminiNode")).toBe(1);

    const handled = await (orchestrator as any).applyStep03bLocalizationDecision({
      task,
      decision: decisionFor(task.id, "Approve — substitute with the local model")
    });
    expect(handled).toBe(true);

    // The workflow ON DISK (what Steps 05–12 will convert + run) is now offline-only.
    expect(await countType(task.workflowPath, "GeminiNode")).toBe(0);
    expect(await countType(task.workflowPath, "llama_cpp_instruct_adv")).toBe(1);
    expect(await countType(task.workflowPath, "llama_cpp_model_loader")).toBe(1);

    // The GUI original is preserved for rollback / audit.
    const backup = task.workflowPath.replace(/\.json$/i, "") + ".gui-original-preloc.json";
    expect(await countType(backup, "GeminiNode")).toBe(1);

    // Provenance records the substitution and asserts the result is a DAG.
    const prov = JSON.parse(await fs.readFile(path.join(task.artifactPath, "03b-node-localization.json"), "utf8"));
    expect(prov.isDag).toBe(true);
    expect(prov.substituted).toHaveLength(1);
    expect(prov.substituted[0].from).toBe("GeminiNode");

    // Step is completed (optional step, never blocks) and the gate is cleared.
    const updated = await store.getTask(task.id);
    expect(updated?.steps.find((s) => s.id === "03b")?.status).toBe("completed");
    const gate = JSON.parse(await fs.readFile(path.join(task.artifactPath, "03b-gate-signal.json"), "utf8"));
    expect(gate.gated).toBe(false);
  });

  it("REJECT → leaves the graph UNCHANGED (API node stays as a human boundary) and completes", async () => {
    const { orchestrator, store, task } = await makeOrchestratorWithGeminiTask("reject");
    const handled = await (orchestrator as any).applyStep03bLocalizationDecision({
      task,
      decision: decisionFor(task.id, "Reject — keep the API node (human boundary)")
    });
    expect(handled).toBe(true);

    // Graph on disk is untouched — the API node is still there.
    expect(await countType(task.workflowPath, "GeminiNode")).toBe(1);
    expect(await countType(task.workflowPath, "llama_cpp_instruct_adv")).toBe(0);
    // No backup is written on reject (nothing was rewritten).
    const backup = task.workflowPath.replace(/\.json$/i, "") + ".gui-original-preloc.json";
    expect(await fs.access(backup).then(() => true).catch(() => false)).toBe(false);

    const md = await fs.readFile(path.join(task.artifactPath, "03b-node-localization.md"), "utf8");
    expect(md).toMatch(/REJECTED|human boundary/i);
    const updated = await store.getTask(task.id);
    expect(updated?.steps.find((s) => s.id === "03b")?.status).toBe("completed");
  });

  it("ignores a decision it does not own (returns false without touching the graph)", async () => {
    const { orchestrator, task } = await makeOrchestratorWithGeminiTask("unowned");
    const handled = await (orchestrator as any).applyStep03bLocalizationDecision({
      task,
      decision: decisionFor(task.id, "some unrelated freeform answer")
    });
    expect(handled).toBe(false);
    expect(await countType(task.workflowPath, "GeminiNode")).toBe(1);
  });
});
