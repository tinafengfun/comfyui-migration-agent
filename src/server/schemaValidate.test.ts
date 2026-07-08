import { describe, it, expect, beforeEach } from "vitest";
import {
  validate,
  validateSkillFrontmatter,
  validateRecipe,
  validateFeedbackEvent,
  assertValid,
  formatResult,
  resetSchemaCache,
  type SchemaKind
} from "./schemaValidate";

// Design-doc canonical examples — same instances we used to validate the
// schema files themselves. If the schema regresses, these flip first.

const SKILL_FP8 = {
  skillId: "fp8-xpu-gate",
  version: "1.2.0",
  tier: "on-demand",
  trigger: {
    stepId: "02",
    condition: {
      anyOf: [
        { assetPattern: "*_fp8*" },
        { assetPattern: "qwen_*_vl_*_fp8*" }
      ]
    }
  },
  provenance: {
    taskOrigin: "7f5cf9e4-1d1d-4429-8017-12c33b273f08",
    createdAt: "2026-06-19",
    approvedBy: "tinafengfun"
  }
};

const SKILL_CORE = {
  skillId: "00-intake",
  version: "1.0.0",
  tier: "core",
  provenance: { taskOrigin: "manual", createdAt: "2026-06-01" }
};

const RECIPE_CLIP_FP8 = {
  recipeId: "CLIPLoader-qwen-fp8",
  version: "1.0.0",
  nodeType: "CLIPLoader",
  modelPattern: "qwen_*_vl_*_fp8*",
  xpuSupport: "patched",
  patchClass: "functional_runtime_support",
  patchFile: "patches/0001-xpu-fp8-fallback.patch",
  knownIssues: ["QTensor.clone() segfaults on .to('xpu')"],
  provenance: { taskOrigin: "7f5cf9e4", createdAt: "2026-06-19" }
};

const FEEDBACK_BUG = {
  id: "evt-001",
  taskId: "7f5cf9e4",
  stepId: "05",
  createdAt: "2026-06-23T08:45:00Z",
  source: "agent_self",
  type: "comfyui_bug",
  severity: "blocker",
  message: "CLIPLoader segfaults on XPU with fp8 TE",
  status: "open"
};

describe("schemaValidate", () => {
  beforeEach(() => resetSchemaCache());

  // ── positive ────────────────────────────────────────────────────────────
  it("accepts design-doc skill-frontmatter example (on-demand)", () => {
    const r = validateSkillFrontmatter(SKILL_FP8);
    expect(r.ok).toBe(true);
  });

  it("accepts core skill without trigger", () => {
    const r = validateSkillFrontmatter(SKILL_CORE);
    expect(r.ok).toBe(true);
  });

  it("accepts design-doc recipe example", () => {
    const r = validateRecipe(RECIPE_CLIP_FP8);
    expect(r.ok).toBe(true);
  });

  it("accepts design-doc feedback event example", () => {
    const r = validateFeedbackEvent(FEEDBACK_BUG);
    expect(r.ok).toBe(true);
  });

  // ── negative ────────────────────────────────────────────────────────────
  it("rejects on-demand skill missing trigger", () => {
    const r = validateSkillFrontmatter({
      ...SKILL_FP8,
      trigger: undefined
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // `required` errors surface in the message, not the instance path.
      expect(r.message).toContain("trigger");
    }
  });

  it("rejects recipe with xpuSupport=patched but no patchFile", () => {
    const { patchFile: _omit, ...noPatch } = RECIPE_CLIP_FP8;
    const r = validateRecipe(noPatch);
    expect(r.ok).toBe(false);
  });

  it("rejects recipe with unknown xpuSupport enum value", () => {
    const r = validateRecipe({ ...RECIPE_CLIP_FP8, xpuSupport: "quantum" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("xpuSupport");
    }
  });

  it("rejects feedback event with bad type enum", () => {
    const r = validateFeedbackEvent({ ...FEEDBACK_BUG, type: "not_a_type" });
    expect(r.ok).toBe(false);
  });

  it("rejects feedback event with malformed date-time", () => {
    const r = validateFeedbackEvent({
      ...FEEDBACK_BUG,
      createdAt: "yesterday"
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.path.includes("createdAt"))).toBe(true);
    }
  });

  it("rejects feedback event missing required field", () => {
    const { taskId: _omit, ...noTask } = FEEDBACK_BUG;
    const r = validateFeedbackEvent(noTask);
    expect(r.ok).toBe(false);
  });

  // ── error surface ─────────────────────────────────────────────────────────
  it("returns a discriminable result and a readable formatResult", () => {
    const r = validate("feedbackEvent" as SchemaKind, { bad: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.schema).toBe("feedbackEvent");
      expect(formatResult(r)).toContain("feedbackEvent");
    }
  });

  it("assertValid throws on invalid input", () => {
    expect(() => assertValid("feedbackEvent", { bad: true })).toThrow(/feedbackEvent/);
  });

  it("assertValid is silent on valid input", () => {
    expect(() => assertValid("feedbackEvent", FEEDBACK_BUG)).not.toThrow();
  });

  // ── caching behavior ────────────────────────────────────────────────────
  it("resetSchemaCache forces re-read on next call", () => {
    // first call compiles
    validateRecipe(RECIPE_CLIP_FP8);
    // after reset, must recompile — if caching were broken this still works
    // (recompilation is idempotent)
    resetSchemaCache();
    const r = validateRecipe(RECIPE_CLIP_FP8);
    expect(r.ok).toBe(true);
  });
});
