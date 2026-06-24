/**
 * Per-task feedback event log (§G).
 *
 * What this is:
 *   Each task has workspaces/<taskId>/feedback/feedback-events.jsonl. The
 *   orchestrator, the human-approval broker, the SDK runner, and the HTTP
 *   API all funnel feedback through here. Every line is one event validated
 *   against feedback-event.schema.json before write.
 *
 * Why a JSONL file and not SQLite/analytics.db:
 *   JSONL is append-only and git-diffable. SQLite (§H) reads from it later
 *   for aggregation. Keep this module the write-only source of truth.
 *
 * Concurrency:
 *   append() uses appendFile which is atomic for lines smaller than the
 *   kernel pipe buffer (PIPE_BUF ≈ 4096 bytes on Linux). Our events are
 *   typically <1KB. For larger events the writer still works, but interleaved
 *   concurrent appends from multiple processes may produce torn lines — the
 *   reader tolerates them and reports them as parse failures with the line.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { assertValid } from "./schemaValidate";
import { taskFeedbackEventsPath } from "./paths";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type FeedbackType =
  | "agent_bug"
  | "comfyui_bug"
  | "missing_feature"
  | "user_preference"
  | "data_gap";

export type FeedbackSeverity = "blocker" | "degrade" | "nit";

export type FeedbackSource = "human" | "agent_self" | "evaluator";

export type FeedbackStatus = "open" | "triaged" | "resolved" | "wontfix";

export interface FeedbackStateSnapshot {
  workflowSha?: string;
  comfyuiSha?: string;
  agentCommitSha?: string;
  failingArtifactPath?: string;
  stackTracePath?: string;
  extraNotes?: string;
}

/**
 * What callers naturally have. The log fills id/taskId/createdAt/status.
 * Provide taskId explicitly only if you're writing on behalf of another task
 * (rare — e.g. cross-task dedupe in Step 13).
 */
export interface FeedbackEventInput {
  taskId?: string;
  stepId: string;
  source: FeedbackSource;
  type: FeedbackType;
  severity: FeedbackSeverity;
  message: string;
  stateSnapshot?: FeedbackStateSnapshot;
  proposedAction?:
    | "evolve_prompt"
    | "evolve_skill"
    | "fix_code"
    | "create_ticket"
    | "escalate_opencode"
    | "record_only";
}

export interface FeedbackEvent extends FeedbackEventInput {
  id: string;
  taskId: string;
  createdAt: string;
  status: FeedbackStatus;
}

export interface FeedbackListResult {
  events: FeedbackEvent[];
  /** Lines that failed JSON.parse or schema validation. */
  corrupt: Array<{ line: number; raw: string; reason: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Writers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate and append one feedback event. Auto-fills id/taskId/createdAt/status.
 * Throws if validation fails — use this on write paths where invalid input
 * must halt the caller.
 */
export async function appendFeedbackEvent(
  workspaceRoot: string,
  taskId: string,
  input: FeedbackEventInput
): Promise<FeedbackEvent> {
  const event: FeedbackEvent = {
    id: randomUUID(),
    taskId: input.taskId ?? taskId,
    createdAt: new Date().toISOString(),
    status: "open",
    stepId: input.stepId,
    source: input.source,
    type: input.type,
    severity: input.severity,
    message: input.message,
    ...(input.stateSnapshot ? { stateSnapshot: input.stateSnapshot } : {}),
    ...(input.proposedAction ? { proposedAction: input.proposedAction } : {})
  };

  // Hard gate: invalid event must halt. The schema covers enum values,
  // required fields, and format (date-time). If this throws, the caller
  // has a bug — surface it now, not at Step 13 read time.
  assertValid("feedbackEvent", event);

  const filePath = taskFeedbackEventsPath(workspaceRoot, event.taskId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

// ─────────────────────────────────────────────────────────────────────────────
// Readers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read all events for a task, in insertion order. Tolerant of corrupt lines:
 * they're returned in `corrupt[]` rather than crashing the reader, so Step 13
 * can still triage the healthy events.
 *
 * Returns `{events: [], corrupt: []}` if the file doesn't exist yet (task
 * has no feedback so far).
 */
export async function listFeedbackEvents(
  workspaceRoot: string,
  taskId: string
): Promise<FeedbackListResult> {
  const filePath = taskFeedbackEventsPath(workspaceRoot, taskId);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { events: [], corrupt: [] };
    }
    throw err;
  }

  const lines = raw.split("\n");
  // Trailing newline produces one empty final entry — drop empties.
  const nonEmpty = lines.map((l, i) => ({ raw: l, line: i + 1 })).filter((x) => x.raw.length > 0);

  const events: FeedbackEvent[] = [];
  const corrupt: FeedbackListResult["corrupt"] = [];

  for (const entry of nonEmpty) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.raw);
    } catch (e) {
      corrupt.push({ line: entry.line, raw: entry.raw, reason: `JSON.parse: ${(e as Error).message}` });
      continue;
    }
    const result = validateFeedbackEventLite(parsed);
    if (!result.ok) {
      corrupt.push({ line: entry.line, raw: entry.raw, reason: result.reason });
      continue;
    }
    events.push(parsed as FeedbackEvent);
  }

  return { events, corrupt };
}

/** Count-only helper, cheaper than list() when callers just need a tally. */
export async function countFeedbackEvents(
  workspaceRoot: string,
  taskId: string
): Promise<number> {
  const { events } = await listFeedbackEvents(workspaceRoot, taskId);
  return events.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Schema-validation wrapper that converts assertValid's throw into an ok/err
 * tuple, for use inside the reader's per-line loop.
 */
function validateFeedbackEventLite(value: unknown): { ok: true } | { ok: false; reason: string } {
  try {
    assertValid("feedbackEvent", value);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message.split("\n")[0] };
  }
}
