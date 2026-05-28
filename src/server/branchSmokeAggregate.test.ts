import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MigrationTask } from "../shared/types";
import { ensureBranchSmokeAggregate } from "./branchSmokeAggregate";
import { ensureDir } from "./fsUtils";

describe("branch smoke aggregate", () => {
  it("creates Step 07 aggregate only when all branch summaries pass", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `branch-smoke-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    await ensureDir(artifactPath);
    const task: MigrationTask = {
      id: "task-1",
      name: "Task",
      status: "running",
      workflowPath: path.join(root, "workflow.json"),
      workspacePath: root,
      artifactPath,
      createdAt: "now",
      updatedAt: "now",
      steps: [{ id: "07", status: "running" }]
    };

    await fs.writeFile(
      path.join(artifactPath, "07-qwenvl-prompt-smoke-summary.json"),
      JSON.stringify({ branch: "qwenvl-prompt", status: "pass", output_node: "60" }),
      "utf8"
    );
    await expect(ensureBranchSmokeAggregate(task)).resolves.toMatchObject({
      complete: false
    });

    for (const [fileName, branch, outputNode] of [
      ["07-zimage-controlnet-smoke-summary.json", "zimage-controlnet", "16"],
      ["07-flux2-refine-smoke-summary.json", "flux2-refine", "26,27,36"],
      ["07-seedvr2-upscale-smoke-summary.json", "seedvr2-upscale", "72,94,52"]
    ]) {
      await fs.writeFile(
        path.join(artifactPath, fileName),
        JSON.stringify({ branch, status: "pass", output_node: outputNode }),
        "utf8"
      );
    }

    const result = await ensureBranchSmokeAggregate(task);

    expect(result).toMatchObject({ complete: true, created: true });
    await expect(fs.readFile(result.path, "utf8")).resolves.toContain("Status: complete");
  });
});
