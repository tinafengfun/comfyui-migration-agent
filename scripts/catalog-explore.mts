#!/usr/bin/env node
/**
 * catalog-explore.mts — deterministic explore-budget CLI for the Step 05 agent.
 * The agent records one call per exploration attempt for a node; when the budget
 * (default 3) is exhausted the CLI exits non-zero so the agent MUST open an
 * `ask_user` human gate instead of looping forever. The counter persists to
 * `<workspace-artifacts>/catalog-explore-budget.json`.
 *
 * Usage:
 *   npx tsx scripts/catalog-explore.mts --workspace <artifacts-dir> --node-key <k> --action record [--max 3]
 *   npx tsx scripts/catalog-explore.mts --workspace <artifacts-dir> --node-key <k> --action status
 *
 * Exit codes: record → 0 (budget remains) / 4 (EXHAUSTED — open a human gate);
 * status → 0; bad args → 2.
 */
import { attemptsFor, recordExploreAttempt } from "../src/server/exploreBudget";
import { parseExploreArgs } from "../src/server/catalogCliArgs";

function main(): number {
  const a = parseExploreArgs(process.argv.slice(2));
  if (!a.artifactPath || !a.nodeKey || !a.action) {
    console.error("usage: --workspace <artifacts> --node-key <k> --action record|status [--max 3]");
    return 2;
  }
  if (a.action === "status") {
    const attempts = attemptsFor(a.artifactPath, a.nodeKey);
    console.log(JSON.stringify({ attempts, exhausted: attempts >= a.max, max: a.max }));
    return 0;
  }
  if (a.action === "record") {
    const r = recordExploreAttempt(a.artifactPath, a.nodeKey, a.max);
    console.log(JSON.stringify({ ...r, max: a.max }));
    return r.exhausted ? 4 : 0;
  }
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
