/**
 * Upstream-history discovery for a ComfyUI core node that the workflow's own
 * `cnr_id: "comfy-core"` tag calls native, but that isn't registered in this
 * environment's pinned ComfyUI checkout (see intakePreflight.ts's
 * isCustomNode -- it cross-checks builtinNodes.ts's loadBuiltinNodeTypes and
 * flags exactly this situation as a critical gap).
 *
 * Real case that motivated this module: `TextEncodeBooguEdit` is genuinely
 * native ComfyUI, added upstream via a PR the pinned fork hadn't picked up
 * yet. The existing recipe/patch-adaptation-protocol machinery already
 * applies patches to core files generically (see recipes/nodes/
 * CLIPLoader-qwen-fp8.json, which patches comfy/ops.py the exact same way a
 * custom-node patch would) -- what's missing is a way to draft a *candidate*
 * recipe the first time a given node is seen, instead of a human having to
 * hand-author one from scratch every single time.
 *
 * Mirrors assetFuzzyMatch.ts's isolated-SDK-session pattern exactly: same
 * FreeformSessionRunner contract (already grants web_search/web_fetch), same
 * "one trailing flat JSON object" response contract, same fail-closed
 * parsing discipline. The one deliberate difference: the actual patch bytes
 * are fetched deterministically by this module (via a direct curl to
 * GitHub's static `.patch` endpoint) rather than trusted from the model's
 * own prose -- an LLM asked to reproduce a multi-file diff verbatim is
 * exactly the kind of transcription error a real patch can't tolerate.
 *
 * Entirely best-effort and advisory: nothing here writes to recipes/ or
 * patches/ directly, and any failure (search finds nothing, fetch fails,
 * the draft doesn't validate against the recipe schema) degrades to "no
 * draft available" -- it never blocks or throws.
 */
import { spawn } from "node:child_process";
import type { Recipe } from "./recipeLibrary";
import { validateRecipe } from "./schemaValidate";

export type CoreNodeDiscoveryConfidence = "high" | "medium" | "low" | "none";

export interface CoreNodeDiscoveryResult {
  found: boolean;
  confidence: CoreNodeDiscoveryConfidence;
  commitSha?: string;
  prUrl?: string;
  filesTouched?: string[];
  reason: string;
}

export interface FreeformSessionRunner {
  runFreeformSession(input: {
    cwd: string;
    prompt: string;
    sessionId: string;
    onProgress?: (message: string) => void;
    timeoutMs?: number;
  }): Promise<{ sessionId: string; summary?: string }>;
}

const DEFAULT_UPSTREAM_REPO = "Comfy-Org/ComfyUI";

export function buildCoreNodeDiscoveryPrompt(input: { nodeType: string; upstreamRepo?: string }): string {
  const upstreamRepo = input.upstreamRepo ?? DEFAULT_UPSTREAM_REPO;
  return [
    `A ComfyUI workflow uses a node class that its own metadata tags as native ComfyUI core (\`cnr_id: "comfy-core"\`), but this environment's pinned ComfyUI checkout does not have it registered -- it may be a recently-merged upstream feature this checkout hasn't picked up yet:`,
    "",
    `  "${input.nodeType}"`,
    "",
    `Use your web_search/web_fetch tool to find the specific commit or pull request in ${upstreamRepo} on GitHub that introduces this exact node class. Search for the class name directly (e.g. "${input.nodeType} ${upstreamRepo}"), check merged PRs, and confirm by looking at the actual diff -- do not guess from the name alone.`,
    "",
    "When you are done, respond with ONLY a single JSON object as the LAST thing in your response, on its own, matching exactly this shape (no markdown fencing, no trailing text after it):",
    '{"found": <true or false>, "confidence": "high" | "medium" | "low" | "none", "commitSha": "<full or short SHA, omit if not applicable>", "prUrl": "<string, omit if not applicable>", "filesTouched": ["<repo-relative path>", ...], "reason": "one sentence citing the specific corroborating evidence (PR title/number, commit message, diff content)"}',
    "",
    `Rules: only use confidence "high" if you found and read the actual merge commit/diff (not just a PR title match). Use "medium" if you found a strong textual match (PR/issue title mentions the exact class name) but did not confirm the diff content. Use "low" for a plausible but unconfirmed guess. If you found nothing plausible, set found=false, confidence="none", and omit commitSha/prUrl/filesTouched.`
  ].join("\n");
}

