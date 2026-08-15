// ─────────────────────────────────────────────────────────────────────────────
// Skill / recipe LOADING AUDIT
//
// Verifies that everything the copilot agent is supposed to receive per step is
// actually loadable -- so a missing/renamed skill file, a broken frontmatter, an
// invalid recipe, a dangling reference link, or an active on-demand skill that
// isn't on disk fails LOUDLY (a test gates the deploy) instead of the agent
// silently getting "(No dedicated skill file...)" or a linked doc that 404s.
//
// Layers checked (mirrors promptSkillCompiler's three injection layers):
//   1. Per-step prompt + skill bindings (skillPath/promptPath exist).
//   2. On-demand skills: every active id (repo seed ∪ runtime) loads + validates.
//   3. Recipes: every recipe file validates against the recipe schema.
//   4. Reference-link integrity: every `[..](*.md)` link inside a skill resolves
//      (the "soft" reference docs like wan22/ladder must at least exist).
// ─────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "./config";
import { loadStepDefinitions } from "./workflowLoader";
import { loadActiveSkills, resolveActiveSkillIds } from "./skillRegistry";
import { loadAllRecipes } from "./recipeLibrary";

export interface LoadingAuditProblem {
  kind:
    | "step_prompt_missing"
    | "step_skill_missing"
    | "ondemand_skill_invalid"
    | "recipe_invalid"
    | "dangling_reference_link";
  detail: string;
}

export interface SkillLoadingAuditInput {
  /** Dir that contains `migration-workflow-v2/…` (default: `<cwd>/prompts`). */
  draftDocRoot?: string;
  /** The skills dir (default: `<draftDocRoot>/migration-workflow-v2/skills`). */
  skillsDir?: string;
  /** Recipes root (default: `<cwd>/recipes`). */
  recipesRoot?: string;
  /** Runtime registry path (default: none -> only the version-controlled seed). */
  registryPath?: string;
}

/**
 * Run the full loading audit. Returns a list of problems (empty = everything the
 * agent needs is loadable). Never throws.
 */
export async function auditSkillRecipeLoading(
  input: SkillLoadingAuditInput = {}
): Promise<LoadingAuditProblem[]> {
  const cwd = process.cwd();
  const draftDocRoot = input.draftDocRoot ?? path.join(cwd, "prompts");
  const skillsDir = input.skillsDir ?? path.join(draftDocRoot, "migration-workflow-v2", "skills");
  const recipesRoot = input.recipesRoot ?? path.join(cwd, "recipes");
  // Default to a path that doesn't exist so the audit reflects the VERSION-CONTROLLED
  // seed (what ships), not whatever per-host promotions happen to be present.
  const registryPath = input.registryPath ?? path.join(cwd, ".demo-state", "__audit_no_runtime_registry__.json");
  const problems: LoadingAuditProblem[] = [];

  // 1. Per-step prompt + skill bindings resolve to real files.
  try {
    const steps = await loadStepDefinitions({ draftDocRoot } as AppConfig);
    for (const step of steps) {
      if (step.promptPath && !fs.existsSync(step.promptPath)) {
        problems.push({ kind: "step_prompt_missing", detail: `step ${step.id}: prompt file missing: ${step.promptPath}` });
      }
      if (step.skillPath && !fs.existsSync(step.skillPath)) {
        problems.push({ kind: "step_skill_missing", detail: `step ${step.id}: skill file missing: ${step.skillPath}` });
      }
    }
  } catch (e) {
    problems.push({ kind: "step_skill_missing", detail: `loadStepDefinitions threw: ${e instanceof Error ? e.message : String(e)}` });
  }

  // 2. Every active on-demand skill (repo seed ∪ runtime) loads + validates.
  const { invalid } = loadActiveSkills(registryPath, skillsDir);
  for (const bad of invalid) {
    problems.push({ kind: "ondemand_skill_invalid", detail: `on-demand skill '${bad.skillId}': ${bad.reason}` });
  }

  // 3. Every recipe validates against the schema.
  const recipes = loadAllRecipes(recipesRoot);
  for (const bad of recipes.invalid) {
    problems.push({ kind: "recipe_invalid", detail: `recipe ${bad.file}: ${bad.reason}` });
  }
  for (const bad of recipes.unparseable) {
    problems.push({ kind: "recipe_invalid", detail: `recipe ${bad.file} (unparseable): ${bad.reason}` });
  }

  // 4. Reference-link integrity: every `[text](something.md)` in a skill resolves.
  //    Catches dangling links to the soft reference docs (wan22, ladder, etc.).
  problems.push(...auditReferenceLinks(skillsDir));

  return problems;
}

const MD_LINK_RE = /\]\(([^)]+?\.md)\)/g;

function auditReferenceLinks(skillsDir: string): LoadingAuditProblem[] {
  const out: LoadingAuditProblem[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
  } catch {
    return out;
  }
  for (const file of files) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(skillsDir, file), "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(MD_LINK_RE)) {
      const target = m[1].trim();
      // Only check relative links to sibling skill docs (skip http(s) + absolute).
      if (/^https?:\/\//.test(target) || target.startsWith("/")) continue;
      const resolved = path.join(skillsDir, target);
      if (!fs.existsSync(resolved)) {
        out.push({ kind: "dangling_reference_link", detail: `${file} links to missing '${target}'` });
      }
    }
  }
  return out;
}

/** Convenience: the active on-demand skill ids the agent would see (seed ∪ runtime). */
export function auditActiveSkillIds(input: SkillLoadingAuditInput = {}): string[] {
  const cwd = process.cwd();
  const draftDocRoot = input.draftDocRoot ?? path.join(cwd, "prompts");
  const skillsDir = input.skillsDir ?? path.join(draftDocRoot, "migration-workflow-v2", "skills");
  const registryPath = input.registryPath ?? path.join(cwd, ".demo-state", "__audit_no_runtime_registry__.json");
  return resolveActiveSkillIds(registryPath, skillsDir);
}
