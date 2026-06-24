import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  extractNodeModelPairs,
  findMatchingRecipes,
  formatRecipesForPrompt,
  injectRecipesForWorkflow,
  RECIPE_INJECTION_STEPS
} from "./recipeInjector";

// Synthetic workflow that should match the CLIPLoader FP8 recipe.
const WORKFLOW_WITH_FP8_CLIP = {
  nodes: [
    {
      id: 1,
      type: "CLIPLoader",
      widgets_values: ["qwen_2.5_vl_7b_fp8_scaled.safetensors"]
    },
    { id: 2, type: "VAELoader", widgets_values: ["ae.safetensors"] },
    { id: 3, type: "UNETLoader", widgets_values: ["flux1-dev.safetensors"] },
    { id: 4, type: "PreviewImage" }
  ]
};

const WORKFLOW_NO_MODELS = {
  nodes: [
    { id: 1, type: "PreviewImage" },
    { id: 2, type: "Note" }
  ]
};

const CLILOADER_FP8_RECIPE = {
  recipeId: "CLIPLoader-qwen25-vl-fp8",
  version: "1.0.0",
  nodeType: "CLIPLoader",
  modelPattern: "qwen_*_vl_*_fp8*.safetensors",
  xpuSupport: "patched",
  patchClass: "functional_runtime_support",
  patchFile: "patches/xpu-bug-investigation/0001-xpu-fp8-fallback.patch",
  knownIssues: ["QTensor.clone() segfaults on .to('xpu')"],
  workarounds: [
    {
      action: "Apply the dequant-before-move patch to comfy/ops.py",
      tradeoff: "Doubles activation memory"
    }
  ],
  provenance: { taskOrigin: "7f5cf9e4", createdAt: "2026-06-19" }
};

const VAE_NATIVE_RECIPE = {
  recipeId: "VAELoader-generic",
  version: "0.1.0",
  nodeType: "VAELoader",
  xpuSupport: "native",
  knownIssues: [],
  provenance: { taskOrigin: "manual", createdAt: "2026-06-01" }
};

let recipesRoot: string;
let workflowPath: string;

beforeEach(async () => {
  recipesRoot = await mkdtemp(path.join(tmpdir(), "inj-recipes-"));
  await mkdir(path.join(recipesRoot, "nodes"), { recursive: true });
  await writeFile(
    path.join(recipesRoot, "nodes", "CLIPLoader-qwen25-vl-fp8.json"),
    JSON.stringify(CLILOADER_FP8_RECIPE)
  );
  await writeFile(
    path.join(recipesRoot, "nodes", "VAELoader-generic.json"),
    JSON.stringify(VAE_NATIVE_RECIPE)
  );

  const tmp = await mkdtemp(path.join(tmpdir(), "inj-wf-"));
  workflowPath = path.join(tmp, "wf.json");
  await writeFile(workflowPath, JSON.stringify(WORKFLOW_WITH_FP8_CLIP));
});

afterEach(async () => {
  await rm(recipesRoot, { recursive: true, force: true });
  await rm(path.dirname(workflowPath), { recursive: true, force: true });
});

describe("recipeInjector.extractNodeModelPairs", () => {
  it("extracts (nodeType, modelFilename) pairs from workflow JSON", () => {
    const pairs = extractNodeModelPairs(WORKFLOW_WITH_FP8_CLIP);
    expect(pairs).toContainEqual({ nodeType: "CLIPLoader", modelFilename: "qwen_2.5_vl_7b_fp8_scaled.safetensors" });
    expect(pairs).toContainEqual({ nodeType: "VAELoader", modelFilename: "ae.safetensors" });
  });

  it("returns nodeType-only entries for nodes without model widgets", () => {
    const pairs = extractNodeModelPairs(WORKFLOW_NO_MODELS);
    expect(pairs).toEqual([
      { nodeType: "PreviewImage" },
      { nodeType: "Note" }
    ]);
  });

  it("returns empty array for malformed workflow JSON", () => {
    expect(extractNodeModelPairs(null)).toEqual([]);
    expect(extractNodeModelPairs({})).toEqual([]);
    expect(extractNodeModelPairs({ nodes: "not-an-array" })).toEqual([]);
  });

  it("ignores widget values that don't look like model files", () => {
    const pairs = extractNodeModelPairs({
      nodes: [
        { id: 1, type: "KSampler", widgets_values: [42, "euler", false, 0.5] }
      ]
    });
    expect(pairs).toEqual([{ nodeType: "KSampler" }]);
  });
});

