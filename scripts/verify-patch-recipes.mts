/**
 * Verify recipe matching + patch adaptation injection across all cartoon workflows.
 *
 * Usage: npx tsx scripts/verify-patch-recipes.mts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  extractNodeModelPairs,
  findMatchingRecipes,
  injectRecipesForWorkflow,
  type NodeModelPair,
} from "../src/server/recipeInjector";
import type { Recipe } from "../src/server/recipeLibrary";

const CARTOON_DIR = "/home/intel/tianfeng/comfy/cartoon";

// ── Collect workflow files ──────────────────────────────────────────────────
import { readdirSync, statSync } from "node:fs";
const workflows = readdirSync(CARTOON_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ name: f, path: path.join(CARTOON_DIR, f) }))
  .sort((a, b) => a.name.localeCompare(b.name));

console.log(`\n${"═".repeat(80)}`);
console.log(`  Patch Adaptation Verification — ${workflows.length} workflows`);
console.log(`${"═".repeat(80)}\n`);

let totalMatched = 0;
let totalPatchRecipes = 0;
let totalProtocolTriggered = 0;

for (const wf of workflows) {
  // Write a temp copy that injectRecipesForWorkflow can read
  const raw = readFileSync(wf.path, "utf8");
  let workflow: unknown;
  try {
    workflow = JSON.parse(raw);
  } catch {
    console.log(`✗ ${wf.name} — INVALID JSON, skipping\n`);
    continue;
  }

  const pairs: NodeModelPair[] = extractNodeModelPairs(workflow);
  const matches: Recipe[] = findMatchingRecipes(pairs);
  const patchRecipes = matches.filter((r) => r.patchFile);

  totalMatched += matches.length;
  totalPatchRecipes += patchRecipes.length;

  // Check protocol injection at step 05
  // (use the actual workflow path — injectRecipesForWorkflow reads it)
  const step05 = await injectRecipesForWorkflow({
    workflowPath: wf.path,
    stepId: "05",
  });
  const hasProtocol = step05.includes("## Recipes requiring patch adaptation");
  if (hasProtocol) totalProtocolTriggered++;

  // Also check step 02 (should NOT have protocol)
  const step02 = await injectRecipesForWorkflow({
    workflowPath: wf.path,
    stepId: "02",
  });
  const hasProtocolAt02 = step02.includes("## Recipes requiring patch adaptation");

  // Report
  const status = matches.length === 0
    ? "⚪ no recipe match"
    : patchRecipes.length > 0
      ? hasProtocol
        ? "✅ patch protocol triggered"
        : "❌ patch recipe matched but NO protocol"
      : "🔵 recipe matched (native, no patch)";

  console.log(`${status}  ${wf.name}`);
  if (pairs.length > 0) {
    console.log(`  nodes: ${pairs.map((p) => p.nodeType).join(", ")}`);
  }
  if (matches.length > 0) {
    for (const r of matches) {
      const patch = r.patchFile ? ` [PATCH: ${r.patchFile}]` : "";
      console.log(`  → recipe: ${r.recipeId} (${r.xpuSupport})${patch}`);
    }
  }
  if (hasProtocolAt02) {
    console.log(`  ⚠️  protocol leaked into step 02 (should be gated to 05)`);
  }
  console.log();
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`${"═".repeat(80)}`);
console.log("  SUMMARY");
console.log(`${"═".repeat(80)}`);
console.log(`  workflows scanned:     ${workflows.length}`);
console.log(`  total recipe matches:  ${totalMatched}`);
console.log(`  patch recipes matched: ${totalPatchRecipes}`);
console.log(`  protocol triggered:    ${totalProtocolTriggered} (at step 05)`);
console.log();

if (totalPatchRecipes > 0 && totalProtocolTriggered === 0) {
  console.log("❌ FAIL: patch recipes matched but protocol never triggered");
  process.exit(1);
}
if (totalPatchRecipes === 0) {
  console.log("⚠️  No patch recipes matched any workflow — recipes may need updating");
}
console.log("✅ Verification complete");
