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
import type { AssetSourceCandidate } from "./assetSourceProviders";

export type FuzzyMatchConfidence = "high" | "medium" | "low" | "none";

export interface FuzzyJudgment {
  matchedCandidateIndex: number | null;
  confidence: FuzzyMatchConfidence;
  reason: string;
  suggestedUrl?: string;
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
}): Promise<FuzzyJudgment | undefined> {
  const prompt = buildFuzzyJudgmentPrompt({ requestedName: input.requestedName, candidates: input.candidates });
  const result = await input.runner.runFreeformSession({
    cwd: input.cwd,
    prompt,
    sessionId: input.sessionId,
    timeoutMs: input.timeoutMs ?? 10 * 60 * 1000
  });
  if (!result.summary) return undefined;
  return parseFuzzyJudgmentResponse(result.summary, input.candidates.length);
}
