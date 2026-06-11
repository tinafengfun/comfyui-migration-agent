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
      autoApproveAgentPermissions: false,
      comfyuiVenv: "/tmp/comfy/.venv-xpu",
      comfyuiPython: "/tmp/comfy/.venv-xpu/bin/python3",
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
      autoApproveAgentPermissions: false,
      comfyuiVenv: "/tmp/comfy/.venv-xpu",
      comfyuiPython: "/tmp/comfy/.venv-xpu/bin/python3",
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
      autoApproveAgentPermissions: false,
      comfyuiVenv: "/tmp/comfy/.venv-xpu",
      comfyuiPython: "/tmp/comfy/.venv-xpu/bin/python3",
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
});
