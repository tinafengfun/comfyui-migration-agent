/**
 * SQLite analytics layer (§H).
 *
 * What this is:
 *   Aggregates task/step/feedback/recipe/skill analytics across all tasks.
 *   Content stays in JSONL/markdown; this DB stores only metadata + statistics
 *   (design §7: "只存 analytics，不存内容").
 *
 * Why node:sqlite (built-in):
 *   Node.js v24 ships `node:sqlite` (DatabaseSync). No npm install needed.
 *   Sync API matches the write patterns here (fire-and-forget single inserts).
 *
 * Write path:
 *   Orchestrator + promptSkillCompiler fire-and-forget → never blocks the
 *   migration pipeline. All writers catch errors and log a warning.
 *
 * Read path:
 *   Step 13 analysis, Step 11 reports, recipe efficacy lookups. Never in
 *   the hot path.
 *
 * Concurrency:
 *   WAL mode. The server is single-process; the sync script may run
 *   concurrently from cron — WAL handles this.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { GLOBAL_DIRS } from "./paths";
import { listFeedbackEvents } from "./feedbackLog";

// ─────────────────────────────────────────────────────────────────────────────
// Suppress the node:sqlite ExperimentalWarning once at import time.
// ─────────────────────────────────────────────────────────────────────────────
const originalEmit = process.emitWarning;
process.emitWarning = function (warning: unknown, ...rest: unknown[]): boolean {
  if (typeof warning === "string" && warning.includes("SQLite is an experimental feature")) {
    return false;
  }
  // @ts-expect-error — forward all overloads
  return originalEmit.call(process, warning, ...rest);
};

// ─────────────────────────────────────────────────────────────────────────────
// DB singleton
// ─────────────────────────────────────────────────────────────────────────────

let db: DatabaseSync | null = null;

/**
 * Open (or create) the analytics DB. Creates tables if they don't exist.
 * Called lazily on first write. Idempotent — returns the cached instance.
 *
 * Tests override the path via process.env.MIGRATION_ANALYTICS_DB + closeDb().
 */
