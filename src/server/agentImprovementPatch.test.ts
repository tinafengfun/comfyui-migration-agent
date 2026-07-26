import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyItemPatches,
  applyItemStatusUpdates,
  parseAgentImprovementFile,
  parseApprovalAnswer,
  parsePushDeployAnswer,
  readAgentImprovementFile,
  writeAgentImprovementFile,
  type AgentImprovementFile,
  type AgentImprovementVerification
} from "./agentImprovementPatch";

function makeState(): AgentImprovementFile {
  return {
    step_id: "13",
    improvements: [
      { id: "I01", apply_status: "patch_plan_only", target_files: ["agent.md"] },
      { id: "I02", apply_status: "patch_plan_only", target_files: ["scripts/foo.sh"] },
      { id: "I03", apply_status: "patch_plan_only", target_files: ["scripts/bar.py"] }
    ]
  };
}

describe("parseAgentImprovementFile", () => {
  it("parses a valid file with an improvements array", () => {
    const state = parseAgentImprovementFile(JSON.stringify(makeState()));
    expect(state.improvements).toHaveLength(3);
  });

  it("throws if 'improvements' isn't an array", () => {
    expect(() => parseAgentImprovementFile(JSON.stringify({ step_id: "13" }))).toThrow();
  });

  it("throws SyntaxError for genuinely invalid JSON (no silent fallback)", () => {
    expect(() => parseAgentImprovementFile("{ not json")).toThrow(SyntaxError);
  });
});

describe("applyItemStatusUpdates", () => {
  it("updates only the specified items' apply_status, leaving others untouched", () => {
    const { state, unmatchedIds } = applyItemStatusUpdates(makeState(), { I01: "approved_to_apply" });
    expect(unmatchedIds).toEqual([]);
    expect(state.improvements.find((i) => i.id === "I01")?.apply_status).toBe("approved_to_apply");
    expect(state.improvements.find((i) => i.id === "I02")?.apply_status).toBe("patch_plan_only");
  });

  it("reports unmatched ids instead of silently ignoring them", () => {
    const { unmatchedIds } = applyItemStatusUpdates(makeState(), { I99: "approved_to_apply" });
    expect(unmatchedIds).toEqual(["I99"]);
  });

  it("never mutates the input state (returns a new object)", () => {
    const original = makeState();
    const originalJson = JSON.stringify(original);
    applyItemStatusUpdates(original, { I01: "approved_to_apply" });
    expect(JSON.stringify(original)).toBe(originalJson);
  });
});

describe("applyItemPatches", () => {
  it("merges apply_status and verification together in one call, leaving other items untouched", () => {
    const verification: AgentImprovementVerification = {
      ranAt: "2026-01-01T00:00:00.000Z",
      validationResults: [{ command: "echo ok", exitCode: 0, stdout: "ok\n", stderr: "", passed: true }],
      passed: true
    };
    const { state, unmatchedIds } = applyItemPatches(makeState(), {
      I01: { apply_status: "verified", verification }
    });
    expect(unmatchedIds).toEqual([]);
    const i01 = state.improvements.find((i) => i.id === "I01");
    expect(i01?.apply_status).toBe("verified");
    expect(i01?.verification).toEqual(verification);
    expect(state.improvements.find((i) => i.id === "I02")?.apply_status).toBe("patch_plan_only");
  });

  it("reports unmatched ids instead of silently ignoring them", () => {
    const { unmatchedIds } = applyItemPatches(makeState(), { I99: { apply_status: "verified" } });
    expect(unmatchedIds).toEqual(["I99"]);
  });

  it("never mutates the input state (returns a new object)", () => {
    const original = makeState();
    const originalJson = JSON.stringify(original);
    applyItemPatches(original, { I01: { apply_status: "verified" } });
    expect(JSON.stringify(original)).toBe(originalJson);
  });
});

describe("parseApprovalAnswer", () => {
  const ids = ["I01", "I02", "I03"];

  it("parses 'approve: I02,I05'-style comma lists, approving only mentioned ids", () => {
    const { decisions, unrecognizedTokens } = parseApprovalAnswer("approve: I01,I03", ids);
    expect(decisions.I01).toBe("approved_to_apply");
    expect(decisions.I02).toBe("do_not_apply");
    expect(decisions.I03).toBe("approved_to_apply");
    expect(unrecognizedTokens).toEqual([]);
  });

  it("is case-insensitive and tolerates space separators", () => {
    const { decisions } = parseApprovalAnswer("approve i01 i02", ids);
    expect(decisions.I01).toBe("approved_to_apply");
    expect(decisions.I02).toBe("approved_to_apply");
    expect(decisions.I03).toBe("do_not_apply");
  });

  it("'approve all' / 'all' approves every known item", () => {
    for (const answer of ["approve: all", "approve all", "all"]) {
      const { decisions } = parseApprovalAnswer(answer, ids);
      expect(Object.values(decisions).every((d) => d === "approved_to_apply")).toBe(true);
    }
  });

  it("'approve: none' / 'none' / empty answer rejects everything (opt-in only)", () => {
    for (const answer of ["approve: none", "none", ""]) {
      const { decisions } = parseApprovalAnswer(answer, ids);
      expect(Object.values(decisions).every((d) => d === "do_not_apply")).toBe(true);
    }
  });

  it("defaults every unmentioned item to do_not_apply -- approval must be opt-in", () => {
    const { decisions } = parseApprovalAnswer("approve: I01", ids);
    expect(decisions.I02).toBe("do_not_apply");
    expect(decisions.I03).toBe("do_not_apply");
  });

  it("surfaces unrecognized tokens instead of silently dropping typos", () => {
    const { unrecognizedTokens, decisions } = parseApprovalAnswer("approve: I01,I99", ids);
    expect(unrecognizedTokens).toEqual(["i99"]);
    expect(decisions.I01).toBe("approved_to_apply");
  });
});

