import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config";
import { ensureDir } from "./fsUtils";
import { StateStore } from "./state";

vi.mock("./comfyuiLifecycle", () => ({
  ensureComfyUiUp: vi.fn().mockResolvedValue({ ok: true, action: "already_up", detail: "mock" }),
  VRAM_ESCALATION_LADDER: [["--reserve-vram", "1"], ["--reserve-vram", "1", "--lowvram"], ["--reserve-vram", "1", "--novram"]]
}));

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

const STEPS = [
  { id: "11", name: "Delivery packaging", requiredOutput: "11-delivery-summary.json", humanIntervention: "" },
  { id: "12b", name: "Final delivery", requiredOutput: "12b-final-delivery.md", humanIntervention: "" }
];

// The reduced-tier signature used across the tests: BerniniConditioning
// ref_max_size 1280->640 and length 81->40 (the real WAN2.2 drivers).
const CHANGES = [
  { node_id: "34", input: "ref_max_size", old: 1280, new: 640, kind: "resolution_cap", class_type: "BerniniConditioning" },
  { node_id: "34", input: "length", old: 81, new: 40, kind: "frames", class_type: "BerniniConditioning" }
];

async function makeOrchestratorWithTask(label: string, reducedTier: boolean, changes: unknown = CHANGES) {
  const { MigrationOrchestrator } = await import("./orchestrator");
  const root = path.join(process.cwd(), ".demo-state", "tests", `delivery-consistency-${label}-${Date.now()}`);
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
  const orchestrator = new MigrationOrchestrator(config, store, STEPS, {
    runStep: async () => ({ sessionId: "s", summary: "unused" })
  });
  const task = await orchestrator.createTask({
    name: label,
    workflowFileName: "Video_Edit_Multimodal_Generator.json",
    workflowJson: { nodes: [], links: [] }
  });
  await ensureDir(task.artifactPath);
  await fs.writeFile(
    path.join(task.artifactPath, "effective-run-config.json"),
    JSON.stringify({
      reduced_tier: reducedTier,
      vram_flags: ["--reserve-vram", "1", "--lowvram"],
      recommended_reduced_setting: reducedTier ? { changes } : undefined
    }),
    "utf8"
  );
  return { orchestrator, store, task };
}

function apiPrompt(ref: number, length: number, wrap: boolean): unknown {
  const graph = {
    "34": { class_type: "BerniniConditioning", inputs: { width: 720, height: 1280, length, batch_size: 1, ref_max_size: ref } },
    "90": { class_type: "VHS_LoadVideo", inputs: { frame_load_cap: 121 } }
  };
  return wrap ? { prompt: graph } : graph;
}

async function berniniOf(file: string): Promise<{ ref: number; length: number }> {
  const obj = JSON.parse(await fs.readFile(file, "utf8"));
  const graph = obj.prompt ?? obj;
  const n = graph["34"].inputs;
  return { ref: n.ref_max_size, length: n.length };
}

