import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import { loadStepDefinitions } from "./workflowLoader";

describe("workflow loader", () => {
  it("loads the draft Step 00-13 migration definitions", async () => {
    const steps = await loadStepDefinitions(loadConfig());
    expect(steps).toHaveLength(14);
    expect(steps[0].id).toBe("00");
    expect(steps.at(-1)?.id).toBe("13");
    expect(steps.every((step) => step.promptPath)).toBe(true);
  });
});