/**
 * Parses the model's final JSON answer. Deliberately narrow, mirroring
 * assetFuzzyMatch.ts's parseFuzzyJudgmentResponse: only looks at flat
 * (non-nested) `{...}` objects, takes the last one found, validates every
 * field strictly, and returns undefined (never a fabricated fallback) on
 * anything malformed.
 */
export function parseCoreNodeDiscoveryResponse(responseText: string): CoreNodeDiscoveryResult | undefined {
  const matches = responseText.match(/\{[^{}]*\}/g);
  if (!matches || matches.length === 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(matches[matches.length - 1]);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.found !== "boolean") return undefined;
  const confidence = obj.confidence;
  if (confidence !== "high" && confidence !== "medium" && confidence !== "low" && confidence !== "none") {
    return undefined;
  }
  const reason = typeof obj.reason === "string" ? obj.reason : "";
  const commitSha = typeof obj.commitSha === "string" ? obj.commitSha : undefined;
  const prUrl = typeof obj.prUrl === "string" ? obj.prUrl : undefined;
  const filesTouched = Array.isArray(obj.filesTouched)
    ? obj.filesTouched.filter((f): f is string => typeof f === "string")
    : undefined;

  return { found: obj.found, confidence, commitSha, prUrl, filesTouched, reason };
}

/**
 * Fetches a commit's raw patch text from GitHub's static, unauthenticated
 * `.patch` endpoint via curl (same tool/pattern as subJobs.ts's
 * contentLengthFromCurl and assetFuzzyMatch.ts's verifyUrlReachable --
 * inherits HTTPS_PROXY/proxy env vars automatically, no new plumbing).
 * Validates the body actually looks like a patch (git format-patch preamble
 * or a raw diff header) before trusting it -- catches the same "200 OK but
 * it's actually an HTML error/login page" failure mode
 * sniffTextMasqueradingAsBinary guards against elsewhere in this codebase.
 */
/**
 * A real `git format-patch`/GitHub `.patch` response starts with a `From
 * <sha> ...` preamble or contains a raw `diff --git` header; a mis-served
 * 404/login/error page won't. Exported standalone so this content check --
 * the part actually worth regression-testing -- doesn't require mocking a
 * live curl/network call.
 */
export function looksLikePatchContent(text: string): boolean {
  return /^From [0-9a-f]{7,40} /m.test(text) || text.includes("diff --git ");
}

