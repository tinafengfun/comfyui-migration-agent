import { describe, expect, it } from "vitest";
import {
  classifySdkEventForRetention,
  sdkEventToContextBudgetEvent,
  shouldPersistApiEvent,
  summarizeSdkEventForStorage
} from "./contextRetention";

describe("context retention policy", () => {
  it("keeps raw assistant deltas out of prompt budget, API state, and debug files", () => {
    const event = {
      type: "assistant.streaming_delta",
      data: { deltaContent: "token chunk that is not durable state" }
    };

    expect(classifySdkEventForRetention(event)).toMatchObject({
      class: "drop",
      promptBudget: false,
      persistApiEvent: false,
      persistDebugEvent: false,
      persistTranscriptEvent: false
    });
    expect(sdkEventToContextBudgetEvent("task", event)).toBeUndefined();
  });

  it("stores only compact summaries for semantic tool progress", () => {
    const event = {
      type: "tool.execution_complete",
      data: {
        toolName: "bash",
        success: true,
        result: {
          content: "x".repeat(10_000)
        }
      }
    };

    const budgetEvent = sdkEventToContextBudgetEvent(
      "task",
      event,
      "tool completed: bash success=true"
    );

    expect(budgetEvent).toMatchObject({
      taskId: "task",
      stepId: "phase1",
      type: "progress",
      message: "tool completed: bash success=true",
      data: {
        retentionClass: "prompt_summary",
        type: "tool.execution_complete",
        toolName: "bash",
        success: true
      }
    });
    expect(JSON.stringify(budgetEvent)).not.toContain("x".repeat(500));
    expect(summarizeSdkEventForStorage(event, "tool completed: bash success=true").contentPreview)
      .toHaveLength(120);
  });

  it("does not persist repetitive API progress noise", () => {
    expect(
      shouldPersistApiEvent({
        taskId: "task",
        stepId: "phase1",
        type: "progress",
        message: "Phase 1 task-state sync found no step status changes."
      })
    ).toBe(false);
    expect(
      shouldPersistApiEvent({
        taskId: "task",
        stepId: "phase1",
        type: "progress",
        message: "tool completed: bash success=true"
      })
    ).toBe(false);
    expect(
      shouldPersistApiEvent({
        taskId: "task",
        stepId: "phase1",
        type: "progress",
        message: "Synced Phase 1 task-state step statuses: 00:completed, 01:running."
      })
    ).toBe(true);
    expect(
      shouldPersistApiEvent({
        taskId: "task",
        stepId: "01",
        type: "human_question",
        message: "Need missing source asset."
      })
    ).toBe(true);
  });
});
