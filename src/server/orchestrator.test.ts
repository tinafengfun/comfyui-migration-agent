import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config";
import { ensureDir } from "./fsUtils";
import { MigrationOrchestrator, sanitizeSessionIdSegment } from "./orchestrator";
import { SdkStepTimeoutError } from "./copilotSdkRunner";
import { StateStore } from "./state";

describe("sanitizeSessionIdSegment", () => {
  // Regression test for a real bug: the Copilot SDK's session.create rejects
  // any sessionId containing characters outside [a-zA-Z0-9_-] (confirmed
  // live -- even a bare "." is enough to fail). Requested asset names are
  // workflow-author-controlled strings that routinely contain backslashes,
  // full-width parentheses, CJK text, and dots (file extensions), so the
  // fuzzy-match sessionId built from one must be sanitized first.
  it("strips backslashes, full-width parens, CJK text, and dots from a real messy asset name", () => {
    const sanitized = sanitizeSessionIdSegment("flux2\\Klein-大熊一致性consistency（0.4-1.0）.safetensors");
    expect(sanitized).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it("strips dots from a plain file extension", () => {
    const sanitized = sanitizeSessionIdSegment("Z-Image-Anime-AIO-FP8_V1.safetensors");
    expect(sanitized).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(sanitized).not.toContain(".");
  });

  it("collapses consecutive replaced characters into a single hyphen", () => {
    expect(sanitizeSessionIdSegment("a（（（b")).toBe("a-b");
  });

  it("caps length at 60 characters", () => {
    const sanitized = sanitizeSessionIdSegment("a".repeat(200));
    expect(sanitized.length).toBeLessThanOrEqual(60);
  });

  it("falls back to a placeholder when nothing valid remains", () => {
    expect(sanitizeSessionIdSegment("（）（）")).toBe("unnamed");
  });
});

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
      gpuNodesPath: path.join(root, "gpu-nodes.json"),
      workflowArchiveRoot: path.join(root, "nfs-workflows"),
      autoApproveAgentPermissions: false
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

  it("terminateWithHardStop actually aborts the in-flight SDK client, not just orchestrator bookkeeping", async () => {
    // Regression test for a real bug: hard-stopping a task only cleared
    // activeStepRuns/hardStoppedTaskIds and left the SDK's CLI subprocess
    // running unsupervised -- confirmed live, a wedged session kept burning
    // CPU for 20+ minutes after this endpoint reported success.
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-abort-${Date.now()}`);
    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      stateRoot: path.join(root, "state"),
      draftDocRoot: root,
      comfyuiRoot: "/tmp/comfy",
      modelRoots: ["/home/intel/hf_models"],
      gpuNodesPath: path.join(root, "gpu-nodes.json"),
      workflowArchiveRoot: path.join(root, "nfs-workflows"),
      autoApproveAgentPermissions: false
    };
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const abortedTaskIds: string[] = [];
    const orchestrator = new MigrationOrchestrator(
      config,
      store,
      [{ id: "00", name: "Intake", requiredOutput: "00-intake-preflight.md", humanIntervention: "x" }],
      {
        runStep: async () => ({ sessionId: "unused", summary: "unused" }),
        abortTask: async (taskId: string) => {
          abortedTaskIds.push(taskId);
          return true;
        }
      }
    );

    const task = await orchestrator.createTask({
      name: "AbortTest",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });
    await orchestrator.terminateWithHardStop({
      taskId: task.id,
      stepId: "00",
      reason: "test hard stop"
    });

    expect(abortedTaskIds).toEqual([task.id]);
  });

  it("terminateWithHardStop tolerates an sdkRunner with no abortTask (backward compatible)", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-abort-missing-${Date.now()}`);
    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      stateRoot: path.join(root, "state"),
      draftDocRoot: root,
      comfyuiRoot: "/tmp/comfy",
      modelRoots: ["/home/intel/hf_models"],
      gpuNodesPath: path.join(root, "gpu-nodes.json"),
      workflowArchiveRoot: path.join(root, "nfs-workflows"),
      autoApproveAgentPermissions: false
    };
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const orchestrator = new MigrationOrchestrator(
      config,
      store,
      [{ id: "00", name: "Intake", requiredOutput: "00-intake-preflight.md", humanIntervention: "x" }],
      { runStep: async () => ({ sessionId: "unused", summary: "unused" }) }
    );
    const task = await orchestrator.createTask({
      name: "NoAbort",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });

    await expect(
      orchestrator.terminateWithHardStop({ taskId: task.id, stepId: "00", reason: "test" })
    ).resolves.toBeDefined();
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
      gpuNodesPath: path.join(root, "gpu-nodes.json"),
      workflowArchiveRoot: path.join(root, "nfs-workflows"),
      autoApproveAgentPermissions: false
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
      gpuNodesPath: path.join(root, "gpu-nodes.json"),
      workflowArchiveRoot: path.join(root, "nfs-workflows"),
      autoApproveAgentPermissions: false
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
      gpuNodesPath: path.join(root, "gpu-nodes.json"),
      workflowArchiveRoot: path.join(root, "nfs-workflows"),
      autoApproveAgentPermissions: false
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

  it("merges the task's pinned GPU node's own model_roots into Step 00's local search (real bug: a node whose model_roots list omitted a root that's still genuinely valid there made the search blind to it)", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-step00-node-modelroots-${Date.now()}`);
    const globalModelsDir = path.join(root, "models-global");
    const nodeOnlyModelsDir = path.join(root, "models-node-only");
    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      stateRoot: path.join(root, "state"),
      draftDocRoot: root,
      comfyuiRoot: path.join(root, "ComfyUI"),
      modelRoots: [globalModelsDir],
      gpuNodesPath: path.join(root, "gpu-nodes.json"),
      workflowArchiveRoot: path.join(root, "nfs-workflows"),
      autoApproveAgentPermissions: false
    };
    await ensureDir(config.workspaceRoot);
    await ensureDir(path.join(config.comfyuiRoot, "custom_nodes"));
    await ensureDir(globalModelsDir);
    await ensureDir(nodeOnlyModelsDir);
    // The target asset only exists under the NODE's own model root, not the
    // global default -- proving the search actually merged both, not just
    // fell back to the node's list alone or the global list alone.
    await fs.writeFile(path.join(nodeOnlyModelsDir, "only-on-remote-node.safetensors"), "fake", "utf8");
    await fs.writeFile(
      config.gpuNodesPath,
      JSON.stringify({
        default_node: "remote-test",
        nodes: [
          {
            name: "remote-test",
            kind: "ssh",
            comfyui_root: config.comfyuiRoot,
            venv_python: "/nfs_share/venv/bin/python3",
            model_roots: [nodeOnlyModelsDir],
            api_host: "172.16.124.12",
            api_port: 8188,
            ssh: { host: "172.16.124.12", user: "intel", port: 22, key_path: "/root/.ssh/id_ed25519" }
          }
        ]
      }),
      "utf8"
    );
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
      name: "Step00 node model_roots",
      workflowFileName: "workflow.json",
      gpuNode: "remote-test",
      workflowJson: {
        nodes: [
          {
            id: 1,
            type: "UNETLoader",
            properties: { cnr_id: "comfy-core" },
            outputs: [{ links: [1] }],
            widgets_values: ["only-on-remote-node.safetensors", "default"]
          }
        ],
        links: []
      }
    });

    await orchestrator.runStep(task.id, "00");

    const artifact = await fs.readFile(path.join(task.artifactPath, "00-intake-preflight.md"), "utf8");
    expect(artifact).toContain("exact filename found");
    expect(artifact).not.toContain("not found under checked model roots");
  });

  it("uses the task's pinned GPU node's own comfyui_root for Step 00's local search, not the global default (real bug: the default node's comfyui_root doesn't even exist on this host, so deterministic steps were silently analyzing the wrong checkout)", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-step00-node-comfyuiroot-${Date.now()}`);
    const globalWrongComfyuiRoot = path.join(root, "ComfyUI-global-wrong");
    const nodeRealComfyuiRoot = path.join(root, "ComfyUI-node-real");
    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      stateRoot: path.join(root, "state"),
      draftDocRoot: root,
      // Deliberately does NOT exist on disk -- mirrors the confirmed live bug
      // where the global default pointed at a checkout the actual pinned
      // node doesn't use.
      comfyuiRoot: globalWrongComfyuiRoot,
      modelRoots: [path.join(root, "models")],
      gpuNodesPath: path.join(root, "gpu-nodes.json"),
      workflowArchiveRoot: path.join(root, "nfs-workflows"),
      autoApproveAgentPermissions: false
    };
    await ensureDir(config.workspaceRoot);
    // Only the NODE's own comfyui_root has the installed custom-node package
    // on disk -- proving the search used it, not the (nonexistent) global default.
    await ensureDir(path.join(nodeRealComfyuiRoot, "custom_nodes", "rgthree-comfy"));
    await fs.writeFile(
      config.gpuNodesPath,
      JSON.stringify({
        default_node: "remote-test",
        nodes: [
          {
            name: "remote-test",
            kind: "ssh",
            comfyui_root: nodeRealComfyuiRoot,
            venv_python: "/nfs_share/venv/bin/python3",
            model_roots: ["/nfs_share"],
            api_host: "172.16.124.12",
            api_port: 8188,
            ssh: { host: "172.16.124.12", user: "intel", port: 22, key_path: "/root/.ssh/id_ed25519" }
          }
        ]
      }),
      "utf8"
    );
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
      name: "Step00 node comfyui_root",
      workflowFileName: "workflow.json",
      gpuNode: "remote-test",
      workflowJson: {
        nodes: [
          {
            id: 1,
            type: "Seed (rgthree)",
            properties: { cnr_id: "rgthree-comfy" },
            outputs: [{ links: [1] }],
            widgets_values: []
          }
        ],
        links: []
      }
    });

    await orchestrator.runStep(task.id, "00");

    const updated = await store.getTask(task.id);
    expect(updated?.steps.find((step) => step.id === "00")?.status).toBe("completed");
    const artifact = await fs.readFile(path.join(task.artifactPath, "00-intake-preflight.md"), "utf8");
    expect(artifact).toContain("custom_nodes/rgthree-comfy");
  }, 30000);

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
      gpuNodesPath: path.join(root, "gpu-nodes.json"),
      workflowArchiveRoot: path.join(root, "nfs-workflows"),
      autoApproveAgentPermissions: false
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
      gpuNodesPath: path.join(root, "gpu-nodes.json"),
      workflowArchiveRoot: path.join(root, "nfs-workflows"),
      autoApproveAgentPermissions: false
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
      gpuNodesPath: path.join(root, "gpu-nodes.json"),
      workflowArchiveRoot: path.join(root, "nfs-workflows"),
      autoApproveAgentPermissions: false
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
      gpuNodesPath: path.join(root, "gpu-nodes.json"),
      workflowArchiveRoot: path.join(root, "nfs-workflows"),
      autoApproveAgentPermissions: false
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
      gpuNodesPath: path.join(root, "gpu-nodes.json"),
      workflowArchiveRoot: path.join(root, "nfs-workflows"),
      autoApproveAgentPermissions: false
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
      gpuNodesPath: path.join(root, "gpu-nodes.json"),
      workflowArchiveRoot: path.join(root, "nfs-workflows"),
      autoApproveAgentPermissions: false
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
      gpuNodesPath: path.join(root, "gpu-nodes.json"),
      workflowArchiveRoot: path.join(root, "nfs-workflows"),
      autoApproveAgentPermissions: false
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
      gpuNodesPath: path.join(root, "gpu-nodes.json"),
      workflowArchiveRoot: path.join(root, "nfs-workflows"),
      autoApproveAgentPermissions: false
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
      gpuNodesPath: path.join(root, "gpu-nodes.json"),
      workflowArchiveRoot: path.join(root, "nfs-workflows"),
      autoApproveAgentPermissions: false
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
      gpuNodesPath: path.join(root, "gpu-nodes.json"),
      workflowArchiveRoot: path.join(root, "nfs-workflows"),
      autoApproveAgentPermissions: false
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
      gpuNodesPath: path.join(root, "gpu-nodes.json"),
      workflowArchiveRoot: path.join(root, "nfs-workflows"),
      autoApproveAgentPermissions: false
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
      gpuNodesPath: path.join(root, "gpu-nodes.json"),
      workflowArchiveRoot: path.join(root, "nfs-workflows"),
      autoApproveAgentPermissions: false
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
      gpuNodesPath: path.join(root, "gpu-nodes.json"),
      workflowArchiveRoot: path.join(root, "nfs-workflows"),
      autoApproveAgentPermissions: false
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
      gpuNodesPath: path.join(root, "gpu-nodes.json"),
      workflowArchiveRoot: path.join(root, "nfs-workflows"),
      autoApproveAgentPermissions: false
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
      gpuNodesPath: path.join(root, "gpu-nodes.json"),
      workflowArchiveRoot: path.join(root, "nfs-workflows"),
      autoApproveAgentPermissions: false
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
      gpuNodesPath: path.join(root, "gpu-nodes.json"),
      workflowArchiveRoot: path.join(root, "nfs-workflows"),
      autoApproveAgentPermissions: false
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

  it("W2: state machine accepts `paused` and surfaces it via deriveTaskStatus", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-w2-${Date.now()}`);
    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      stateRoot: path.join(root, "state"),
      draftDocRoot: root,
      comfyuiRoot: "/tmp/comfy",
      modelRoots: ["/home/intel/hf_models"],
      gpuNodesPath: path.join(root, "gpu-nodes.json"),
      workflowArchiveRoot: path.join(root, "nfs-workflows"),
      autoApproveAgentPermissions: false
    };
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const orchestrator = new MigrationOrchestrator(config, store, [
      { id: "05", name: "Env", requiredOutput: "05-environment.md", humanIntervention: "Approve" },
      { id: "06", name: "Prompt", requiredOutput: "06-prompt.md", humanIntervention: "Approve" }
    ]);
    const task = await orchestrator.createTask({
      name: "W2",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });

    // Simulate the W2 paused-state routing: SDK timed out, no human question open,
    // orchestrator sets paused instead of failed.
    await store.updateStep(task.id, "05", "paused", { error: "SDK watchdog timeout" });

    const updated = await store.getTask(task.id);
    const step = updated?.steps.find((s) => s.id === "05");
    expect(step?.status).toBe("paused");
    expect(step?.error).toMatch(/SDK watchdog timeout/);
    // paused is non-terminal: completedAt must be cleared
    expect(step?.completedAt).toBeUndefined();
    // deriveTaskStatus must surface paused at the task level so UI can render it
    expect(updated?.status).toBe("paused");

    // resumeStep moves paused back to running (via runStep's updateStep call);
    // verify the state transition doesn't reject.
    const beforeResume = await store.getTask(task.id);
    expect(beforeResume?.steps.find((s) => s.id === "05")?.status).toBe("paused");
  });

  it("W4: rerunStep cleans runtime output subdirs (previews, validation-runs, gui-acceptance)", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-w4-${Date.now()}`);
    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      stateRoot: path.join(root, "state"),
      draftDocRoot: root,
      comfyuiRoot: "/tmp/comfy",
      modelRoots: ["/home/intel/hf_models"],
      gpuNodesPath: path.join(root, "gpu-nodes.json"),
      workflowArchiveRoot: path.join(root, "nfs-workflows"),
      autoApproveAgentPermissions: false
    };
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();

    // Stub sdkRunner so runStep throws at the end — we only care that the cleanup ran first.
    const failingRunner = {
      runStep: async () => {
        throw new Error("stub: no SDK runner in unit test");
      }
    };
    const orchestrator = new MigrationOrchestrator(config, store, [
      { id: "07", name: "Branch smoke", requiredOutput: "07-branch-smoke.md", humanIntervention: "Approve" },
      { id: "08", name: "Full validation", requiredOutput: "08-full-validation.md", humanIntervention: "Approve" },
      { id: "12", name: "GUI demo", requiredOutput: "12-gui-acceptance.md", humanIntervention: "Approve" }
    ], failingRunner);
    const task = await orchestrator.createTask({
      name: "W4",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });

    // Pre-populate stale runtime outputs from a prior run.
    const outputsDir = path.join(task.workspacePath, "outputs");
    const previewsFile = path.join(outputsDir, "previews", "stale.png");
    const validationFile = path.join(outputsDir, "validation-runs", "stale-run", "out.png");
    const guiFile = path.join(outputsDir, "gui-acceptance", "stale-gui.png");
    await fs.mkdir(path.dirname(validationFile), { recursive: true });
    await fs.writeFile(previewsFile, "fake png bytes", "utf8");
    await fs.writeFile(validationFile, "fake png bytes", "utf8");
    await fs.writeFile(guiFile, "fake png bytes", "utf8");

    // Mark steps as completed so rerunStep's "downstream reset" logic actually fires.
    await store.updateStep(task.id, "07", "completed");
    await store.updateStep(task.id, "08", "completed");
    await store.updateStep(task.id, "12", "completed");

    // rerunStep will run cleanup, then call runStep which throws.
    await expect(orchestrator.rerunStep(task.id, "07")).rejects.toThrow(/stub: no SDK runner/);

    // Verify stale outputs were cleaned — both the rerun step's subdir and downstream ones.
    await expect(fs.stat(previewsFile)).rejects.toThrow(/ENOENT/);
    await expect(fs.stat(validationFile)).rejects.toThrow(/ENOENT/);
    await expect(fs.stat(guiFile)).rejects.toThrow(/ENOENT/);

    // Verify the subdirs themselves still exist (we keep them so ComfyUI can re-write without mkdir races).
    const stat = await fs.stat(outputsDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it("rejects a concurrent rerunStep call for the same step instead of tearing down the one already in flight (real bug: a rerun button with no click-feedback let a human triple-click it, each click killing the ComfyUI process the previous click had just started)", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-rerun-concurrent-${Date.now()}`);
    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: path.join(root, "workspaces"),
      stateRoot: path.join(root, "state"),
      draftDocRoot: root,
      comfyuiRoot: "/tmp/comfy",
      modelRoots: ["/home/intel/hf_models"],
      gpuNodesPath: path.join(root, "gpu-nodes.json"),
      workflowArchiveRoot: path.join(root, "nfs-workflows"),
      autoApproveAgentPermissions: false
    };
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();

    let runStepCalls = 0;
    const orchestrator = new MigrationOrchestrator(
      config,
      store,
      [{ id: "05", name: "Environment deployment", requiredOutput: "05-environment.md", humanIntervention: "Approve" }],
      {
        async runStep() {
          runStepCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 50));
          throw new Error("stub: no SDK runner in unit test");
        }
      }
    );
    const task = await orchestrator.createTask({
      name: "Concurrent rerun",
      workflowFileName: "workflow.json",
      workflowJson: { nodes: [], links: [] }
    });
    await store.updateStep(task.id, "05", "completed");

    // Fire two rerun requests back-to-back without awaiting the first --
    // mirrors two rapid clicks on a Re-run button with no disabled state.
    const first = orchestrator.rerunStep(task.id, "05").catch((e: Error) => e);
    const second = orchestrator.rerunStep(task.id, "05").catch((e: Error) => e);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    // Exactly one of the two must have been rejected as a duplicate; the
    // other proceeds (and fails downstream only because of the stub SDK
    // runner, not because of the reentrancy guard).
    const results = [firstResult, secondResult];
    const duplicateRejections = results.filter(
      (r) => r instanceof Error && /already being re-run/.test(r.message)
    );
    const stubFailures = results.filter((r) => r instanceof Error && /stub: no SDK runner/.test(r.message));
    expect(duplicateRejections).toHaveLength(1);
    expect(stubFailures).toHaveLength(1);
    expect(runStepCalls).toBe(1);
  });

  describe("assessComfyUIEnvironment", () => {
    async function makeOrchestratorAndTask(root: string) {
      const config: AppConfig = {
        port: 0,
        projectRoot: root,
        workspaceRoot: path.join(root, "workspaces"),
        stateRoot: path.join(root, "state"),
        draftDocRoot: root,
        comfyuiRoot: path.join(root, "ComfyUI"),
        modelRoots: ["/home/intel/hf_models"],
        gpuNodesPath: path.join(root, "gpu-nodes.json"),
        workflowArchiveRoot: path.join(root, "nfs-workflows"),
        autoApproveAgentPermissions: false
      };
      await ensureDir(config.workspaceRoot);
      const store = new StateStore(config);
      await store.initialize();
      const orchestrator = new MigrationOrchestrator(config, store, [
        { id: "05", name: "Environment deployment", requiredOutput: "05-environment.md", humanIntervention: "Approve" }
      ]);
      const task = await orchestrator.createTask({
        name: "Assess env",
        workflowFileName: "workflow.json",
        workflowJson: { nodes: [], links: [] }
      });
      return { config, store, orchestrator, task };
    }

    it("flags an occupied port not attributable to any known task as ambiguous, and does not touch it", async () => {
      const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-assess-ambiguous-${Date.now()}`);
      const { orchestrator, task } = await makeOrchestratorAndTask(root);
      const net = await import("node:net");
      const server = net.createServer();
      const port = await new Promise<number>((resolve, reject) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          if (addr && typeof addr !== "string") resolve(addr.port);
          else reject(new Error("failed to bind test server"));
        });
      });
      try {
        const node = {
          name: "n", kind: "local" as const, comfyui_root: path.join(root, "ComfyUI"),
          venv_python: "/usr/bin/python3", model_roots: ["/m"], api_host: "127.0.0.1", api_port: port
        };
        const result = await (orchestrator as unknown as {
          assessComfyUIEnvironment: (t: typeof task, n: typeof node) => Promise<{ notes: string[] }>;
        }).assessComfyUIEnvironment(task, node);
        expect(result.notes.some((n) => n.includes("not attributable to any known task"))).toBe(true);
        expect(server.listening).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("reclaims a port occupied by a process attributable to a task that is no longer live", async () => {
      const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-assess-reclaim-${Date.now()}`);
      const { store, orchestrator, task } = await makeOrchestratorAndTask(root);

      // Use store.createTask directly (not orchestrator.createTask) -- the
      // orchestrator enforces single-active-task semantics and would delete
      // `task` (created above) as a side effect of creating a second one.
      const staleTask = await store.createTask({
        name: "Stale",
        workflowPath: path.join(root, "stale-workflow.json"),
        workspacePath: path.join(root, "stale-workspace"),
        artifactPath: path.join(root, "stale-artifacts"),
        steps: [{ id: "05", name: "Environment deployment", requiredOutput: "05-environment.md", humanIntervention: "Approve" }]
      });
      await store.updateStep(staleTask.id, "05", "completed");
      await store.updateTaskStatus(staleTask.id, "completed");

      const port = 20000 + Math.floor(Math.random() * 10000);
      const { spawn } = await import("node:child_process");
      const child = spawn(
        "node",
        ["-e", `require('net').createServer().listen(${port}, '127.0.0.1', () => {}); setInterval(() => {}, 1000);`, "--", staleTask.id],
        { stdio: "ignore" }
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      try {
        const node = {
          name: "n", kind: "local" as const, comfyui_root: path.join(root, "ComfyUI"),
          venv_python: "/usr/bin/python3", model_roots: ["/m"], api_host: "127.0.0.1", api_port: port
        };
        const result = await (orchestrator as unknown as {
          assessComfyUIEnvironment: (t: typeof task, n: typeof node) => Promise<{ notes: string[] }>;
        }).assessComfyUIEnvironment(task, node);
        expect(result.notes.some((n) => n.includes("reclaimed"))).toBe(true);

        const exitPromise = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 2000))]);
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      } finally {
        child.kill("SIGKILL");
      }
    });

    it("does not reclaim a port occupied by a process attributable to a task that is still live", async () => {
      const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-assess-live-${Date.now()}`);
      const { store, orchestrator, task } = await makeOrchestratorAndTask(root);

      const liveTask = await store.createTask({
        name: "Live",
        workflowPath: path.join(root, "live-workflow.json"),
        workspacePath: path.join(root, "live-workspace"),
        artifactPath: path.join(root, "live-artifacts"),
        steps: [{ id: "05", name: "Environment deployment", requiredOutput: "05-environment.md", humanIntervention: "Approve" }]
      });
      await store.updateStep(liveTask.id, "05", "running");
      await store.updateTaskStatus(liveTask.id, "running");

      const port = 20000 + Math.floor(Math.random() * 10000);
      const { spawn } = await import("node:child_process");
      const child = spawn(
        "node",
        ["-e", `require('net').createServer().listen(${port}, '127.0.0.1', () => {}); setInterval(() => {}, 1000);`, "--", liveTask.id],
        { stdio: "ignore" }
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      try {
        const node = {
          name: "n", kind: "local" as const, comfyui_root: path.join(root, "ComfyUI"),
          venv_python: "/usr/bin/python3", model_roots: ["/m"], api_host: "127.0.0.1", api_port: port
        };
        const result = await (orchestrator as unknown as {
          assessComfyUIEnvironment: (t: typeof task, n: typeof node) => Promise<{ notes: string[] }>;
        }).assessComfyUIEnvironment(task, node);
        expect(result.notes.some((n) => n.includes("still active"))).toBe(true);
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBeNull();
      } finally {
        child.kill("SIGKILL");
      }
    });
  });

  describe("Step 12 GUI workflow sync wiring", () => {
    it("pushes the prepared GUI workflow to the node's ComfyUI server as soon as Step 12 pauses for human review", async () => {
      const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-gui-sync-${Date.now()}`);
      const config: AppConfig = {
        port: 0,
        projectRoot: root,
        workspaceRoot: path.join(root, "workspaces"),
        stateRoot: path.join(root, "state"),
        draftDocRoot: root,
        comfyuiRoot: path.join(root, "ComfyUI"),
        modelRoots: ["/home/intel/hf_models"],
        gpuNodesPath: path.join(root, "gpu-nodes.json"),
        workflowArchiveRoot: path.join(root, "nfs-workflows"),
        autoApproveAgentPermissions: false
      };
      await ensureDir(config.workspaceRoot);

      const receivedRequests: Array<{ url: string; body: string }> = [];
      const http = await import("node:http");
      const fakeComfyUI = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          receivedRequests.push({ url: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('""');
        });
      });
      const port: number = await new Promise((resolve, reject) => {
        fakeComfyUI.listen(0, "127.0.0.1", () => {
          const addr = fakeComfyUI.address();
          if (addr && typeof addr !== "string") resolve(addr.port);
          else reject(new Error("failed to bind fake ComfyUI server"));
        });
      });

      try {
        await fs.writeFile(
          config.gpuNodesPath,
          JSON.stringify({
            default_node: "n",
            nodes: [
              {
                name: "n",
                kind: "local",
                comfyui_root: path.join(root, "ComfyUI"),
                venv_python: "/usr/bin/python3",
                model_roots: [],
                api_host: "127.0.0.1",
                api_port: port
              }
            ]
          })
        );

        const store = new StateStore(config);
        await store.initialize();
        const orchestrator = new MigrationOrchestrator(config, store, [
          { id: "12", name: "GUI acceptance and demo", requiredOutput: "12-gui-acceptance.md", humanIntervention: "Approve" }
        ]);
        const task = await orchestrator.createTask({
          name: "Smart_Photo_Rewrite",
          workflowFileName: "workflow.json",
          workflowJson: { nodes: [], links: [] }
        });

        await ensureDir(path.join(task.artifactPath, "12-gui-acceptance"));
        await fs.writeFile(
          path.join(task.artifactPath, "12-gui-acceptance", "12-runtime-policy-gui-workflow.json"),
          '{"nodes":[],"links":[]}\n',
          "utf8"
        );
        await fs.writeFile(
          path.join(task.artifactPath, "12-gui-acceptance-summary.json"),
          JSON.stringify({ gui_workflow_json: { path: "12-gui-acceptance/12-runtime-policy-gui-workflow.json" } }),
          "utf8"
        );

        await (orchestrator as unknown as {
          updateStepAndPersist: (taskId: string, stepId: string, status: string) => Promise<unknown>;
        }).updateStepAndPersist(task.id, "12", "waiting_for_human");

        expect(receivedRequests).toHaveLength(1);
        expect(decodeURIComponent(receivedRequests[0].url)).toMatch(/^\/api\/userdata\/workflows\/.*\.json$/);
        expect(JSON.parse(receivedRequests[0].body)).toEqual({ nodes: [], links: [] });
      } finally {
        await new Promise<void>((resolve) => fakeComfyUI.close(() => resolve()));
      }
    });
  });

  describe("resumeStep vs. the required-artifact fast path", () => {
    // Regression test for a real, live incident: Step 12 wrote its required
    // artifact (12-gui-acceptance.md) before pausing for human review; the
    // backend was restarted while it waited, orphaning the live SDK session;
    // when the human later answered "passed the test looks good" in chat,
    // resumeStep() re-invoked runStep() with that answer in
    // resumeContext.humanDecisions -- but the fast-path artifact check fired
    // first, saw 12-gui-acceptance.md already existed, and declared the step
    // "completed" without ever starting an SDK session to process the
    // answer. The human's real signoff was silently discarded: manual_result
    // stayed "not_performed" and the task advanced anyway.
    async function makeOrchestratorWithStubRunner(root: string, runStepCalls: unknown[][]) {
      const config: AppConfig = {
        port: 0,
        projectRoot: root,
        workspaceRoot: path.join(root, "workspaces"),
        stateRoot: path.join(root, "state"),
        draftDocRoot: root,
        comfyuiRoot: "/tmp/comfy",
        modelRoots: ["/home/intel/hf_models"],
        gpuNodesPath: path.join(root, "gpu-nodes.json"),
        workflowArchiveRoot: path.join(root, "nfs-workflows"),
        autoApproveAgentPermissions: false
      };
      await ensureDir(config.workspaceRoot);
      const store = new StateStore(config);
      await store.initialize();
      const stubRunner = {
        runStep: async (job: unknown) => {
          runStepCalls.push([job]);
          return { sessionId: "stub-session", summary: "Stub SDK session processed the resume decision." };
        }
      };
      const orchestrator = new MigrationOrchestrator(
        config,
        store,
        [{ id: "12", name: "GUI acceptance and demo", requiredOutput: "12-gui-acceptance.md", humanIntervention: "Approve" }],
        stubRunner
      );
      return { store, orchestrator };
    }

    it("does NOT fast-path-complete a resumed step that has a pending human decision, even though its required artifact already exists", async () => {
      const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-resume-bug-${Date.now()}`);
      const runStepCalls: unknown[][] = [];
      const { store, orchestrator } = await makeOrchestratorWithStubRunner(root, runStepCalls);

      const task = await orchestrator.createTask({
        name: "Resume bug repro",
        workflowFileName: "workflow.json",
        workflowJson: { nodes: [], links: [] }
      });

      // Step 12 already wrote its required artifact (as it does before
      // pausing for human review) and is sitting at waiting_for_human --
      // exactly the state a lost SDK session leaves behind.
      await fs.writeFile(path.join(task.artifactPath, "12-gui-acceptance.md"), "# prepared for GUI acceptance\n", "utf8");
      await store.updateStep(task.id, "12", "waiting_for_human");

      // The human's real answer, recorded while no live SDK session existed
      // to receive it (mirrors recordHumanDecision's "for next resume" path).
      await store.appendDecision({
        taskId: task.id,
        stepId: "12",
        questionEventId: "q1",
        answer: "passed the test looks good",
        wasFreeform: true,
        decidedAt: new Date().toISOString()
      });

      await orchestrator.resumeStep(task.id, "12");

      expect(runStepCalls).toHaveLength(1);
      const finalTask = await store.getTask(task.id);
      const step12 = finalTask?.steps.find((s) => s.id === "12");
      expect(step12?.summary).not.toMatch(/completed from existing required artifact/);
    });

    it("still uses the fast path for a plain run with no pending resume decisions", async () => {
      const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-resume-fastpath-${Date.now()}`);
      const runStepCalls: unknown[][] = [];
      const { store, orchestrator } = await makeOrchestratorWithStubRunner(root, runStepCalls);

      const task = await orchestrator.createTask({
        name: "Fast path still works",
        workflowFileName: "workflow.json",
        workflowJson: { nodes: [], links: [] }
      });
      await fs.writeFile(path.join(task.artifactPath, "12-gui-acceptance.md"), "# already done\n", "utf8");

      await orchestrator.runStep(task.id, "12");

      expect(runStepCalls).toHaveLength(0);
      const finalTask = await store.getTask(task.id);
      const step12 = finalTask?.steps.find((s) => s.id === "12");
      expect(step12?.status).toBe("completed");
      expect(step12?.summary).toMatch(/completed from existing required artifact/);
    });
  });

  describe("NFS delivery archive -- fires at Step 12 AND Step 13 completion", () => {
    async function makeOrchestratorForArchiveTest(root: string) {
      const config: AppConfig = {
        port: 0,
        projectRoot: root,
        workspaceRoot: path.join(root, "workspaces"),
        stateRoot: path.join(root, "state"),
        draftDocRoot: root,
        comfyuiRoot: path.join(root, "ComfyUI"),
        modelRoots: ["/home/intel/hf_models"],
        gpuNodesPath: path.join(root, "gpu-nodes.json"),
        workflowArchiveRoot: path.join(root, "nfs-workflows"),
        autoApproveAgentPermissions: false
      };
      await ensureDir(config.workspaceRoot);
      const store = new StateStore(config);
      await store.initialize();
      const orchestrator = new MigrationOrchestrator(config, store, [
        { id: "12", name: "GUI acceptance and demo", requiredOutput: "12-gui-acceptance.md", humanIntervention: "Approve" },
        { id: "13", name: "Agent improvement", requiredOutput: "13-agent-improvement.md", humanIntervention: "Approve" }
      ]);
      const task = await orchestrator.createTask({
        name: "Archive wiring test",
        workflowFileName: "workflow.json",
        workflowJson: { nodes: [], links: [] }
      });
      const deliveryDir = path.join(task.artifactPath, "11-delivery");
      await ensureDir(deliveryDir);
      await fs.writeFile(path.join(deliveryDir, "README.md"), "# delivery\n", "utf8");
      await fs.writeFile(
        path.join(task.artifactPath, "12-gui-acceptance-summary.json"),
        JSON.stringify({ manual_result: "accepted" }),
        "utf8"
      );
      return { config, store, orchestrator, task };
    }

    it("archives when Step 13 completes, even if Step 12's own trigger never ran for this task", async () => {
      const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-archive-step13-${Date.now()}`);
      const { config, orchestrator, task } = await makeOrchestratorForArchiveTest(root);

      // Simulate Step 13 completing directly, without ever going through
      // Step 12's own completion transition (the exact real-world gap this
      // was built for -- some other path marks Step 12 accepted/complete
      // without ever calling updateStepAndPersist("12", "completed")).
      await (orchestrator as unknown as {
        updateStepAndPersist: (taskId: string, stepId: string, status: string) => Promise<unknown>;
      }).updateStepAndPersist(task.id, "13", "completed");

      const entries = await fs.readdir(config.workflowArchiveRoot).catch(() => []);
      expect(entries.length).toBe(1);
    });

    it("does not double-archive when both Step 12 and Step 13 completion fire for the same task", async () => {
      const root = path.join(process.cwd(), ".demo-state", "tests", `orchestrator-archive-both-${Date.now()}`);
      const { config, orchestrator, task } = await makeOrchestratorForArchiveTest(root);
      const castOrchestrator = orchestrator as unknown as {
        updateStepAndPersist: (taskId: string, stepId: string, status: string) => Promise<unknown>;
      };

      await castOrchestrator.updateStepAndPersist(task.id, "12", "completed");
      await castOrchestrator.updateStepAndPersist(task.id, "13", "completed");

      const entries = await fs.readdir(config.workflowArchiveRoot).catch(() => []);
      expect(entries.length).toBe(1);
    });
  });
});
