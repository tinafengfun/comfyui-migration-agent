/**
 * Single source of truth for all migration-agent path constants.
 *
 * Why this file exists:
 *   - Subdir/file names were hardcoded across taskWorkspaces.ts, orchestrator.ts,
 *     phase1Agent.ts, and tests, leading to drift and typos.
 *   - The self-evolution + memory design (docs/evolution-and-memory-design.md)
 *     introduces new per-task dirs (feedback/, escalation/) and global dirs
 *     (recipes/, schemas/, patches/, debug-archives/) that need a single home.
 *
 * Usage rules:
 *   - Base roots (workspaceRoot, stateRoot, comfyuiRoot) come from config.ts.
 *   - This module owns subdir/file *names* and composes them into helpers.
 *   - Always import constants from here; never inline "feedback" or "previews"
 *     as string literals in other files.
 *   - For env-var overrides of global dirs, see EnvOverride below.
 */
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Per-task workspace subdir and file names
// ─────────────────────────────────────────────────────────────────────────────

/** Subdirectories created under <workspaceRoot>/<taskId>/. */
export const TASK_SUBDIRS = {
  source: "source",
  artifacts: "artifacts",
  cache: "cache",
  outputs: "outputs",
  logs: "logs",
  package: "package",
  /** Per-task feedback events (design §L3 / §G). */
  feedback: "feedback",
  /** Per-task escalation bundles for opencode handoff (design §L3 / §E). */
  escalation: "escalation"
} as const;

/** Subdirectories of <taskId>/cache/. */
export const CACHE_SUBDIRS = {
  customNodes: "custom_nodes",
  comfyUser: "comfyui-user"
} as const;

/** Subdirectories of <taskId>/outputs/. Keyed by step id. */
export const STEP_OUTPUT_SUBDIR: Readonly<Record<string, string>> = {
  "07": "previews",
  "08": "validation-runs",
  "12": "gui-acceptance"
} as const;