describe("recipeInjector.findMatchingRecipes", () => {
  it("matches a recipe by nodeType + modelPattern glob", () => {
    const pairs = extractNodeModelPairs(WORKFLOW_WITH_FP8_CLIP);
    const matches = findMatchingRecipes(pairs, recipesRoot);
    const ids = matches.map((r) => r.recipeId);
    expect(ids).toContain("CLIPLoader-qwen25-vl-fp8");
  });

  it("includes native recipes whose nodeType appears (no modelPattern required)", () => {
    const pairs = extractNodeModelPairs(WORKFLOW_WITH_FP8_CLIP);
    const matches = findMatchingRecipes(pairs, recipesRoot);
    const ids = matches.map((r) => r.recipeId);
    expect(ids).toContain("VAELoader-generic");
  });

  it("returns empty when nothing matches", () => {
    const pairs = [{ nodeType: "NonexistentLoader", modelFilename: "x.safetensors" }];
    expect(findMatchingRecipes(pairs, recipesRoot)).toEqual([]);
  });

  it("dedupes by recipeId when multiple pair hits would repeat", () => {
    const pairs = [
      { nodeType: "CLIPLoader", modelFilename: "qwen_2.5_vl_7b_fp8_scaled.safetensors" },
      { nodeType: "CLIPLoader", modelFilename: "qwen_2.5_vl_3b_fp8.safetensors" }
    ];
    const matches = findMatchingRecipes(pairs, recipesRoot);
    expect(matches.filter((r) => r.recipeId === "CLIPLoader-qwen25-vl-fp8")).toHaveLength(1);
  });
});

describe("recipeInjector.formatRecipesForPrompt", () => {
  it("produces a non-empty markdown section when recipes are present", () => {
    const pairs = extractNodeModelPairs(WORKFLOW_WITH_FP8_CLIP);
    const matches = findMatchingRecipes(pairs, recipesRoot);
    const md = formatRecipesForPrompt(matches);
    expect(md).toContain("## Matched recipes");
    expect(md).toContain("CLIPLoader-qwen25-vl-fp8");
    expect(md).toContain("QTensor.clone()"); // knownIssues content
    expect(md).toContain("workarounds (in priority order)");
  });

  it("returns empty string for no recipes", () => {
    expect(formatRecipesForPrompt([])).toBe("");
  });
});

describe("recipeInjector.injectRecipesForWorkflow", () => {
  it("injects when stepId is 02/04/05", async () => {
    const out = await injectRecipesForWorkflow({
      workflowPath,
      stepId: "04",
      recipesRoot
    });
    expect(out).toContain("CLIPLoader-qwen25-vl-fp8");
  });

  it("returns empty for steps outside the injection set", async () => {
    for (const stepId of ["00", "01", "03", "06", "07", "12", "13"]) {
      const out = await injectRecipesForWorkflow({
        workflowPath,
        stepId,
        recipesRoot
      });
      expect(out).toBe("");
    }
  });

  it("returns empty when no recipes match the workflow", async () => {
    const emptyWf = path.join(path.dirname(workflowPath), "wf2.json");
    await writeFile(emptyWf, JSON.stringify(WORKFLOW_NO_MODELS));
    const out = await injectRecipesForWorkflow({
      workflowPath: emptyWf,
      stepId: "04",
      recipesRoot
    });
    expect(out).toBe("");
  });

  it("returns empty on malformed workflow JSON (no throw)", async () => {
    const badWf = path.join(path.dirname(workflowPath), "bad.json");
    await writeFile(badWf, "{ not json");
    const out = await injectRecipesForWorkflow({
      workflowPath: badWf,
      stepId: "04",
      recipesRoot
    });
    expect(out).toBe("");
  });

  it("returns empty when workflow file does not exist", async () => {
    const out = await injectRecipesForWorkflow({
      workflowPath: "/nonexistent/workflow.json",
      stepId: "04",
      recipesRoot
    });
    expect(out).toBe("");
  });
});

describe("recipeInjector.RECIPE_INJECTION_STEPS", () => {
  it("contains exactly 02, 04, 05", () => {
    expect([...RECIPE_INJECTION_STEPS].sort()).toEqual(["02", "04", "05"]);
  });
});
