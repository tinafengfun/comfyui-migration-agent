import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HumanDecision, MigrationTask } from "../shared/types";
import { buildTaskStateLedger, writeTaskStateLedger } from "./taskStateLedger";

function makeTask(overrides: Partial<MigrationTask> = {}): MigrationTask {
  return {
    id: "task-1",
    name: "Test workflow",
    status: "running",
    workflowPath: "/workspaces/task-1/source/workflow.json",
    workspacePath: "/workspaces/task-1",
    artifactPath: "/workspaces/task-1/artifacts",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    steps: [
      { id: "00", status: "completed", summary: "intake ok", startedAt: "t0", completedAt: "t1" },
      { id: "01", status: "running", startedAt: "t1" }
    ],
    ...overrides
  };
}

describe("buildTaskStateLedger", () => {
  it("produces an array-shaped steps list (not a dict), matching every real consumer except the broken one", () => {
    const ledger = buildTaskStateLedger(makeTask(), []);
    expect(Array.isArray(ledger.steps)).toBe(true);
    expect(ledger.steps).toHaveLength(2);
  });

  it("includes every step regardless of status", () => {
    const task = makeTask({
      steps: [
        { id: "00", status: "completed" },
        { id: "01", status: "failed", error: "boom" },
        { id: "02", status: "pending" }
      ]
    });
    const ledger = buildTaskStateLedger(task, []);
    expect(ledger.steps.map((s) => s.id)).toEqual(["00", "01", "02"]);
    expect(ledger.steps[1].error).toBe("boom");
  });

  it("marks the first non-completed step as current_step_id", () => {
    const ledger = buildTaskStateLedger(makeTask(), []);
    expect(ledger.current_step_id).toBe("01");
  });

  it("leaves current_step_id undefined when every step is completed", () => {
    const task = makeTask({ steps: [{ id: "00", status: "completed" }, { id: "01", status: "completed" }] });
    const ledger = buildTaskStateLedger(task, []);
    expect(ledger.current_step_id).toBeUndefined();
  });

  it("includes all human decisions for the task, not filtered by step", () => {
    const decisions: HumanDecision[] = [
      { taskId: "task-1", stepId: "01", questionEventId: "e1", answer: "1", wasFreeform: false, decidedAt: "t1" },
      { taskId: "task-1", stepId: "02", questionEventId: "e2", answer: "option 0", wasFreeform: false, decidedAt: "t2" }
    ];
    const ledger = buildTaskStateLedger(makeTask(), decisions);
    expect(ledger.human_decisions).toHaveLength(2);
    expect(ledger.human_decisions[1].answer).toBe("option 0");
  });

  it("marks generated_by as orchestrator, distinguishing it from any legacy agent-hand-written file", () => {
    const ledger = buildTaskStateLedger(makeTask(), []);
    expect(ledger.generated_by).toBe("orchestrator");
  });

  it("only attaches handoff_ref when precomputed map provides one for that step", () => {
    const ledger = buildTaskStateLedger(makeTask(), [], { "00": "step-handoffs/00-handoff.md" });
    expect(ledger.steps[0].handoff_ref).toBe("step-handoffs/00-handoff.md");
    expect(ledger.steps[1].handoff_ref).toBeUndefined();
  });
});

describe("writeTaskStateLedger", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-state-ledger-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes valid JSON to <workspacePath>/task-state.json (workspace root, not under artifacts/)", async () => {
    const artifactPath = path.join(tmpDir, "artifacts");
    await fs.mkdir(artifactPath, { recursive: true });
    const task = makeTask({ workspacePath: tmpDir, artifactPath });

    await writeTaskStateLedger(task, []);

    const taskStatePath = path.join(tmpDir, "task-state.json");
    const raw = await fs.readFile(taskStatePath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.task_id).toBe("task-1");
    expect(Array.isArray(parsed.steps)).toBe(true);

    await expect(fs.access(path.join(artifactPath, "task-state.json"))).rejects.toThrow();
  });

  it("includes handoff_ref only for steps whose step-handoffs/{id}-handoff.md actually exists on disk", async () => {
    const artifactPath = path.join(tmpDir, "artifacts");
    await fs.mkdir(path.join(artifactPath, "step-handoffs"), { recursive: true });
    await fs.writeFile(path.join(artifactPath, "step-handoffs", "00-handoff.md"), "notes for step 01", "utf8");
    const task = makeTask({ workspacePath: tmpDir, artifactPath });

    await writeTaskStateLedger(task, []);

    const raw = await fs.readFile(path.join(tmpDir, "task-state.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.steps[0].handoff_ref).toBe("step-handoffs/00-handoff.md");
    expect(parsed.steps[1].handoff_ref).toBeUndefined();
  });

  it("is safe to call repeatedly without ever leaving invalid JSON on disk (atomic write)", async () => {
    const artifactPath = path.join(tmpDir, "artifacts");
    await fs.mkdir(artifactPath, { recursive: true });
    const task = makeTask({ workspacePath: tmpDir, artifactPath });

    await writeTaskStateLedger(task, []);
    await writeTaskStateLedger({ ...task, status: "completed" }, []);

    const raw = await fs.readFile(path.join(tmpDir, "task-state.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw).status).toBe("completed");
  });
});
