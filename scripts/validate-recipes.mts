#!/usr/bin/env npx tsx
/**
 * CLI for recipe schema validation (§J / §F / §I).
 *
 * Usage:
 *   npx tsx scripts/validate-recipes.mts [--root <dir>] [--json]
 *
 * Walks the recipes directory (default: project-root recipes/, override with
 * --root or MIGRATION_RECIPES_DIR), loads every *.json, runs each through
 * recipe.schema.json via ajv. Reports invalid + unparseable files.
 *
 * Exit codes:
 *   0 = all recipes valid (or none present)
 *   1 = at least one recipe failed validation
 *   2 = bad CLI args
 *
 * Designed to run from cron via scripts/daily-check.sh, or manually before
 * committing recipe edits.
 */
import { loadAllRecipes } from "../src/server/recipeLibrary";
import { GLOBAL_DIRS } from "../src/server/paths";

interface ParsedArgs {
  root?: string;
  json: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") out.root = argv[++i];
    else if (a === "--json") out.json = true;
    else if (a === "-h" || a === "--help") {
      console.log(`Usage: validate-recipes.mts [--root <dir>] [--json]
  --root   Recipes directory (default: MIGRATION_RECIPES_DIR or ./recipes)
  --json   Emit machine-readable JSON instead of human-readable text
`);
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const root = args.root ?? GLOBAL_DIRS.recipesRoot;
const result = loadAllRecipes(root);

if (args.json) {
  console.log(JSON.stringify({ root, ...result }, null, 2));
} else {
  console.log(`# Recipe validation report`);
  console.log(`root:        ${root}`);
  console.log(`recipes:     ${result.recipes.length} valid`);
  console.log(`invalid:     ${result.invalid.length}`);
  console.log(`unparseable: ${result.unparseable.length}`);
  console.log("");
  if (result.unparseable.length > 0) {
    console.log("## Unparseable (not valid JSON)");
    for (const u of result.unparseable) {
      console.log(`- ${u.file}`);
      console.log(`    ${u.reason}`);
    }
    console.log("");
  }
  if (result.invalid.length > 0) {
    console.log("## Invalid (failed schema)");
    for (const i of result.invalid) {
      console.log(`- ${i.file}`);
      console.log(`    ${i.reason}`);
    }
    console.log("");
  }
  if (result.recipes.length > 0) {
    console.log("## Loaded");
    for (const r of result.recipes) {
      console.log(`- ${r.recipeId} v${r.version}  [${r.xpuSupport}]`);
    }
  }
}

if (result.invalid.length > 0 || result.unparseable.length > 0) {
  process.exit(1);
}
process.exit(0);
