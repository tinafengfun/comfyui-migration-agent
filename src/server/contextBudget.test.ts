import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ContextBudgetTracker, estimateTokens } from "./contextBudget";
import { ensureDir } from "./fsUtils";

describe("context budget tracker", () => {
  it("writes snapshots and classifies critical budget pressure", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `context-budget-${Date.now()}`);
    await ensureDir(root);
    const promptPath = path.join(root, "prompt.md");
    const budgetPath = path.join(root, "context-budget.json");
    await fs.writeFile(promptPath, "x".repeat(200), "utf8");

    const tracker = new ContextBudgetTracker({
      budgetPath,
      trackedPaths: [promptPath],
      limits: {
        warningEstimatedTokens: 20,
        criticalEstimatedTokens: 40,
        warningSdkEvents: 2,
        criticalSdkEvents: 3,
        snapshotIntervalMs: 0
      }
    });

    await tracker.recordSdkEvent({
      taskId: "task",
      stepId: "phase1",
      type: "progress",
      message: "event payload",
      data: { text: "y".repeat(80) }
    });
    const snapshot = await tracker.writeSnapshot("test");

    expect(estimateTokens(200)).toBe(50);
    expect(snapshot.level).toBe("critical");
    expect(snapshot.trackedArtifactChars).toBeGreaterThanOrEqual(200);
    expect(await fs.readFile(budgetPath, "utf8")).toContain("critical");
  });
});
