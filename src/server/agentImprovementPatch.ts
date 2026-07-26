/**
 * Safe read-modify-write helpers for `13-agent-improvement.json`'s
 * `improvements` array, plus a deterministic parser for the human's freeform
 * approval answer at the new Step 13 approval gate. Mirrors the safety
 * discipline of `taskStatePatch.ts`: never leave the file invalid, never
 * silently guess at content that doesn't match a recognized shape.
 *
 * Unlike task-state.json (spliced incrementally by 13 separate step
 * sessions), this file is written once, whole, by Step 13's own SDK session
 * -- so no corruption-repair pass is needed here, only a safe way to apply
 * `apply_status` updates afterward (human approval, then the apply tool's
 * awaiting_merge_review/applied transitions) without hand-editing JSON text.
 */
import fs from "node:fs/promises";
import { writeJson } from "./fsUtils";

export type ApplyStatus =
  | "patch_plan_only"
  | "waiting_for_human_approval"
  | "approved_to_apply"
  | "do_not_apply"
  // The generate -> verify -> merge pipeline, in order:
  | "drafted" // apply-agent-improvements.mts made + committed the edit in a disposable worktree branch
  | "verifying" // verify-agent-improvement.mts is running required_validation / replay checks
  | "verified" // all checks passed -- ready for a human's final merge decision
  | "verification_failed" // a check failed -- see item.verification for details
  | "awaiting_merge_review" // (legacy alias of "verified", kept for older files) human's final call before merge
  | "applied"; // merge-agent-improvement.mts merged the branch into main

export interface AgentImprovementValidationResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  passed: boolean;
}

export interface AgentImprovementReplayResult {
  ranReplay: boolean;
  reason?: string;
  taskId?: string;
  stepId?: string;
  stepStatus?: string;
  hardStopped?: boolean;
}

export interface AgentImprovementVerification {
  ranAt: string;
  validationResults: AgentImprovementValidationResult[];
  replayResult?: AgentImprovementReplayResult;
  passed: boolean;
}

/** Where apply-agent-improvements.mts left the disposable worktree/branch/commit for this item. */
export interface AgentImprovementDraft {
  branch: string;
  worktreePath: string;
  commitSha: string;
}

export interface AgentImprovementItem {
  id: string;
  risk_tier?: string;
  category?: string;
  target_files?: string[];
  root_cause?: string;
  proposed_change?: string;
  approval_required?: boolean;
  required_validation?: string[];
  apply_status: string;
  draft?: AgentImprovementDraft;
  verification?: AgentImprovementVerification;
  [key: string]: unknown;
}

/**
 * Tracks which round of Step 13's multi-round chat flow a task is in.
 * Deliberately stored in this durable JSON file (not in-memory) so it
 * survives a backend restart the same way apply_status does -- the
 * deterministic gate dispatch (applyDeterministicGateDecision in
 * orchestrator.ts) reads this to know what the human's next answer means,
 * rather than relying on a live SDK session that a restart would orphan
 * (see the resumeStep fast-path bug fixed earlier this project for exactly
 * why that distinction matters).
 */
export type PipelinePhase = "awaiting_approval" | "processing" | "awaiting_push_deploy_decision" | "done";

export interface AgentImprovementFile {
  improvements: AgentImprovementItem[];
  pipeline_phase?: PipelinePhase;
  [key: string]: unknown;
}

export function parseAgentImprovementFile(rawText: string): AgentImprovementFile {
  const parsed = JSON.parse(rawText) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as Record<string, unknown>).improvements)
  ) {
    throw new Error("13-agent-improvement.json is missing a valid 'improvements' array");
  }
  return parsed as AgentImprovementFile;
}

export async function readAgentImprovementFile(filePath: string): Promise<AgentImprovementFile | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (raw.trim() === "") return undefined;
  return parseAgentImprovementFile(raw);
}

/**
 * Applies `apply_status` updates to specific items by id, never touching
 * anything else in the file. Returns the updated file plus any ids in
 * `updates` that didn't match a real item (caller should surface these
 * rather than silently drop them).
 */
export function applyItemStatusUpdates(
  state: AgentImprovementFile,
  updates: Record<string, string>
): { state: AgentImprovementFile; unmatchedIds: string[] } {
  const knownIds = new Set(state.improvements.map((item) => item.id));
  const unmatchedIds = Object.keys(updates).filter((id) => !knownIds.has(id));
  const improvements = state.improvements.map((item) =>
    Object.prototype.hasOwnProperty.call(updates, item.id)
      ? { ...item, apply_status: updates[item.id] }
      : item
  );
  return { state: { ...state, improvements }, unmatchedIds };
}

