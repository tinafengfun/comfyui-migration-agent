/**
 * Skill registry + loader (§M — soft-injection layer).
 *
 * What this is:
 *   The skills-registry.json file lists which on-demand skills are active.
 *   This module loads the registry, finds the matching .md files under the
 *   skills directory, parses their YAML frontmatter, and validates against
 *   skill-frontmatter.schema.json.
 *
 * How it differs from recipeLibrary (§I):
 *   Recipes are loaded from a global directory and matched by nodeType +
 *   modelPattern. Skills are loaded from the draft-doc prompts tree, listed
 *   in a registry file, and matched by trigger conditions (stepId, asset
 *   patterns, node types, env versions). Recipes = deterministic hard
 *   injection; skills = soft fallback (design §5.2, feedback memory
 *   two_layer_injection).
 *
 * Who calls this:
 *   - skillInjector.findMatchingSkills() — loads active skills, evaluates triggers
 *   - Step 13 agent-improvement — lists skills for review/retirement
 *   - Future UI — lists, adds, retires skills
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { load as yamlLoad } from "js-yaml";
import { GLOBAL_DIRS, skillsDir } from "./paths";
import { validate, type ValidationResult } from "./schemaValidate";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SkillTriggerCondition {
  anyOf?: Array<{
    assetPattern?: string;
    nodeType?: string;
    modelPattern?: string;
    envGte?: Record<string, string>;
  }>;
  assetPattern?: string;
  nodeType?: string;
  modelPattern?: string;
}

export interface SkillTrigger {
  /** One step id ("08") or several ("07"/"08") -- the skill injects at any of them. */
  stepId: string | string[];
  condition: SkillTriggerCondition;
}

export interface SkillFrontmatter {
  skillId: string;
  version: string;
  tier: "core" | "on-demand" | "reference";
  trigger?: SkillTrigger;
  provenance: {
    taskOrigin: string;
    evidenceArtifact?: string;
    createdAt: string;
    approvedBy?: string;
  };
  retireCondition?: { envGte?: Record<string, string>; reason?: string };
  tags?: string[];
}

export interface SkillEntry {
  frontmatter: SkillFrontmatter;
  /** Absolute path to the .md file. */
  filePath: string;
  /** Markdown body after the frontmatter block. */
  body: string;
}

export interface SkillRegistryLoadResult {
  skills: SkillEntry[];
  /** skillIds that failed schema validation or file read. */
  invalid: Array<{ skillId: string; reason: string }>;
}

interface RegistryShape {
  active: string[];
  retired: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry file
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load the skills-registry.json file. Returns `{active: [], retired: {}}`
 * if the file doesn't exist (fresh checkout — no on-demand skills yet).
 */
export function loadRegistry(registryPath: string = GLOBAL_DIRS.skillsRegistry): RegistryShape {
  if (!existsSync(registryPath)) return { active: [], retired: {} };
  try {
    const raw = readFileSync(registryPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<RegistryShape>;
    return {
      active: Array.isArray(parsed.active) ? parsed.active.filter((s) => typeof s === "string") : [],
      retired: parsed.retired && typeof parsed.retired === "object" ? parsed.retired as RegistryShape["retired"] : {}
    };
  } catch {
    return { active: [], retired: {} };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill loader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load all active skills listed in the registry. For each skillId:
 *   1. Look for `<skillsDir>/<skillId>.md`
 *   2. Parse YAML frontmatter from the top of the file
 *   3. Validate against skill-frontmatter.schema.json
 *
 * Skills that fail validation or are missing from disk go to `invalid[]`;
 * healthy skills still load.
 */
/**
 * The set of active on-demand skillIds = the VERSION-CONTROLLED repo seed
 * (`<skillsDir>/skills-registry.default.json`, synced by deploy) UNION the runtime
 * `.demo-state/skills-registry.json` (per-host promotions), minus any id retired in
 * either. The seed is what makes on-demand skills guaranteed across deployments --
 * the runtime file alone is not synced, so a skill listed only there would silently
 * not load on a fresh host.
 */
export function resolveActiveSkillIds(
  registryPath: string = GLOBAL_DIRS.skillsRegistry,
  dir: string = skillsDir(path.join(process.cwd(), "prompts"))
): string[] {
  const runtime = loadRegistry(registryPath);
  const seed = loadRegistry(path.join(dir, "skills-registry.default.json"));
  const retired = new Set([...Object.keys(runtime.retired ?? {}), ...Object.keys(seed.retired ?? {})]);
  const active = new Set<string>();
  for (const id of [...seed.active, ...runtime.active]) if (!retired.has(id)) active.add(id);
  return [...active];
}

export function loadActiveSkills(
  registryPath: string = GLOBAL_DIRS.skillsRegistry,
  dir: string = skillsDir(path.join(process.cwd(), "prompts"))
): SkillRegistryLoadResult {
  const result: SkillRegistryLoadResult = { skills: [], invalid: [] };
  const active = resolveActiveSkillIds(registryPath, dir);
  if (active.length === 0) return result;

  for (const skillId of active) {
    const filePath = path.join(dir, `${skillId}.md`);
    if (!existsSync(filePath)) {
      result.invalid.push({ skillId, reason: `file not found: ${filePath}` });
      continue;
    }
    const parsed = parseFrontmatter(filePath);
    if (!parsed) {
      result.invalid.push({ skillId, reason: "failed to parse frontmatter" });
      continue;
    }
    const v: ValidationResult = validate("skillFrontmatter", parsed.frontmatter);
    if (!v.ok) {
      result.invalid.push({
        skillId,
        reason: v.errors.map((e) => `${e.path}: ${e.message}`).join("; ")
      });
      continue;
    }
    result.skills.push({
      frontmatter: parsed.frontmatter as SkillFrontmatter,
      filePath,
      body: parsed.body
    });
  }

  result.skills.sort((a, b) => a.frontmatter.skillId.localeCompare(b.frontmatter.skillId));
  return result;
}

/** Look up a single skill by skillId. Returns undefined if missing or invalid. */
export function findSkillById(
  skillId: string,
  registryPath: string = GLOBAL_DIRS.skillsRegistry,
  dir: string = skillsDir(path.join(process.cwd(), "prompts"))
): SkillEntry | undefined {
  return loadActiveSkills(registryPath, dir).skills.find((s) => s.frontmatter.skillId === skillId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse YAML frontmatter from the top of a .md file. Returns null if the
 * file doesn't start with `---` or the frontmatter block is malformed.
 */
function parseFrontmatter(
  filePath: string
): { frontmatter: unknown; body: string } | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  if (!raw.startsWith("---")) return null;

  const end = raw.indexOf("\n---", 3);
  if (end === -1) return null;

  const yamlBlock = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\n/, "");
  try {
    const frontmatter = yamlLoad(yamlBlock);
    if (frontmatter === null || typeof frontmatter !== "object") return null;
    return { frontmatter, body };
  } catch {
    return null;
  }
}
