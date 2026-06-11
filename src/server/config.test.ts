import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config";

describe("server config", () => {
  const originalModelRoot = process.env.MODEL_ROOT;
  const originalModelRoots = process.env.MODEL_ROOTS;

  afterEach(() => {
    restoreEnv("MODEL_ROOT", originalModelRoot);
    restoreEnv("MODEL_ROOTS", originalModelRoots);
  });

  it("uses MODEL_ROOTS env var for model search paths", () => {
    process.env.MODEL_ROOTS = "/tmp/custom-models:/tmp/other";
    delete process.env.MODEL_ROOT;

    const config = loadConfig();

    expect(config.modelRoots).toContain("/tmp/custom-models");
    expect(config.modelRoots).toContain("/tmp/other");
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
