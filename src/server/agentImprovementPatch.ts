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
  | "awaiting_merge_review"
  | "applied";

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
  [key: string]: unknown;
}

export interface AgentImprovementFile {
  improvements: AgentImprovementItem[];
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
