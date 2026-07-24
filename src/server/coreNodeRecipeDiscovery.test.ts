import { describe, expect, it } from "vitest";
import {
  buildCoreNodeDiscoveryPrompt,
  buildCoreNodeRecipeDraft,
  discoverCoreNodeRecipe,
  looksLikePatchContent,
  parseCoreNodeDiscoveryResponse,
  type CoreNodeDiscoveryResult,
  type FreeformSessionRunner
} from "./coreNodeRecipeDiscovery";

describe("buildCoreNodeDiscoveryPrompt", () => {
  it("includes the node type and defaults the upstream repo", () => {
    const prompt = buildCoreNodeDiscoveryPrompt({ nodeType: "TextEncodeBooguEdit" });
    expect(prompt).toContain("TextEncodeBooguEdit");
    expect(prompt).toContain("Comfy-Org/ComfyUI");
  });

  it("honors an explicit upstream repo override", () => {
    const prompt = buildCoreNodeDiscoveryPrompt({ nodeType: "Foo", upstreamRepo: "tinafengfun/ComfyUI" });
    expect(prompt).toContain("tinafengfun/ComfyUI");
    expect(prompt).not.toContain("Comfy-Org/ComfyUI");
  });
});

describe("parseCoreNodeDiscoveryResponse", () => {
  it("parses a well-formed trailing JSON object", () => {
    const text = 'I searched and found it.\n\n{"found": true, "confidence": "high", "commitSha": "abc1234", "prUrl": "https://github.com/Comfy-Org/ComfyUI/pull/14523", "filesTouched": ["comfy_extras/nodes_boogu.py"], "reason": "PR#14523 merge commit adds TextEncodeBooguEdit"}';
    const result = parseCoreNodeDiscoveryResponse(text);
    expect(result).toEqual({
      found: true,
      confidence: "high",
      commitSha: "abc1234",
      prUrl: "https://github.com/Comfy-Org/ComfyUI/pull/14523",
      filesTouched: ["comfy_extras/nodes_boogu.py"],
      reason: "PR#14523 merge commit adds TextEncodeBooguEdit"
    });
  });

  it("returns undefined when found is missing or not a boolean", () => {
    expect(parseCoreNodeDiscoveryResponse('{"confidence": "high", "reason": "x"}')).toBeUndefined();
    expect(parseCoreNodeDiscoveryResponse('{"found": "yes", "confidence": "high", "reason": "x"}')).toBeUndefined();
  });

  it("returns undefined for an invalid confidence value", () => {
    expect(parseCoreNodeDiscoveryResponse('{"found": true, "confidence": "certain", "reason": "x"}')).toBeUndefined();
  });

  it("returns undefined when no JSON object is present", () => {
    expect(parseCoreNodeDiscoveryResponse("I could not find anything relevant.")).toBeUndefined();
  });

  it("accepts found=false with confidence none and omitted optional fields", () => {
    const result = parseCoreNodeDiscoveryResponse('{"found": false, "confidence": "none", "reason": "no plausible match"}');
    expect(result).toEqual({
      found: false,
      confidence: "none",
      commitSha: undefined,
      prUrl: undefined,
      filesTouched: undefined,
      reason: "no plausible match"
    });
  });
});

describe("looksLikePatchContent", () => {
  it("recognizes a git format-patch preamble", () => {
    expect(looksLikePatchContent("From abc1234def5678 Mon Sep 17 00:00:00 2001\nSubject: add node\n")).toBe(true);
  });

  it("recognizes a raw diff header", () => {
    expect(looksLikePatchContent("some preamble\ndiff --git a/foo.py b/foo.py\n")).toBe(true);
  });

  it("rejects an HTML error/login page", () => {
    expect(looksLikePatchContent("<!doctype html>\n<html><body>Sign in to GitHub</body></html>")).toBe(false);
  });

  it("rejects an empty body", () => {
    expect(looksLikePatchContent("")).toBe(false);
  });
});

