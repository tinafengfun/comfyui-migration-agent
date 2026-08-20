import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for the P4 "last mile": the whole catalog learning loop is
 * dead in real runs unless the Step 05 prompt+skill actually tell the agent to
 * take the clone-lease, bound exploration, and emit the deploy ledger the backend
 * folds back. This asserts those instructions are present (the backlog incident
 * was exactly `grep prompts/ skills/ == EMPTY`).
 */
const ROOT = path.resolve(__dirname, "../../prompts/migration-workflow-v2");
const PROMPT = path.join(ROOT, "prompts", "05-environment-deployment-prompt.md");
const SKILL = path.join(ROOT, "skills", "05-environment-deployment-skill.md");

const MARKERS = [
  "XPU_CATALOG_ENABLED",
  "catalog-lease.mts",
  "catalog-explore.mts",
  "05-catalog-deploy-ledger.json",
  "Matched catalog records", // the recipeInjector-bridged trusted-record section
  "ask_user" // the exhausted-explore human gate
];

describe("Step 05 catalog-migration wiring", () => {
  for (const file of [PROMPT, SKILL]) {
    const name = path.basename(file);
    it(`${name} references the catalog-driven migration flow`, () => {
      const text = fs.readFileSync(file, "utf8");
      for (const marker of MARKERS) {
        expect(text, `${name} must reference "${marker}"`).toContain(marker);
      }
    });
  }

  it("the prompt spells out the trusted/adapt/explore routing + lease-wait + explore bound", () => {
    const text = fs.readFileSync(PROMPT, "utf8");
    expect(text).toMatch(/commit.*match|commit-match/i);
    expect(text).toMatch(/dtype/i);
    expect(text).toMatch(/held by another agent|WAIT and reuse/i);
    expect(text).toMatch(/EXHAUSTED|3 rounds/i);
  });
});
