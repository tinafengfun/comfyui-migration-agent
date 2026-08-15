/**
 * Deploy-time audit of the recipe + skill files the copilot agent loads.
 *
 * Run from the copy being deployed (cwd = the agent root) so it audits the ACTUAL
 * prompts/recipes on disk. Prints a human-readable summary of what will load and
 * exits NON-ZERO if anything is broken (missing step skill/prompt, invalid
 * on-demand skill frontmatter, invalid recipe, or a dangling reference link) --
 * so `deploy-agent-demo.sh` fails loudly instead of shipping guidance the agent
 * can't receive.
 *
 *   npm run audit:skills
 */
import path from "node:path";
import { auditSkillRecipeLoading, auditActiveSkillIds } from "../src/server/skillLoadingAudit";
import { loadAllRecipes } from "../src/server/recipeLibrary";

async function main(): Promise<void> {
  const problems = await auditSkillRecipeLoading();
  const active = auditActiveSkillIds();
  const recipes = loadAllRecipes(path.join(process.cwd(), "recipes"));
  const badRecipes = recipes.invalid.length + recipes.unparseable.length;

  console.log("==> Recipe + skill loading audit");
  console.log(`    recipes:            ${recipes.recipes.length} valid${badRecipes ? `, ${badRecipes} INVALID` : ""}`);
  console.log(`    on-demand skills:   ${active.length} active (${active.join(", ") || "none"})`);

  if (problems.length === 0) {
    console.log("    ✓ step bindings, on-demand skills, recipes, and reference links all load.");
    return;
  }
  console.error(`    ✗ ${problems.length} LOADING PROBLEM(S) — the agent would not receive all guidance:`);
  for (const p of problems) console.error(`      - [${p.kind}] ${p.detail}`);
  process.exit(1);
}

main().catch((e) => {
  console.error(`audit-skills-recipes failed to run: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