export async function fetchCommitPatch(input: {
  repo: string;
  commitSha: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const url = `https://github.com/${input.repo}/commit/${input.commitSha}.patch`;
  return new Promise((resolve) => {
    const curl = spawn("curl", ["-sL", "--max-time", "30", url], {
      env: input.env ?? process.env,
      stdio: ["ignore", "pipe", "ignore"]
    });
    let output = "";
    curl.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    curl.on("error", () => resolve(undefined));
    curl.on("close", (code) => {
      if (code !== 0 || !output) {
        resolve(undefined);
        return;
      }
      resolve(looksLikePatchContent(output) ? output : undefined);
    });
  });
}

/**
 * Best-effort `git -C <comfyuiRoot> rev-parse --short HEAD`. Returns
 * undefined on any failure (not a git repo, git not installed, etc.) --
 * baseVersion is advisory metadata, never worth failing the whole draft over.
 */
export function localCoreCommit(comfyuiRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  return new Promise((resolve) => {
    const git = spawn("git", ["-C", comfyuiRoot, "rev-parse", "--short", "HEAD"], {
      env,
      stdio: ["ignore", "pipe", "ignore"]
    });
    let output = "";
    git.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    git.on("error", () => resolve(undefined));
    git.on("close", (code) => resolve(code === 0 && output.trim() ? output.trim() : undefined));
  });
}

/**
 * Pure function: builds a schema-conformant recipe draft from a confirmed
 * discovery result. Exported separately from discoverCoreNodeRecipe so the
 * schema-conformance itself (the part that must never regress) is testable
 * without mocking an SDK session.
 *
 * `approvedBy` is deliberately left unset -- only human promotion (a
 * separate, explicit action) fills it in, matching every other recipe's
 * provenance convention in this repo.
 */
export function buildCoreNodeRecipeDraft(input: {
  nodeType: string;
  discovery: CoreNodeDiscoveryResult;
  patchFile: string;
  baseVersion?: string;
  taskId: string;
  evidenceArtifact?: string;
}): { recipe: Recipe; valid: boolean; errorMessage?: string } {
  const recipe: Recipe = {
    recipeId: `${input.nodeType}-core-support-draft`,
    version: "0.1.0",
    nodeType: input.nodeType,
    xpuSupport: "unknown",
    patchClass: "functional_runtime_support",
    patchFile: input.patchFile,
    patchTarget: input.discovery.filesTouched?.join(", "),
    baseVersion: input.baseVersion,
    knownIssues: [
      "Auto-drafted from upstream discovery; not yet validated on XPU or reviewed by a human.",
      input.discovery.reason
    ],
    provenance: {
      taskOrigin: input.taskId,
      evidenceArtifact: input.evidenceArtifact,
      createdAt: new Date().toISOString().slice(0, 10)
    }
  };
  const result = validateRecipe(recipe);
  return { recipe, valid: result.ok, errorMessage: result.ok ? undefined : result.message };
}

/**
 * Top-level orchestration: run the discovery session, and only when it
 * reports a plausible find (confidence above "low", per the plan's intent
 * that a weak guess isn't worth surfacing) fetch the real patch and build a
 * validated draft. Returns undefined on any failure or low-confidence/no
 * find -- callers should treat that identically to "no recipe available",
 * same as the rest of Step 01's advisory-only research helpers.
 */
export async function discoverCoreNodeRecipe(input: {
  nodeType: string;
  comfyuiRoot: string;
  taskId: string;
  patchFile: string;
  runner: FreeformSessionRunner;
  cwd: string;
  sessionId: string;
  upstreamRepo?: string;
  evidenceArtifact?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  fetchPatch?: typeof fetchCommitPatch;
  getLocalCoreCommit?: typeof localCoreCommit;
}): Promise<{ recipe: Recipe; patchContent: string; discovery: CoreNodeDiscoveryResult } | undefined> {
  const upstreamRepo = input.upstreamRepo ?? DEFAULT_UPSTREAM_REPO;
  const prompt = buildCoreNodeDiscoveryPrompt({ nodeType: input.nodeType, upstreamRepo });
  const result = await input.runner.runFreeformSession({
    cwd: input.cwd,
    prompt,
    sessionId: input.sessionId,
    timeoutMs: input.timeoutMs ?? 10 * 60 * 1000
  });
  if (!result.summary) return undefined;

  const discovery = parseCoreNodeDiscoveryResponse(result.summary);
  if (!discovery || !discovery.found || !discovery.commitSha) return undefined;
  if (discovery.confidence === "low" || discovery.confidence === "none") return undefined;

  const fetchPatch = input.fetchPatch ?? fetchCommitPatch;
  const patchContent = await fetchPatch({ repo: upstreamRepo, commitSha: discovery.commitSha, env: input.env }).catch(
    () => undefined
  );
  if (!patchContent) return undefined;

  const getLocalCoreCommit = input.getLocalCoreCommit ?? localCoreCommit;
  const localCommit = await getLocalCoreCommit(input.comfyuiRoot, input.env ?? process.env).catch(() => undefined);
  const baseVersion = localCommit ? `local-comfyui@${localCommit}` : undefined;

  const draft = buildCoreNodeRecipeDraft({
    nodeType: input.nodeType,
    discovery,
    patchFile: input.patchFile,
    baseVersion,
    taskId: input.taskId,
    evidenceArtifact: input.evidenceArtifact
  });
  if (!draft.valid) return undefined;

  return { recipe: draft.recipe, patchContent, discovery };
}
