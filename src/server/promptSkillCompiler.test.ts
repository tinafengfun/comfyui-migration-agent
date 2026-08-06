import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config";
import { ensureDir } from "./fsUtils";
import { compileStepJob, serializeStepJobForAgent } from "./promptSkillCompiler";

describe("prompt skill compiler", () => {
  it("compiles prompt and skill docs into a StepJob", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", "compiler");
    await ensureDir(root);
    const promptPath = path.join(root, "prompt.md");
    const skillPath = path.join(root, "skill.md");
    const agentPath = path.join(root, "migration-workflow-v2", "agent.md");
    await fs.writeFile(promptPath, "Prompt body", "utf8");
    await fs.writeFile(skillPath, "Skill body", "utf8");
    await ensureDir(path.dirname(agentPath));
    await fs.writeFile(
      agentPath,
      [
        "# Agent",
        "",
        "## Common Migration Contract",
        "",
        "Shared rule: keep claim boundaries visible.",
        "",
        "## Backend state contract",
        "",
        "Do not inject this large backend-only section into per-step prompts."
      ].join("\n"),
      "utf8"
    );

    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: root,
      stateRoot: root,
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

    const job = await compileStepJob({
      config,
      task: {
        id: "task-1",
        name: "Task",
        status: "pending",
        workflowPath: path.join(root, "workflow.json"),
        workspacePath: root,
        artifactPath: path.join(root, "artifacts"),
        createdAt: "now",
        updatedAt: "now",
        steps: [{ id: "00", status: "pending" }]
      },
      step: {
        id: "00",
        name: "Intake",
        promptPath,
        skillPath,
        requiredOutput: "00-intake-preflight.md",
        humanIntervention: "Provide missing sources"
      }
    });

    expect(job.instructions).toContain("Prompt body");
    expect(job.instructions).toContain("Skill body");
    expect(job.instructions).toContain("Shared rule: keep claim boundaries visible.");
    expect(job.instructions).not.toContain("Do not inject this large backend-only section");
    expect(job.constraints).toContain("Do not modify the source workflow in place.");
    expect(serializeStepJobForAgent(job)).toContain("Structured StepJob");
    expect(serializeStepJobForAgent(job)).toContain("read the artifacts listed");
  });

  it("merges the pinned GPU node's own model_roots with the global default instead of overriding it (real bug: a node whose model_roots list omits a root that's still genuinely valid there made the agent blind to it)", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `compiler-gpu-node-${Date.now()}`);
    await ensureDir(root);
    const promptPath = path.join(root, "prompt.md");
    const skillPath = path.join(root, "skill.md");
    await fs.writeFile(promptPath, "Prompt body", "utf8");
    await fs.writeFile(skillPath, "Skill body", "utf8");
    const gpuNodesPath = path.join(root, "gpu-nodes.json");
    await fs.writeFile(
      gpuNodesPath,
      JSON.stringify({
        default_node: "remote-test",
        nodes: [
          {
            name: "remote-test",
            kind: "ssh",
            comfyui_root: "/home/intel/ComfyUI",
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

    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: root,
      stateRoot: root,
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

    const job = await compileStepJob({
      config,
      task: {
        id: "task-gpu-node",
        name: "Task",
        status: "pending",
        workflowPath: path.join(root, "workflow.json"),
        workspacePath: root,
        artifactPath: path.join(root, "artifacts"),
        createdAt: "now",
        updatedAt: "now",
        gpuNode: "remote-test",
        steps: [{ id: "05", status: "pending" }]
      },
      step: {
        id: "05",
        name: "Environment deployment",
        promptPath,
        skillPath,
        requiredOutput: "05-environment.md",
        humanIntervention: "Resolve environment gaps"
      }
    });

    expect(job.modelRoots).toEqual(["/home/intel/hf_models", "/nfs_share"]);
    expect(job.comfyuiRoot).toBe("/home/intel/ComfyUI");
  });

  it("passes durable artifact memory to each SDK step job", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", "compiler-artifacts");
    const artifactPath = path.join(root, "artifacts");
    await ensureDir(artifactPath);
    await fs.writeFile(path.join(artifactPath, "00-intake-preflight.md"), "# intake\n", "utf8");
    await fs.writeFile(path.join(artifactPath, "01-assets.csv"), "asset,state\n", "utf8");

    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: root,
      stateRoot: root,
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

    const job = await compileStepJob({
      config,
      task: {
        id: "task-1",
        name: "Task",
        status: "pending",
        workflowPath: path.join(root, "workflow.json"),
        workspacePath: root,
        artifactPath,
        createdAt: "now",
        updatedAt: "now",
        steps: [{ id: "02", status: "pending" }]
      },
      step: {
        id: "02",
        name: "Feasibility",
        requiredOutput: "02-feasibility.md",
        humanIntervention: "Confirm route"
      }
    });

    expect(job.requiredContext.priorArtifacts).toEqual([
      "00-intake-preflight.md",
      "01-assets.csv"
    ]);
    expect(job.requiredContext.recommendedInputArtifacts).toEqual([
      "00-intake-preflight.md",
      "01-assets.csv",
      "01-custom-nodes.md"
    ]);
    expect(job.requiredContext.availableInputArtifacts).toEqual([
      "00-intake-preflight.md",
      "01-assets.csv"
    ]);
    expect(job.requiredContext.unavailableRecommendedInputArtifacts).toEqual([
      "01-custom-nodes.md"
    ]);
    const serialized = serializeStepJobForAgent(job);
    expect(serialized).toContain("availableInputArtifacts");
    expect(serialized).toContain("00-intake-preflight.md");
    expect(serialized).toContain("Treat `requiredContext.recommendedInputArtifacts` as the step's prompt-input contract");
  });

  it("adds scoped execution hints for Step 04 source audits", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", "compiler-step04");
    await ensureDir(root);
    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: root,
      stateRoot: root,
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

    const job = await compileStepJob({
      config,
      task: {
        id: "task-1",
        name: "Task",
        status: "pending",
        workflowPath: path.join(root, "workflow.json"),
        workspacePath: root,
        artifactPath: path.join(root, "artifacts"),
        createdAt: "now",
        updatedAt: "now",
        steps: [{ id: "04", status: "pending" }]
      },
      step: {
        id: "04",
        name: "Source audit",
        requiredOutput: "04-source-audit.md",
        humanIntervention: "Approve runtime policy"
      }
    });

    const serialized = serializeStepJobForAgent(job);
    expect(serialized).toContain("Write `04-source-audit.md` first");
    expect(serialized).toContain("QwenVL");
    expect(serialized).toContain("SeedVR2");
  });

  it("recommends Step 12b's own upstream inputs, and points Step 13 at Step 12b's outputs instead of Step 12's (12b now supersedes 12 as the final-delivery evidence source)", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `compiler-12b-${Date.now()}`);
    await ensureDir(root);

    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: root,
      stateRoot: root,
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

    const baseTask = {
      id: "task-1",
      name: "Task",
      status: "pending" as const,
      workflowPath: path.join(root, "workflow.json"),
      workspacePath: root,
      artifactPath: path.join(root, "artifacts"),
      createdAt: "now",
      updatedAt: "now"
    };

    const job12b = await compileStepJob({
      config,
      task: { ...baseTask, steps: [{ id: "12b", status: "pending" as const }] },
      step: {
        id: "12b",
        name: "Final delivery: docker deployment guide",
        requiredOutput: "12b-final-delivery.md",
        humanIntervention: "Review the generated docker deployment guide for accuracy."
      }
    });
    expect(job12b.requiredContext.recommendedInputArtifacts).toContain("12-gui-acceptance.md");
    expect(job12b.requiredContext.recommendedInputArtifacts).toContain("11-delivery.md");

    const job13 = await compileStepJob({
      config,
      task: { ...baseTask, steps: [{ id: "13", status: "pending" as const }] },
      step: {
        id: "13",
        name: "Agent improvement and playbook hardening",
        requiredOutput: "13-agent-improvement.md",
        humanIntervention: "Approve improvements"
      }
    });
    expect(job13.requiredContext.recommendedInputArtifacts).toContain("12b-final-delivery.md");
    expect(job13.requiredContext.recommendedInputArtifacts).not.toContain("12-gui-acceptance.md");
  });
});