/** Filenames standard to every task workspace. */
export const TASK_FILES = {
  taskState: "task-state.json",
  sdkLog: "sdk-session.jsonl",
  packageManifest: "manifest.json",
  bundle: "migration-bundle.zip",
  /** Per-task feedback event log (JSON Lines, design §G). */
  feedbackEvents: "feedback-events.jsonl",
  /** Per-task escalation summary written before opencode handoff. */
  escalationSummary: "escalation-summary.md"
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Global dir env overrides
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Global dirs default to <projectRoot>/<name> but can be relocated via env vars
 * for deployments that want them on a different mount point.
 */
const projectRoot = process.cwd();
function resolveGlobal(value: string | undefined, fallback: string): string {
  return path.isAbsolute(value ?? "") ? (value as string) : path.resolve(projectRoot, value ?? fallback);
}

export const GLOBAL_DIRS = {
  /** Version-controlled reusable recipes (design §I). */
  recipesRoot: resolveGlobal(process.env.MIGRATION_RECIPES_DIR, "recipes"),
  /** Version-controlled JSON schemas (design §A). */
  schemasRoot: resolveGlobal(process.env.MIGRATION_SCHEMAS_DIR, "schemas"),
  /** Patch files applied to ComfyUI source (e.g. xpu-bug-investigation/*). */
  patchesRoot: resolveGlobal(process.env.MIGRATION_PATCHES_DIR, "patches"),
  /** Out-of-band debug archives, pruned by cron (design §C). */
  debugArchivesRoot: resolveGlobal(process.env.MIGRATION_DEBUG_ARCHIVES_DIR, "debug-archives"),
  /** Aggregated analytics DB (design §H). */
  analyticsDb: resolveGlobal(process.env.MIGRATION_ANALYTICS_DB, ".demo-state/analytics.sqlite"),
  /** Skills registry file — active/retired lists (design §5.2/§M). */
  skillsRegistry: resolveGlobal(process.env.MIGRATION_SKILLS_REGISTRY, ".demo-state/skills-registry.json"),
  /** Protocol docs — single-context files injected when matching recipes need them (e.g. patch adaptation). */
  protocolsRoot: resolveGlobal(process.env.MIGRATION_PROTOCOLS_DIR, "prompts/migration-workflow-v2/protocols")
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Schema file paths (design §A)
// ─────────────────────────────────────────────────────────────────────────────

export const SCHEMA_FILES = {
  skillFrontmatter: path.join(GLOBAL_DIRS.schemasRoot, "skill-frontmatter.schema.json"),
  recipe: path.join(GLOBAL_DIRS.schemasRoot, "recipe.schema.json"),
  feedbackEvent: path.join(GLOBAL_DIRS.schemasRoot, "feedback-event.schema.json")
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Per-task path helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compose a per-task path. Use this when you only need one path and have the
 * workspaceRoot in hand. taskWorkspaces.ts remains the source of truth for the
 * full TaskWorkspaceLayout; these helpers cover the new design dirs that
 * aren't yet in the layout interface.
 */
export function taskDir(workspaceRoot: string, taskId: string): string {
  return path.join(path.resolve(workspaceRoot), taskId);
}

export function taskFeedbackDir(workspaceRoot: string, taskId: string): string {
  return path.join(taskDir(workspaceRoot, taskId), TASK_SUBDIRS.feedback);
}

export function taskFeedbackEventsPath(workspaceRoot: string, taskId: string): string {
  return path.join(taskFeedbackDir(workspaceRoot, taskId), TASK_FILES.feedbackEvents);
}

export function taskEscalationDir(workspaceRoot: string, taskId: string): string {
  return path.join(taskDir(workspaceRoot, taskId), TASK_SUBDIRS.escalation);
}

export function taskEscalationSummaryPath(workspaceRoot: string, taskId: string): string {
  return path.join(taskEscalationDir(workspaceRoot, taskId), TASK_FILES.escalationSummary);
}

/**
 * Skills directory under the draft-doc root. On-demand skill .md files
 * (with YAML frontmatter) live here alongside the existing core skills.
 */
export function skillsDir(draftDocRoot: string): string {
  return path.join(draftDocRoot, "migration-workflow-v2", "skills");
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime path block (design §L): the minimal set every step prompt sees,
// plus optional extensions the prompt compiler can layer in step-by-step.
// ─────────────────────────────────────────────────────────────────────────────

export interface AvailablePathsBlock {
  /** Always injected. */
  core: {
    WORKSPACE: string;
    COMFYUI_ROOT: string;
    LOGS_DIR: string;
    PATCHES_DIR: string;
    ARTIFACTS_DIR: string;
    OUTPUTS_DIR: string;
  };
  /** Step-relevant extensions. Caller picks which keys to add. */
  extensions: {
    FEEDBACK_DIR?: string;
    FEEDBACK_EVENTS_PATH?: string;
    ESCALATION_DIR?: string;
    RECIPES_DIR?: string;
    SCHEMAS_DIR?: string;
    DEBUG_ARCHIVES_DIR?: string;
  };
}

/**
 * Build the paths block for prompt injection. Core is always present;
 * pass extension flags to layer in step-relevant dirs.
 *
 * Example (Step 13 agent-improvement):
 *   buildAvailablePathsBlock({ workspaceRoot, taskId, comfyuiRoot,
 *     extensions: { recipes: true, feedbackEvents: true } })
 */
export function buildAvailablePathsBlock(input: {
  workspaceRoot: string;
  taskId: string;
  comfyuiRoot: string;
  artifactsDir: string;
  outputsDir: string;
  logsDir: string;
  extensions?: {
    feedback?: boolean;
    feedbackEvents?: boolean;
    escalation?: boolean;
    recipes?: boolean;
    schemas?: boolean;
    debugArchives?: boolean;
  };
}): AvailablePathsBlock {
  const { workspaceRoot, taskId, comfyuiRoot, artifactsDir, outputsDir, logsDir } = input;
  const ext = input.extensions ?? {};
  const extensions: AvailablePathsBlock["extensions"] = {};
  if (ext.feedback) {
    extensions.FEEDBACK_DIR = taskFeedbackDir(workspaceRoot, taskId);
  }
  if (ext.feedbackEvents) {
    extensions.FEEDBACK_EVENTS_PATH = taskFeedbackEventsPath(workspaceRoot, taskId);
  }
  if (ext.escalation) {
    extensions.ESCALATION_DIR = taskEscalationDir(workspaceRoot, taskId);
  }
  if (ext.recipes) {
    extensions.RECIPES_DIR = GLOBAL_DIRS.recipesRoot;
  }
  if (ext.schemas) {
    extensions.SCHEMAS_DIR = GLOBAL_DIRS.schemasRoot;
  }
  if (ext.debugArchives) {
    extensions.DEBUG_ARCHIVES_DIR = GLOBAL_DIRS.debugArchivesRoot;
  }
  return {
    core: {
      WORKSPACE: taskDir(workspaceRoot, taskId),
      COMFYUI_ROOT: comfyuiRoot,
      LOGS_DIR: logsDir,
      PATCHES_DIR: GLOBAL_DIRS.patchesRoot,
      ARTIFACTS_DIR: artifactsDir,
      OUTPUTS_DIR: outputsDir
    },
    extensions
  };
}

/** Render the paths block as a markdown bullet list for prompt injection. */
export function renderAvailablePathsBlock(block: AvailablePathsBlock): string {
  const lines: string[] = ["## Available paths", ""];
  for (const [key, value] of Object.entries(block.core)) {
    lines.push(`- **${key}**: \`${value}\``);
  }
  const ext = Object.entries(block.extensions).filter(([, v]) => v !== undefined);
  if (ext.length > 0) {
    lines.push("");
    for (const [key, value] of ext) {
      lines.push(`- **${key}**: \`${value}\``);
    }
  }
  return lines.join("\n");
}