describe("buildCoreNodeRecipeDraft", () => {
  const discovery: CoreNodeDiscoveryResult = {
    found: true,
    confidence: "high",
    commitSha: "abc1234",
    prUrl: "https://github.com/Comfy-Org/ComfyUI/pull/14523",
    filesTouched: ["comfy_extras/nodes_boogu.py", "comfy/text_encoders/boogu.py"],
    reason: "PR#14523 merge commit adds TextEncodeBooguEdit"
  };

  it("builds a recipe draft that validates against the real recipe schema", () => {
    const draft = buildCoreNodeRecipeDraft({
      nodeType: "TextEncodeBooguEdit",
      discovery,
      patchFile: "artifacts/staged-recipes/TextEncodeBooguEdit-core-support.patch",
      baseVersion: "local-comfyui@30d03b0",
      taskId: "task-123",
      evidenceArtifact: "02-feasibility.md"
    });
    expect(draft.valid).toBe(true);
    expect(draft.recipe).toMatchObject({
      recipeId: "TextEncodeBooguEdit-core-support-draft",
      nodeType: "TextEncodeBooguEdit",
      xpuSupport: "unknown",
      patchFile: "artifacts/staged-recipes/TextEncodeBooguEdit-core-support.patch",
      patchTarget: "comfy_extras/nodes_boogu.py, comfy/text_encoders/boogu.py",
      baseVersion: "local-comfyui@30d03b0"
    });
    expect(draft.recipe.provenance.approvedBy).toBeUndefined();
  });

  it("still validates when baseVersion/evidenceArtifact/filesTouched are absent", () => {
    const draft = buildCoreNodeRecipeDraft({
      nodeType: "SomeOtherNode",
      discovery: { found: true, confidence: "medium", reason: "textual PR title match only" },
      patchFile: "artifacts/staged-recipes/SomeOtherNode-core-support.patch",
      taskId: "task-456"
    });
    expect(draft.valid).toBe(true);
  });

  it("fails validation (rather than silently producing a broken recipe) when recipeId characters are invalid", () => {
    // A node type with characters outside recipeId's schema pattern (letters/digits/_/- only)
    // would otherwise silently produce an unusable draft; confirm the schema catches it.
    const draft = buildCoreNodeRecipeDraft({
      nodeType: "Weird Node:Type!",
      discovery,
      patchFile: "artifacts/staged-recipes/weird.patch",
      taskId: "task-789"
    });
    expect(draft.valid).toBe(false);
    expect(draft.errorMessage).toBeTruthy();
  });
});

function makeRunner(summary: string | undefined): FreeformSessionRunner {
  return {
    async runFreeformSession() {
      return { sessionId: "test-session", summary };
    }
  };
}

describe("discoverCoreNodeRecipe", () => {
  const validSummary =
    '{"found": true, "confidence": "high", "commitSha": "abc1234", "prUrl": "https://github.com/Comfy-Org/ComfyUI/pull/14523", "filesTouched": ["comfy_extras/nodes_boogu.py"], "reason": "confirmed via merge commit diff"}';

  it("returns a validated draft end-to-end when discovery, patch fetch, and commit lookup all succeed", async () => {
    const result = await discoverCoreNodeRecipe({
      nodeType: "TextEncodeBooguEdit",
      comfyuiRoot: "/fake/ComfyUI",
      taskId: "task-abc",
      patchFile: "artifacts/staged-recipes/TextEncodeBooguEdit-core-support.patch",
      runner: makeRunner(validSummary),
      cwd: "/fake/workspace",
      sessionId: "task-abc-01-core-node-TextEncodeBooguEdit",
      fetchPatch: async () => "From abc1234 Mon Sep 17 00:00:00 2001\nSubject: add TextEncodeBooguEdit\n",
      getLocalCoreCommit: async () => "30d03b0"
    });

    expect(result).toBeDefined();
    expect(result?.recipe.baseVersion).toBe("local-comfyui@30d03b0");
    expect(result?.patchContent).toContain("TextEncodeBooguEdit");
    expect(result?.discovery.commitSha).toBe("abc1234");
  });

  it("returns undefined when the session produces no summary", async () => {
    const result = await discoverCoreNodeRecipe({
      nodeType: "TextEncodeBooguEdit",
      comfyuiRoot: "/fake/ComfyUI",
      taskId: "task-abc",
      patchFile: "artifacts/staged-recipes/x.patch",
      runner: makeRunner(undefined),
      cwd: "/fake/workspace",
      sessionId: "s"
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined on a low-confidence find (not worth surfacing)", async () => {
    const result = await discoverCoreNodeRecipe({
      nodeType: "TextEncodeBooguEdit",
      comfyuiRoot: "/fake/ComfyUI",
      taskId: "task-abc",
      patchFile: "artifacts/staged-recipes/x.patch",
      runner: makeRunner('{"found": true, "confidence": "low", "reason": "vague guess"}'),
      cwd: "/fake/workspace",
      sessionId: "s"
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when the patch fetch fails (e.g. 404/HTML page)", async () => {
    const result = await discoverCoreNodeRecipe({
      nodeType: "TextEncodeBooguEdit",
      comfyuiRoot: "/fake/ComfyUI",
      taskId: "task-abc",
      patchFile: "artifacts/staged-recipes/x.patch",
      runner: makeRunner(validSummary),
      cwd: "/fake/workspace",
      sessionId: "s",
      fetchPatch: async () => undefined
    });
    expect(result).toBeUndefined();
  });

  it("still succeeds (with baseVersion omitted) when local commit lookup fails", async () => {
    const result = await discoverCoreNodeRecipe({
      nodeType: "TextEncodeBooguEdit",
      comfyuiRoot: "/fake/ComfyUI",
      taskId: "task-abc",
      patchFile: "artifacts/staged-recipes/x.patch",
      runner: makeRunner(validSummary),
      cwd: "/fake/workspace",
      sessionId: "s",
      fetchPatch: async () => "diff --git a/foo b/foo\n",
      getLocalCoreCommit: async () => undefined
    });
    expect(result).toBeDefined();
    expect(result?.recipe.baseVersion).toBeUndefined();
  });
});