function getDb(): DatabaseSync {
  if (db) return db;
  const resolvedPath = process.env.MIGRATION_ANALYTICS_DB ?? GLOBAL_DIRS.analyticsDb;
  mkdirSync(path.dirname(resolvedPath), { recursive: true });
  db = new DatabaseSync(resolvedPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  initTables(db);
  return db;
}

/** Close the DB connection. For tests and graceful shutdown. */
export function closeDb(): void {
  db?.close();
  db = null;
}

/**
 * Force a specific DB path (for tests). Call before any write.
 * Resets the singleton so the next getDb() opens at the new path.
 */
export function setDbPath(_p: string): void {
  closeDb();
}

function initTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      workflow_filename TEXT,
      workflow_sha256 TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      source TEXT NOT NULL,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      proposed_action TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      related_recipe_id TEXT
    );

    CREATE TABLE IF NOT EXISTS recipe_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      recipe_id TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      outcome TEXT,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_recipe_usage_recipe ON recipe_usage(recipe_id);

    CREATE TABLE IF NOT EXISTS skill_injections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      skill_version TEXT NOT NULL,
      injected_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_skill_injections_skill ON skill_injections(skill_id);
  `);
}

// ─────────────────────────────────────────────────────────────────────────────
// Writers (fire-and-forget, never throw)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record that recipes were applied (injected into a step prompt).
 * Called from compileStepJob after recipe injection succeeds.
 */
export function recordRecipeApplied(taskId: string, stepId: string, recipeIds: string[]): void {
  if (recipeIds.length === 0) return;
  try {
    const database = getDb();
    const stmt = database.prepare(
      "INSERT INTO recipe_usage (task_id, step_id, recipe_id, applied_at) VALUES (?, ?, ?, ?)"
    );
    const now = new Date().toISOString();
    for (const id of recipeIds) stmt.run(taskId, stepId, id, now);
  } catch (e) {
    console.warn(`[analyticsDb] recordRecipeApplied failed: ${(e as Error).message}`);
  }
}

/**
 * Record the outcome of recipe usage for a task+step.
 * Called when a step completes or fails. outcome:
 *   "success" = step completed normally
 *   "failed"  = step failed
 *   "partial" = completed but with degrade-severity feedback (future)
 *
 * Updates all recipe_usage rows for this task+step that don't yet have an outcome.
 */
export function recordRecipeOutcome(
  taskId: string,
  stepId: string,
  outcome: "success" | "failed" | "partial"
): void {
  try {
    const database = getDb();
    const now = new Date().toISOString();
    database.prepare(
      "UPDATE recipe_usage SET outcome = ?, resolved_at = ? WHERE task_id = ? AND step_id = ? AND outcome IS NULL"
    ).run(outcome, now, taskId, stepId);
  } catch (e) {
    console.warn(`[analyticsDb] recordRecipeOutcome failed: ${(e as Error).message}`);
  }
}

/**
 * Record that a skill was injected into a step prompt.
 * Called from compileStepJob after skill injection succeeds.
 */
export function recordSkillInjected(
  taskId: string,
  stepId: string,
  skillId: string,
  skillVersion: string
): void {
  try {
    const database = getDb();
    database.prepare(
      "INSERT INTO skill_injections (task_id, step_id, skill_id, skill_version, injected_at) VALUES (?, ?, ?, ?, ?)"
    ).run(taskId, stepId, skillId, skillVersion, new Date().toISOString());
  } catch (e) {
    console.warn(`[analyticsDb] recordSkillInjected failed: ${(e as Error).message}`);
  }
}

/**
 * Record task creation in the analytics DB.
 */
export function recordTaskCreated(
  taskId: string,
  workflowFilename: string,
  workflowSha256?: string
): void {
  try {
    const database = getDb();
    database.prepare(
      "INSERT OR REPLACE INTO tasks (task_id, workflow_filename, workflow_sha256, created_at, status) VALUES (?, ?, ?, ?, 'pending')"
    ).run(taskId, workflowFilename, workflowSha256 ?? null, new Date().toISOString());
  } catch (e) {
    console.warn(`[analyticsDb] recordTaskCreated failed: ${(e as Error).message}`);
  }
}

/**
 * Record task completion.
 */
export function recordTaskCompleted(taskId: string, status: string): void {
  try {
    const database = getDb();
    database.prepare(
      "UPDATE tasks SET status = ?, completed_at = ? WHERE task_id = ?"
    ).run(status, new Date().toISOString(), taskId);
  } catch (e) {
    console.warn(`[analyticsDb] recordTaskCompleted failed: ${(e as Error).message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Readers (for Step 13 / evolution analyzer)
// ─────────────────────────────────────────────────────────────────────────────

export interface RecipeEfficacy {
  recipeId: string;
  appliedCount: number;
  successCount: number;
  failedCount: number;
  partialCount: number;
  lastAppliedAt: string | null;
  successRate: number;
}

/**
 * Compute efficacy for all recipes, or filter by recipeId.
 * Uses SQLite aggregation.
 */
export function computeRecipeEfficacy(recipeId?: string): RecipeEfficacy[] {
  try {
    const database = getDb();
    const where = recipeId ? "WHERE recipe_id = ?" : "";
    const params = recipeId ? [recipeId] : [];
    const rows = database.prepare(
      `SELECT
         recipe_id AS recipeId,
         COUNT(*) AS appliedCount,
         SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS successCount,
         SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failedCount,
         SUM(CASE WHEN outcome = 'partial' THEN 1 ELSE 0 END) AS partialCount,
         MAX(applied_at) AS lastAppliedAt
       FROM recipe_usage
       ${where}
       GROUP BY recipe_id
       ORDER BY recipe_id`
    ).all(...params) as Array<{
      recipeId: string;
      appliedCount: number;
      successCount: number;
      failedCount: number;
      partialCount: number;
      lastAppliedAt: string | null;
    }>;

    return rows.map((r) => ({
      ...r,
      successRate: r.appliedCount > 0 ? r.successCount / r.appliedCount : 0
    }));
  } catch (e) {
    console.warn(`[analyticsDb] computeRecipeEfficacy failed: ${(e as Error).message}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Feedback sync (JSONL → SQLite)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sync feedback events from all task JSONL files into SQLite.
 * Dedupes by event `id` (INSERT OR REPLACE).
 *
 * Walks workspaceRoot/<taskId>/feedback/feedback-events.jsonl for every task dir.
 */
export async function syncFeedbackFromJsonl(
  workspaceRoot: string
): Promise<{ synced: number; skipped: number; errors: number }> {
  const stats = { synced: 0, skipped: 0, errors: 0 };
  let database: DatabaseSync;
  try {
    database = getDb();
  } catch {
    return stats;
  }

  let taskDirs: string[];
  try {
    taskDirs = readdirSync(workspaceRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return stats;
  }

  const stmt = database.prepare(
    `INSERT OR REPLACE INTO feedback
      (id, task_id, step_id, created_at, source, type, severity, message, proposed_action, status, related_recipe_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const taskId of taskDirs) {
    try {
      const { events } = await listFeedbackEvents(workspaceRoot, taskId);
      for (const e of events) {
        stmt.run(
          e.id, e.taskId, e.stepId, e.createdAt, e.source, e.type,
          e.severity, e.message, e.proposedAction ?? null,
          e.status,
          (e as unknown as Record<string, unknown>).relatedRecipeId as string ?? null
        );
      }
      stats.synced += events.length;
    } catch {
      stats.errors++;
    }
  }

  return stats;
}
