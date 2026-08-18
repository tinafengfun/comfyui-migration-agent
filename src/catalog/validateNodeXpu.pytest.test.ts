import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Bridge the per-node harness's Python unit tests into the JS suite so
 * `npx vitest run` (and the deploy gate) actually exercise the XPU-vs-CPU
 * verdict logic. Skips cleanly if python3 is unavailable.
 */
const TOOLS_DIR = path.resolve(__dirname, "../../prompts/migration-workflow-v2/tools");

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("validate_node_xpu (python harness)", () => {
  it.skipIf(!hasPython())("passes its Python unittest suite", () => {
    const out = execFileSync("python3", ["-m", "unittest", "test_validate_node_xpu"], {
      cwd: TOOLS_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    // unittest prints "OK" to stderr; execFileSync throws on non-zero exit, so
    // reaching here already means the suite passed.
    expect(out).toBeDefined();
  });
});
