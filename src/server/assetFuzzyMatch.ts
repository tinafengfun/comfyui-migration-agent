/**
 * LLM-judged fuzzy asset matching for Step 01.
 *
 * Deterministic query-variant generation (see generateAssetQueryVariants in
 * assetAcquisition.ts) only strips noise already present in the requested
 * filename -- it can't invent a semantically-related term that isn't in the
 * string at all. Real case that motivated this module: a workflow requested
 * "Z-Image-Anime-AIO-FP8_V1.safetensors", which is actually
 * "z-image-anime-aio-fp8.safetensors" inside the HuggingFace repo
 * SeeSee21/Z-Image-Turbo-AIO -- no string transform of the filename produces
 * "Turbo" (the word that actually appears in the repo name), since it never
 * appears in the filename to begin with. A plain web search finds this in
 * seconds by reasoning about what the fragments likely mean; this module
 * gives the pipeline the same capability by spinning up an isolated Copilot
 * SDK session (via CopilotSdkRunner.runFreeformSession, which already grants
 * the session's default web_search/web_fetch tools -- see
 * copilotSdkRunner.ts) to verify pre-found candidates or independently
 * search for the real source.
 *
 * This is advisory only: the result is never merged into row.resolved_path
 * or used to auto-download anything (isExactDownloadCandidate in
 * assetAcquisition.ts is untouched and still requires an exact filename
 * match). It only enriches the human gate's question text with reasoning,
 * matching the "the human always explicitly picks" rule already in place
 * for every other gate in this project.
 */
import { spawn } from "node:child_process";
import type { AssetSourceCandidate } from "./assetSourceProviders";

export type FuzzyMatchConfidence = "high" | "medium" | "low" | "none";

