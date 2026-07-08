/**
 * Skill injector (§M — soft-injection layer).
 *
 * Implements the "soft injection" layer of the two-layer knowledge design
 * (see feedback memory: two_layer_injection.md). Where recipes (§L) inject
 * deterministically by nodeType + modelPattern, skills inject by trigger
 * conditions — stepId + asset/node/model/env patterns. This catches cases
 * recipes can't express: multi-node patterns, version-conditional logic,
 * workflow-shaped triggers.
 *
 * What this does:
 *   1. Load active on-demand skills from the registry (skillRegistry.ts).
 *   2. For each skill, evaluate its trigger against the current step context.
 *   3. Format matched skills as a markdown section for the step prompt.
 *
 * Scope:
 *   Unlike recipes (gated to steps 02/04/05), skills fire for ANY step whose
 *   trigger matches. Each skill's frontmatter declares which stepId it
 *   targets, so per-step gating happens naturally via trigger evaluation.
 *
 * Failure mode:
 *   Everything is best-effort. Missing registry, bad workflow JSON, missing
 *   skill files — all return empty string, never break the step.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { extractNodeModelPairs, type NodeModelPair } from "./recipeInjector";
import { loadActiveSkills, type SkillEntry } from "./skillRegistry";
import { GLOBAL_DIRS, skillsDir } from "./paths";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SkillTriggerContext {
  stepId: string;
  /** (nodeType, modelFilename?) pairs extracted from the source workflow. */
  nodeModelPairs: NodeModelPair[];
  /** Asset filenames available in the task (e.g. staged model files). */
  assetFilenames?: string[];
  /** Installed environment versions for envGte checks. */
  envVersions?: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Trigger evaluation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluate whether a skill's trigger matches the given context.
 *
 * Rules:
 *   1. Only on-demand skills participate (core/reference are loaded statically).
 *   2. trigger.stepId must match context.stepId.
 *   3. Condition keys are AND'd; anyOf entries are OR'd.
 *
 * Exported for testing; production callers use findMatchingSkills.
 */
export function evaluateTrigger(skill: SkillEntry, context: SkillTriggerContext): boolean {
  const fm = skill.frontmatter;
  if (fm.tier !== "on-demand") return false;
  if (!fm.trigger) return false;
  if (fm.trigger.stepId !== context.stepId) return false;

  const cond = fm.trigger.condition;
  if (!cond) return false;

  // anyOf: OR over entries; each entry is AND of its keys.
  if (cond.anyOf && cond.anyOf.length > 0) {
    return cond.anyOf.some((entry) => matchConditionEntry(entry, context));
  }

  // Top-level condition keys (no anyOf): all must match.
  return matchConditionEntry(
    {
      assetPattern: cond.assetPattern,
      nodeType: cond.nodeType,
      modelPattern: cond.modelPattern
    },
    context
  );
}

interface ConditionEntry {
  assetPattern?: string;
  nodeType?: string;
  modelPattern?: string;
  envGte?: Record<string, string>;
}

function matchConditionEntry(entry: ConditionEntry, context: SkillTriggerContext): boolean {
  if (entry.assetPattern) {
    const assets = context.assetFilenames ?? [];
    if (!assets.some((a) => globMatch(entry.assetPattern!, a))) return false;
  }
  if (entry.nodeType) {
    // Glob match: "SeedVR2*" matches SeedVR2VideoUpscaler, SeedVR2LoadDiTModel, etc.
    // This handles the many naming variants in real ComfyUI custom nodes.
    if (!context.nodeModelPairs.some((p) => globMatch(entry.nodeType!, p.nodeType ?? ""))) return false;
  }
  if (entry.modelPattern) {
    const models = context.nodeModelPairs
      .map((p) => p.modelFilename)
      .filter((m): m is string => typeof m === "string");
    if (!models.some((m) => globMatch(entry.modelPattern!, m))) return false;
  }
  if (entry.envGte) {
    const env = context.envVersions ?? {};
    for (const [key, floor] of Object.entries(entry.envGte)) {
      const actual = env[key];
      if (!actual || !versionGte(actual, floor)) return false;
    }
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Matching + formatting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find all active on-demand skills whose triggers match the context.
 * Loads the registry once, filters, evaluates triggers.
 */
export function findMatchingSkills(
  context: SkillTriggerContext,
  registryPath: string = GLOBAL_DIRS.skillsRegistry,
  dir: string = skillsDir(path.join(process.cwd(), "prompts"))
): SkillEntry[] {
  const { skills } = loadActiveSkills(registryPath, dir);
  return skills.filter((s) => evaluateTrigger(s, context));
}

/**
 * Format matched skills as a markdown prompt section.
 * Each skill gets a header with skillId + version, then the full body.
 */
export function formatSkillsForPrompt(skills: SkillEntry[]): string {
  if (skills.length === 0) return "";
  const blocks = skills.map((s) => {
    const header = `### Skill: ${s.frontmatter.skillId} (v${s.frontmatter.version})`;
    return [header, "", s.body.trim()].join("\n");
  });
  return ["## Matched on-demand skills (from skill registry)", ...blocks].join("\n\n");
}

/**
 * Top-level entry: read workflow, build context, find matching skills,
 * format for prompt. Returns "" on any error or when no skills match.
 * Never throws.
 */
export async function injectSkillsForWorkflow(input: {
  workflowPath: string;
  stepId: string;
  assetFilenames?: string[];
  envVersions?: Record<string, string>;
  registryPath?: string;
  skillsDir?: string;
}): Promise<string> {
  try {
    const raw = await readFile(input.workflowPath, "utf8");
    const workflow = JSON.parse(raw);
    const pairs = extractNodeModelPairs(workflow);
    const context: SkillTriggerContext = {
      stepId: input.stepId,
      nodeModelPairs: pairs,
      assetFilenames: input.assetFilenames,
      envVersions: input.envVersions
    };
    const matches = findMatchingSkills(
      context,
      input.registryPath,
      input.skillsDir ?? skillsDir(path.join(process.cwd(), "prompts"))
    );
    return formatSkillsForPrompt(matches);
  } catch {
    return "";
  }
}

/**
 * Return the skillIds that would be injected for the given context.
 * Used by analytics tracking (§H) to record which skills fired.
 */
export function getMatchedSkillIds(
  context: SkillTriggerContext,
  registryPath?: string,
  dir?: string
): string[] {
  return findMatchingSkills(context, registryPath, dir).map((s) => s.frontmatter.skillId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal glob matcher (same semantics as recipeLibrary.globMatch).
 *   * -> [^/]*   ? -> [^/]
 */
function globMatch(pattern: string, input: string): boolean {
  let re = "^";
  for (const ch of pattern) {
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  re += "$";
  return new RegExp(re).test(input);
}

/**
 * Simple semver >= comparison. Both values must be "X.Y.Z".
 * Returns true if actual >= floor.
 */
function versionGte(actual: string, floor: string): boolean {
  const a = actual.split(".").map((n) => parseInt(n, 10));
  const b = floor.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return true; // equal
}
