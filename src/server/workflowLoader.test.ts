import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import { loadStepDefinitions } from "./workflowLoader";

describe("workflow loader", () => {
  it("loads the draft Step 00-13 migration definitions (incl. the optional 03b node-localization step)", async () => {
    const steps = await loadStepDefinitions(loadConfig());
    expect(steps).toHaveLength(16);
    expect(steps[0].id).toBe("00");
    expect(steps[4].id).toBe("03b"); // inserted between 03 and 04
    expect(steps[14].id).toBe("12b");
    expect(steps.at(-1)?.id).toBe("13");
    // Every step has a prompt EXCEPT the fully-deterministic 03b (no SDK session).
    expect(steps.filter((step) => step.id !== "03b").every((step) => step.promptPath)).toBe(true);
    expect(steps.find((step) => step.id === "03b")?.promptPath).toBeUndefined();
  });

  it("marks 03b (node localization) and 13 (self-improvement) as optional — they must not gate overall migration completion", async () => {
    const steps = await loadStepDefinitions(loadConfig());
    expect(steps.find((step) => step.id === "03b")?.optional).toBe(true);
    expect(steps.find((step) => step.id === "13")?.optional).toBe(true);
    expect(steps.filter((step) => step.optional).map((step) => step.id)).toEqual(["03b", "13"]);
  });
});
