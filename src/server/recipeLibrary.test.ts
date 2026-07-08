import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadAllRecipes, findRecipesForNode, findRecipeById } from "./recipeLibrary";

const CLILOADER_FP8 = {
  recipeId: "CLIPLoader-qwen-fp8",
  version: "1.0.0",
  nodeType: "CLIPLoader",
  modelPattern: "*qwen*fp8*.safetensors",
  xpuSupport: "patched",
  patchClass: "functional_runtime_support",
  patchFile: "patches/xpu-bug-investigation/0001-xpu-fp8-fallback.patch",
  knownIssues: ["QTensor.clone() segfaults on .to('xpu')"],
  provenance: { taskOrigin: "7f5cf9e4", createdAt: "2026-06-19" }
};

const VAE_NATIVE = {
  recipeId: "VAELoader-generic",
  version: "0.1.0",
  nodeType: "VAELoader",
  xpuSupport: "native",
  knownIssues: [],
  provenance: { taskOrigin: "manual", createdAt: "2026-06-01" }
};

let recipesRoot: string;

beforeEach(async () => {
  recipesRoot = await mkdtemp(path.join(tmpdir(), "recipes-"));
  await mkdir(path.join(recipesRoot, "nodes"), { recursive: true });
  await writeFile(
    path.join(recipesRoot, "nodes", "CLIPLoader-qwen-fp8.json"),
    JSON.stringify(CLILOADER_FP8, null, 2)
  );
  await writeFile(
    path.join(recipesRoot, "nodes", "VAELoader-generic.json"),
    JSON.stringify(VAE_NATIVE, null, 2)
  );
});

afterEach(async () => {
  await rm(recipesRoot, { recursive: true, force: true });
});

describe("recipeLibrary.loadAllRecipes", () => {
  it("loads every valid recipe from nested dirs", () => {
    const { recipes, invalid, unparseable } = loadAllRecipes(recipesRoot);
    expect(unparseable).toHaveLength(0);
    expect(invalid).toHaveLength(0);
    expect(recipes).toHaveLength(2);
    // Sort order: alphabetical by recipeId.
    expect(recipes[0].recipeId).toBe("CLIPLoader-qwen-fp8");
    expect(recipes[1].recipeId).toBe("VAELoader-generic");
  });

  it("returns empty result when recipesRoot does not exist", () => {
    const result = loadAllRecipes(path.join(recipesRoot, "missing"));
    expect(result).toEqual({ recipes: [], invalid: [], unparseable: [] });
  });

  it("skips and reports corrupt-JSON files without dropping healthy ones", async () => {
    await writeFile(
      path.join(recipesRoot, "nodes", "broken.json"),
      "{ not valid json"
    );
    const result = loadAllRecipes(recipesRoot);
    expect(result.unparseable).toHaveLength(1);
    expect(result.unparseable[0].file).toMatch(/broken\.json$/);
    expect(result.recipes).toHaveLength(2); // the two healthy ones still load
  });

  it("rejects schema-invalid recipes and reports the reason", async () => {
    await writeFile(
      path.join(recipesRoot, "nodes", "bad-shape.json"),
      JSON.stringify({
        recipeId: "Bad-Recipe",
        // missing required: version, nodeType, xpuSupport, knownIssues, provenance
        extraField: true
      })
    );
    const result = loadAllRecipes(recipesRoot);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0].file).toMatch(/bad-shape\.json$/);
    expect(result.invalid[0].reason).toMatch(/version|nodeType|xpuSupport|knownIssues|provenance/);
    expect(result.recipes).toHaveLength(2);
  });
});

describe("recipeLibrary.findRecipesForNode", () => {
  it("returns all recipes for a nodeType when modelFilename is omitted", () => {
    const list = findRecipesForNode("CLIPLoader", undefined, recipesRoot);
    expect(list.map((r) => r.recipeId)).toEqual(["CLIPLoader-qwen-fp8"]);
  });

  it("matches recipes whose modelPattern glob fits the filename", () => {
    const matches = findRecipesForNode(
      "CLIPLoader",
      "qwen_2.5_vl_7b_fp8_scaled.safetensors",
      recipesRoot
    );
    expect(matches.map((r) => r.recipeId)).toEqual(["CLIPLoader-qwen-fp8"]);
  });

  it("returns empty when the glob does not match", () => {
    const matches = findRecipesForNode(
      "CLIPLoader",
      "stable_diffusion_vae.safetensors",
      recipesRoot
    );
    expect(matches).toEqual([]);
  });

  it("treats missing modelPattern as a catch-all when a filename is given", () => {
    // VAELoader-generic has no modelPattern. Schema says absent = "all models
    // for this nodeType", so it should still match.
    const list = findRecipesForNode("VAELoader", "any.safetensors", recipesRoot);
    expect(list.map((r) => r.recipeId)).toEqual(["VAELoader-generic"]);
  });

  it("includes recipes with no modelPattern when no filename is given", () => {
    const list = findRecipesForNode("VAELoader", undefined, recipesRoot);
    expect(list.map((r) => r.recipeId)).toEqual(["VAELoader-generic"]);
  });
});

describe("recipeLibrary.findRecipeById", () => {
  it("finds by exact recipeId", () => {
    const r = findRecipeById("CLIPLoader-qwen-fp8", recipesRoot);
    expect(r?.recipeId).toBe("CLIPLoader-qwen-fp8");
    expect(r?.patchFile).toMatch(/0001-xpu-fp8/);
  });

  it("returns undefined for unknown recipeId", () => {
    expect(findRecipeById("nope", recipesRoot)).toBeUndefined();
  });
});

describe("recipeLibrary against the real recipes/ dir", () => {
  // This test reads the actual repo recipe. Skip if running in a context
  // where the repo root is not the cwd (e.g. some CI sandboxes). The point
  // is to catch regressions to the committed recipe.
  it("loads the committed CLIPLoader-qwen-fp8 recipe without errors", () => {
    // Use the default recipesRoot by passing the project-relative path.
    const realRoot = path.resolve(__dirname, "..", "..", "recipes");
    const result = loadAllRecipes(realRoot);
    expect(result.unparseable).toEqual([]);
    expect(result.invalid).toEqual([]);
    const ours = result.recipes.find((r) => r.recipeId === "CLIPLoader-qwen-fp8");
    expect(ours).toBeDefined();
    expect(ours?.xpuSupport).toBe("patched");
    expect(ours?.patchFile).toMatch(/xpu-fp8-fallback/);
    expect(ours?.workarounds?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