describe("parsePushDeployAnswer", () => {
  const verifiedIds = ["I01", "I02", "I03"];

  it("parses 'push: <ids>' without deploy", () => {
    const { pushIds, deploy, unrecognizedTokens } = parsePushDeployAnswer("push: I01,I03", verifiedIds);
    expect(pushIds).toEqual(["I01", "I03"]);
    expect(deploy).toBe(false);
    expect(unrecognizedTokens).toEqual([]);
  });

  it("parses 'push: <ids> deploy' with the trailing deploy keyword", () => {
    const { pushIds, deploy } = parsePushDeployAnswer("push: I01 deploy", verifiedIds);
    expect(pushIds).toEqual(["I01"]);
    expect(deploy).toBe(true);
  });

  it("'push: all' selects every verified item", () => {
    const { pushIds } = parsePushDeployAnswer("push: all", verifiedIds);
    expect(pushIds).toEqual(verifiedIds);
  });

  it("'push: all deploy' selects everything and deploys", () => {
    const { pushIds, deploy } = parsePushDeployAnswer("push: all deploy", verifiedIds);
    expect(pushIds).toEqual(verifiedIds);
    expect(deploy).toBe(true);
  });

  it("'push: none' / empty answer selects nothing and never deploys", () => {
    for (const answer of ["push: none", "none", ""]) {
      const { pushIds, deploy } = parsePushDeployAnswer(answer, verifiedIds);
      expect(pushIds).toEqual([]);
      expect(deploy).toBe(false);
    }
  });

  it("forces deploy:false even if the word 'deploy' appears, when nothing was selected to push", () => {
    const { pushIds, deploy } = parsePushDeployAnswer("push: none deploy", verifiedIds);
    expect(pushIds).toEqual([]);
    expect(deploy).toBe(false);
  });

  it("is case-insensitive", () => {
    const { pushIds, deploy } = parsePushDeployAnswer("PUSH: i01 DEPLOY", verifiedIds);
    expect(pushIds).toEqual(["I01"]);
    expect(deploy).toBe(true);
  });

  it("surfaces unrecognized tokens instead of silently dropping typos", () => {
    const { pushIds, unrecognizedTokens } = parsePushDeployAnswer("push: I01,I99", verifiedIds);
    expect(pushIds).toEqual(["I01"]);
    expect(unrecognizedTokens).toEqual(["i99"]);
  });
});

describe("read/writeAgentImprovementFile (real filesystem round trip)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-improvement-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns undefined when the file doesn't exist yet (Step 13 hasn't run)", async () => {
    const result = await readAgentImprovementFile(path.join(tmpDir, "13-agent-improvement.json"));
    expect(result).toBeUndefined();
  });

  it("writes valid JSON that re-parses cleanly, and round-trips through read", async () => {
    const filePath = path.join(tmpDir, "13-agent-improvement.json");
    await writeAgentImprovementFile(filePath, makeState());
    const reRead = await readAgentImprovementFile(filePath);
    expect(reRead?.improvements).toHaveLength(3);
  });

  it("full flow: write -> parse approval answer -> apply updates -> write -> verify", async () => {
    const filePath = path.join(tmpDir, "13-agent-improvement.json");
    await writeAgentImprovementFile(filePath, makeState());

    const state = (await readAgentImprovementFile(filePath))!;
    const ids = state.improvements.map((i) => i.id);
    const { decisions } = parseApprovalAnswer("approve: I01,I03", ids);
    const { state: updated, unmatchedIds } = applyItemStatusUpdates(state, decisions);
    expect(unmatchedIds).toEqual([]);
    await writeAgentImprovementFile(filePath, updated);

    const final = await readAgentImprovementFile(filePath);
    expect(final?.improvements.find((i) => i.id === "I01")?.apply_status).toBe("approved_to_apply");
    expect(final?.improvements.find((i) => i.id === "I02")?.apply_status).toBe("do_not_apply");
    expect(final?.improvements.find((i) => i.id === "I03")?.apply_status).toBe("approved_to_apply");
  });

  it("round-trips a verification result through applyItemPatches -> write -> read", async () => {
    const filePath = path.join(tmpDir, "13-agent-improvement.json");
    await writeAgentImprovementFile(filePath, makeState());

    const state = (await readAgentImprovementFile(filePath))!;
    const verification: AgentImprovementVerification = {
      ranAt: "2026-01-01T00:00:00.000Z",
      validationResults: [
        { command: "python tool.py --check", exitCode: 0, stdout: "all good\n", stderr: "", passed: true }
      ],
      passed: true
    };
    const { state: updated, unmatchedIds } = applyItemPatches(state, {
      I01: {
        apply_status: "verified",
        verification,
        draft: { branch: "apply-improvement/I01-123", worktreePath: "/tmp/cma-staging/.worktrees/I01-123", commitSha: "abc1234" }
      }
    });
    expect(unmatchedIds).toEqual([]);
    await writeAgentImprovementFile(filePath, updated);

    const final = await readAgentImprovementFile(filePath);
    const i01 = final?.improvements.find((i) => i.id === "I01");
    expect(i01?.apply_status).toBe("verified");
    expect(i01?.verification).toEqual(verification);
  });
});
