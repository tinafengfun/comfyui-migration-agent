import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MigrationTask } from "../shared/types";
import { ensureDir } from "./fsUtils";
import { ensureWorkflowInventory } from "./workflowInventory";

describe("workflow inventory", () => {
  it("writes a complete deterministic Step 02 inventory", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `workflow-inventory-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    const workflowPath = path.join(root, "workflow.json");
    await ensureDir(artifactPath);
    await fs.writeFile(
      workflowPath,
      JSON.stringify({
        nodes: [
          {
            id: 1,
            type: "UNETLoader",
            properties: { cnr_id: "comfy-core" },
            outputs: [{ links: [1] }],
            widgets_values: ["model.safetensors", "default"]
          },
          {
            id: 2,
            type: "SaveImage",
            properties: { cnr_id: "comfy-core" },
            inputs: [{ link: 1 }],
            widgets_values: ["ComfyUI"]
          }
        ],
        links: [[1, 1, 0, 2, 0, "IMAGE"]]
      }),
      "utf8"
    );
    const task: MigrationTask = {
      id: "task",
      name: "Task",
      status: "running",
      workflowPath,
      workspacePath: root,
      artifactPath,
      createdAt: "now",
      updatedAt: "now",
      steps: [{ id: "02", status: "running" }]
    };

    const result = await ensureWorkflowInventory(task);

    expect(result.nodeCount).toBe(2);
    const content = await fs.readFile(result.artifactPath, "utf8");
    expect(content).toContain("Workflow inventory");
    expect(content).toContain("model.safetensors");
    expect(content).toContain("2:SaveImage");
  });
});
