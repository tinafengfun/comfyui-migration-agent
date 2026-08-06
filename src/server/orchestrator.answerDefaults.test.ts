import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config";
import type { AgentEvent, HumanDecision, HumanQuestion } from "../shared/types";
import { ensureDir } from "./fsUtils";
import { MigrationOrchestrator } from "./orchestrator";
import { StateStore } from "./state";
import { appendAnswerDefault, computeQuestionSignature, type AnswerDefaultEntry } from "./answerDefaults";

// Integration tests for the answer-defaults auto-answer at the gate-wait
// chokepoint (see answerDefaults.ts / orchestrator.tryAutoAnswerFromDefault).
// The mock SDK runner drives the wait callback with a synthetic
// human_question so we control the outcome precisely.

function makeConfig(root: string): AppConfig {
  return {
    port: 0,
    projectRoot: root,
    workspaceRoot: path.join(root, "workspaces"),
    stateRoot: path.join(root, "state"),
    draftDocRoot: root,
    comfyuiRoot: path.join(root, "ComfyUI"),
    modelRoots: [path.join(root, "models")],
    gpuNodesPath: path.join(root, "gpu-nodes.json"),
    workflowArchiveRoot: path.join(root, "nfs-workflows"),
    taskArchiveRoot: path.join(root, "task-archive"),
    assetResolutionLedgerPath: path.join(root, "asset-resolutions.jsonl"),
    answerLogPath: path.join(root, "answer-log.jsonl"),
    answerDefaultsPath: path.join(root, "answer-defaults.jsonl"),
    answerDefaultsEnabled: true,
    autoApproveAgentPermissions: false
  };
}

const CHOICES = ["Approve and continue", "Stop"];

async function seedAutoDefault(config: AppConfig, opts: {
  stepId: string;
  blockingReason: HumanQuestion["blockingReason"];
  choices?: string[];
  answer: string;
}): Promise<void> {
  const identity = { stepId: opts.stepId, blockingReason: opts.blockingReason, choices: opts.choices };
  const entry: AnswerDefaultEntry = {
    ...identity,
    signature: computeQuestionSignature(identity),
    label: "test question",
    defaultAnswer: opts.answer,
    tier: "auto",
    enabled: true,
    createdAt: "t0",
    updatedAt: "t0"
  };
  await ensureDir(path.dirname(config.answerDefaultsPath));
  await appendAnswerDefault(config.answerDefaultsPath, entry);
}

/** Build an orchestrator whose Step-09 SDK session emits one gate question. */
function buildOrchestrator(config: AppConfig, store: StateStore, question: HumanQuestion, capture: { decision?: HumanDecision }) {
  return new MigrationOrchestrator(
    config,
    store,
    [{ id: "09", name: "Performance tuning", requiredOutput: "09-tuning.md", humanIntervention: "Approve" }],
    {
      async runStep(job, emit, waitForDecision) {
        const event = await emit({ taskId: job.taskId, stepId: job.stepId, type: "human_question", message: question.question, data: question });
        if (waitForDecision) {
          // Direct await: an auto-answered question resolves immediately; a
          // correctly-NOT-auto-answered one stays parked here until the test
          // resolves it via recordHumanDecision (proving it wasn't auto).
          capture.decision = await waitForDecision(event as AgentEvent);
        }
        await fs.writeFile(path.join(job.artifactPath, "09-tuning.md"), "# tuning\n", "utf8");
        return { sessionId: "fake", summary: "done" };
      }
    }
  );
}

