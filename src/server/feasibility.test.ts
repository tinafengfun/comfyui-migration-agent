import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MigrationTask } from "../shared/types";
import { ensureFeasibility } from "./feasibility";
import { ensureDir } from "./fsUtils";

describe("feasibility", () => {
  it("writes a deterministic Step 01 human gate from Step 00 gaps", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `feasibility-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    await ensureDir(artifactPath);
    await fs.writeFile(
      path.join(artifactPath, "00-intake-preflight.md"),
      [
        "# 00",
        "can_continue_to_feasibility: no",
        "## Missing source-identical models",
        "- missing.safetensors",
        "## Alias/smoke candidates requiring approval",
        "- alias.safetensors"
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

    const result = await ensureFeasibility({ task, modelRoots: ["/models"] });

    expect(result.gated).toBe(true);
    expect(result.criticalGapCount).toBe(1);
    const content = await fs.readFile(result.artifactPath, "utf8");
    expect(content).toContain("unresolved asset gaps");
    expect(content).toContain("missing.safetensors");
    expect(content).toContain("alias.safetensors");
    // Gate signal is now in gate-signal.json, not artifact text
    const gateSignalPath = path.join(task.artifactPath, "02-gate-signal.json");
    const gateSignal = JSON.parse(await fs.readFile(gateSignalPath, "utf8"));
    expect(gateSignal.gated).toBe(true);
  });
});
