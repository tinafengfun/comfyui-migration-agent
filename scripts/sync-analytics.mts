#!/usr/bin/env npx tsx
/**
 * CLI for SQLite analytics sync (§H).
 *
 * Usage:
 *   npx tsx scripts/sync-analytics.mts [--workspace-root <dir>] [--json]
 *
 * Syncs feedback events from all task JSONL files into the analytics DB
 * (default: .demo-state/analytics.sqlite). Prints a summary.
 *
 * Exit codes:
 *   0 = sync completed (even if some task dirs had errors)
 *   2 = bad CLI args
 *
 * Designed to run from cron via scripts/daily-check.sh, or manually.
 */
import { syncFeedbackFromJsonl, computeRecipeEfficacy, closeDb } from "../src/server/analyticsDb";

interface ParsedArgs {
  workspaceRoot?: string;
  json: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--workspace-root") {
      out.workspaceRoot = argv[++i];
    } else if (arg === "--json") {
      out.json = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(`Usage: npx tsx scripts/sync-analytics.mts [--workspace-root <dir>] [--json]`);
      process.exit(0);
    } else {
      console.error(`unknown arg: ${arg}`);
      process.exit(2);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspaceRoot = args.workspaceRoot ?? process.env.DEMO_WORKSPACE_ROOT ?? "./workspaces";

  const stats = await syncFeedbackFromJsonl(workspaceRoot);
  const efficacy = computeRecipeEfficacy();

  if (args.json) {
    console.log(JSON.stringify({ sync: stats, efficacy }, null, 2));
  } else {
    console.log(`Analytics sync complete:`);
    console.log(`  feedback events synced: ${stats.synced}`);
    console.log(`  errors: ${stats.errors}`);
    console.log(``);
    if (efficacy.length > 0) {
      console.log(`Recipe efficacy:`);
      for (const r of efficacy) {
        const rate = `${(r.successRate * 100).toFixed(0)}%`;
        console.log(`  ${r.recipeId}: ${r.successCount}/${r.appliedCount} (${rate}) last: ${r.lastAppliedAt ?? "n/a"}`);
      }
    } else {
      console.log(`No recipe usage recorded yet.`);
    }
  }

  closeDb();
}

main().catch((e) => {
  console.error(`sync-analytics failed: ${(e as Error).message}`);
  process.exit(1);
});
