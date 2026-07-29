/**
 * Validation helper for improvement S13-06.
 *
 * Exercises the ask_user dispatch path (`dispatchAskUserWithRetry`) plus the
 * task-ledger fault recorder (`recordBackendToolFault` / `buildTaskStateLedger`)
 * to prove:
 *   1. A transient ask_user tool error is retried, then surfaces a Web-visible
 *      backend-fault event (a `progress` event with data.kind === "backend_tool_fault",
 *      distinct from a pending `human_question` gate), and the dispatch THROWS
 *      (no auto-proceed with a guessed default).
 *   2. No gate can be silently bypassed when ask_user errors -- the dispatch
 *      never returns a fabricated answer on a tool fault; it re-throws.
 *   3. A human "no answer" timeout and a hard-stop cancellation are legitimate
 *      gate closures (NOT tool faults): they propagate immediately with no
 *      retry and no backend-fault event, so the gate is neither bypassed nor
 *      misreported as a tool fault.
 *   4. The fault is recorded in the task ledger (backend-faults.json sidecar
 *      and surfaced in buildTaskStateLedger's backend_faults array).
 *
 * Run with a tiny backoff so it finishes fast:
 *   MIGRATION_AGENT_ASK_USER_BACKOFF_MS=1 npx tsx .agent-improvement-validate-helpers/S13-06/check_ask_user_fault_retry.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { dispatchAskUserWithRetry } from "../../src/server/copilotSdkRunner";
import {
  buildTaskStateLedger,
  recordBackendToolFault
} from "../../src/server/taskStateLedger";
import type { AgentEvent, HumanDecision, HumanQuestion } from "../../src/shared/types";

interface EmittedEvent {
  type: string;
  message: string;
  data?: unknown;
}

function makeEmit(sink: EmittedEvent[]): (e: Omit<AgentEvent, "id" | "createdAt">) => Promise<AgentEvent> {
  return async (e) => {
    sink.push({ type: e.type, message: e.message, data: e.data });
    const full: AgentEvent = {
      id: `evt-${sink.length}`,
      taskId: e.taskId,
      stepId: e.stepId,
      type: e.type,
      message: e.message,
      createdAt: new Date().toISOString(),
      ...(e.data !== undefined ? { data: e.data } : {})
    };
    return full;
  };
}

function decision(answer: string, eventId: string): HumanDecision {
  return {
    taskId: "task-x",
    stepId: "02",
    questionEventId: eventId,
    answer,
    wasFreeform: false,
    decidedAt: new Date().toISOString()
  };
}

const question: HumanQuestion = {
  question: "Pick a source",
  choices: ["a", "b"],
  allowFreeform: true,
  blockingReason: "other"
};

function faultEvents(events: EmittedEvent[]): EmittedEvent[] {
  return events.filter(
    (e) => e.type === "progress" && (e.data as { kind?: string } | undefined)?.kind === "backend_tool_fault"
  );
}

async function testToolErrorRetriesThenFaultsNoAutoProceed(tmp: string): Promise<void> {
  const events: EmittedEvent[] = [];
  const emit = makeEmit(events);
  // Simulate a transient ask_user tool/backend fault on every attempt.
  const waiter = async (event: AgentEvent): Promise<HumanDecision> => {
    throw new Error("ask_user transport stream disconnected");
  };
  const artifactPath = path.join(tmp, "artifacts");
  await fs.mkdir(artifactPath, { recursive: true });

  let threw = false;
  try {
    await dispatchAskUserWithRetry({
      taskId: "task-x",
      stepId: "02",
      artifactPath,
      workspacePath: tmp,
      question,
      emit,
      waitForDecision: waiter
    });
  } catch (e) {
    threw = true;
    assert.match((e as Error).message, /stream disconnected/, "should re-throw the tool fault");
  }
  assert.equal(threw, true, "MUST throw on exhausted tool fault -- no auto-proceed with a guessed default");

  const humanGates = events.filter((e) => e.type === "human_question");
  assert.ok(humanGates.length > 1, `should have retried the gate (got ${humanGates.length} human_question events)`);

  const faults = faultEvents(events);
  assert.equal(faults.length, 1, "should emit exactly one Web-visible backend-fault event");
  const faultData = faults[0].data as { kind?: string; tool?: string };
  assert.equal(faultData.kind, "backend_tool_fault");
  assert.equal(faultData.tool, "ask_user");
  assert.match(faults[0].message, /tool failure, not an ignored gate/i);

  // Ledger sidecar must contain the recorded fault.
  const sidecar = JSON.parse(
    await fs.readFile(path.join(artifactPath, "backend-faults.json"), "utf8")
  ) as Array<{ tool: string; reason: string }>;
  assert.equal(sidecar.length, 1, "backend-faults.json sidecar should have one entry");
  assert.equal(sidecar[0].tool, "ask_user");
  assert.match(sidecar[0].reason, /stream disconnected/);
}

async function testTimeoutIsNotAToolFault(): Promise<void> {
  const events: EmittedEvent[] = [];
  const emit = makeEmit(events);
  const waiter = async (): Promise<HumanDecision> => {
    throw new Error("Timed out waiting for human decision on event evt-1");
  };
  let threw = false;
  try {
    await dispatchAskUserWithRetry({
      taskId: "task-x",
      stepId: "02",
      artifactPath: path.join(os.tmpdir(), "noop-artifacts"),
      workspacePath: path.join(os.tmpdir(), "noop-ws"),
      question,
      emit,
      waitForDecision: waiter
    });
  } catch (e) {
    threw = true;
    assert.match((e as Error).message, /Timed out/);
  }
  assert.equal(threw, true, "timeout should propagate (gate not bypassed)");
  const humanGates = events.filter((e) => e.type === "human_question");
  assert.equal(humanGates.length, 1, "timeout must NOT be retried (not a tool fault)");
  assert.equal(faultEvents(events).length, 0, "timeout must NOT emit a backend-fault event");
}

async function testCancellationIsNotAToolFault(): Promise<void> {
  const events: EmittedEvent[] = [];
  const emit = makeEmit(events);
  const waiter = async (): Promise<HumanDecision> => {
    throw new Error("Cancelled: hard stop");
  };
  let threw = false;
  try {
    await dispatchAskUserWithRetry({
      taskId: "task-x",
      stepId: "02",
      artifactPath: path.join(os.tmpdir(), "noop-artifacts"),
      workspacePath: path.join(os.tmpdir(), "noop-ws"),
      question,
      emit,
      waitForDecision: waiter
    });
  } catch (e) {
    threw = true;
    assert.match((e as Error).message, /Cancelled:/);
  }
  assert.equal(threw, true, "cancellation should propagate (gate not bypassed)");
  assert.equal(faultEvents(events).length, 0, "cancellation must NOT emit a backend-fault event");
}

async function testHumanAnswerResolvesImmediately(): Promise<void> {
  const events: EmittedEvent[] = [];
  const emit = makeEmit(events);
  const waiter = async (event: AgentEvent): Promise<HumanDecision> => decision("option a", event.id);
  const res = await dispatchAskUserWithRetry({
    taskId: "task-x",
    stepId: "02",
    artifactPath: path.join(os.tmpdir(), "noop-artifacts"),
    workspacePath: path.join(os.tmpdir(), "noop-ws"),
    question,
    emit,
    waitForDecision: waiter
  });
  assert.equal(res.answer, "option a");
  assert.equal(faultEvents(events).length, 0);
  assert.equal(events.filter((e) => e.type === "human_question").length, 1);
}

async function testLedgerSurfacesBackendFaults(tmp: string): Promise<void> {
  const artifactPath = path.join(tmp, "artifacts-ledger");
  await fs.mkdir(artifactPath, { recursive: true });
  await recordBackendToolFault({
    taskId: "task-x",
    stepId: "04",
    tool: "ask_user",
    reason: "transport dropped",
    artifactPath,
    workspacePath: tmp
  });
  const task = {
    id: "task-x",
    name: "t",
    status: "running",
    workflowPath: "/wf.json",
    workspacePath: tmp,
    artifactPath,
    createdAt: "t0",
    updatedAt: "t0",
    steps: [{ id: "04", status: "running" }]
  };
  const ledger = buildTaskStateLedger(task as never, [], {}, [
    { id: "f1", taskId: "task-x", stepId: "04", tool: "ask_user", reason: "transport dropped", occurredAt: "t1" }
  ]);
  assert.ok(Array.isArray(ledger.backend_faults), "ledger must include backend_faults array");
  assert.equal(ledger.backend_faults.length, 1);
  assert.equal(ledger.backend_faults[0].tool, "ask_user");
}

async function main(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "s13-06-validate-"));
  try {
    await testToolErrorRetriesThenFaultsNoAutoProceed(tmp);
    await testTimeoutIsNotAToolFault();
    await testCancellationIsNotAToolFault();
    await testHumanAnswerResolvesImmediately();
    await testLedgerSurfacesBackendFaults(tmp);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  console.log("S13-06 validation OK: ask_user tool-fault retry, Web-visible fault event, no auto-proceed, ledger recorded.");
}

main().catch((err) => {
  console.error("S13-06 validation FAILED:", err);
  process.exit(1);
});
