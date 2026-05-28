import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MigrationTask } from "../shared/types";
import {
  checkRequiredArtifactCompletion,
  checkRequiredArtifactGate,
  expectedArtifactCandidates
} from "./artifactCompletion";
import { ensureDir } from "./fsUtils";

describe("artifact completion", () => {
  it("maps concrete step artifacts", () => {
    expect(expectedArtifactCandidates({ id: "03", name: "Inventory", requiredOutput: "", humanIntervention: "" })).toContain("03-inventory.md");
    expect(expectedArtifactCandidates({ id: "11", name: "Delivery", requiredOutput: "", humanIntervention: "" })).toContain("migration-result-report.md");
    expect(expectedArtifactCandidates({ id: "13", name: "Agent improvement", requiredOutput: "", humanIntervention: "" })).toEqual([
      "13-agent-improvement.json",
      "13-agent-improvement.md",
      "13-playbook-patch-plan.md",
      "13-phase3-readiness.json",
      "13-reflection.md",
      "13-reflection.json"
    ]);
  });

  it("detects a non-empty required artifact", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `artifact-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    await ensureDir(artifactPath);
    await fs.writeFile(path.join(artifactPath, "03-inventory.md"), "# inventory\n", "utf8");
    const task: MigrationTask = {
      id: "task",
      name: "Task",
      status: "running",
      workflowPath: path.join(root, "workflow.json"),
      workspacePath: root,
      artifactPath,
      createdAt: "now",
      updatedAt: "now",
      steps: [{ id: "03", status: "running" }]
    };

    await expect(
      checkRequiredArtifactCompletion(task, {
        id: "03",
        name: "Workflow inventory",
        requiredOutput: "03-inventory.md",
        humanIntervention: ""
      })
    ).resolves.toMatchObject({ complete: true });
  });

  it("requires every member of multi-artifact completion groups", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `artifact-group-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    await ensureDir(artifactPath);
    const task: MigrationTask = {
      id: "task",
      name: "Task",
      status: "running",
      workflowPath: path.join(root, "workflow.json"),
      workspacePath: root,
      artifactPath,
      createdAt: "now",
      updatedAt: "now",
      steps: [{ id: "06", status: "running" }]
    };
    const step = {
      id: "06",
      name: "Prompt conversion validation",
      requiredOutput: "06-prompt.json / 06-prompt-validation.json",
      humanIntervention: ""
    };

    await fs.writeFile(path.join(artifactPath, "06-prompt-validation.json"), "{}\n", "utf8");

    await expect(checkRequiredArtifactCompletion(task, step)).resolves.toMatchObject({
      complete: false,
      reason: expect.stringContaining("06-prompt.json")
    });

    await fs.writeFile(path.join(artifactPath, "06-prompt.json"), "{}\n", "utf8");

    await expect(checkRequiredArtifactCompletion(task, step)).resolves.toMatchObject({
      complete: true,
      reason: expect.stringContaining("06-prompt-validation.json, 06-prompt.json")
    });
  });

  it("does not treat an in-progress scaffold as a completed artifact", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `artifact-scaffold-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    await ensureDir(artifactPath);
    await fs.writeFile(
      path.join(artifactPath, "05-environment.md"),
      "# 05 - Environment\n\norchestrator_status: in_progress\n",
      "utf8"
    );
    const task: MigrationTask = {
      id: "task",
      name: "Task",
      status: "running",
      workflowPath: path.join(root, "workflow.json"),
      workspacePath: root,
      artifactPath,
      createdAt: "now",
      updatedAt: "now",
      steps: [{ id: "05", status: "running" }]
    };

    await expect(
      checkRequiredArtifactCompletion(task, {
        id: "05",
        name: "Environment deployment",
        requiredOutput: "05-environment.md",
        humanIntervention: ""
      })
    ).resolves.toMatchObject({ complete: false });
  });

  it("detects human gate via gate-signal.json", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `artifact-gate-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    await ensureDir(artifactPath);
    await fs.writeFile(
      path.join(artifactPath, "02-feasibility.md"),
      "# Feasibility\n\nCompleted analysis.\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(artifactPath, "02-gate-signal.json"),
      JSON.stringify({ stepId: "02", gated: true, category: "missing_asset", trigger: "deterministic", reason: "Test gate" }),
      "utf8"
    );
    const task: MigrationTask = {
      id: "task",
      name: "Task",
      status: "running",
      workflowPath: path.join(root, "workflow.json"),
      workspacePath: root,
      artifactPath,
      createdAt: "now",
      updatedAt: "now",
      steps: [{ id: "02", status: "running" }]
    };

    await expect(
      checkRequiredArtifactGate(task, {
        id: "02",
        name: "Feasibility",
        requiredOutput: "02-feasibility.md",
        humanIntervention: ""
      })
    ).resolves.toMatchObject({ gated: true });
  });

  it("does NOT gate based on LLM-written text markers (only gate-signal.json is authoritative)", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `artifact-prose-gate-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    await ensureDir(artifactPath);
    await fs.writeFile(
      path.join(artifactPath, "02-feasibility.md"),
      "# Feasibility\n\nStatus: human-gated hard stop before runtime or migration work.\n",
      "utf8"
    );
    const task: MigrationTask = {
      id: "task",
      name: "Task",
      status: "running",
      workflowPath: path.join(root, "workflow.json"),
      workspacePath: root,
      artifactPath,
      createdAt: "now",
      updatedAt: "now",
      steps: [{ id: "02", status: "running" }]
    };

    await expect(
      checkRequiredArtifactGate(task, {
        id: "02",
        name: "Feasibility",
        requiredOutput: "02-feasibility.md",
        humanIntervention: ""
      })
    ).resolves.toMatchObject({ gated: false });
  });

  it("does not gate completed artifacts that only document future human approval boundaries", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `artifact-complete-boundary-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    await ensureDir(artifactPath);
    await fs.writeFile(
      path.join(artifactPath, "01-custom-nodes.md"),
      [
        "# 01 - Asset and custom-node resolution",
        "",
        "orchestrator_status: complete",
        "",
        "Smoke-only aliases require explicit human approval."
      ].join("\n"),
      "utf8"
    );
    const task: MigrationTask = {
      id: "task",
      name: "Task",
      status: "running",
      workflowPath: path.join(root, "workflow.json"),
      workspacePath: root,
      artifactPath,
      createdAt: "now",
      updatedAt: "now",
      steps: [{ id: "01", status: "running" }]
    };

    await expect(
      checkRequiredArtifactGate(task, {
        id: "01",
        name: "Asset resolution",
        requiredOutput: "01-assets.csv / 01-custom-nodes.md",
        humanIntervention: ""
      })
    ).resolves.toMatchObject({ gated: false });
  });

  it("requires every Step 13 self-evolution artifact before completion", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `artifact-step13-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    await ensureDir(artifactPath);
    const task: MigrationTask = {
      id: "task",
      name: "Task",
      status: "running",
      workflowPath: path.join(root, "workflow.json"),
      workspacePath: root,
      artifactPath,
      createdAt: "now",
      updatedAt: "now",
      steps: [{ id: "13", status: "running" }]
    };
    const step = {
      id: "13",
      name: "Agent improvement",
      requiredOutput: "13-agent-improvement.*",
      humanIntervention: ""
    };
    await fs.writeFile(path.join(artifactPath, "13-agent-improvement.md"), "# improvement\n", "utf8");
    await fs.writeFile(path.join(artifactPath, "13-agent-improvement.json"), "{}\n", "utf8");

    await expect(checkRequiredArtifactCompletion(task, step)).resolves.toMatchObject({
      complete: false,
      reason: expect.stringContaining("13-playbook-patch-plan.md")
    });

    for (const candidate of expectedArtifactCandidates(step)) {
      await fs.writeFile(path.join(artifactPath, candidate), `${candidate}\n`, "utf8");
    }

    await expect(checkRequiredArtifactCompletion(task, step)).resolves.toMatchObject({
      complete: true,
      reason: expect.stringContaining("All Step 13 self-evolution artifacts")
    });
  });
});
