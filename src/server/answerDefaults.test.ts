import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureDir } from "./fsUtils";
import {
  appendAnswerDefault,
  appendAnswerLog,
  computeQuestionSignature,
  isAutoAnswerEligible,
  isNeverAutoQuestion,
  listAnswerDefaults,
  lookupAnswerDefault,
  summarizeHistory,
  type AnswerDefaultEntry,
  type QuestionIdentity
} from "./answerDefaults";

const q = (over: Partial<QuestionIdentity> = {}): QuestionIdentity => ({
  stepId: "01",
  blockingReason: "missing_asset",
  choices: ["Approve and continue", "Stop"],
  ...over
});

describe("computeQuestionSignature", () => {
  it("is stable for the same structured question and independent of choice order", () => {
    const a = computeQuestionSignature(q({ choices: ["Approve and continue", "Stop"] }));
    const b = computeQuestionSignature(q({ choices: ["Stop", "Approve and continue"] }));
    expect(a).toBe(b);
  });

  it("differs when choices differ", () => {
    expect(computeQuestionSignature(q({ choices: ["A"] }))).not.toBe(computeQuestionSignature(q({ choices: ["B"] })));
  });

  it("disambiguates Step 13's two same-blockingReason gates via phase", () => {
    const approve = q({ stepId: "13", blockingReason: "quality_review", choices: ["approve: all"], phase: "awaiting_approval" });
    const pushDeploy = q({ stepId: "13", blockingReason: "quality_review", choices: ["approve: all"], phase: "awaiting_push_deploy_decision" });
    expect(computeQuestionSignature(approve)).not.toBe(computeQuestionSignature(pushDeploy));
  });
});

describe("isNeverAutoQuestion (safety floor)", () => {
  it("is true for hard_stop and the Step 13 push/deploy gate", () => {
    expect(isNeverAutoQuestion(q({ blockingReason: "hard_stop" }))).toBe(true);
    expect(isNeverAutoQuestion(q({ stepId: "13", blockingReason: "quality_review", phase: "awaiting_push_deploy_decision" }))).toBe(true);
  });
  it("is false for routine templatable gates", () => {
    expect(isNeverAutoQuestion(q({ blockingReason: "missing_asset" }))).toBe(false);
    expect(isNeverAutoQuestion(q({ blockingReason: "quality_review" }))).toBe(false);
    expect(isNeverAutoQuestion(q({ stepId: "13", blockingReason: "quality_review", phase: "awaiting_approval" }))).toBe(false);
  });
});

describe("isAutoAnswerEligible", () => {
  it("requires enumerated choices and not being on the never-auto floor", () => {
    expect(isAutoAnswerEligible(q({ choices: ["A", "B"] }))).toBe(true);
    expect(isAutoAnswerEligible(q({ choices: [] }))).toBe(false); // freeform-only
    expect(isAutoAnswerEligible(q({ choices: undefined }))).toBe(false);
    expect(isAutoAnswerEligible(q({ blockingReason: "hard_stop", choices: ["A"] }))).toBe(false);
  });
});

describe("answer log + history", () => {
  it("summarizes all-same history per signature", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `answerlog-${Date.now()}`);
    await ensureDir(root);
    const logPath = path.join(root, "answer-log.jsonl");
    const sig = computeQuestionSignature(q());
    for (let i = 0; i < 3; i++) {
      await appendAnswerLog(logPath, {
        ...q(),
        signature: sig,
        answer: "Approve and continue",
        wasFreeform: false,
        source: "human",
        workflowName: "wf",
        taskId: `t${i}`,
        decidedAt: new Date().toISOString()
      });
    }
    const h = await summarizeHistory(logPath, sig);
    expect(h.count).toBe(3);
    expect(h.allSame).toBe(true);
    expect(h.lastAnswer).toBe("Approve and continue");
    // A different signature is unaffected.
    expect((await summarizeHistory(logPath, "nope")).count).toBe(0);
  });
});

describe("answer defaults (latest-wins + tombstone)", () => {
  it("returns the latest template, and undefined once tombstoned; list drops deleted", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `answerdef-${Date.now()}`);
    await ensureDir(root);
    const defaultsPath = path.join(root, "answer-defaults.jsonl");
    const sig = computeQuestionSignature(q());
    const base: AnswerDefaultEntry = {
      ...q(),
      signature: sig,
      label: "provide source?",
      defaultAnswer: "Approve and continue",
      tier: "confirm",
      enabled: true,
      createdAt: "t0",
      updatedAt: "t0"
    };
    await appendAnswerDefault(defaultsPath, base);
    await appendAnswerDefault(defaultsPath, { ...base, tier: "auto", updatedAt: "t1" });
    const latest = await lookupAnswerDefault(defaultsPath, sig);
    expect(latest?.tier).toBe("auto");
    expect((await listAnswerDefaults(defaultsPath)).length).toBe(1);

    await appendAnswerDefault(defaultsPath, { ...base, deleted: true, updatedAt: "t2" });
    expect(await lookupAnswerDefault(defaultsPath, sig)).toBeUndefined();
    expect((await listAnswerDefaults(defaultsPath)).length).toBe(0);
  });

  it("skips torn/malformed lines instead of throwing", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `answerdef-torn-${Date.now()}`);
    await ensureDir(root);
    const defaultsPath = path.join(root, "answer-defaults.jsonl");
    const fs = await import("node:fs/promises");
    await fs.writeFile(defaultsPath, "{not valid json\n", "utf8");
    expect(await lookupAnswerDefault(defaultsPath, "x")).toBeUndefined();
  });
});
