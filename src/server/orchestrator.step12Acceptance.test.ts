import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config";
import type { MigrationStepDefinition, MigrationTask } from "../shared/types";
import { ensureDir } from "./fsUtils";
import { MigrationOrchestrator } from "./orchestrator";
import { StateStore } from "./state";

// Step 12 GUI-acceptance human gate (regression fix): Step 12 must not
// auto-complete on artifact presence -- it must pause for an explicit operator
// verification result (Pass / Not pass / Not validated), surface a clickable
// ComfyUI verification URL, and route each result to the right pipeline effect.

const STEP12: MigrationStepDefinition = {
  id: "12",
  name: "GUI acceptance and demo",
  requiredOutput: "12-gui-acceptance.md",
  humanIntervention: "Run clean GUI workflow and sign off generated outputs."
};

const API_URL = "http://172.16.124.12:8188";

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

function orchestratorWith(config: AppConfig, store: StateStore): MigrationOrchestrator {
  return new MigrationOrchestrator(
    config,
    store,
    [STEP12],
    { runStep: async () => ({ sessionId: "x", summary: "x" }) }
  );
}

async function setupGatedStep12(
  store: StateStore,
  orchestrator: MigrationOrchestrator,
  manualResult: string
): Promise<{ task: MigrationTask; questionEventId: string; paused: boolean }> {
  const task = await orchestrator.createTask({
    name: "Step12Accept",
    workflowFileName: "MyWorkflow.json",
    workflowJson: { nodes: [], links: [] }
  });
  await fs.writeFile(path.join(task.artifactPath, "12-gui-acceptance.md"), "# GUI acceptance\n", "utf8");
  await fs.writeFile(
    path.join(task.artifactPath, "12-gui-acceptance-summary.json"),
    JSON.stringify({ manual_result: manualResult, service: { api_url: API_URL } }, null, 2),
    "utf8"
  );

  const paused = await (orchestrator as unknown as {
    pauseIfStep12AcceptanceGate(t: MigrationTask, s: MigrationStepDefinition): Promise<boolean>;
  }).pauseIfStep12AcceptanceGate(task, STEP12);

  const events = await store.listEvents(task.id);
  const question = events.filter((e) => e.type === "human_question").at(-1);
  return { task, questionEventId: question?.id ?? "", paused };
}

async function stepStatus(store: StateStore, taskId: string): Promise<string | undefined> {
  return (await store.getTask(taskId))?.steps.find((s) => s.id === "12")?.status;
}

async function manualResultOf(task: MigrationTask): Promise<string | undefined> {
  const raw = await fs.readFile(path.join(task.artifactPath, "12-gui-acceptance-summary.json"), "utf8");
  return JSON.parse(raw).manual_result;
}

async function freshStore(name: string): Promise<{ store: StateStore; orchestrator: MigrationOrchestrator }> {
  const root = path.join(process.cwd(), ".demo-state", "tests", `${name}-${Date.now()}-${Math.round(performance.now())}`);
  const config = makeConfig(root);
  await ensureDir(config.workspaceRoot);
  const store = new StateStore(config);
  await store.initialize();
  return { store, orchestrator: orchestratorWith(config, store) };
}

describe("Step 12 GUI-acceptance gate", () => {
  it("pauses for human acceptance and emits a clickable verification URL + three result choices", async () => {
    const { store, orchestrator } = await freshStore("s12-gate");
    const { task, questionEventId, paused } = await setupGatedStep12(store, orchestrator, "pending_human_run");

    expect(paused).toBe(true);
    expect(await stepStatus(store, task.id)).toBe("waiting_for_human");

    const events = await store.listEvents(task.id);
    const question = events.find((e) => e.id === questionEventId);
    const data = question?.data as { verificationUrl?: string; choices?: string[] } | undefined;
    expect(data?.verificationUrl).toBe(API_URL);
    expect(data?.choices).toHaveLength(3);
    expect(data?.choices?.some((c) => /pass/i.test(c))).toBe(true);
  });

  it("does NOT pause when the summary already records manual_result=accepted", async () => {
    const { store, orchestrator } = await freshStore("s12-accepted");
    const { task, paused } = await setupGatedStep12(store, orchestrator, "accepted");
    expect(paused).toBe(false);
    expect(await stepStatus(store, task.id)).not.toBe("waiting_for_human");
  });

  it("Pass -> step completed and manual_result=accepted", async () => {
    const { store, orchestrator } = await freshStore("s12-pass");
    const { task, questionEventId } = await setupGatedStep12(store, orchestrator, "pending_human_run");

    await orchestrator.recordHumanDecision({
      taskId: task.id,
      stepId: "12",
      questionEventId,
      answer: "Pass — outputs verified correct",
      wasFreeform: false
    });

    expect(await stepStatus(store, task.id)).toBe("completed");
    expect(await manualResultOf(task)).toBe("accepted");
  });

  it("Not pass -> step paused (re-runnable) and manual_result=rejected", async () => {
    const { store, orchestrator } = await freshStore("s12-notpass");
    const { task, questionEventId } = await setupGatedStep12(store, orchestrator, "pending_human_run");

    await orchestrator.recordHumanDecision({
      taskId: task.id,
      stepId: "12",
      questionEventId,
      answer: "Not pass — outputs are wrong",
      wasFreeform: false
    });

    expect(await stepStatus(store, task.id)).toBe("paused");
    expect(await manualResultOf(task)).toBe("rejected");
  });

  it("Not validated -> step completed, flagged not customer-ready, manual_result=not_validated", async () => {
    const { store, orchestrator } = await freshStore("s12-notval");
    const { task, questionEventId } = await setupGatedStep12(store, orchestrator, "pending_human_run");

    await orchestrator.recordHumanDecision({
      taskId: task.id,
      stepId: "12",
      questionEventId,
      answer: "Not validated — did not verify",
      wasFreeform: false
    });

    expect(await stepStatus(store, task.id)).toBe("completed");
    expect(await manualResultOf(task)).toBe("not_validated");
    const summary = (await store.getTask(task.id))?.steps.find((s) => s.id === "12")?.summary ?? "";
    expect(summary.toLowerCase()).toContain("not customer-ready");
  });
});
