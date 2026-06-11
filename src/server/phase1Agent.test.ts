import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config";
import { ensureDir } from "./fsUtils";
import { MigrationOrchestrator } from "./orchestrator";
import { preparePhase1Driver } from "./phase1Agent";
import { StateStore } from "./state";
import { loadStepDefinitions } from "./workflowLoader";

function testConfig(root: string): AppConfig {
  return {
    port: 0,
    projectRoot: root,
    workspaceRoot: path.join(root, "workspaces"),
    stateRoot: path.join(root, "state"),
    draftDocRoot: testDraftDocRoot(),
    comfyuiRoot: path.join(root, "ComfyUI"),
    modelRoots: [path.join(root, "models")],
    autoApproveAgentPermissions: false,
      comfyuiVenv: "/tmp/comfy/.venv-xpu",
      comfyuiPython: "/tmp/comfy/.venv-xpu/bin/python3",
  };
}

function testDraftDocRoot(): string {
  const candidates = [
    path.resolve(process.cwd(), "../ComfyUI/docs/draft"),
    path.resolve(process.cwd(), "../docs/draft")
  ];
  const found = candidates.find((candidate) => fsSync.existsSync(candidate));
  return found ?? candidates[0];
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe("Phase 1 monolithic agent", () => {
  it("loads the v2 00-13 step definitions", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `phase1-steps-${Date.now()}`);
    const steps = await loadStepDefinitions(testConfig(root));

    expect(steps.map((step) => step.id)).toEqual([
      "00",
      "01",
      "02",
      "03",
      "04",
      "05",
      "06",
      "07",
      "08",
      "09",
      "10",
      "11",
      "12",
      "13"
    ]);
    expect(steps.find((step) => step.id === "13")?.promptPath).toContain(
      "13-agent-improvement-prompt.md"
    );
  });

  it("prepares task-state, compaction, and Phase 3 extraction artifacts", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `phase1-prepare-${Date.now()}`);
    const config = testConfig(root);
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const steps = await loadStepDefinitions(config);
    const orchestrator = new MigrationOrchestrator(config, store, steps);
    const task = await orchestrator.createTask({
      name: "Phase1 prep",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });

    const prepared = await preparePhase1Driver({
      config,
      task,
      steps,
      decisions: []
    });

    const taskStateText = await fs.readFile(prepared.taskStatePath, "utf8");
    expect(taskStateText).toContain("phase1-monolithic-copilot-driver");
    expect(Buffer.byteLength(taskStateText, "utf8")).toBeLessThan(10_000);
    const prompt = await fs.readFile(prepared.promptPath, "utf8");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(11_000);
    expect(prompt).toContain("00-13");
    expect(prompt).toContain("context budget monitor");
    expect(prompt).toContain("full agent contract");
    expect(prompt).toContain("compact ledger");
    expect(prompt).not.toContain("## Automatic compaction protocol");
    expect(await fs.readFile(prepared.phase3ExtractionPath, "utf8")).toContain("candidates");
  });

  it("runs the Phase 1 backend runner and syncs task-state step statuses", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `phase1-runner-${Date.now()}`);
    const config = testConfig(root);
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const steps = [
      {
        id: "00",
        name: "Intake",
        requiredOutput: "00-intake-preflight.md",
        humanIntervention: "Provide sources"
      },
      {
        id: "13",
        name: "Agent improvement",
        requiredOutput: "13-agent-improvement.md",
        humanIntervention: "Approve patch plan"
      }
    ];
    const orchestrator = new MigrationOrchestrator(config, store, steps, {
      async runStep(job, emit) {
        const taskStatePath = String(job.requiredContext.taskStatePath);
        const raw = JSON.parse(await fs.readFile(taskStatePath, "utf8")) as {
          status: string;
          steps: Array<{ id: string; status: string; summary?: string }>;
        };
        for (const step of raw.steps) {
          step.status = "completed";
          step.summary = `Fake completed Step ${step.id}.`;
        }
        raw.status = "completed";
        await fs.writeFile(taskStatePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
        await emit({
          taskId: job.taskId,
          stepId: job.stepId,
          type: "progress",
          message: "Fake Phase 1 SDK completed."
        });
        return { sessionId: "fake-phase1", summary: "Fake Phase 1 complete." };
      }
    });
    const task = await orchestrator.createTask({
      name: "Phase1 run",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });

    await orchestrator.runPhase1Agent(task.id);

    const updated = await store.getTask(task.id);
    expect(updated?.steps.every((step) => step.status === "completed")).toBe(true);
    expect(await fs.readFile(path.join(task.workspacePath, "task-state.json"), "utf8")).toContain(
      "Fake completed Step 13"
    );
  });

  it("periodically syncs Phase 1 task-state even when the SDK emits no API progress events", async () => {
    const previousSyncMs = process.env.MIGRATION_AGENT_PHASE1_SYNC_MS;
    process.env.MIGRATION_AGENT_PHASE1_SYNC_MS = "20";
    try {
      const root = path.join(process.cwd(), ".demo-state", "tests", `phase1-periodic-sync-${Date.now()}`);
      const config = testConfig(root);
      await ensureDir(config.workspaceRoot);
      const store = new StateStore(config);
      await store.initialize();
      const steps = [
        {
          id: "00",
          name: "Intake",
          requiredOutput: "00-intake-preflight.md",
          humanIntervention: "Provide sources"
        },
        {
          id: "01",
          name: "Assets",
          requiredOutput: "01-assets.csv / 01-custom-nodes.md",
          humanIntervention: "Approve substitute"
        }
      ];
      const orchestrator = new MigrationOrchestrator(config, store, steps, {
        async runStep(job) {
          const taskStatePath = String(job.requiredContext.taskStatePath);
          const raw = JSON.parse(await fs.readFile(taskStatePath, "utf8")) as {
            status: string;
            current_step_id?: string;
            steps: Array<{ id: string; status: string; summary?: string }>;
          };
          raw.steps[0].status = "completed";
          raw.steps[0].summary = "Periodic sync completed Step 00.";
          raw.steps[1].status = "running";
          raw.current_step_id = "01";
          raw.status = "running";
          await fs.writeFile(taskStatePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
          await new Promise((resolve) => setTimeout(resolve, 120));
          const midRun = await store.getTask(job.taskId);
          expect(midRun?.steps.find((step) => step.id === "00")?.status).toBe("completed");
          expect(midRun?.steps.find((step) => step.id === "01")?.status).toBe("running");

          raw.steps[1].status = "completed";
          raw.steps[1].summary = "Periodic sync completed Step 01.";
          raw.status = "completed";
          await fs.writeFile(taskStatePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
          return { sessionId: "fake-phase1", summary: "Fake Phase 1 complete." };
        }
      });
      const task = await orchestrator.createTask({
        name: "Phase1 periodic sync",
        workflowFileName: "workflow.json",
        workflowJson: { nodes: [], links: [] }
      });

      await orchestrator.runPhase1Agent(task.id);

      const updated = await store.getTask(task.id);
      expect(updated?.steps.every((step) => step.status === "completed")).toBe(true);
    } finally {
      if (previousSyncMs === undefined) {
        delete process.env.MIGRATION_AGENT_PHASE1_SYNC_MS;
      } else {
        process.env.MIGRATION_AGENT_PHASE1_SYNC_MS = previousSyncMs;
      }
    }
  });

  it("does not infer a pending Phase 1 current step as running during sync", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `phase1-pending-current-${Date.now()}`);
    const config = testConfig(root);
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const steps = [
      {
        id: "00",
        name: "Intake",
        requiredOutput: "00-intake-preflight.md",
        humanIntervention: "Provide sources"
      },
      {
        id: "01",
        name: "Assets",
        requiredOutput: "01-assets.csv / 01-custom-nodes.md",
        humanIntervention: "Approve substitute"
      }
    ];
    const orchestrator = new MigrationOrchestrator(config, store, steps, {
      async runStep(job, _emit, _waitForDecision, observeSdkEvent) {
        const taskStatePath = String(job.requiredContext.taskStatePath);
        const raw = JSON.parse(await fs.readFile(taskStatePath, "utf8")) as {
          status: string;
          current_step_id?: string;
          steps: Array<{ id: string; status: string; summary?: string }>;
        };
        raw.steps[0].status = "completed";
        raw.steps[0].summary = "Completed Step 00 and ready for Step 01.";
        raw.steps[1].status = "pending";
        raw.current_step_id = "01";
        raw.status = "running";
        await fs.writeFile(taskStatePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
        await observeSdkEvent?.({ type: "tool.execution_complete", data: { toolName: "bash", success: true } });
        return { sessionId: "fake-phase1", summary: "Fake Phase 1 stopped before Step 01." };
      }
    });
    const task = await orchestrator.createTask({
      name: "Phase1 pending current",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });

    await expect(orchestrator.runPhase1Agent(task.id)).rejects.toThrow(
      "ended before reaching a terminal task-state checkpoint"
    );

    const updated = await store.getTask(task.id);
    const step00 = updated?.steps.find((step) => step.id === "00");
    const step01 = updated?.steps.find((step) => step.id === "01");
    expect(step00?.status).toBe("completed");
    expect(step01?.status).toBe("failed");
    expect(step01?.startedAt).toBeUndefined();
  });

  it("pauses instead of crashing when the Phase 1 context budget turns critical", async () => {
    const previousWarning = process.env.MIGRATION_AGENT_CONTEXT_WARNING_TOKENS;
    const previousCritical = process.env.MIGRATION_AGENT_CONTEXT_CRITICAL_TOKENS;
    const previousSnapshot = process.env.MIGRATION_AGENT_CONTEXT_SNAPSHOT_MS;
    process.env.MIGRATION_AGENT_CONTEXT_WARNING_TOKENS = "1";
    process.env.MIGRATION_AGENT_CONTEXT_CRITICAL_TOKENS = "1";
    process.env.MIGRATION_AGENT_CONTEXT_SNAPSHOT_MS = "1";
    try {
      const root = path.join(process.cwd(), ".demo-state", "tests", `phase1-critical-budget-${Date.now()}`);
      const config = testConfig(root);
      await ensureDir(config.workspaceRoot);
      const store = new StateStore(config);
      await store.initialize();
      const steps = [
        {
          id: "00",
          name: "Intake",
          requiredOutput: "00-intake-preflight.md",
          humanIntervention: "Provide sources"
        },
        {
          id: "01",
          name: "Assets",
          requiredOutput: "01-assets.csv / 01-custom-nodes.md",
          humanIntervention: "Approve substitute"
        }
      ];
      const orchestrator = new MigrationOrchestrator(config, store, steps, {
        async runStep(job, _emit, _waitForDecision, observeSdkEvent) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          await observeSdkEvent?.(
            { type: "tool.execution_complete", data: { toolName: "bash", success: true } },
            "tool completed: bash success=true"
          );
          return { sessionId: "fake-phase1", summary: "should not complete" };
        }
      });
      const task = await orchestrator.createTask({
        name: "Phase1 critical budget",
        workflowFileName: "workflow.json",
        workflowJson: { nodes: [], links: [] }
      });

      await expect(orchestrator.runPhase1Agent(task.id)).resolves.toBeUndefined();

      const updated = await store.getTask(task.id);
      const events = await store.listEvents(task.id);
      expect(updated?.steps.find((step) => step.id === "00")?.status).toBe("waiting_for_human");
      expect(
        events.some(
          (event) =>
            event.type === "human_question" &&
            event.stepId === "00" &&
            JSON.stringify(event.data).includes("capacity_policy")
        )
      ).toBe(true);
    } finally {
      restoreEnv("MIGRATION_AGENT_CONTEXT_WARNING_TOKENS", previousWarning);
      restoreEnv("MIGRATION_AGENT_CONTEXT_CRITICAL_TOKENS", previousCritical);
      restoreEnv("MIGRATION_AGENT_CONTEXT_SNAPSHOT_MS", previousSnapshot);
    }
  });

  it("fails when the Phase 1 SDK session returns without a terminal task-state checkpoint", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `phase1-incomplete-${Date.now()}`);
    const config = testConfig(root);
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const steps = [
      {
        id: "00",
        name: "Intake",
        requiredOutput: "00-intake-preflight.md",
        humanIntervention: "Provide sources"
      },
      {
        id: "01",
        name: "Assets",
        requiredOutput: "01-assets.csv",
        humanIntervention: "Approve substitute"
      }
    ];
    const orchestrator = new MigrationOrchestrator(config, store, steps, {
      async runStep(job, emit) {
        await emit({
          taskId: job.taskId,
          stepId: job.stepId,
          type: "progress",
          message: "Fake SDK returned without updating task-state.json."
        });
        return { sessionId: "fake-phase1", summary: "Still externalizing Step 00." };
      }
    });
    const task = await orchestrator.createTask({
      name: "Phase1 incomplete",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });

    await expect(orchestrator.runPhase1Agent(task.id)).rejects.toThrow(
      "ended before reaching a terminal task-state checkpoint"
    );

    const updated = await store.getTask(task.id);
    const events = await store.listEvents(task.id);
    expect(updated?.steps.find((step) => step.id === "00")?.status).toBe("failed");
    expect(updated?.steps.find((step) => step.id === "00")?.error).toContain(
      "did not write the required step artifacts"
    );
    expect(events.some((event) => event.type === "step_failed")).toBe(true);
  });

  it("marks a stale completed-but-incomplete Phase 1 session failed during reconciliation", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `phase1-stale-incomplete-${Date.now()}`);
    const config = testConfig(root);
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const orchestrator = new MigrationOrchestrator(config, store, [
      {
        id: "00",
        name: "Intake",
        requiredOutput: "00-intake-preflight.md",
        humanIntervention: "Provide sources"
      }
    ]);
    const task = await orchestrator.createTask({
      name: "Stale incomplete",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });
    await store.updateStep(task.id, "00", "running");
    await store.appendEvent({
      taskId: task.id,
      stepId: "phase1",
      type: "step_summary",
      message: "SDK returned before writing artifacts.",
      data: {
        sessionArtifacts: {
          transcriptPath: path.join(task.artifactPath, "sdk-sessions", "phase1.md")
        }
      }
    });

    const cleaned = await orchestrator.reconcileStaleActiveTasks("server restarted");

    const updated = await store.getTask(task.id);
    const events = await store.listEvents(task.id);
    expect(cleaned).toEqual([{ id: task.id, name: task.name, stepIds: ["00"] }]);
    expect(updated?.steps.find((step) => step.id === "00")?.status).toBe("failed");
    expect(events.some((event) => event.type === "step_failed")).toBe(true);
  });

  it("exposes Phase 1 task-state human gates as backend human questions", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `phase1-gate-${Date.now()}`);
    const config = testConfig(root);
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const steps = [
      {
        id: "00",
        name: "Intake",
        requiredOutput: "00-intake-preflight.md",
        humanIntervention: "Provide sources"
      },
      {
        id: "01",
        name: "Assets",
        requiredOutput: "01-assets.csv",
        humanIntervention: "Approve substitute"
      }
    ];
    const orchestrator = new MigrationOrchestrator(config, store, steps, {
      async runStep(job) {
        const taskStatePath = String(job.requiredContext.taskStatePath);
        const raw = JSON.parse(await fs.readFile(taskStatePath, "utf8")) as {
          status: string;
          current_step_id?: string;
          steps: Array<{
            id: string;
            status: string;
            summary?: string;
            artifacts?: string[];
            completion_decision?: Record<string, unknown>;
          }>;
        };
        raw.status = "waiting_for_human";
        raw.current_step_id = "01";
        raw.steps[0].status = "completed";
        raw.steps[0].summary = "Fake Step 00 complete.";
        raw.steps[1].status = "waiting_for_human";
        raw.steps[1].summary = "Need alias approval.";
        raw.steps[1].artifacts = ["artifacts/01-human-gate.json", "artifacts/01-human-gate.md"];
        const detailedGate = {
          question_event_id: "phase1-test-gate",
          problem_summary: "Need alias approval.",
          allowed_decisions: [
            { choice: "A", label: "Provide exact file" },
            { choice: "B", label: "Approve alias", alias_path: "/models/alias.safetensors" }
          ],
          claim_boundary_impact: "Smoke-only if alias is approved.",
          unresolved_items: Array.from({ length: 12 }, (_, index) => ({
            item: `missing-${index}.safetensors`,
            kind: "model",
            blocker:
              "This intentionally verbose blocker stays in the gate artifact and must not remain in task-state.json."
          })),
          decision_context: {
            background_reason_scene:
              "Full artifact background: the exact source-identical model is unavailable, so the operator must choose a safe continuation edge.",
            terminology: [
              {
                term: "alias approval",
                explanation:
                  "Permission to use a non-source-identical local file only for bounded smoke validation."
              }
            ],
            consequences_and_follow_up: [
              {
                choice: "A Provide exact file",
                consequence: "Source-identical claim can remain possible for this item.",
                follow_up: "Record the supplied source and retry Step 01."
              },
              {
                choice: "B Approve alias",
                consequence: "The run becomes smoke-only for this item.",
                follow_up: "Record the downgraded claim boundary before Step 02."
              }
            ]
          }
        };
        await fs.writeFile(
          path.join(job.artifactPath, "01-human-gate.json"),
          `${JSON.stringify({ human_gate: detailedGate }, null, 2)}\n`,
          "utf8"
        );
        raw.steps[1].completion_decision = {
          status: "waiting_for_human",
          evidence_artifacts: ["artifacts/01-human-gate.json", "artifacts/01-human-gate.md"],
          human_gate: detailedGate
        };
        await fs.writeFile(taskStatePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
        return { sessionId: "fake-phase1", summary: "Fake Phase 1 paused." };
      }
    });
    const task = await orchestrator.createTask({
      name: "Phase1 gate",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });

    await orchestrator.runPhase1Agent(task.id);

    const events = await store.listEvents(task.id);
    const question = events.find((event) => event.type === "human_question");
    expect(question?.stepId).toBe("01");
    expect(question?.message).toContain("Need alias approval");
    expect(question?.data).toMatchObject({
      phase1GateId: "phase1-test-gate",
      choices: ["A Provide exact file", "B Approve alias (/models/alias.safetensors)"]
    });
    const data = question?.data as
      | {
          decisionContext?: {
            formatVersion: string;
            backgroundReasonScene: string;
            terminology: Array<{ term: string; explanation: string }>;
            consequencesAndFollowUp: Array<{ choice: string; consequence: string; followUp: string }>;
          };
        }
      | undefined;
    expect(data?.decisionContext?.formatVersion).toBe("human-gate-v1");
    expect(data?.decisionContext?.backgroundReasonScene).toContain("Full artifact background");
    expect(data?.decisionContext?.terminology.some((item) => item.term === "alias approval")).toBe(true);
    expect(data?.decisionContext?.terminology.some((item) => item.term === "source-identical asset")).toBe(
      true
    );
    expect(data?.decisionContext?.consequencesAndFollowUp).toHaveLength(2);
    const compactStateText = await fs.readFile(path.join(task.workspacePath, "task-state.json"), "utf8");
    expect(Buffer.byteLength(compactStateText, "utf8")).toBeLessThan(10_000);
    expect(compactStateText).not.toContain("Full artifact background");
    expect(compactStateText).not.toContain("unresolved_items");
    const compactState = JSON.parse(compactStateText) as {
      steps: Array<{ id: string; completion_decision?: { human_gate?: Record<string, unknown> } }>;
    };
    expect(compactState.steps.find((step) => step.id === "01")?.completion_decision?.human_gate).toMatchObject({
      question_event_id: "phase1-test-gate",
      artifact_ref: "artifacts/01-human-gate.json",
      unresolved_item_count: 12
    });
  });

  it("hydrates artifact-only Phase 1 human gates into backend human questions", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `phase1-artifact-gate-${Date.now()}`);
    const config = testConfig(root);
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const steps = [
      {
        id: "00",
        name: "Intake",
        requiredOutput: "00-intake-preflight.md",
        humanIntervention: "Provide sources"
      },
      {
        id: "01",
        name: "Assets",
        requiredOutput: "01-assets.csv",
        humanIntervention: "Approve substitute"
      }
    ];
    const orchestrator = new MigrationOrchestrator(config, store, steps, {
      async runStep(job) {
        const taskStatePath = String(job.requiredContext.taskStatePath);
        const raw = JSON.parse(await fs.readFile(taskStatePath, "utf8")) as {
          status: string;
          current_step_id?: string;
          steps: Array<{
            id: string;
            status: string;
            summary?: string;
            artifacts?: string[];
            completion_decision?: Record<string, unknown>;
          }>;
        };
        raw.status = "waiting_for_human";
        raw.current_step_id = "01";
        raw.steps[0].status = "completed";
        raw.steps[1].status = "waiting_for_human";
        raw.steps[1].summary = "Artifact-only gate reached.";
        raw.steps[1].artifacts = [
          "artifacts/01-human-gate.json",
          "artifacts/phase1-context/step-handoffs/01-handoff.json"
        ];
        raw.steps[1].completion_decision = {
          next_step_allowed: false,
          detail_ref: "artifacts/phase1-context/step-handoffs/01-handoff.json"
        };
        const gate = {
          gate_id: "phase1-artifact-only-gate",
          problem_summary: "Need DWPose hidden assets or reduced-route approval.",
          background_reason_scene:
            "Node 76 is disconnected but still part of the source workflow, so hidden DWPose assets require a human decision.",
          terminology: [
            {
              term: "reduced route",
              explanation: "Continue while preserving an explicit unresolved-node claim boundary."
            }
          ],
          unresolved_items: [
            { item: "yolox_l.onnx", kind: "hidden_runtime_asset" },
            { item: "dw-ll_ucoco_384_bs5.torchscript.pt", kind: "hidden_runtime_asset" }
          ],
          allowed_decisions: [
            { choice: "A", label: "Provide exact files" },
            { choice: "C", label: "Approve reduced route" },
            { choice: "D", label: "Stop migration" }
          ],
          continuation_edge: "A retries Step 01; C starts Step 02 with a route constraint; D stops."
        };
        await fs.writeFile(
          path.join(job.artifactPath, "01-human-gate.json"),
          `${JSON.stringify(gate, null, 2)}\n`,
          "utf8"
        );
        await ensureDir(path.join(job.artifactPath, "phase1-context", "step-handoffs"));
        await fs.writeFile(
          path.join(job.artifactPath, "phase1-context", "step-handoffs", "01-handoff.json"),
          `${JSON.stringify({ status: "human_gate", human_gate: gate }, null, 2)}\n`,
          "utf8"
        );
        await fs.writeFile(taskStatePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
        return { sessionId: "fake-phase1", summary: "Fake Phase 1 paused at artifact-only gate." };
      }
    });
    const task = await orchestrator.createTask({
      name: "Phase1 artifact gate",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });

    await orchestrator.runPhase1Agent(task.id);

    const events = await store.listEvents(task.id);
    const question = events.find((event) => event.type === "human_question");
    expect(question?.stepId).toBe("01");
    expect(question?.data).toMatchObject({
      phase1GateId: "phase1-artifact-only-gate",
      choices: ["A Provide exact files", "C Approve reduced route", "D Stop migration"]
    });
    const data = question?.data as
      | {
          decisionContext?: {
            backgroundReasonScene: string;
            terminology: Array<{ term: string; explanation: string }>;
          };
        }
      | undefined;
    expect(data?.decisionContext?.backgroundReasonScene).toContain("Node 76 is disconnected");
    expect(data?.decisionContext?.terminology.some((item) => item.term === "reduced route")).toBe(true);
  });

  it("marks a deterministic human-gate answer as running while it is applied", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `phase1-gate-applying-${Date.now()}`);
    const config = testConfig(root);
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const steps = [
      {
        id: "00",
        name: "Intake",
        requiredOutput: "00-intake-preflight.md",
        humanIntervention: "Provide sources"
      },
      {
        id: "01",
        name: "Assets",
        requiredOutput: "01-assets.csv",
        humanIntervention: "Approve substitute"
      }
    ];
    const orchestrator = new MigrationOrchestrator(config, store, steps);
    const task = await orchestrator.createTask({
      name: "Gate applying",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });
    await store.updateStep(task.id, "00", "waiting_for_human", {
      summary: "Step 00 is waiting for a gate decision."
    });

    await orchestrator.recordHumanDecision({
      taskId: task.id,
      stepId: "00",
      questionEventId: "gate-00",
      answer: "Approve bounded smoke-only follow-up with documented gaps",
      wasFreeform: false
    });

    const updated = await store.getTask(task.id);
    expect(updated?.steps.find((step) => step.id === "00")?.status).toBe("completed");
    const events = await store.listEvents(task.id);
    const applyingIndex = events.findIndex(
      (event) => event.type === "progress" && event.message.includes("Applying human decision")
    );
    const completedIndex = events.findIndex((event) => event.type === "step_completed");
    expect(applyingIndex).toBeGreaterThanOrEqual(0);
    expect(completedIndex).toBeGreaterThan(applyingIndex);
  });

  it("uses backend-completed gate state when preparing a Phase 1 resume", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `phase1-resume-${Date.now()}`);
    const config = testConfig(root);
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const steps = [
      {
        id: "00",
        name: "Intake",
        requiredOutput: "00-intake-preflight.md",
        humanIntervention: "Provide sources"
      },
      {
        id: "01",
        name: "Assets",
        requiredOutput: "01-assets.csv",
        humanIntervention: "Approve substitute"
      },
      {
        id: "02",
        name: "Feasibility",
        requiredOutput: "02-feasibility.md",
        humanIntervention: "Review route"
      }
    ];
    const orchestrator = new MigrationOrchestrator(config, store, steps);
    const task = await orchestrator.createTask({
      name: "Phase1 resume",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });
    const prepared = await preparePhase1Driver({ config, task, steps, decisions: [] });
    const raw = JSON.parse(await fs.readFile(prepared.taskStatePath, "utf8")) as {
      status: string;
      current_step_id?: string;
      steps: Array<{ id: string; status: string; summary?: string }>;
    };
    raw.status = "waiting_for_human";
    raw.current_step_id = "01";
    raw.steps.find((step) => step.id === "00")!.status = "completed";
    raw.steps.find((step) => step.id === "01")!.status = "waiting_for_human";
    await fs.writeFile(prepared.taskStatePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    await store.updateStep(task.id, "00", "completed");
    await store.updateStep(task.id, "01", "completed");
    const updatedTask = await store.getTask(task.id);
    if (!updatedTask) throw new Error("Task missing after test setup.");

    await preparePhase1Driver({ config, task: updatedTask, steps, decisions: [] });

    const resumed = JSON.parse(await fs.readFile(prepared.taskStatePath, "utf8")) as {
      status: string;
      current_step_id?: string;
      steps: Array<{ id: string; status: string }>;
    };
    expect(resumed.steps.find((step) => step.id === "01")?.status).toBe("completed");
    expect(resumed.current_step_id).toBe("02");
    expect(resumed.steps.find((step) => step.id === "02")?.status).toBe("running");
  });
});
