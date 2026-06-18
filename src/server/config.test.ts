import { afterEach, describe, expect, it } from "vitest";
import { demoModelRoot, loadConfig } from "./config";

describe("server config", () => {
  const originalModelRoot = process.env.MODEL_ROOT;
  const originalModelRoots = process.env.MODEL_ROOTS;

  afterEach(() => {
    restoreEnv("MODEL_ROOT", originalModelRoot);
    restoreEnv("MODEL_ROOTS", originalModelRoots);
  });

  it("keeps the demo hf_models root in search and storage roots even when model roots are overridden", () => {
    process.env.MODEL_ROOTS = "/tmp/custom-models";
    delete process.env.MODEL_ROOT;

    const config = loadConfig();

    expect(config.modelRoots[0]).toBe(demoModelRoot);
    expect(config.modelRoots).toContain("/tmp/custom-models");
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
