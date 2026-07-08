/**
 * Tests for skillInjector.ts (§M).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  evaluateTrigger,
  findMatchingSkills,
  formatSkillsForPrompt,
  injectSkillsForWorkflow,
  getMatchedSkillIds,
  type SkillTriggerContext
} from "./skillInjector";
import type { SkillEntry } from "./skillRegistry";
import { extractNodeModelPairs } from "./recipeInjector";

let registryPath: string;
let skillsDir: string;
let workflowDir: string;

beforeEach(async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "skill-inj-"));
  registryPath = path.join(tmp, "skills-registry.json");
  skillsDir = path.join(tmp, "skills");
  workflowDir = path.join(tmp, "workflows");
  await mkdir(skillsDir, { recursive: true });
  await mkdir(workflowDir, { recursive: true });
  await writeFile(registryPath, JSON.stringify({ active: [], retired: {} }));
});

afterEach(async () => {
  await rm(path.dirname(registryPath), { recursive: true, force: true });
});

async function writeSkill(
  skillId: string,
  frontmatter: Record<string, unknown>,
  body = "Skill body."
) {
  const yamlLines: string[] = ["---"];
  for (const [k, v] of Object.entries(frontmatter)) {
    yamlLines.push(`${k}: ${JSON.stringify(v)}`);
  }
  // Trigger needs to be multi-line YAML. Hand-build it.
  yamlLines.length = 0;
  yamlLines.push("---");
  yamlLines.push(`skillId: ${frontmatter.skillId}`);
  yamlLines.push(`version: "${frontmatter.version}"`);
  yamlLines.push(`tier: ${frontmatter.tier}`);
  if (frontmatter.trigger) {
    yamlLines.push("trigger:");
    const trig = frontmatter.trigger as Record<string, unknown>;
    for (const [tk, tv] of Object.entries(trig)) {
      if (tk === "stepId") {
        yamlLines.push(`  stepId: "${tv}"`);
      } else if (tk === "condition") {
        yamlLines.push("  condition:");
        const cond = tv as Record<string, unknown>;
        for (const [ck, cv] of Object.entries(cond)) {
          if (ck === "anyOf") {
            yamlLines.push("    anyOf:");
            for (const entry of cv as Array<Record<string, string>>) {
              const parts = Object.entries(entry).map(([ek, ev]) => `${ek}: "${ev}"`);
              yamlLines.push(`      - { ${parts.join(", ")} }`);
            }
          } else {
            yamlLines.push(`    ${ck}: "${cv}"`);
          }
        }
      }
    }
  }
  yamlLines.push("provenance:");
  yamlLines.push(`  taskOrigin: "${(frontmatter.provenance as Record<string, string>).taskOrigin}"`);
  yamlLines.push(`  createdAt: "${(frontmatter.provenance as Record<string, string>).createdAt}"`);
  yamlLines.push("---");
  const content = `${yamlLines.join("\n")}\n\n${body}`;
  await writeFile(path.join(skillsDir, `${skillId}.md`), content);
}

async function setRegistry(active: string[]) {
  await writeFile(registryPath, JSON.stringify({ active, retired: {} }));
}

function context(stepId: string, workflow: unknown, extra?: Partial<SkillTriggerContext>): SkillTriggerContext {
  return {
    stepId,
    nodeModelPairs: extractNodeModelPairs(workflow),
    ...extra
  };
}

const WORKFLOW_WITH_FP8 = {
  nodes: [
    { id: 1, type: "CLIPLoader", widgets_values: ["qwen_fp8.safetensors"] },
    { id: 2, type: "AIO_Preprocessor" }
  ]
};

const WORKFLOW_WITH_SEEDVR2 = {
  nodes: [
    { id: 1, type: "SeedVR2LoadDiTModel", widgets_values: ["seedvr2_ema_7b_fp16.safetensors"] },
    { id: 2, type: "SeedVR2LoadVAEModel", widgets_values: ["ema_vae_fp16.safetensors"] },
    { id: 3, type: "SeedVR2VideoUpscaler" }
  ]
};

describe("skillInjector.evaluateTrigger", () => {
  it("returns false for core tier skills (handled by static loading)", () => {
    const skill: SkillEntry = {
      frontmatter: {
        skillId: "core",
        version: "1.0.0",
        tier: "core",
        provenance: { taskOrigin: "manual", createdAt: "2026-06-25" }
      },
      filePath: "",
      body: ""
    };
    expect(evaluateTrigger(skill, context("02", WORKFLOW_WITH_FP8))).toBe(false);
  });

  it("returns false when stepId doesn't match", () => {
    const skill: SkillEntry = {
      frontmatter: {
        skillId: "fp8",
        version: "1.0.0",
        tier: "on-demand",
        trigger: { stepId: "02", condition: { nodeType: "CLIPLoader" } },
        provenance: { taskOrigin: "manual", createdAt: "2026-06-25" }
      },
      filePath: "",
      body: ""
    };
    expect(evaluateTrigger(skill, context("04", WORKFLOW_WITH_FP8))).toBe(false);
  });

  it("matches by nodeType in condition", () => {
    const skill: SkillEntry = {
      frontmatter: {
        skillId: "clip",
        version: "1.0.0",
        tier: "on-demand",
        trigger: { stepId: "02", condition: { nodeType: "CLIPLoader" } },
        provenance: { taskOrigin: "manual", createdAt: "2026-06-25" }
      },
      filePath: "",
      body: ""
    };
    expect(evaluateTrigger(skill, context("02", WORKFLOW_WITH_FP8))).toBe(true);
  });

  it("matches by glob nodeType pattern (SeedVR2* matches SeedVR2VideoUpscaler)", () => {
    const skill: SkillEntry = {
      frontmatter: {
        skillId: "seedvr2",
        version: "1.0.0",
        tier: "on-demand",
        trigger: { stepId: "04", condition: { nodeType: "SeedVR2*" } },
        provenance: { taskOrigin: "manual", createdAt: "2026-06-25" }
      },
      filePath: "",
      body: ""
    };
    // SeedVR2VideoUpscaler, SeedVR2LoadDiTModel, SeedVR2LoadVAEModel all match SeedVR2*
    expect(evaluateTrigger(skill, context("04", WORKFLOW_WITH_SEEDVR2))).toBe(true);
  });

  it("glob nodeType does not match unrelated nodes", () => {
    const skill: SkillEntry = {
      frontmatter: {
        skillId: "seedvr2",
        version: "1.0.0",
        tier: "on-demand",
        trigger: { stepId: "04", condition: { nodeType: "SeedVR2*" } },
        provenance: { taskOrigin: "manual", createdAt: "2026-06-25" }
      },
      filePath: "",
      body: ""
    };
    // WORKFLOW_WITH_FP8 has no SeedVR2 nodes
    expect(evaluateTrigger(skill, context("04", WORKFLOW_WITH_FP8))).toBe(false);
  });

  it("matches by modelPattern glob", () => {
    const skill: SkillEntry = {
      frontmatter: {
        skillId: "fp8",
        version: "1.0.0",
        tier: "on-demand",
        trigger: { stepId: "02", condition: { modelPattern: "*fp8*.safetensors" } },
        provenance: { taskOrigin: "manual", createdAt: "2026-06-25" }
      },
      filePath: "",
      body: ""
    };
    expect(evaluateTrigger(skill, context("02", WORKFLOW_WITH_FP8))).toBe(true);
  });

  it("anyOf uses OR semantics", () => {
    const skill: SkillEntry = {
      frontmatter: {
        skillId: "multi",
        version: "1.0.0",
        tier: "on-demand",
        trigger: {
          stepId: "04",
          condition: {
            anyOf: [
              { nodeType: "NonExistentNode" },
              { nodeType: "AIO_Preprocessor" }
            ]
          }
        },
        provenance: { taskOrigin: "manual", createdAt: "2026-06-25" }
      },
      filePath: "",
      body: ""
    };
    expect(evaluateTrigger(skill, context("04", WORKFLOW_WITH_FP8))).toBe(true);
  });

  it("multiple condition keys use AND semantics", () => {
    const skill: SkillEntry = {
      frontmatter: {
        skillId: "and",
        version: "1.0.0",
        tier: "on-demand",
        trigger: {
          stepId: "02",
          condition: { nodeType: "CLIPLoader", modelPattern: "*nomatch*" }
        },
        provenance: { taskOrigin: "manual", createdAt: "2026-06-25" }
      },
      filePath: "",
      body: ""
    };
    expect(evaluateTrigger(skill, context("02", WORKFLOW_WITH_FP8))).toBe(false);
  });

  it("envGte passes when version is sufficient", () => {
    const skill: SkillEntry = {
      frontmatter: {
        skillId: "env",
        version: "1.0.0",
        tier: "on-demand",
        trigger: {
          stepId: "02",
          condition: { nodeType: "CLIPLoader" }
        },
        provenance: { taskOrigin: "manual", createdAt: "2026-06-25" }
      },
      filePath: "",
      body: ""
    };
    // envGte is checked in matchConditionEntry, not at the trigger level.
    // Test it via the anyOf path.
    const skill2: SkillEntry = {
      frontmatter: {
        skillId: "env2",
        version: "1.0.0",
        tier: "on-demand",
        trigger: {
          stepId: "02",
          condition: {
            anyOf: [
              { envGte: { comfy_kitchen: "0.3.0" } }
            ]
          }
        },
        provenance: { taskOrigin: "manual", createdAt: "2026-06-25" }
      },
      filePath: "",
      body: ""
    };
    // Version above floor → match
    expect(evaluateTrigger(skill2, {
      ...context("02", WORKFLOW_WITH_FP8),
      envVersions: { comfy_kitchen: "0.5.0" }
    })).toBe(true);
    // Version below floor → no match
    expect(evaluateTrigger(skill2, {
      ...context("02", WORKFLOW_WITH_FP8),
      envVersions: { comfy_kitchen: "0.1.0" }
    })).toBe(false);
    // Missing env → no match
    expect(evaluateTrigger(skill2, context("02", WORKFLOW_WITH_FP8))).toBe(false);
  });
});

describe("skillInjector.findMatchingSkills", () => {
  it("finds skills whose triggers match the context", async () => {
    await setRegistry(["fp8-skill", "attn-skill"]);
    await writeSkill("fp8-skill", {
      skillId: "fp8-skill",
      version: "1.0.0",
      tier: "on-demand",
      trigger: { stepId: "02", condition: { modelPattern: "*fp8*.safetensors" } },
      provenance: { taskOrigin: "manual", createdAt: "2026-06-25" }
    });
    await writeSkill("attn-skill", {
      skillId: "attn-skill",
      version: "1.0.0",
      tier: "on-demand",
      trigger: { stepId: "04", condition: { nodeType: "AIO_Preprocessor" } },
      provenance: { taskOrigin: "manual", createdAt: "2026-06-25" }
    });

    // Step 02 with FP8 workflow → only fp8-skill matches
    const matches02 = findMatchingSkills(context("02", WORKFLOW_WITH_FP8), registryPath, skillsDir);
    expect(matches02).toHaveLength(1);
    expect(matches02[0].frontmatter.skillId).toBe("fp8-skill");

    // Step 04 → only attn-skill matches
    const matches04 = findMatchingSkills(context("04", WORKFLOW_WITH_FP8), registryPath, skillsDir);
    expect(matches04).toHaveLength(1);
    expect(matches04[0].frontmatter.skillId).toBe("attn-skill");
  });
});

describe("skillInjector.formatSkillsForPrompt", () => {
  it("returns empty string for no skills", () => {
    expect(formatSkillsForPrompt([])).toBe("");
  });

  it("produces markdown with skill headers and bodies", () => {
    const skills: SkillEntry[] = [
      {
        frontmatter: {
          skillId: "test-skill",
          version: "1.0.0",
          tier: "on-demand",
          trigger: { stepId: "02", condition: { nodeType: "X" } },
          provenance: { taskOrigin: "manual", createdAt: "2026-06-25" }
        },
        filePath: "",
        body: "Do the thing."
      }
    ];
    const out = formatSkillsForPrompt(skills);
    expect(out).toContain("Matched on-demand skills");
    expect(out).toContain("test-skill");
    expect(out).toContain("v1.0.0");
    expect(out).toContain("Do the thing.");
  });
});

describe("skillInjector.injectSkillsForWorkflow", () => {
  it("returns skill content when trigger matches", async () => {
    await setRegistry(["fp8-skill"]);
    await writeSkill("fp8-skill", {
      skillId: "fp8-skill",
      version: "1.0.0",
      tier: "on-demand",
      trigger: { stepId: "02", condition: { modelPattern: "*fp8*.safetensors" } },
      provenance: { taskOrigin: "manual", createdAt: "2026-06-25" }
    }, "FP8 checklist body.");

    const wfPath = path.join(workflowDir, "wf.json");
    await writeFile(wfPath, JSON.stringify(WORKFLOW_WITH_FP8));

    const result = await injectSkillsForWorkflow({
      workflowPath: wfPath,
      stepId: "02",
      registryPath,
      skillsDir
    });
    expect(result).toContain("fp8-skill");
    expect(result).toContain("FP8 checklist body.");
  });

  it("returns empty string when no triggers match", async () => {
    await setRegistry(["fp8-skill"]);
    await writeSkill("fp8-skill", {
      skillId: "fp8-skill",
      version: "1.0.0",
      tier: "on-demand",
      trigger: { stepId: "02", condition: { modelPattern: "*fp8*.safetensors" } },
      provenance: { taskOrigin: "manual", createdAt: "2026-06-25" }
    });

    const wfPath = path.join(workflowDir, "wf.json");
    await writeFile(wfPath, JSON.stringify({ nodes: [{ type: "PreviewImage" }] }));

    const result = await injectSkillsForWorkflow({
      workflowPath: wfPath,
      stepId: "02",
      registryPath,
      skillsDir
    });
    expect(result).toBe("");
  });

  it("returns empty string when workflow file is missing", async () => {
    const result = await injectSkillsForWorkflow({
      workflowPath: "/nonexistent/wf.json",
      stepId: "02",
      registryPath,
      skillsDir
    });
    expect(result).toBe("");
  });
});

describe("skillInjector.getMatchedSkillIds", () => {
  it("returns skillIds for matched skills", async () => {
    await setRegistry(["fp8-skill"]);
    await writeSkill("fp8-skill", {
      skillId: "fp8-skill",
      version: "1.0.0",
      tier: "on-demand",
      trigger: { stepId: "02", condition: { modelPattern: "*fp8*.safetensors" } },
      provenance: { taskOrigin: "manual", createdAt: "2026-06-25" }
    });

    const ids = getMatchedSkillIds(context("02", WORKFLOW_WITH_FP8), registryPath, skillsDir);
    expect(ids).toEqual(["fp8-skill"]);
  });
});