/**
 * Like applyItemStatusUpdates, but merges an arbitrary partial patch per item
 * (used by verify-agent-improvement.mts to set apply_status and the
 * verification result object in one atomic write, instead of two separate
 * read-modify-write round trips that could interleave).
 */
export function applyItemPatches(
  state: AgentImprovementFile,
  patches: Record<string, Partial<AgentImprovementItem>>
): { state: AgentImprovementFile; unmatchedIds: string[] } {
  const knownIds = new Set(state.improvements.map((item) => item.id));
  const unmatchedIds = Object.keys(patches).filter((id) => !knownIds.has(id));
  const improvements = state.improvements.map((item) =>
    Object.prototype.hasOwnProperty.call(patches, item.id) ? { ...item, ...patches[item.id] } : item
  );
  return { state: { ...state, improvements }, unmatchedIds };
}

export async function writeAgentImprovementFile(filePath: string, state: AgentImprovementFile): Promise<void> {
  await writeJson(filePath, state);
  const verify = await fs.readFile(filePath, "utf8");
  parseAgentImprovementFile(verify);
}

/**
 * Parses the human's freeform answer at the Step 13 approval gate into a
 * per-item apply_status decision. Every known item id gets an explicit
 * decision (approved_to_apply or do_not_apply); items never mentioned
 * default to do_not_apply -- approval must be opt-in, never opt-out, since
 * these changes touch the agent's own prompts/skills/scripts.
 */
export function parseApprovalAnswer(
  answer: string,
  allItemIds: string[]
): { decisions: Record<string, "approved_to_apply" | "do_not_apply">; unrecognizedTokens: string[] } {
  const normalized = answer.trim().toLowerCase().replace(/^approve\s*:?\s*/, "");
  const decisions: Record<string, "approved_to_apply" | "do_not_apply"> = {};

  if (/^all$/.test(normalized)) {
    for (const id of allItemIds) decisions[id] = "approved_to_apply";
    return { decisions, unrecognizedTokens: [] };
  }
  if (normalized === "" || /^none$/.test(normalized)) {
    for (const id of allItemIds) decisions[id] = "do_not_apply";
    return { decisions, unrecognizedTokens: [] };
  }

  const idsById = new Map(allItemIds.map((id) => [id.toLowerCase(), id]));
  const tokens = normalized.split(/[\s,;]+/).filter(Boolean);
  const approvedIds = new Set<string>();
  const unrecognizedTokens: string[] = [];
  for (const token of tokens) {
    const matched = idsById.get(token);
    if (matched) approvedIds.add(matched);
    else unrecognizedTokens.push(token);
  }

  for (const id of allItemIds) {
    decisions[id] = approvedIds.has(id) ? "approved_to_apply" : "do_not_apply";
  }
  return { decisions, unrecognizedTokens };
}

/**
 * Parses the human's freeform answer at the (new) post-verification push/
 * deploy gate: "push: <ids>", "push: all", or "push: none", each optionally
 * suffixed with the word "deploy" (e.g. "push: all deploy") to additionally
 * trigger a sync + restart of the live agent-demo backend after a
 * successful push. `deploy` is forced false if no items end up selected --
 * restarting the live service over nothing pushed is never intentional.
 */
export function parsePushDeployAnswer(
  answer: string,
  verifiedItemIds: string[]
): { pushIds: string[]; deploy: boolean; unrecognizedTokens: string[] } {
  const normalized = answer.trim().toLowerCase();
  const wantsDeploy = /\bdeploy\b/.test(normalized);
  const withoutDeploy = normalized.replace(/\bdeploy\b/g, " ").trim();
  const withoutPrefix = withoutDeploy.replace(/^push\s*:?\s*/, "").trim();

  let pushIds: string[] = [];
  const unrecognizedTokens: string[] = [];
  if (/^all$/.test(withoutPrefix)) {
    pushIds = [...verifiedItemIds];
  } else if (withoutPrefix !== "" && !/^none$/.test(withoutPrefix)) {
    const idsById = new Map(verifiedItemIds.map((id) => [id.toLowerCase(), id]));
    const tokens = withoutPrefix.split(/[\s,;]+/).filter(Boolean);
    for (const token of tokens) {
      const matched = idsById.get(token);
      if (matched) pushIds.push(matched);
      else unrecognizedTokens.push(token);
    }
  }
  return { pushIds, deploy: wantsDeploy && pushIds.length > 0, unrecognizedTokens };
}