describe("enforceReducedDeliveryConsistency", () => {
  it("auto-corrects a full-size runnable prompt (incl. the misnamed reduced-tier-prompt.json) and leaves source-workflow.json untouched", async () => {
    const { orchestrator, store, task } = await makeOrchestratorWithTask("repair", true);
    const wfDir = path.join(task.artifactPath, "11-delivery", "workflows");
    await ensureDir(wfDir);
    // The real landmine: a file NAMED reduced-tier but actually full-size.
    await fs.writeFile(path.join(wfDir, "reduced-tier-prompt.json"), JSON.stringify(apiPrompt(1280, 81, false)), "utf8");
    // A second runnable full-size prompt in the {prompt:...} shape.
    await fs.writeFile(path.join(wfDir, "runtime-policy-prompt.json"), JSON.stringify(apiPrompt(1280, 81, true)), "utf8");
    // Reference-only source: must be left FULL-SIZE (fidelity reference).
    await fs.writeFile(path.join(wfDir, "source-workflow.json"), JSON.stringify(apiPrompt(1280, 81, false)), "utf8");

    const hardStopped = await (orchestrator as any).enforceReducedDeliveryConsistency(task, "11");
    expect(hardStopped).toBe(false);

    // Both runnable prompts are now reduced...
    expect(await berniniOf(path.join(wfDir, "reduced-tier-prompt.json"))).toEqual({ ref: 640, length: 40 });
    expect(await berniniOf(path.join(wfDir, "runtime-policy-prompt.json"))).toEqual({ ref: 640, length: 40 });
    // ...but the source reference is untouched (still full-size).
    expect(await berniniOf(path.join(wfDir, "source-workflow.json"))).toEqual({ ref: 1280, length: 81 });

    const events = await store.listEvents(task.id);
    const repaired = events.find((e) => (e.data as any)?.deliveryConsistency === "repaired");
    expect(repaired, "a repaired event should be emitted").toBeTruthy();
    expect((repaired!.data as any).files).toEqual(
      expect.arrayContaining([
        path.join("11-delivery", "workflows", "reduced-tier-prompt.json"),
        path.join("11-delivery", "workflows", "runtime-policy-prompt.json")
      ])
    );
    // The step must NOT be hard-stopped (auto-correct succeeded).
    const updated = await store.getTask(task.id);
    expect(updated?.steps.find((s) => s.id === "11")?.status).not.toBe("hard_stopped");
  });

  it("is a no-op for an already-reduced bundle (idempotent, no repair event)", async () => {
    const { orchestrator, store, task } = await makeOrchestratorWithTask("noop-reduced", true);
    const wfDir = path.join(task.artifactPath, "12b-final-delivery");
    await ensureDir(wfDir);
    await fs.writeFile(path.join(wfDir, "reduced-validation-prompt.json"), JSON.stringify(apiPrompt(640, 40, true)), "utf8");

    const hardStopped = await (orchestrator as any).enforceReducedDeliveryConsistency(task, "12b");
    expect(hardStopped).toBe(false);
    expect(await berniniOf(path.join(wfDir, "reduced-validation-prompt.json"))).toEqual({ ref: 640, length: 40 });

    const events = await store.listEvents(task.id);
    expect(events.find((e) => (e.data as any)?.deliveryConsistency === "repaired")).toBeFalsy();
  });

  it("does nothing for a full-size (non-reduced-tier) delivery", async () => {
    const { orchestrator, store, task } = await makeOrchestratorWithTask("full-size", false);
    const wfDir = path.join(task.artifactPath, "11-delivery", "workflows");
    await ensureDir(wfDir);
    await fs.writeFile(path.join(wfDir, "runtime-policy-prompt.json"), JSON.stringify(apiPrompt(1280, 81, true)), "utf8");

    const hardStopped = await (orchestrator as any).enforceReducedDeliveryConsistency(task, "11");
    expect(hardStopped).toBe(false);
    // Untouched: full-size delivery is legitimate.
    expect(await berniniOf(path.join(wfDir, "runtime-policy-prompt.json"))).toEqual({ ref: 1280, length: 81 });
  });

  it("emits a warning (not a crash) when the reduced tier has no structured changes", async () => {
    const { orchestrator, store, task } = await makeOrchestratorWithTask("no-changes", true, []);
    const hardStopped = await (orchestrator as any).enforceReducedDeliveryConsistency(task, "11");
    expect(hardStopped).toBe(false);
    const events = await store.listEvents(task.id);
    expect(events.find((e) => (e.data as any)?.deliveryConsistency === "no_structured_changes")).toBeTruthy();
  });

  it("emits an advisory warning when a launch script omits the offload flag", async () => {
    const { orchestrator, store, task } = await makeOrchestratorWithTask("flag-doc", true);
    const wfDir = path.join(task.artifactPath, "12b-final-delivery");
    await ensureDir(wfDir);
    await fs.writeFile(path.join(wfDir, "reduced-validation-prompt.json"), JSON.stringify(apiPrompt(640, 40, true)), "utf8");
    // A launch script that forgets --lowvram.
    await fs.writeFile(path.join(wfDir, "12-docker-launch.sh"), "#!/usr/bin/env bash\npython main.py --port 8188 --reserve-vram 1\n", "utf8");

    await (orchestrator as any).enforceReducedDeliveryConsistency(task, "12b");
    const events = await store.listEvents(task.id);
    const warn = events.find((e) => (e.data as any)?.deliveryConsistency === "flags_missing_in_doc");
    expect(warn, "a flags-missing advisory should be emitted").toBeTruthy();
    expect((warn!.data as any).missing).toContain("--lowvram");
  });
});
