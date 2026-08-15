import path from "node:path";
import { describe, expect, it } from "vitest";
import { auditSkillRecipeLoading, auditActiveSkillIds } from "./skillLoadingAudit";
import { findMatchingSkills } from "./skillInjector";
import type { SkillTriggerContext } from "./skillInjector";

const REPO = process.cwd();
const SKILLS_DIR = path.join(REPO, "prompts", "migration-workflow-v2", "skills");
// Force the audit/injection to reflect the VERSION-CONTROLLED seed only (not any
// per-host runtime .demo-state registry), so the test is deterministic + is exactly
// what ships on a fresh deployment.
const NO_RUNTIME = path.join(REPO, ".demo-state", "__test_no_runtime_registry__.json");

describe("skill/recipe loading audit — everything the agent needs is loadable (deploy gate)", () => {
  it("has ZERO loading problems across step bindings, on-demand skills, recipes, and reference links", async () => {
    const problems = await auditSkillRecipeLoading({ registryPath: NO_RUNTIME });
    // Print details so a failure names the exact broken file, not just a count.
    expect(problems, JSON.stringify(problems, null, 2)).toEqual([]);
  });

  it("the version-controlled seed activates wan22-capacity-reference (guaranteed on a fresh deploy)", () => {
    const ids = auditActiveSkillIds({ registryPath: NO_RUNTIME });
    expect(ids).toContain("wan22-capacity-reference");
    expect(ids).toContain("fp8-feasibility-checklist");
  });
});

describe("WAN2.2 capacity reference injects at the steps that need it (02/07/08), not elsewhere", () => {
  function wanContext(stepId: string): SkillTriggerContext {
    return {
      stepId,
      // A native-WAN workflow node (BerniniConditioning) — matches the wan22 trigger.
      nodeModelPairs: [
        { nodeType: "BerniniConditioning" },
        { nodeType: "UNETLoader", modelFilename: "Bernini_HIGH_fp8_e4m3fn_scaled.safetensors" }
      ]
    };
  }
  function matchedIds(stepId: string): string[] {
    return findMatchingSkills(wanContext(stepId), NO_RUNTIME, SKILLS_DIR).map((s) => s.frontmatter.skillId);
  }

  it("injects wan22-capacity-reference at Step 08 (multi-step trigger)", () => {
    expect(matchedIds("08")).toContain("wan22-capacity-reference");
  });
  it("injects wan22-capacity-reference at Step 07 and Step 02 too", () => {
    expect(matchedIds("07")).toContain("wan22-capacity-reference");
    expect(matchedIds("02")).toContain("wan22-capacity-reference");
  });
  it("does NOT inject wan22-capacity-reference at an unrelated step (e.g. 05)", () => {
    expect(matchedIds("05")).not.toContain("wan22-capacity-reference");
  });
  it("does NOT inject wan22 for a non-WAN workflow at Step 08", () => {
    const ctx: SkillTriggerContext = { stepId: "08", nodeModelPairs: [{ nodeType: "KSampler" }, { nodeType: "VAEDecode" }] };
    const ids = findMatchingSkills(ctx, NO_RUNTIME, SKILLS_DIR).map((s) => s.frontmatter.skillId);
    expect(ids).not.toContain("wan22-capacity-reference");
  });
});
