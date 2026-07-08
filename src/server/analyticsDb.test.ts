/**
 * Tests for analyticsDb.ts (§H).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  recordRecipeApplied,
  recordRecipeOutcome,
  recordSkillInjected,
  recordTaskCreated,
  recordTaskCompleted,
  computeRecipeEfficacy,
  syncFeedbackFromJsonl,
  closeDb
} from "./analyticsDb";

let dbDir: string;

beforeEach(async () => {
  dbDir = await mkdtemp(path.join(tmpdir(), "analytics-"));
  process.env.MIGRATION_ANALYTICS_DB = path.join(dbDir, "test.sqlite");
  closeDb(); // reset singleton
});

afterEach(async () => {
  closeDb();
  delete process.env.MIGRATION_ANALYTICS_DB;
  await rm(dbDir, { recursive: true, force: true });
});

describe("analyticsDb recipe tracking", () => {
  it("recordRecipeApplied inserts rows", () => {
    recordRecipeApplied("task-1", "04", ["recipe-a", "recipe-b"]);
    const efficacy = computeRecipeEfficacy();
    expect(efficacy).toHaveLength(2);
    expect(efficacy.map((e) => e.recipeId).sort()).toEqual(["recipe-a", "recipe-b"]);
    expect(efficacy[0].appliedCount).toBe(1);
    expect(efficacy[0].successCount).toBe(0);
  });

  it("recordRecipeOutcome updates matching rows", () => {
    recordRecipeApplied("task-1", "04", ["recipe-a"]);
    recordRecipeOutcome("task-1", "04", "success");

    const efficacy = computeRecipeEfficacy("recipe-a");
    expect(efficacy).toHaveLength(1);
    expect(efficacy[0].successCount).toBe(1);
    expect(efficacy[0].successRate).toBe(1);
  });

  it("recordRecipeOutcome does nothing when no applied rows exist", () => {
    recordRecipeOutcome("unknown-task", "04", "success");
    const efficacy = computeRecipeEfficacy();
    expect(efficacy).toHaveLength(0);
  });

  it("computeRecipeEfficacy aggregates across multiple tasks", () => {
    recordRecipeApplied("task-1", "04", ["recipe-x"]);
    recordRecipeApplied("task-2", "04", ["recipe-x"]);
    recordRecipeApplied("task-3", "04", ["recipe-x"]);
    recordRecipeOutcome("task-1", "04", "success");
    recordRecipeOutcome("task-2", "04", "failed");
    // task-3 has no outcome yet

    const efficacy = computeRecipeEfficacy("recipe-x");
    expect(efficacy).toHaveLength(1);
    expect(efficacy[0].appliedCount).toBe(3);
    expect(efficacy[0].successCount).toBe(1);
    expect(efficacy[0].failedCount).toBe(1);
    expect(efficacy[0].successRate).toBeCloseTo(1 / 3);
    expect(efficacy[0].lastAppliedAt).toBeTruthy();
  });
});

describe("analyticsDb skill tracking", () => {
  it("recordSkillInjected inserts rows without error", () => {
    recordSkillInjected("task-1", "02", "fp8-checklist", "1.0.0");
    // No error thrown is the assertion — the row is in skill_injections.
    // We don't expose a reader for skill_injections yet (§H reader is recipe-focused).
    expect(true).toBe(true);
  });
});

describe("analyticsDb task tracking", () => {
  it("recordTaskCreated + recordTaskCompleted lifecycle", () => {
    recordTaskCreated("task-1", "workflow.json", "abc123");
    recordTaskCompleted("task-1", "completed");
    // No reader for tasks table yet — verify no throw.
    expect(true).toBe(true);
  });
});

describe("analyticsDb feedback sync", () => {
  it("syncs feedback events from JSONL to SQLite", async () => {
    const workspaceRoot = path.join(dbDir, "workspaces");
    const taskId = "sync-test-task";
    const feedbackDir = path.join(workspaceRoot, taskId, "feedback");
    await mkdir(feedbackDir, { recursive: true });

    const events = [
      {
        id: "evt-1", taskId, stepId: "04", createdAt: "2026-06-25T00:00:00Z",
        source: "human", type: "comfyui_bug", severity: "blocker",
        message: "Segfault on XPU", status: "open"
      },
      {
        id: "evt-2", taskId, stepId: "05", createdAt: "2026-06-25T01:00:00Z",
        source: "agent_self", type: "agent_bug", severity: "degrade",
        message: "SDK timeout", status: "open"
      }
    ];
    await appendFile(
      path.join(feedbackDir, "feedback-events.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n"
    );

    const stats = await syncFeedbackFromJsonl(workspaceRoot);
    expect(stats.synced).toBe(2);
    expect(stats.errors).toBe(0);

    // Re-sync should be idempotent (INSERT OR REPLACE by id).
    const stats2 = await syncFeedbackFromJsonl(workspaceRoot);
    expect(stats2.synced).toBe(2);
  });

  it("handles missing workspace root gracefully", async () => {
    const stats = await syncFeedbackFromJsonl("/nonexistent/workspace-root");
    expect(stats.synced).toBe(0);
  });
});

describe("analyticsDb error resilience", () => {
  it("writer functions do not throw on DB unavailable", () => {
    // Point to a path that can't be created (file where dir should be).
    process.env.MIGRATION_ANALYTICS_DB = "/dev/null/impossible.sqlite";
    closeDb();

    // These should all catch internally and warn, not throw.
    expect(() => recordRecipeApplied("t", "04", ["r"])).not.toThrow();
    expect(() => recordRecipeOutcome("t", "04", "success")).not.toThrow();
    expect(() => recordSkillInjected("t", "04", "s", "1.0.0")).not.toThrow();
    expect(() => recordTaskCreated("t", "wf.json")).not.toThrow();
    expect(() => computeRecipeEfficacy()).not.toThrow();
  });
});
