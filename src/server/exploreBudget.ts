/**
 * Explore-budget guard — the DETERMINISTIC half of "explore ≤ 3 rounds → human
 * gate". The Step 05 agent drives the exploration (soft), but the bound must be
 * code, not a hope: each explore attempt is recorded to a per-task artifact and
 * this guard reports when a node has exhausted its budget so the agent MUST open
 * an `ask_user` gate (and a post-hoc check can verify it did).
 *
 * Pure core (`bumpAttempt`) is unit-tested; the fs wrappers persist the counter
 * to `<artifacts>/catalog-explore-budget.json`.
 */
import fs from "node:fs";
import path from "node:path";

export const MAX_EXPLORE_ROUNDS = 3;
export const EXPLORE_BUDGET_FILE = "catalog-explore-budget.json";

export interface ExploreBudgetState {
  attempts: Record<string, number>;
}

export interface AttemptResult {
  attempts: number;
  exhausted: boolean;
}

/** Pure: increment nodeKey's counter, returning the new state + whether the budget is spent. */
export function bumpAttempt(
  state: ExploreBudgetState,
  nodeKey: string,
  max: number = MAX_EXPLORE_ROUNDS
): { state: ExploreBudgetState; attempts: number; exhausted: boolean } {
  const attempts = (state.attempts[nodeKey] ?? 0) + 1;
  return {
    state: { attempts: { ...state.attempts, [nodeKey]: attempts } },
    attempts,
    exhausted: attempts >= max
  };
}

function budgetPath(artifactPath: string): string {
  return path.join(artifactPath, EXPLORE_BUDGET_FILE);
}

export function readBudget(artifactPath: string): ExploreBudgetState {
  try {
    const parsed = JSON.parse(fs.readFileSync(budgetPath(artifactPath), "utf8")) as ExploreBudgetState;
    if (parsed && typeof parsed.attempts === "object" && parsed.attempts) return { attempts: parsed.attempts };
  } catch {
    /* fresh */
  }
  return { attempts: {} };
}

/** Record one explore attempt for `nodeKey`; returns attempts so far + exhausted. */
export function recordExploreAttempt(
  artifactPath: string,
  nodeKey: string,
  max: number = MAX_EXPLORE_ROUNDS
): AttemptResult {
  const { state, attempts, exhausted } = bumpAttempt(readBudget(artifactPath), nodeKey, max);
  fs.mkdirSync(artifactPath, { recursive: true });
  fs.writeFileSync(budgetPath(artifactPath), JSON.stringify(state, null, 2) + "\n", "utf8");
  return { attempts, exhausted };
}

export function attemptsFor(artifactPath: string, nodeKey: string): number {
  return readBudget(artifactPath).attempts[nodeKey] ?? 0;
}