export interface FuzzyJudgment {
  matchedCandidateIndex: number | null;
  confidence: FuzzyMatchConfidence;
  reason: string;
  suggestedUrl?: string;
  /**
   * Best-effort live reachability check on suggestedUrl, added after a real
   * incident: the LLM judgment session has real web_search/web_fetch tools
   * (see module docstring) but its final answer can still be wrong -- one
   * suggestedUrl pointed at a HuggingFace repo that doesn't appear to exist
   * at all. Undefined (not false) means the check itself didn't run or
   * couldn't complete -- never treat "unverified" as "confirmed bad."
   */
  urlVerified?: boolean;
  urlVerifiedDetail?: string;
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

export function buildFuzzyJudgmentPrompt(input: {
  requestedName: string;
  candidates: AssetSourceCandidate[];
}): string {
  const candidateLines = input.candidates.length
    ? input.candidates
        .map((candidate, index) => `${index}. [${candidate.provider}] ${candidate.title} -- ${candidate.url}${candidate.notes ? ` (${candidate.notes})` : ""}`)
        .join("\n")
    : "(structured keyword search found nothing)";

  return [
    "A ComfyUI workflow migration references a model/LoRA file that could not be found under its exact requested name:",
    "",
    `  "${input.requestedName}"`,
    "",
    "Workflow authors sometimes reference a file under a relabeled/mangled name: extra descriptive words mixed in, a parenthetical strength-range hint, a stale version suffix, or a completely different naming style than the file's real upload (e.g. a descriptive word like \"Anime\" in the filename when the real repo is actually named after something else, like \"Turbo\").",
    "",
    "Structured keyword search against HuggingFace/Civitai/ModelScope/GitHub already found these candidates (index: provider, title, url):",
    candidateLines,
    "",
    "Use your web_search/web_fetch tool to verify whether any candidate above is genuinely the same asset, or to find the real source if none of them are -- reason about what the filename's fragments likely mean (model family, precision/quantization tag, style/purpose, version) and search for it directly, the way you'd research any unfamiliar file name.",
    "",
    "When you are done, respond with ONLY a single JSON object as the LAST thing in your response, on its own, matching exactly this shape (no markdown fencing, no trailing text after it):",
    '{"matchedCandidateIndex": <number or null>, "confidence": "high" | "medium" | "low" | "none", "reason": "one sentence citing the specific corroborating evidence", "suggestedUrl": "<string, omit if not applicable>"}',
    "",
    "Rules: matchedCandidateIndex refers to the candidate list above -- use null if the real match isn't in that list but you found it yourself via web search (put the source in suggestedUrl instead). Never use confidence \"high\" without a concrete corroborating detail (matching numeric range, matching author/uploader, matching file size, matching description) -- vague genre/style similarity alone is at most \"low\". If you cannot find anything plausible, use confidence \"none\" and matchedCandidateIndex null."
  ].join("\n");
}

/**
 * Parses the model's final JSON answer out of a freeform response that may
 * contain tool-call narration/reasoning before it. Deliberately narrow: only
 * looks at flat (non-nested) `{...}` objects, takes the last one found, and
 * validates every field strictly. Returns undefined (no judgment) rather
 * than guessing on anything malformed or out of range -- never fabricates a
 * fallback, matching the precedent set by taskStatePatch.ts/
 * agentImprovementPatch.ts's parsing.
 */
export function parseFuzzyJudgmentResponse(
  responseText: string,
  candidateCount: number
): FuzzyJudgment | undefined {
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

  const confidence = obj.confidence;
  if (confidence !== "high" && confidence !== "medium" && confidence !== "low" && confidence !== "none") {
    return undefined;
  }

  let matchedCandidateIndex: number | null = null;
  const rawIndex = obj.matchedCandidateIndex;
  if (typeof rawIndex === "number") {
    if (!Number.isInteger(rawIndex) || rawIndex < 0 || rawIndex >= candidateCount) return undefined;
    matchedCandidateIndex = rawIndex;
  } else if (rawIndex !== null && rawIndex !== undefined) {
    return undefined;
  }

  const reason = typeof obj.reason === "string" ? obj.reason : "";
  const suggestedUrl = typeof obj.suggestedUrl === "string" ? obj.suggestedUrl : undefined;
  return { matchedCandidateIndex, confidence, reason, suggestedUrl };
}

/**
 * Live HEAD-style reachability check for a suggestedUrl, modeled on
 * subJobs.ts's contentLengthFromCurl (same curl invocation shape, honors the
 * same proxy env vars). Best-effort: any failure (timeout, DNS, network)
 * resolves reachable:false with a short detail string -- never throws, so a
 * flaky check can't fail the whole fuzzy-match step.
 */
export async function verifyUrlReachable(
  url: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ reachable: boolean; detail: string }> {
  if (!url.startsWith("http")) {
    return { reachable: false, detail: `not an http(s) URL: ${url}` };
  }
  return new Promise((resolve) => {
    const head = spawn("curl", ["-I", "-L", "--silent", "--max-time", "15", url], {
      env,
      stdio: ["ignore", "pipe", "ignore"]
    });
    let output = "";
    head.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    head.on("error", (error) => {
      resolve({ reachable: false, detail: `curl failed to start: ${error.message}` });
    });
    head.on("close", (code) => {
      // -L follows redirects; the LAST status line reflects the final hop.
      const statusLines = [...output.matchAll(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/gim)];
      const lastStatus = statusLines.at(-1)?.[1];
      if (!lastStatus) {
        resolve({ reachable: false, detail: code === 0 ? "no HTTP status line in response" : `curl exited ${code}` });
        return;
      }
      const statusNum = Number(lastStatus);
      resolve({
        reachable: statusNum >= 200 && statusNum < 400,
        detail: `HTTP ${lastStatus}`
      });
    });
  });
}

// Matches both a bare HF repo URL (https://huggingface.co/owner/repo) and a
// file-level URL (.../blob|resolve/<revision>/<path>) -- the whole point is
// to also catch the broken case where suggestedUrl is just the repo's own
// landing page, which a plain HTTP-status check can't distinguish from a
// real file link (both return 200).
const HF_URL_PATTERN =
  /^https:\/\/(?:huggingface\.co|hf-mirror\.com)\/([^/\s]+\/[^/\s]+?)(?:\/(?:tree|blob|resolve)\/([^/\s]+)(?:\/(.+))?)?\/?(?:[?#].*)?$/;

/**
 * Confirms the requested filename actually appears in the target HF repo's
 * own file manifest (via the /api/models/<repo> `siblings` list), instead of
 * only checking that some URL under that repo returns HTTP 200. Real
 * incident this closes: a suggestedUrl was just a repo's landing page
 * (https://huggingface.co/meituan-longcat/LongCat-Video-Avatar-1.5) -- that
 * page is a real, reachable, HTTP-200 URL, so the old HTTP-only check passed
 * it as "✓ verified reachable" even though the repo does not contain a file
 * named LongCat-Avatar-15_bf16.safetensors at all (only differently-shaped
 * sharded files). The download later failed once approved, but only after a
 * human had already trusted a misleading "verified" badge.
 *
 * Returns `fileConfirmed: undefined` (not false) whenever the check itself
 * couldn't run (non-HF URL, network/API failure) -- never treat "couldn't
 * check" as "confirmed absent."
 */
export async function verifyFilenameInHfManifest(
  url: string,
  requestedName: string,
  env: NodeJS.ProcessEnv = process.env,
  /** Test seam only: override where the /api/models/<repo> lookup itself is sent, independent of the huggingface.co/hf-mirror.com host the URL must still match. */
  apiOriginOverride?: string
): Promise<{ fileConfirmed: boolean | undefined; detail: string }> {
  const match = HF_URL_PATTERN.exec(url.trim());
  if (!match) return { fileConfirmed: undefined, detail: "not a recognized HuggingFace URL -- manifest check skipped" };
  const repoId = match[1];
  const endpoint = apiOriginOverride ?? (url.includes("hf-mirror.com") ? "https://hf-mirror.com" : "https://huggingface.co");

  return new Promise((resolve) => {
    const proc = spawn(
      "curl",
      ["-L", "--fail", "--silent", "--max-time", "15", "-H", "Accept: application/json", `${endpoint}/api/models/${repoId}`],
      { env, stdio: ["ignore", "pipe", "ignore"] }
    );
    let output = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    proc.on("error", (error) => {
      resolve({ fileConfirmed: undefined, detail: `manifest lookup failed to start: ${error.message}` });
    });
    proc.on("close", (code) => {
      if (code !== 0 || !output) {
        resolve({ fileConfirmed: undefined, detail: `manifest lookup failed (curl exited ${code})` });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(output);
      } catch {
        resolve({ fileConfirmed: undefined, detail: "manifest lookup returned non-JSON response" });
        return;
      }
      const siblings = (parsed as { siblings?: unknown[] })?.siblings;
      if (!Array.isArray(siblings)) {
        resolve({ fileConfirmed: undefined, detail: "manifest response had no siblings list" });
        return;
      }
      const basename = requestedName.split("/").pop() ?? requestedName;
      const found = siblings.some((entry) => {
        const rfilename = (entry as { rfilename?: unknown })?.rfilename;
        return typeof rfilename === "string" && (rfilename === requestedName || rfilename.split("/").pop() === basename);
      });
      resolve({
        fileConfirmed: found,
        detail: found
          ? `confirmed in ${repoId}'s file manifest`
          : `NOT found in ${repoId}'s file manifest (${siblings.length} file(s) listed)`
      });
    });
  });
}

/**
 * Only worth calling for the genuinely ambiguous case: structured search
 * found something but not an exact filename match. Callers should skip this
 * entirely once an exact match already exists (see isExactDownloadCandidate
 * in assetAcquisition.ts) -- no LLM call needed for the common case.
 */
export async function judgeFuzzyMatch(input: {
  requestedName: string;
  candidates: AssetSourceCandidate[];
  runner: FreeformSessionRunner;
  cwd: string;
  sessionId: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Test seam only -- see verifyFilenameInHfManifest's apiOriginOverride. */
  hfApiOriginOverride?: string;
}): Promise<FuzzyJudgment | undefined> {
  const prompt = buildFuzzyJudgmentPrompt({ requestedName: input.requestedName, candidates: input.candidates });
  const result = await input.runner.runFreeformSession({
    cwd: input.cwd,
    prompt,
    sessionId: input.sessionId,
    timeoutMs: input.timeoutMs ?? 10 * 60 * 1000
  });
  if (!result.summary) return undefined;
  const judgment = parseFuzzyJudgmentResponse(result.summary, input.candidates.length);
  if (!judgment?.suggestedUrl) return judgment;
  const env = input.env ?? process.env;
  try {
    const { reachable, detail } = await verifyUrlReachable(judgment.suggestedUrl, env);
    // The manifest check is strictly stronger evidence than raw HTTP
    // reachability -- when it actually ran (fileConfirmed !== undefined), it
    // decides urlVerified outright, overriding a merely-reachable page that
    // isn't the real file. When it couldn't run (non-HF source, API
    // hiccup), fall back to the reachability result exactly as before.
    const manifestResult = await verifyFilenameInHfManifest(
      judgment.suggestedUrl,
      input.requestedName,
      env,
      input.hfApiOriginOverride
    );
    if (manifestResult.fileConfirmed !== undefined) {
      return { ...judgment, urlVerified: manifestResult.fileConfirmed, urlVerifiedDetail: manifestResult.detail };
    }
    return { ...judgment, urlVerified: reachable, urlVerifiedDetail: detail };
  } catch (error) {
    // Never let a flaky verification check fail the whole judgment.
    return { ...judgment, urlVerifiedDetail: `verification error: ${error instanceof Error ? error.message : String(error)}` };
  }
}
