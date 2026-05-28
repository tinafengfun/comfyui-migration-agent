import type { AgentEvent, HumanDecision } from "../shared/types";

interface Waiter {
  resolve(decision: HumanDecision): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class HumanApprovalBroker {
  private readonly waiters = new Map<string, Waiter>();

  waitForDecision(event: AgentEvent, timeoutMs = 30 * 60 * 1000): Promise<HumanDecision> {
    if (event.type !== "human_question") {
      throw new Error(`Cannot wait for non-human question event: ${event.type}`);
    }
    if (this.waiters.has(event.id)) {
      throw new Error(`Already waiting for decision on event ${event.id}`);
    }
    return new Promise<HumanDecision>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(event.id);
        reject(new Error(`Timed out waiting for human decision on event ${event.id}`));
      }, timeoutMs);
      this.waiters.set(event.id, { resolve, reject, timer });
    });
  }

  resolveDecision(decision: HumanDecision): boolean {
    const waiter = this.waiters.get(decision.questionEventId);
    if (!waiter) {
      return false;
    }
    clearTimeout(waiter.timer);
    this.waiters.delete(decision.questionEventId);
    waiter.resolve(decision);
    return true;
  }

  pendingCount(): number {
    return this.waiters.size;
  }
}
