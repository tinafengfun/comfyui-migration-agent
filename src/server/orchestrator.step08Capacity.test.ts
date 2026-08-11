import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config";
import { ensureDir } from "./fsUtils";
import { StateStore } from "./state";

// pauseIfStep08CapacityGate calls updateStepAndPersist; the reachability check
// lives in runStep (its caller), not here, but mock ensureComfyUiUp defensively
// so no test ever touches docker/network.
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

const STEP08 = { id: "08", name: "Full validation and capacity", requiredOutput: "08-full-validation.md", humanIntervention: "Capacity decision" };

async function makeOrchestratorWithTask(label: string) {
  const { MigrationOrchestrator } = await import("./orchestrator");
  const root = path.join(process.cwd(), ".demo-state", "tests", `step08-capacity-${label}-${Date.now()}`);
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
  const orchestrator = new MigrationOrchestrator(config, store, [STEP08], {
    runStep: async () => ({ sessionId: "s", summary: "unused" })
  });
  const task = await orchestrator.createTask({
    name: label,
    workflowFileName: "Video_Edit_Multimodal_Generator.json",
    workflowJson: { nodes: [], links: [] }
  });
  return { orchestrator, store, task };
}

function summary(capacityTier: string) {
  return {
    run_level: "capacity-probe",
    memory_runtime: { peak_memory_budget_ratio: 1.1663 },
    completion_decision: {
      status: capacityTier === "ok" ? "complete" : "hard_stop",
      capacity_tier: capacityTier,
      capacity: {
        capacity_tier: capacityTier,
        peak_memory_budget_ratio: 1.1663,
        capacity_error_signature: "device_lost",
        recommended_reduced_setting: "480x832 x 49 frames"
      }
    },
    step12_context: { capacity_tier: capacityTier, recommended_reduced_setting: "480x832 x 49 frames" }
  };
}

async function writeSummary(task: { artifactPath: string }, capacityTier: string) {
  await ensureDir(task.artifactPath);
  await fs.writeFile(
    path.join(task.artifactPath, "08-full-validation-summary.json"),
    JSON.stringify(summary(capacityTier), null, 2),
    "utf8"
  );
}

describe("Step 08 capacity decision gate", () => {
  it("gates on capacity_tier 'insufficient' — pauses waiting_for_human and emits a capacity_policy question with 3 choices", async () => {
    const { orchestrator, store, task } = await makeOrchestratorWithTask("insufficient");
    await writeSummary(task, "insufficient");

    const gated = await (orchestrator as any).pauseIfStep08CapacityGate(task, STEP08);
    expect(gated).toBe(true);

    const updated = await store.getTask(task.id);
    expect(updated?.steps.find((s) => s.id === "08")?.status).toBe("waiting_for_human");

    const events = await store.listEvents(task.id);
    const q = events.find((e) => e.stepId === "08" && e.type === "human_question");
    expect(q).toBeTruthy();
    const data = q!.data as any;
    expect(data.blockingReason).toBe("capacity_policy");
    expect(data.choices).toHaveLength(3);
    expect(data.capacityTier).toBe("insufficient");
  });

  it("does NOT gate when capacity_tier is 'ok'", async () => {
    const { orchestrator, task } = await makeOrchestratorWithTask("ok");
    await writeSummary(task, "ok");
    expect(await (orchestrator as any).pauseIfStep08CapacityGate(task, STEP08)).toBe(false);
  });

  it("does NOT re-gate once a capacity_decision has been recorded", async () => {
    const { orchestrator, task } = await makeOrchestratorWithTask("regate");
    await writeSummary(task, "insufficient");
    // First gate, then decision.
    expect(await (orchestrator as any).pauseIfStep08CapacityGate(task, STEP08)).toBe(true);
    await (orchestrator as any).patchStep08CapacityDecision(task, "reduced", "");
    expect(await (orchestrator as any).pauseIfStep08CapacityGate(task, STEP08)).toBe(false);
  });

  it("routes 'accept reduced tier' -> step completed (migration proceeds)", async () => {
    const { orchestrator, store, task } = await makeOrchestratorWithTask("reduced");
    await writeSummary(task, "insufficient");
    await (orchestrator as any).pauseIfStep08CapacityGate(task, STEP08);
    const decision = { taskId: task.id, stepId: "08", questionEventId: "q", answer: "Accept reduced tier — run GUI acceptance at the recommended reduced setting", wasFreeform: false, decidedAt: new Date().toISOString() };
    const handled = await (orchestrator as any).applyStep08CapacityDecision({ task, decision });
    expect(handled).toBe(true);
    const updated = await store.getTask(task.id);
    expect(updated?.steps.find((s) => s.id === "08")?.status).toBe("completed");
  });

  it("routes 'hardware escalation' -> step hard_stopped", async () => {
    const { orchestrator, store, task } = await makeOrchestratorWithTask("escalation");
    await writeSummary(task, "insufficient");
    await (orchestrator as any).pauseIfStep08CapacityGate(task, STEP08);
    const decision = { taskId: task.id, stepId: "08", questionEventId: "q", answer: "Hardware escalation — full size needs a larger / multi-GPU node", wasFreeform: false, decidedAt: new Date().toISOString() };
    expect(await (orchestrator as any).applyStep08CapacityDecision({ task, decision })).toBe(true);
    const updated = await store.getTask(task.id);
    expect(updated?.steps.find((s) => s.id === "08")?.status).toBe("hard_stopped");
  });

  it("routes 'hard stop' -> step hard_stopped", async () => {
    const { orchestrator, store, task } = await makeOrchestratorWithTask("stop");
    await writeSummary(task, "insufficient");
    await (orchestrator as any).pauseIfStep08CapacityGate(task, STEP08);
    const decision = { taskId: task.id, stepId: "08", questionEventId: "q", answer: "Hard stop — stop the migration here", wasFreeform: false, decidedAt: new Date().toISOString() };
    expect(await (orchestrator as any).applyStep08CapacityDecision({ task, decision })).toBe(true);
    const updated = await store.getTask(task.id);
    expect(updated?.steps.find((s) => s.id === "08")?.status).toBe("hard_stopped");
  });
});