describe("answer-defaults auto-answer at the gate-wait chokepoint", () => {
  it("auto-answers a structured question that has a matching tier:auto template, recording source auto-default", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orch-ad-auto-${Date.now()}`);
    const config = makeConfig(root);
    await ensureDir(config.workspaceRoot);
    await seedAutoDefault(config, { stepId: "09", blockingReason: "quality_review", choices: CHOICES, answer: "Approve and continue" });
    const store = new StateStore(config);
    await store.initialize();
    const capture: { decision?: HumanDecision } = {};
    const orchestrator = buildOrchestrator(
      config,
      store,
      { question: "Continue with downgraded claim?", choices: CHOICES, allowFreeform: true, blockingReason: "quality_review" },
      capture
    );
    const task = await orchestrator.createTask({ name: "AutoAnswerTest", workflowFileName: "workflow.json", workflowJson: { nodes: [], links: [] } });

    await orchestrator.runStep(task.id, "09");

    expect(capture.decision?.answer).toBe("Approve and continue");
    // The answer log recorded it as an auto-default.
    const log = await fs.readFile(config.answerLogPath, "utf8");
    expect(log).toContain('"source":"auto-default"');
    // A visible "auto-answered per default" progress event was emitted.
    const events = await store.listEvents(task.id);
    expect(events.some((e) => e.type === "progress" && e.message.includes("Auto-answered per your saved default"))).toBe(true);
  });

  it("does NOT auto-answer a hard_stop question even with a matching tier:auto template (safety floor)", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orch-ad-hardstop-${Date.now()}`);
    const config = makeConfig(root);
    await ensureDir(config.workspaceRoot);
    await seedAutoDefault(config, { stepId: "09", blockingReason: "hard_stop", choices: CHOICES, answer: "Approve and continue" });
    const store = new StateStore(config);
    await store.initialize();
    const capture: { decision?: HumanDecision } = {};
    const orchestrator = buildOrchestrator(
      config,
      store,
      { question: "Override this hard stop?", choices: CHOICES, allowFreeform: true, blockingReason: "hard_stop" },
      capture
    );
    const task = await orchestrator.createTask({ name: "HardStopFloorTest", workflowFileName: "workflow.json", workflowJson: { nodes: [], links: [] } });

    const runPromise = orchestrator.runStep(task.id, "09");
    // Give the wait path time to (not) auto-answer and park on the broker.
    await new Promise((r) => setTimeout(r, 400));
    // It must have parked for a human, not auto-answered.
    expect(capture.decision).toBeUndefined();
    const question = (await store.listEvents(task.id)).find((e) => e.type === "human_question");
    expect(question).toBeDefined();
    // Resolve it as a human to unblock and finish cleanly.
    await orchestrator.recordHumanDecision({ taskId: task.id, stepId: "09", questionEventId: question!.id, answer: "manual override", wasFreeform: true });
    await runPromise;
    expect(capture.decision?.answer).toBe("manual override");
  });

  it("does NOT auto-answer a freeform-only question (no choices) even with a tier:auto template", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orch-ad-freeform-${Date.now()}`);
    const config = makeConfig(root);
    await ensureDir(config.workspaceRoot);
    // Template keyed on the no-choices signature.
    await seedAutoDefault(config, { stepId: "09", blockingReason: "other", choices: undefined, answer: "whatever" });
    const store = new StateStore(config);
    await store.initialize();
    const capture: { decision?: HumanDecision } = {};
    const orchestrator = buildOrchestrator(
      config,
      store,
      { question: "Free-form: what should I do?", allowFreeform: true, blockingReason: "other" },
      capture
    );
    const task = await orchestrator.createTask({ name: "FreeformTest", workflowFileName: "workflow.json", workflowJson: { nodes: [], links: [] } });

    const runPromise = orchestrator.runStep(task.id, "09");
    await new Promise((r) => setTimeout(r, 400));
    expect(capture.decision).toBeUndefined();
    const question = (await store.listEvents(task.id)).find((e) => e.type === "human_question");
    await orchestrator.recordHumanDecision({ taskId: task.id, stepId: "09", questionEventId: question!.id, answer: "typed answer", wasFreeform: true });
    await runPromise;
    expect(capture.decision?.answer).toBe("typed answer");
  });

  it("getAnswerSuggestion surfaces a saved default and marks the never-auto floor", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orch-ad-suggest-${Date.now()}`);
    const config = makeConfig(root);
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const orchestrator = new MigrationOrchestrator(config, store, [{ id: "09", name: "Tuning", requiredOutput: "09-tuning.md", humanIntervention: "x" }], {
      runStep: async () => ({ sessionId: "x", summary: "x" })
    });
    const task = await orchestrator.createTask({ name: "SuggestTest", workflowFileName: "workflow.json", workflowJson: { nodes: [], links: [] } });

    // No default, no history yet.
    const q1: HumanQuestion = { question: "Continue?", choices: CHOICES, allowFreeform: true, blockingReason: "quality_review" };
    const ev1 = await store.appendEvent({ taskId: task.id, stepId: "09", type: "human_question", message: q1.question, data: q1 });
    const s0 = await orchestrator.getAnswerSuggestion(task.id, ev1.id);
    expect(s0.default).toBeUndefined();
    expect(s0.neverAuto).toBe(false);
    expect(s0.history.count).toBe(0);

    // Seed an enabled confirm default -> surfaced.
    await seedAutoDefault(config, { stepId: "09", blockingReason: "quality_review", choices: CHOICES, answer: "Approve and continue" });
    const s1 = await orchestrator.getAnswerSuggestion(task.id, ev1.id);
    expect(s1.default?.answer).toBe("Approve and continue");

    // A hard_stop question is flagged never-auto.
    const q2: HumanQuestion = { question: "Override?", choices: CHOICES, allowFreeform: true, blockingReason: "hard_stop" };
    const ev2 = await store.appendEvent({ taskId: task.id, stepId: "09", type: "human_question", message: q2.question, data: q2 });
    expect((await orchestrator.getAnswerSuggestion(task.id, ev2.id)).neverAuto).toBe(true);
  });

  it("saveAnswerDefault derives the answer from the recorded decision, and rejects tier:auto on the safety floor / freeform", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orch-ad-save-${Date.now()}`);
    const config = makeConfig(root);
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const orchestrator = new MigrationOrchestrator(config, store, [{ id: "09", name: "Tuning", requiredOutput: "09-tuning.md", humanIntervention: "x" }], {
      runStep: async () => ({ sessionId: "x", summary: "x" })
    });
    const task = await orchestrator.createTask({ name: "SaveTest", workflowFileName: "workflow.json", workflowJson: { nodes: [], links: [] } });

    const q: HumanQuestion = { question: "Continue?", choices: CHOICES, allowFreeform: true, blockingReason: "quality_review" };
    const ev = await store.appendEvent({ taskId: task.id, stepId: "09", type: "human_question", message: q.question, data: q });
    await store.appendDecision({ taskId: task.id, stepId: "09", questionEventId: ev.id, answer: "Approve and continue", wasFreeform: false, decidedAt: new Date().toISOString() });

    const saved = await orchestrator.saveAnswerDefault(task.id, ev.id, "auto");
    expect(saved.defaultAnswer).toBe("Approve and continue");
    expect(saved.tier).toBe("auto");
    expect((await orchestrator.listAnswerDefaultTemplates()).length).toBe(1);

    // hard_stop question: tier:auto rejected.
    const qh: HumanQuestion = { question: "Override?", choices: CHOICES, allowFreeform: true, blockingReason: "hard_stop" };
    const evh = await store.appendEvent({ taskId: task.id, stepId: "09", type: "human_question", message: qh.question, data: qh });
    await store.appendDecision({ taskId: task.id, stepId: "09", questionEventId: evh.id, answer: "force", wasFreeform: true, decidedAt: new Date().toISOString() });
    await expect(orchestrator.saveAnswerDefault(task.id, evh.id, "auto")).rejects.toThrow(/cannot be set to fully-auto/);
    // confirm tier is still allowed for it.
    expect((await orchestrator.saveAnswerDefault(task.id, evh.id, "confirm")).tier).toBe("confirm");

    // freeform-only (no choices): tier:auto rejected.
    const qf: HumanQuestion = { question: "What now?", allowFreeform: true, blockingReason: "other" };
    const evf = await store.appendEvent({ taskId: task.id, stepId: "09", type: "human_question", message: qf.question, data: qf });
    await store.appendDecision({ taskId: task.id, stepId: "09", questionEventId: evf.id, answer: "do X", wasFreeform: true, decidedAt: new Date().toISOString() });
    await expect(orchestrator.saveAnswerDefault(task.id, evf.id, "auto")).rejects.toThrow(/cannot be set to fully-auto/);
  });

  it("updateAnswerDefault disables and tombstone-deletes a template", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orch-ad-update-${Date.now()}`);
    const config = makeConfig(root);
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const orchestrator = new MigrationOrchestrator(config, store, [{ id: "09", name: "Tuning", requiredOutput: "09-tuning.md", humanIntervention: "x" }], {
      runStep: async () => ({ sessionId: "x", summary: "x" })
    });
    const task = await orchestrator.createTask({ name: "UpdateTest", workflowFileName: "workflow.json", workflowJson: { nodes: [], links: [] } });
    const q: HumanQuestion = { question: "Continue?", choices: CHOICES, allowFreeform: true, blockingReason: "quality_review" };
    const ev = await store.appendEvent({ taskId: task.id, stepId: "09", type: "human_question", message: q.question, data: q });
    await store.appendDecision({ taskId: task.id, stepId: "09", questionEventId: ev.id, answer: "Approve and continue", wasFreeform: false, decidedAt: new Date().toISOString() });
    const saved = await orchestrator.saveAnswerDefault(task.id, ev.id, "confirm");

    const disabled = await orchestrator.updateAnswerDefault(saved.signature, { enabled: false });
    expect(disabled?.enabled).toBe(false);
    expect((await orchestrator.listAnswerDefaultTemplates())[0].enabled).toBe(false);

    const deleted = await orchestrator.updateAnswerDefault(saved.signature, { deleted: true });
    expect(deleted).toBeUndefined();
    expect((await orchestrator.listAnswerDefaultTemplates()).length).toBe(0);
  });

  it("records every human answer to the cross-task answer log", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `orch-ad-record-${Date.now()}`);
    const config = makeConfig(root);
    await ensureDir(config.workspaceRoot);
    const store = new StateStore(config);
    await store.initialize();
    const capture: { decision?: HumanDecision } = {};
    const orchestrator = buildOrchestrator(
      config,
      store,
      { question: "Continue?", choices: CHOICES, allowFreeform: true, blockingReason: "quality_review" },
      capture
    );
    const task = await orchestrator.createTask({ name: "RecordTest", workflowFileName: "workflow.json", workflowJson: { nodes: [], links: [] } });

    const runPromise = orchestrator.runStep(task.id, "09");
    await new Promise((r) => setTimeout(r, 300));
    const question = (await store.listEvents(task.id)).find((e) => e.type === "human_question");
    await orchestrator.recordHumanDecision({ taskId: task.id, stepId: "09", questionEventId: question!.id, answer: "Stop", wasFreeform: false });
    await runPromise;

    const log = await fs.readFile(config.answerLogPath, "utf8");
    expect(log).toContain('"source":"human"');
    expect(log).toContain('"answer":"Stop"');
  });
});
