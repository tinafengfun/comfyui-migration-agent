import { describe, expect, it } from "vitest";
import { applyStepPatch, parseTaskStateWithRepair, repairDanglingStepObjects } from "./taskStatePatch";

// Minimal reproduction of the real corruption found in a production task's
// task-state.json: steps array closes early, then step 13's entry lands
// outside it as a bare object, followed by an orphaned extra `]`.
const CORRUPTED = `{
  "taskId": "fd5a985c-3d9a-4e10-96f4-549cdb6a3e43",
  "steps": [
    {
      "step": "12",
      "status": "completed",
      "human_decisions": []
    }
  ],
  {
      "step": "13",
      "name": "Agent improvement",
      "status": "completed",
      "human_decisions": []
  }
  ],
  "currentStep": 13,
  "orchestrator_status": "complete"
}`;

const VALID = `{
  "taskId": "abc",
  "steps": [
    { "step": "00", "status": "completed" },
    { "step": "01", "status": "completed" }
  ],
  "currentStep": 1
}`;

describe("repairDanglingStepObjects", () => {
  it("splices a dangling step object back into the array and drops the orphaned bracket", () => {
    const repaired = repairDanglingStepObjects(CORRUPTED);
    const parsed = JSON.parse(repaired);
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps[1].step).toBe("13");
    expect(parsed.currentStep).toBe(13);
    expect(parsed.orchestrator_status).toBe("complete");
  });

  it("returns text unchanged when the corruption shape isn't present", () => {
    expect(repairDanglingStepObjects(VALID)).toBe(VALID);
  });

  it("returns text unchanged for unrelated garbage", () => {
    const garbage = "{ this is not json at all";
    expect(repairDanglingStepObjects(garbage)).toBe(garbage);
  });
});

describe("parseTaskStateWithRepair", () => {
  it("parses valid JSON directly with repaired=false", () => {
    const { state, repaired } = parseTaskStateWithRepair(VALID);
    expect(repaired).toBe(false);
    expect((state.steps as unknown[]).length).toBe(2);
  });

  it("auto-repairs the exact confirmed corruption shape", () => {
    const { state, repaired } = parseTaskStateWithRepair(CORRUPTED);
    expect(repaired).toBe(true);
    const steps = state.steps as Record<string, unknown>[];
    expect(steps).toHaveLength(2);
    expect(steps[1].step).toBe("13");
  });

  it("rethrows the original SyntaxError for unrecognized garbage, never fabricates a fallback", () => {
    expect(() => parseTaskStateWithRepair("{ not json")).toThrow(SyntaxError);
  });
});

describe("applyStepPatch", () => {
  it("replaces an existing step entry matched by 'step' in place", () => {
    const state = { steps: [{ step: "00", status: "completed" }, { step: "01", status: "running" }] };
    const next = applyStepPatch(state, { step: "01", status: "completed" });
    const steps = next.steps as Record<string, unknown>[];
    expect(steps).toHaveLength(2);
    expect(steps[1].status).toBe("completed");
  });

  it("matches an existing entry via legacy 'stepId' field (schema drift tolerance)", () => {
    const state = { steps: [{ stepId: "00", status: "completed" }] };
    const next = applyStepPatch(state, { step: "00", status: "revised" });
    const steps = next.steps as Record<string, unknown>[];
    expect(steps).toHaveLength(1);
    expect(steps[0].status).toBe("revised");
  });

  it("pushes a new entry when the step isn't already present, never touching existing ones", () => {
    const state = { steps: [{ step: "00", status: "completed" }] };
    const next = applyStepPatch(state, { step: "01", status: "running" });
    const steps = next.steps as Record<string, unknown>[];
    expect(steps).toHaveLength(2);
    expect(steps[0].step).toBe("00");
    expect(steps[1].step).toBe("01");
  });

  it("creates the steps array when missing (first-ever patch for a task)", () => {
    const next = applyStepPatch({}, { step: "00", status: "completed" });
    expect(next.steps).toHaveLength(1);
  });

  it("shallow-merges top-level fields in the same safe call (the exact edit shape that caused the corruption)", () => {
    const state = { steps: [{ step: "12", status: "completed" }], currentStep: 12 };
    const next = applyStepPatch(state, { step: "13", status: "completed" }, { currentStep: 13, orchestrator_status: "complete" });
    expect(next.currentStep).toBe(13);
    expect(next.orchestrator_status).toBe("complete");
    expect((next.steps as unknown[]).length).toBe(2);
  });

  it("throws if the step patch has no step/stepId field", () => {
    expect(() => applyStepPatch({}, { status: "completed" })).toThrow();
  });
});