describe("capacitySignalForStep (drives the lossless VRAM-escalation ladder)", () => {
  it("Step 08: true only when capacity_tier is 'insufficient' (a hard OOM)", async () => {
    const { orchestrator, task } = await makeOrchestratorWithTask("sig08");
    await writeSummary(task, "insufficient");
    expect(await (orchestrator as any).capacitySignalForStep(task, "08")).toBe(true);
    await writeSummary(task, "reduced"); // completed-over-budget -> gate, not ladder
    expect(await (orchestrator as any).capacitySignalForStep(task, "08")).toBe(false);
    await writeSummary(task, "ok");
    expect(await (orchestrator as any).capacitySignalForStep(task, "08")).toBe(false);
  });

  it("Step 07: true when the branch-smoke summary flags capacity_suspected", async () => {
    const { orchestrator, task } = await makeOrchestratorWithTask("sig07");
    await ensureDir(task.artifactPath);
    await fs.writeFile(
      path.join(task.artifactPath, "07-branch-smoke-summary.json"),
      JSON.stringify({ capacity_suspected: true, capacity_signatures: ["device_lost"] }),
      "utf8"
    );
    expect(await (orchestrator as any).capacitySignalForStep(task, "07")).toBe(true);

    await fs.writeFile(
      path.join(task.artifactPath, "07-branch-smoke-summary.json"),
      JSON.stringify({ capacity_suspected: false }),
      "utf8"
    );
    expect(await (orchestrator as any).capacitySignalForStep(task, "07")).toBe(false);
  });
});

describe("effective VRAM level is hardened to disk (carries to Step 12 + survives restart)", () => {
  it("persistVramLevel writes effective-run-config.json and effectiveVramLevel recovers it with an empty in-memory cache", async () => {
    const { orchestrator, task } = await makeOrchestratorWithTask("persist");
    await (orchestrator as any).persistVramLevel(task, 2, "capacity OOM at Step 08");

    // Simulate a backend restart: the in-memory map is empty, so the level must
    // come from the persisted artifact (this is what makes Step 12 use it).
    (orchestrator as any).vramEscalationLevel.clear();
    expect(await (orchestrator as any).effectiveVramLevel(task.id, task)).toBe(2);

    // The artifact records the exact flags for the delivery handoff.
    const cfg = JSON.parse(await fs.readFile(path.join(task.artifactPath, "effective-run-config.json"), "utf8"));
    expect(cfg.vram_flags).toContain("--novram");
    expect(cfg.vram_level).toBe(2);
  });

  it("effectiveVramLevel returns the max of the in-memory cache and the persisted file", async () => {
    const { orchestrator, task } = await makeOrchestratorWithTask("persist-max");
    await (orchestrator as any).persistVramLevel(task, 1, "x");
    (orchestrator as any).vramEscalationLevel.set(task.id, 2); // mid-run escalated further
    expect(await (orchestrator as any).effectiveVramLevel(task.id, task)).toBe(2);
  });
});
