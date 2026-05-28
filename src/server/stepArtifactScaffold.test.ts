import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MigrationTask } from "../shared/types";
import { ensureDir } from "./fsUtils";
import { ensureStepArtifactScaffold, isInProgressScaffold } from "./stepArtifactScaffold";

describe("step artifact scaffold", () => {
  it("creates in-progress required artifacts without marking them complete", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `step-scaffold-${Date.now()}`);
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

    const result = await ensureStepArtifactScaffold(task, {
      id: "06",
      name: "Prompt conversion validation",
      requiredOutput: "06-prompt.json / 06-prompt-validation.json",
      humanIntervention: "Decide schema changes"
    });

    expect(result.created).toBe(true);
    expect(result.relativePath).toBe(path.join("artifacts", "06-prompt-validation.json"));
    const content = await fs.readFile(path.join(artifactPath, "06-prompt-validation.json"), "utf8");
    expect(isInProgressScaffold(content)).toBe(true);
  });
});
