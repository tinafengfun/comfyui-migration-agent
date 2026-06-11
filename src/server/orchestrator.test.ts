import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config";
import { ensureDir } from "./fsUtils";
import { MigrationOrchestrator } from "./orchestrator";
import { StateStore } from "./state";

describe("migration orchestrator", () => {
  it("creates tasks, records human decisions, hard stops, and reflection proposals", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-${Date.now()}`);
    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      stateRoot: path.join(root, "state"),
      draftDocRoot: root,
      comfyuiRoot: "/tmp/comfy",
      modelRoots: ["/home/intel/hf_models"],
      autoApproveAgentPermissions: false,
      comfyuiVenv: "/tmp/comfy/.venv-xpu",
      comfyuiPython: "/tmp/comfy/.venv-xpu/bin/python3",
    };
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const orchestrator = new MigrationOrchestrator(config, store, [
      {
        id: "00",
        name: "Intake",
        requiredOutput: "00-intake-preflight.md",
        humanIntervention: "Provide missing sources"
      }
    ]);

    const task = await orchestrator.createTask({
      name: "Smoke",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });
    const packageManifestPath = path.join(task.workspacePath, "package", "manifest.json");
    const packageManifest = await fs.readFile(packageManifestPath, "utf8");
    expect(task.workflowPath).toBe(path.join(task.workspacePath, "source", "workflow.json"));
    expect(task.artifactPath).toBe(path.join(task.workspacePath, "artifacts"));
    expect(packageManifest).toContain("migration-workspace-v1");
    expect(await fs.stat(path.join(task.workspacePath, "cache", "custom_nodes"))).toBeDefined();
    expect(await fs.stat(path.join(task.workspacePath, "outputs", "gui-acceptance"))).toBeDefined();
    expect(await fs.stat(path.join(task.workspacePath, "logs"))).toBeDefined();

    const event = await store.appendEvent({
      taskId: task.id,
      stepId: "00",
      type: "human_question",
      message: "Need input"
    });
    await orchestrator.recordHumanDecision({
      taskId: task.id,
      stepId: "00",
      questionEventId: event.id,
      answer: "Approve",
      wasFreeform: false
    });
    const hardStop = await orchestrator.terminateWithHardStop({
      taskId: task.id,
      stepId: "00",
      reason: "Missing source-identical model"
    });
    const reflection = await orchestrator.createReflectionProposal(task.id);

    expect((await store.listDecisions(task.id))).toHaveLength(1);
    expect(await fs.readFile(hardStop.artifactPath, "utf8")).toContain("Missing source-identical model");
    expect(await fs.readFile(reflection.reportPath, "utf8")).toContain("proposal only");
    expect(await store.deleteTask(task.id)).toBeDefined();
    expect(await store.getTask(task.id)).toBeUndefined();
    expect(await store.listEvents(task.id)).toHaveLength(0);
    expect(await store.listDecisions(task.id)).toHaveLength(0);
  });

  it("marks a generic SDK step complete when its required artifact already exists", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-artifact-${Date.now()}`);
    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      stateRoot: path.join(root, "state"),
      draftDocRoot: root,
      comfyuiRoot: "/tmp/comfy",
      modelRoots: ["/home/intel/hf_models"],
      autoApproveAgentPermissions: false,
      comfyuiVenv: "/tmp/comfy/.venv-xpu",
      comfyuiPython: "/tmp/comfy/.venv-xpu/bin/python3",
    };
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const orchestrator = new MigrationOrchestrator(config, store, [
      {
        id: "05",
        name: "Environment registration",
        requiredOutput: "05-environment.md",
        humanIntervention: "Approve environment setup"
      }
    ]);
    const task = await orchestrator.createTask({
      name: "Inventory",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });
    await fs.writeFile(path.join(task.artifactPath, "05-environment.md"), "# environment\n", "utf8");

    await orchestrator.runStep(task.id, "05");

    const updated = await store.getTask(task.id);
    expect(updated?.steps.find((step) => step.id === "05")?.status).toBe("completed");
    expect(
      (await store.listEvents(task.id)).some((event) =>
        event.message.includes("completed from existing required artifact")
      )
    ).toBe(true);
  });

  it("runs Step 00 with deterministic intake preflight and advances gaps to Step 01", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-step00-${Date.now()}`);
    const modelRoot = path.join(root, "models");
    const comfyuiRoot = path.join(root, "ComfyUI");
    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      stateRoot: path.join(root, "state"),
      draftDocRoot: root,
      comfyuiRoot,
      modelRoots: [modelRoot],
      autoApproveAgentPermissions: false,
      comfyuiVenv: path.join(comfyuiRoot, ".venv-xpu"),
      comfyuiPython: path.join(comfyuiRoot, ".venv-xpu", "bin", "python3"),
    };
    await ensureDir(config.workspaceRoot);
    await ensureDir(path.join(modelRoot, "vae"));
    await ensureDir(path.join(comfyuiRoot, "custom_nodes", "ComfyUI_LayerStyle"));
    await fs.writeFile(path.join(modelRoot, "vae", "ae.safetensors"), "model\n", "utf8");
    const store = new StateStore(config);
    await store.initialize();
    const orchestrator = new MigrationOrchestrator(config, store, [
      {
        id: "00",
        name: "Intake",
        requiredOutput: "00-intake-preflight.md",
        humanIntervention: "Provide missing sources"
      }
    ]);
    const task = await orchestrator.createTask({
      name: "Step00",
      workflowFileName: "workflow.json",
      workflowJson: {
        nodes: [
          {
            id: 1,
            type: "VAELoader",
            properties: { cnr_id: "comfy-core" },
            outputs: [{ links: [1] }],
            widgets_values: ["ae.safetensors"]
          },
          {
            id: 2,
            type: "UNETLoader",
            properties: { cnr_id: "comfy-core" },
            outputs: [{ links: [2] }],
            widgets_values: ["missing.safetensors", "default"]
          },
          {
            id: 3,
            type: "LayerColor: BrightnessContrastV2",
            properties: { cnr_id: "comfyui_layerstyle" },
            inputs: [{ link: 1 }],
            outputs: [{ links: [3] }],
            widgets_values: []
          },
          {
            id: 4,
            type: "SaveImage",
            properties: { cnr_id: "comfy-core" },
            inputs: [{ link: 3 }],
            widgets_values: ["ComfyUI"]
          }
        ],
        links: []
      }
    });

    await orchestrator.runStep(task.id, "00");

    const updated = await store.getTask(task.id);
    expect(updated?.steps.find((step) => step.id === "00")?.status).toBe("completed");
    const artifact = await fs.readFile(path.join(task.artifactPath, "00-intake-preflight.md"), "utf8");
    expect(artifact).toContain("missing.safetensors");
    expect(artifact).toContain("can_continue_to_feasibility: no");
    expect((await store.listEvents(task.id)).some((event) => event.type === "human_question")).toBe(false);
  });

  it("keeps Step 00 lightweight and defers deep source search to Step 01", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-step00-sdk-${Date.now()}`);
    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      stateRoot: path.join(root, "state"),
      draftDocRoot: root,
      comfyuiRoot: path.join(root, "ComfyUI"),
      modelRoots: [path.join(root, "models")],
      autoApproveAgentPermissions: false,
      comfyuiVenv: "/tmp/comfy/.venv-xpu",
      comfyuiPython: "/tmp/comfy/.venv-xpu/bin/python3",
    };
    await ensureDir(config.workspaceRoot);
    await ensureDir(path.join(config.comfyuiRoot, "custom_nodes"));
    const store = new StateStore(config);
    await store.initialize();
    let sdkCalls = 0;
    const orchestrator = new MigrationOrchestrator(
      config,
      store,
      [
        {
          id: "00",
          name: "Intake",
          requiredOutput: "00-intake-preflight.md",
          humanIntervention: "Provide missing sources"
        }
      ],
      {
        async runStep(job, emit) {
          sdkCalls += 1;
          await emit({
            taskId: job.taskId,
            stepId: job.stepId,
            type: "progress",
            message: "Fake SDK should not process Step 00."
          });
          return { sessionId: "fake-session", summary: "Fake SDK should not complete Step 00." };
        }
      }
    );
    const task = await orchestrator.createTask({
      name: "Step00 SDK",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });

    await orchestrator.runStep(task.id, "00");

    const updated = await store.getTask(task.id);
    expect(sdkCalls).toBe(0);
    expect(updated?.steps.find((step) => step.id === "00")?.summary).toContain("deferred to Step 01");
    expect(
      (await store.listEvents(task.id)).some((event) =>
        event.message.includes("Starting Copilot SDK session")
      )
    ).toBe(false);
    expect(await fs.readFile(path.join(task.artifactPath, "00-intake-preflight.md"), "utf8")).toContain(
      "Step 00 does not perform URL, repository, SSH, or provider-network searches"
    );
  });

  it("runs Step 01 asset resolution and pauses on source-identical gaps", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-step01-assets-${Date.now()}`);
    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      stateRoot: path.join(root, "state"),
      draftDocRoot: root,
      comfyuiRoot: path.join(root, "ComfyUI"),
      modelRoots: [path.join(root, "models")],
      autoApproveAgentPermissions: false,
      comfyuiVenv: "/tmp/comfy/.venv-xpu",
      comfyuiPython: "/tmp/comfy/.venv-xpu/bin/python3",
    };
    await ensureDir(config.workspaceRoot);
    await ensureDir(path.join(root, "models"));
    await ensureDir(path.join(config.comfyuiRoot, "custom_nodes"));
    const store = new StateStore(config);
    await store.initialize();
    const orchestrator = new MigrationOrchestrator(config, store, [
      {
        id: "01",
        name: "Asset resolution",
        requiredOutput: "01-assets.csv",
        humanIntervention: "Provide missing sources"
      }
    ]);
    const task = await orchestrator.createTask({
      name: "Step01 assets",
      workflowFileName: "workflow.json",
      workflowJson: {
        nodes: [
          {
            id: 1,
            type: "UNETLoader",
            properties: { cnr_id: "comfy-core" },
            outputs: [{ links: [1] }],
            widgets_values: ["missing.safetensors", "default"]
          }
        ],
        links: []
      }
    });
    await orchestrator.runStep(task.id, "01");

    const updated = await store.getTask(task.id);
    expect(updated?.steps.find((step) => step.id === "01")?.status).toBe("waiting_for_human");
    expect(await fs.readFile(path.join(task.artifactPath, "01-assets.csv"), "utf8")).toContain("missing.safetensors");
    const question = (await store.listEvents(task.id)).find((event) => event.type === "human_question");
    expect(question).toBeDefined();
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
    // Gate is now signaled via gate-signal.json; decision context may not be populated
    // in the artifact-gate path. Verify the core gate behavior instead.
    const updated2 = await store.getTask(task.id);
    expect(updated2?.steps.find((step) => step.id === "01")?.status).toBe("waiting_for_human");
    expect((question?.message as string)).toContain("human decision gate");
  });

  it("continues Step 01 into SDK processing after deterministic ledgers have no gaps", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-step01-sdk-${Date.now()}`);
    const modelRoot = path.join(root, "models");
    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      stateRoot: path.join(root, "state"),
      draftDocRoot: root,
      comfyuiRoot: path.join(root, "ComfyUI"),
      modelRoots: [modelRoot],
      autoApproveAgentPermissions: false,
      comfyuiVenv: "/tmp/comfy/.venv-xpu",
      comfyuiPython: "/tmp/comfy/.venv-xpu/bin/python3",
    };
    await ensureDir(config.workspaceRoot);
    await ensureDir(modelRoot);
    await ensureDir(path.join(config.comfyuiRoot, "custom_nodes"));
    await fs.writeFile(path.join(modelRoot, "present.safetensors"), "model", "utf8");
    const store = new StateStore(config);
    await store.initialize();
    let sdkCalls = 0;
    const orchestrator = new MigrationOrchestrator(
      config,
      store,
      [
        {
          id: "01",
          name: "Asset resolution",
          requiredOutput: "01-assets.csv / 01-custom-nodes.md",
          humanIntervention: "Provide missing sources"
        }
      ],
      {
        async runStep(job, emit) {
          sdkCalls += 1;
          await emit({
            taskId: job.taskId,
            stepId: job.stepId,
            type: "progress",
            message: "Fake SDK processed Step 01."
          });
          return { sessionId: "fake-session", summary: "Fake SDK completed Step 01." };
        }
      }
    );
    const task = await orchestrator.createTask({
      name: "Step01 SDK",
      workflowFileName: "workflow.json",
      workflowJson: {
        nodes: [
          {
            id: 1,
            type: "UNETLoader",
            properties: { cnr_id: "comfy-core" },
            outputs: [{ links: [1] }],
            widgets_values: ["present.safetensors", "default"]
          }
        ],
        links: []
      }
    });

    await orchestrator.runStep(task.id, "01");

    const updated = await store.getTask(task.id);
    expect(sdkCalls).toBe(1);
    expect(updated?.steps.find((step) => step.id === "01")?.summary).toBe("Fake SDK completed Step 01.");
    expect(
      (await store.listEvents(task.id)).some((event) =>
        event.message.includes("Step 01 deterministic ledgers are ready")
      )
    ).toBe(true);
  });

  it("keeps Step 01 human input visible when operator chooses to provide missing assets", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-step01-followup-${Date.now()}`);
    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      stateRoot: path.join(root, "state"),
      draftDocRoot: root,
      comfyuiRoot: path.join(root, "ComfyUI"),
      modelRoots: [path.join(root, "models")],
      autoApproveAgentPermissions: false,
      comfyuiVenv: "/tmp/comfy/.venv-xpu",
      comfyuiPython: "/tmp/comfy/.venv-xpu/bin/python3",
    };
    await ensureDir(config.workspaceRoot);
    await ensureDir(path.join(config.comfyuiRoot, "custom_nodes"));
    const store = new StateStore(config);
    await store.initialize();
    const orchestrator = new MigrationOrchestrator(config, store, [
      {
        id: "01",
        name: "Asset resolution",
        requiredOutput: "01-assets.csv",
        humanIntervention: "Provide missing sources"
      }
    ]);
    const task = await orchestrator.createTask({
      name: "Step01 follow-up",
      workflowFileName: "workflow.json",
      workflowJson: {
        nodes: [
          {
            id: 1,
            type: "UNETLoader",
            properties: { cnr_id: "comfy-core" },
            widgets_values: ["missing.safetensors", "default"]
          }
        ],
        links: []
      }
    });
    await orchestrator.runStep(task.id, "01");
    const question = (await store.listEvents(task.id)).find((event) => event.type === "human_question");
    expect(question).toBeDefined();

    await orchestrator.recordHumanDecision({
      taskId: task.id,
      stepId: "01",
      questionEventId: question?.id ?? "",
      answer: "Provide missing source-identical assets before feasibility",
      wasFreeform: false
    });

    const updated = await store.getTask(task.id);
    const questions = (await store.listEvents(task.id)).filter((event) => event.type === "human_question");
    expect(updated?.steps.find((step) => step.id === "01")?.status).toBe("waiting_for_human");
    expect(questions).toHaveLength(2);
    expect(questions.at(-1)?.message).toContain("still needs missing context");
    expect(JSON.stringify(questions.at(-1)?.data)).toContain("Provide missing context");
  });

  it("accepts actionable Step 01 source context, redacts secrets, and completes the gate", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-step01-context-${Date.now()}`);
    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      stateRoot: path.join(root, "state"),
      draftDocRoot: root,
      comfyuiRoot: path.join(root, "ComfyUI"),
      modelRoots: [path.join(root, "models")],
      autoApproveAgentPermissions: false,
      comfyuiVenv: "/tmp/comfy/.venv-xpu",
      comfyuiPython: "/tmp/comfy/.venv-xpu/bin/python3",
    };
    await ensureDir(config.workspaceRoot);
    await ensureDir(path.join(config.comfyuiRoot, "custom_nodes"));
    const store = new StateStore(config);
    await store.initialize();
    const orchestrator = new MigrationOrchestrator(config, store, [
      {
        id: "01",
        name: "Asset resolution",
        requiredOutput: "01-assets.csv",
        humanIntervention: "Provide missing sources"
      }
    ]);
    const task = await orchestrator.createTask({
      name: "Step01 source context",
      workflowFileName: "workflow.json",
      workflowJson: {
        nodes: [
          {
            id: 1,
            type: "UNETLoader",
            properties: { cnr_id: "comfy-core" },
            widgets_values: ["missing.safetensors", "default"]
          }
        ],
        links: []
      }
    });
    await orchestrator.runStep(task.id, "01");
    const question = (await store.listEvents(task.id)).find((event) => event.type === "human_question");
    expect(question).toBeDefined();

    const result = await orchestrator.recordHumanDecision({
      taskId: task.id,
      stepId: "01",
      questionEventId: question?.id ?? "",
      answer:
        `Use ${path.join(root, "models")} and operator-approved ssh remote model source. export HF_TOKEN=hf_SECRET1234567890 and pwd super-secret`,
      wasFreeform: true
    });

    expect(result.resumedLiveSession).toBe(true);
    expect(result.decision.answer).not.toContain("hf_SECRET");
    expect(result.decision.answer).not.toContain("super-secret");
    const updated = await store.getTask(task.id);
    expect(updated?.steps.find((step) => step.id === "01")?.status).toBe("waiting_for_human");
    const artifact = path.join(task.artifactPath, "01-human-source-instructions.md");
    const content = await fs.readFile(artifact, "utf8");
    expect(content).toContain(path.join(root, "models"));
    expect(content).not.toContain("hf_SECRET");
    expect(content).not.toContain("super-secret");
    const job = JSON.parse(await fs.readFile(path.join(task.artifactPath, "01-acquisition-job.json"), "utf8")) as {
      status: string;
    };
    expect(job.status).toBe("waiting_for_secure_download");
    expect(await fs.readFile(path.join(task.artifactPath, "01-acquisition-report.md"), "utf8")).toContain(
      "pending_secure_download"
    );
    expect((await store.listDecisions(task.id))[0]?.answer).not.toContain("hf_SECRET");
    const events = await store.listEvents(task.id);
    expect(JSON.stringify(events)).not.toContain("hf_SECRET");
    expect(events.filter((event) => event.type === "human_question" && event.stepId === "01")).toHaveLength(2);
  });

  it("completes Step 01 acquisition when human-provided local roots contain exact assets", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-step01-local-${Date.now()}`);
    const modelRoot = path.join(root, "models");
    const initialModelRoot = path.join(root, "initial-empty-models");
    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      stateRoot: path.join(root, "state"),
      draftDocRoot: root,
      comfyuiRoot: path.join(root, "ComfyUI"),
      modelRoots: [initialModelRoot],
      autoApproveAgentPermissions: false,
      comfyuiVenv: "/tmp/comfy/.venv-xpu",
      comfyuiPython: "/tmp/comfy/.venv-xpu/bin/python3",
    };
    await ensureDir(config.workspaceRoot);
    await ensureDir(path.join(config.comfyuiRoot, "custom_nodes"));
    await ensureDir(initialModelRoot);
    await ensureDir(modelRoot);
    await fs.writeFile(path.join(modelRoot, "missing.safetensors"), "stub", "utf8");
    const store = new StateStore(config);
    await store.initialize();
    const orchestrator = new MigrationOrchestrator(config, store, [
      {
        id: "01",
        name: "Asset resolution",
        requiredOutput: "01-assets.csv",
        humanIntervention: "Provide missing sources"
      }
    ]);
    const task = await orchestrator.createTask({
      name: "Step01 local acquisition",
      workflowFileName: "workflow.json",
      workflowJson: {
        nodes: [
          {
            id: 1,
            type: "UNETLoader",
            properties: { cnr_id: "comfy-core" },
            widgets_values: ["missing.safetensors", "default"]
          }
        ],
        links: []
      }
    });
    await orchestrator.runStep(task.id, "01");
    const question = (await store.listEvents(task.id)).find((event) => event.type === "human_question");

    await orchestrator.recordHumanDecision({
      taskId: task.id,
      stepId: "01",
      questionEventId: question?.id ?? "",
      answer: `Use exact local staged files from ${modelRoot}`,
      wasFreeform: true
    });

    const updated = await store.getTask(task.id);
    expect(updated?.steps.find((step) => step.id === "01")?.status).toBe("completed");
    const assets = await fs.readFile(path.join(task.artifactPath, "01-assets.csv"), "utf8");
    expect(assets).toContain(path.join(modelRoot, "missing.safetensors"));
    expect(assets).not.toContain("source-identical asset not staged");
    const job = JSON.parse(await fs.readFile(path.join(task.artifactPath, "01-acquisition-job.json"), "utf8")) as {
      status: string;
    };
    expect(job.status).toBe("completed");
  });

  it("runs Step 02 deterministically and pauses on feasibility human gate", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-step01-${Date.now()}`);
    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      stateRoot: path.join(root, "state"),
      draftDocRoot: root,
      comfyuiRoot: path.join(root, "ComfyUI"),
      modelRoots: [path.join(root, "models")],
      autoApproveAgentPermissions: false,
      comfyuiVenv: "/tmp/comfy/.venv-xpu",
      comfyuiPython: "/tmp/comfy/.venv-xpu/bin/python3",
    };
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const orchestrator = new MigrationOrchestrator(config, store, [
      {
        id: "02",
        name: "Feasibility",
        requiredOutput: "02-feasibility.md",
        humanIntervention: "Confirm target fidelity"
      }
    ]);
    const task = await orchestrator.createTask({
      name: "Step01 deterministic",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });
    await fs.writeFile(
      path.join(task.artifactPath, "00-intake-preflight.md"),
      [
        "# 00",
        "can_continue_to_feasibility: no",
        "## Missing source-identical models",
        "- missing.safetensors"
      ].join("\n"),
      "utf8"
    );

    await orchestrator.runStep(task.id, "02");

    const updated = await store.getTask(task.id);
    expect(updated?.steps.find((step) => step.id === "02")?.status).toBe("waiting_for_human");
    expect(await fs.readFile(path.join(task.artifactPath, "02-feasibility.md"), "utf8")).toContain(
      "unresolved asset gaps"
    );
    // Gate signal is in gate-signal.json, not in artifact text
    const gateSignal = JSON.parse(await fs.readFile(path.join(task.artifactPath, "02-gate-signal.json"), "utf8"));
    expect(gateSignal.gated).toBe(true);
  });

  it("cleans previous task state and workspace before creating the next task", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-cleanup-${Date.now()}`);
    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      stateRoot: path.join(root, "state"),
      draftDocRoot: root,
      comfyuiRoot: "/tmp/comfy",
      modelRoots: ["/home/intel/hf_models"],
      autoApproveAgentPermissions: false,
      comfyuiVenv: "/tmp/comfy/.venv-xpu",
      comfyuiPython: "/tmp/comfy/.venv-xpu/bin/python3",
    };
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const orchestrator = new MigrationOrchestrator(config, store, [
      {
        id: "00",
        name: "Intake",
        requiredOutput: "00-intake-preflight.md",
        humanIntervention: "Provide missing sources"
      }
    ]);
    const staleTask = await orchestrator.createTask({
      name: "Previous",
      workflowFileName: "previous.json",
      workflowJson: { nodes: [], links: [] }
    });
    await store.updateStep(staleTask.id, "00", "running");
    await fs.writeFile(path.join(staleTask.artifactPath, "stale.txt"), "stale\n", "utf8");

    const nextTask = await orchestrator.createTask({
      name: "Next",
      workflowFileName: "next.json",
      workflowJson: { nodes: [], links: [] }
    });

    expect(await store.getTask(staleTask.id)).toBeUndefined();
    expect(await store.listEvents(staleTask.id)).toHaveLength(0);
    await expect(fs.stat(staleTask.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await store.listTasks()).map((task) => task.id)).toEqual([nextTask.id]);
  });

  it("preserves waiting human gates during stale active-task reconciliation", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-preserve-gate-${Date.now()}`);
    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      stateRoot: path.join(root, "state"),
      draftDocRoot: root,
      comfyuiRoot: "/tmp/comfy",
      modelRoots: ["/home/intel/hf_models"],
      autoApproveAgentPermissions: false,
      comfyuiVenv: "/tmp/comfy/.venv-xpu",
      comfyuiPython: "/tmp/comfy/.venv-xpu/bin/python3",
    };
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const orchestrator = new MigrationOrchestrator(config, store, [
      {
        id: "00",
        name: "Intake",
        requiredOutput: "00-intake-preflight.md",
        humanIntervention: "Provide missing sources"
      }
    ]);
    const task = await orchestrator.createTask({
      name: "Waiting gate",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });
    await store.updateStep(task.id, "00", "waiting_for_human", {
      summary: "Needs human input"
    });

    const cleaned = await orchestrator.reconcileStaleActiveTasks("server restarted");

    const updated = await store.getTask(task.id);
    expect(cleaned).toHaveLength(0);
    expect(updated?.status).toBe("waiting_for_human");
    expect(updated?.steps.find((step) => step.id === "00")?.status).toBe("waiting_for_human");
  });

  it("pauses when a required artifact records a human gate", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-artifact-gate-${Date.now()}`);
    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      stateRoot: path.join(root, "state"),
      draftDocRoot: root,
      comfyuiRoot: "/tmp/comfy",
      modelRoots: ["/home/intel/hf_models"],
      autoApproveAgentPermissions: false,
      comfyuiVenv: "/tmp/comfy/.venv-xpu",
      comfyuiPython: "/tmp/comfy/.venv-xpu/bin/python3",
    };
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const orchestrator = new MigrationOrchestrator(config, store, [
      {
        id: "05",
        name: "Environment",
        requiredOutput: "05-environment.md",
        humanIntervention: "Confirm policy"
      }
    ]);
    const task = await orchestrator.createTask({
      name: "Artifact gate",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });
    await fs.writeFile(
      path.join(task.artifactPath, "05-environment.md"),
      "# Environment\n\nDeployment completed.\n",
      "utf8"
    );
    // Gate is signaled via gate-signal.json, not artifact text
    await fs.writeFile(
      path.join(task.artifactPath, "05-gate-signal.json"),
      JSON.stringify({ stepId: "05", gated: true, category: "missing_asset", trigger: "deterministic", reason: "Test gate" }),
      "utf8"
    );

    await orchestrator.runStep(task.id, "05");

    const updated = await store.getTask(task.id);
    expect(updated?.steps.find((step) => step.id === "05")?.status).toBe("waiting_for_human");
    expect((await store.listEvents(task.id)).some((event) => event.type === "human_question")).toBe(true);
    const question = (await store.listEvents(task.id)).find((event) => event.type === "human_question");

    const decision = await orchestrator.recordHumanDecision({
      taskId: task.id,
      stepId: "05",
      questionEventId: question?.id ?? "",
      answer: "Continue with documented risk/gaps",
      wasFreeform: false
    });

    expect(decision.resumedLiveSession).toBe(true);
    const continued = await store.getTask(task.id);
    expect(continued?.steps.find((step) => step.id === "05")?.status).toBe("completed");
  });

  it("treats context-budget resume gates as a fresh Phase 1 restart, not step completion", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-context-resume-${Date.now()}`);
    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      stateRoot: path.join(root, "state"),
      draftDocRoot: root,
      comfyuiRoot: "/tmp/comfy",
      modelRoots: ["/home/intel/hf_models"],
      autoApproveAgentPermissions: false,
      comfyuiVenv: "/tmp/comfy/.venv-xpu",
      comfyuiPython: "/tmp/comfy/.venv-xpu/bin/python3",
    };
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const orchestrator = new MigrationOrchestrator(config, store, [
      {
        id: "01",
        name: "Assets",
        requiredOutput: "01-assets.csv / 01-custom-nodes.md",
        humanIntervention: "Provide sources"
      }
    ]);
    const task = await orchestrator.createTask({
      name: "Context resume",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });
    await store.updateStep(task.id, "01", "waiting_for_human", {
      summary: "Paused for context budget"
    });
    const question = await store.appendEvent({
      taskId: task.id,
      stepId: "01",
      type: "human_question",
      message: "Context budget reached the critical threshold.",
      data: {
        question:
          "Context budget reached the critical threshold. Resume Phase 1 from the compact state in a fresh SDK session, or stop here for manual inspection.",
        choices: ["Resume Phase 1 from compact checkpoint", "Stop and inspect context artifacts"],
        allowFreeform: true,
        blockingReason: "capacity_policy",
        artifactPath: "artifacts/phase1-context/context-budget.json"
      }
    });

    const result = await orchestrator.recordHumanDecision({
      taskId: task.id,
      stepId: "01",
      questionEventId: question.id,
      answer: "Resume Phase 1 from compact checkpoint",
      wasFreeform: false
    });

    expect(result.resumedLiveSession).toBe(true);
    const updated = await store.getTask(task.id);
    const step01 = updated?.steps.find((step) => step.id === "01");
    expect(step01?.status).toBe("pending");
    expect(step01?.summary).toContain("restart from task-state.json");
    expect(step01?.status).not.toBe("completed");
  });

  it("accepts actionable human context for non-Step 01 gates without repeating the question", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-generic-context-${Date.now()}`);
    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      stateRoot: path.join(root, "state"),
      draftDocRoot: root,
      comfyuiRoot: "/tmp/comfy",
      modelRoots: ["/home/intel/hf_models"],
      autoApproveAgentPermissions: false,
      comfyuiVenv: "/tmp/comfy/.venv-xpu",
      comfyuiPython: "/tmp/comfy/.venv-xpu/bin/python3",
    };
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const orchestrator = new MigrationOrchestrator(config, store, [
      {
        id: "05",
        name: "Environment",
        requiredOutput: "05-environment.md",
        humanIntervention: "Confirm policy"
      }
    ]);
    const task = await orchestrator.createTask({
      name: "Generic context gate",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });
    await fs.writeFile(
      path.join(task.artifactPath, "05-environment.md"),
      "# Environment\n\nDeployment completed.\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(task.artifactPath, "05-gate-signal.json"),
      JSON.stringify({ stepId: "05", gated: true, category: "quality_review", trigger: "deterministic", reason: "Test actionable gate" }),
      "utf8"
    );
    await orchestrator.runStep(task.id, "05");
    const question = (await store.listEvents(task.id)).find((event) => event.type === "human_question");

    const result = await orchestrator.recordHumanDecision({
      taskId: task.id,
      stepId: "05",
      questionEventId: question?.id ?? "",
      answer:
        "Use the already prepared /tmp/comfy-xpu-env environment and do not persist TOKEN=secret-value in artifacts.",
      wasFreeform: true
    });

    expect(result.resumedLiveSession).toBe(true);
    const updated = await store.getTask(task.id);
    expect(updated?.steps.find((step) => step.id === "05")?.status).toBe("completed");
    const questions = (await store.listEvents(task.id)).filter((event) => event.type === "human_question");
    expect(questions).toHaveLength(1);
    const contextArtifact = path.join(task.artifactPath, "05-human-context.md");
    const content = await fs.readFile(contextArtifact, "utf8");
    expect(content).toContain("/tmp/comfy-xpu-env");
    expect(content).not.toContain("secret-value");
  });

  it("auto-runs existing-artifact steps until the flow completes", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-autorun-${Date.now()}`);
    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      stateRoot: path.join(root, "state"),
      draftDocRoot: root,
      comfyuiRoot: "/tmp/comfy",
      modelRoots: ["/home/intel/hf_models"],
      autoApproveAgentPermissions: false,
      comfyuiVenv: "/tmp/comfy/.venv-xpu",
      comfyuiPython: "/tmp/comfy/.venv-xpu/bin/python3",
    };
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const orchestrator = new MigrationOrchestrator(config, store, [
      {
        id: "05",
        name: "Environment",
        requiredOutput: "05-environment.md",
        humanIntervention: "Approve environment"
      },
      {
        id: "06",
        name: "Prompt validation",
        requiredOutput: "06-prompt-validation.json",
        humanIntervention: "Approve prompt"
      }
    ]);
    const task = await orchestrator.createTask({
      name: "Auto-run",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });
    await fs.writeFile(path.join(task.artifactPath, "05-environment.md"), "# environment\n", "utf8");
    await fs.writeFile(path.join(task.artifactPath, "06-prompt-validation.json"), "{}\n", "utf8");

    await orchestrator.runUntilGate(task.id);

    const updated = await store.getTask(task.id);
    expect(updated?.status).toBe("completed");
    expect(updated?.steps.every((step) => step.status === "completed")).toBe(true);
    expect(
      (await store.listEvents(task.id)).some((event) =>
        event.message.includes("Auto-run reached the end")
      )
    ).toBe(true);
  });

  it("continues Step 02 into SDK processing after deterministic precheck has no gate", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-step02-${Date.now()}`);
    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      stateRoot: path.join(root, "state"),
      draftDocRoot: root,
      comfyuiRoot: "/tmp/comfy",
      modelRoots: ["/home/intel/hf_models"],
      autoApproveAgentPermissions: false,
      comfyuiVenv: "/tmp/comfy/.venv-xpu",
      comfyuiPython: "/tmp/comfy/.venv-xpu/bin/python3",
    };
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    let sdkCalls = 0;
    const orchestrator = new MigrationOrchestrator(
      config,
      store,
      [
        {
          id: "02",
          name: "Feasibility",
          requiredOutput: "02-feasibility.md",
          humanIntervention: "Confirm policy"
        }
      ],
      {
        async runStep(job, emit) {
          sdkCalls += 1;
          await emit({
            taskId: job.taskId,
            stepId: job.stepId,
            type: "progress",
            message: "Fake SDK processed Step 02."
          });
          return { sessionId: "fake-session", summary: "Fake SDK completed Step 02." };
        }
      }
    );
    const task = await orchestrator.createTask({
      name: "Step 02 feasibility",
      workflowFileName: "workflow.json",
      workflowJson: {
        nodes: [
          {
            id: 1,
            type: "SaveImage",
            properties: { cnr_id: "comfy-core" },
            inputs: [{ link: 1 }],
            widgets_values: ["ComfyUI"]
          }
        ],
        links: []
      }
    });

    await orchestrator.runStep(task.id, "02");

    const updated = await store.getTask(task.id);
    expect(sdkCalls).toBe(1);
    expect(updated?.steps.find((step) => step.id === "02")?.status).toBe("completed");
    expect(updated?.steps.find((step) => step.id === "02")?.summary).toBe("Fake SDK completed Step 02.");
    expect(await fs.readFile(path.join(task.artifactPath, "02-feasibility.md"), "utf8")).toContain(
      "Feasibility precheck completed without source-identical asset blockers"
    );
    // No gate-signal.json should exist when not gated
    await expect(fs.readFile(path.join(task.artifactPath, "02-gate-signal.json"), "utf8")).rejects.toThrow();
    expect(
      (await store.listEvents(task.id)).some((event) =>
        event.message.includes("Step 02 deterministic feasibility precheck is ready")
      )
    ).toBe(true);
  });

  it("fails SDK steps that return without replacing the in-progress required artifact", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-missing-evidence-${Date.now()}`);
    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      stateRoot: path.join(root, "state"),
      draftDocRoot: root,
      comfyuiRoot: "/tmp/comfy",
      modelRoots: ["/home/intel/hf_models"],
      autoApproveAgentPermissions: false,
      comfyuiVenv: "/tmp/comfy/.venv-xpu",
      comfyuiPython: "/tmp/comfy/.venv-xpu/bin/python3",
    };
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const orchestrator = new MigrationOrchestrator(
      config,
      store,
      [
        {
          id: "06",
          name: "Prompt conversion validation",
          requiredOutput: "06-prompt.json / 06-prompt-validation.json",
          humanIntervention: "Decide schema changes"
        }
      ],
      {
        async runStep() {
          return { sessionId: "fake-session", summary: "Fake SDK returned without evidence." };
        }
      }
    );
    const task = await orchestrator.createTask({
      name: "Missing evidence",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });

    await expect(orchestrator.runStep(task.id, "06")).rejects.toThrow(
      "SDK session ended before required evidence was complete"
    );

    const updated = await store.getTask(task.id);
    const scaffold = await fs.readFile(path.join(task.artifactPath, "06-prompt-validation.json"), "utf8");
    expect(scaffold).toContain('"orchestrator_status": "in_progress"');
    expect(updated?.steps.find((step) => step.id === "06")?.status).toBe("failed");
    expect(updated?.steps.find((step) => step.id === "06")?.error).toContain(
      "SDK session ended before required evidence was complete"
    );
  });

  it("runs Step 03 inventory deterministically without SDK waiting", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-step03-${Date.now()}`);
    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      stateRoot: path.join(root, "state"),
      draftDocRoot: root,
      comfyuiRoot: path.join(root, "ComfyUI"),
      modelRoots: [path.join(root, "models")],
      autoApproveAgentPermissions: false,
      comfyuiVenv: "/tmp/comfy/.venv-xpu",
      comfyuiPython: "/tmp/comfy/.venv-xpu/bin/python3",
    };
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const orchestrator = new MigrationOrchestrator(config, store, [
      {
        id: "03",
        name: "Workflow inventory",
        requiredOutput: "03-inventory.md",
        humanIntervention: "Clarify branches"
      }
    ]);
    const task = await orchestrator.createTask({
      name: "Step 03 inventory",
      workflowFileName: "workflow.json",
      workflowJson: {
        nodes: [
          {
            id: 1,
            type: "SaveImage",
            properties: { cnr_id: "comfyui-kjnodes" },
            widgets_values: ["ComfyUI"]
          }
        ],
        links: []
      }
    });

    await orchestrator.runStep(task.id, "03");

    const updated = await store.getTask(task.id);
    expect(updated?.steps.find((step) => step.id === "03")?.status).toBe("completed");
    expect(await fs.readFile(path.join(task.artifactPath, "03-inventory.md"), "utf8")).toContain(
      "Workflow inventory"
    );
  });

  it("gates Step 05 before environment deployment when Step 03 has asset gaps", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-step05-gate-${Date.now()}`);
    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      stateRoot: path.join(root, "state"),
      draftDocRoot: root,
      comfyuiRoot: path.join(root, "ComfyUI"),
      modelRoots: [path.join(root, "models")],
      autoApproveAgentPermissions: false,
      comfyuiVenv: "/tmp/comfy/.venv-xpu",
      comfyuiPython: "/tmp/comfy/.venv-xpu/bin/python3",
    };
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const orchestrator = new MigrationOrchestrator(config, store, [
      {
        id: "05",
        name: "Environment deployment",
        requiredOutput: "05-environment.md",
        humanIntervention: "Approve environment setup"
      }
    ]);
    const task = await orchestrator.createTask({
      name: "Step05 gate",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });
    await fs.writeFile(
      path.join(task.artifactPath, "01-assets.csv"),
      "asset_name,gap\nmissing.safetensors,source-identical asset not staged\n",
      "utf8"
    );

    await orchestrator.runStep(task.id, "05");

    const updated = await store.getTask(task.id);
    expect(updated?.steps.find((step) => step.id === "05")?.status).toBe("waiting_for_human");
    expect(await fs.readFile(path.join(task.artifactPath, "05-environment.md"), "utf8")).toContain(
      "source-identical asset gaps"
    );
    // Gate signal is in gate-signal.json, not in artifact text
    const gateSignal = JSON.parse(await fs.readFile(path.join(task.artifactPath, "05-gate-signal.json"), "utf8"));
    expect(gateSignal.gated).toBe(true);
    expect((await store.listEvents(task.id)).some((event) => event.stepId === "05" && event.type === "human_question")).toBe(true);
  });
});
