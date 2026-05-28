import { describe, expect, it } from "vitest";
import type { AgentEvent, HumanDecision } from "../shared/types";
import { HumanApprovalBroker } from "./humanApprovalBroker";

describe("HumanApprovalBroker", () => {
  it("resolves a waiting human question with a matching decision", async () => {
    const broker = new HumanApprovalBroker();
    const event: AgentEvent = {
      id: "event-1",
      taskId: "task-1",
      stepId: "00",
      type: "human_question",
      message: "Approve?",
      createdAt: new Date().toISOString()
    };
    const decision: HumanDecision = {
      taskId: "task-1",
      stepId: "00",
      questionEventId: "event-1",
      answer: "Approve once",
      wasFreeform: false,
      decidedAt: new Date().toISOString()
    };

    const waiting = broker.waitForDecision(event, 1000);
    expect(broker.pendingCount()).toBe(1);
    expect(broker.resolveDecision(decision)).toBe(true);
    await expect(waiting).resolves.toEqual(decision);
    expect(broker.pendingCount()).toBe(0);
  });

  it("returns false when a decision has no active waiter", () => {
    const broker = new HumanApprovalBroker();
    expect(
      broker.resolveDecision({
        taskId: "task-1",
        questionEventId: "missing",
        answer: "Approve once",
        wasFreeform: false,
        decidedAt: new Date().toISOString()
      })
    ).toBe(false);
  });
});
