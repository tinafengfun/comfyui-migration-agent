import { describe, expect, it } from "vitest";
import { buildEnumPackageResolver } from "./sourceObjectInfo";

describe("buildEnumPackageResolver (recipe-backed)", () => {
  it("resolves res_2s / bong_tangent → RES4LYF from the bundled recipe", () => {
    // Uses the real recipes/ dir — the RES4LYF recipe declares providesEnumValues.
    const resolve = buildEnumPackageResolver("./recipes");
    expect(resolve("sampler_name", "res_2s")).toContain("RES4LYF");
    expect(resolve("scheduler", "bong_tangent")).toContain("RES4LYF");
    // slot-agnostic fallback also works (value known regardless of slot)
    expect(resolve("anything", "res_2m")).toContain("RES4LYF");
  });

  it("returns undefined for a core value with no providing package", () => {
    const resolve = buildEnumPackageResolver("./recipes");
    expect(resolve("sampler_name", "euler")).toBeUndefined();
    expect(resolve("scheduler", "normal")).toBeUndefined();
  });

  it("is empty-safe when the recipes dir does not exist", () => {
    const resolve = buildEnumPackageResolver("/nonexistent/recipes/dir");
    expect(resolve("sampler_name", "res_2s")).toBeUndefined();
  });
});
