/**
 * vlmJudge.ts — SUBJECTIVE/semantic quality judge using the on-node local VLM
 * (the same llama.cpp VLM that node-localization substitutes for cloud API nodes).
 *
 * Why this exists (a real blind spot in quality.ts):
 *   The objective gate (spatialContrast/blackdetect) catches TRULY flat/black
 *   output, but a "ran-but-degenerate" render — a muddy near-flat image with a
 *   slight gradient — scores just above the flat threshold and FALSELY PASSES.
 *   Observed live: a blank Flux render scored spatialContrast 5–17 (threshold 3)
 *   while a real render scored 100+. A VLM reads the image semantically and
 *   answers PASS/FAIL, catching exactly that class. Validated live on the node:
 *   good apple → "PASS — high-quality detailed render …"; blank → "FAIL — uniform
 *   muddy brown, no content".
 *
 * The judge runs against the SAME ComfyUI serving the render, reusing the local
 * VLM subgraph (model_loader + parameters + instruct_adv). Supply the three VLM
 * node configs (named inputs) — e.g. via extractVlmConfigFromGraph() on the
 * localized workflow, which already contains them after Step 03b.
 */
export interface VlmNode {
  class_type: string;
  inputs: Record<string, unknown>;
}
export interface VlmNodeConfig {
  loader: VlmNode; // llama_cpp_model_loader
  params: VlmNode; // llama_cpp_parameters
  instruct: VlmNode; // llama_cpp_instruct_adv
}

export interface VlmVerdict {
  pass: boolean;
  raw: string;
  reason: string;
}

export const DEFAULT_JUDGE_PROMPT =
  "You are a strict image-quality inspector for an AI image render pipeline. Look at the image. " +
  "If it shows real, detailed, coherent visual content, answer PASS. If it is a blank, flat, or muddy " +
  "single-color image with essentially no content (a failed or degenerate render), answer FAIL. " +
  "First line: exactly PASS or FAIL. Second line: one short reason.";

/**
 * Parse a VLM judge reply into a structured verdict. Fail-closed: only an
 * explicit leading PASS (with no FAIL) passes; anything ambiguous is treated as
 * a failure so a degenerate render never slips through on a garbled reply. Pure.
 */
export function parseVlmVerdict(raw: string): VlmVerdict {
  const text = String(raw ?? "").trim();
  const head = text.slice(0, 200).toUpperCase();
  const hasFail = /\bFAIL(?:ED|URE)?\b/.test(head);
  const hasPass = /\bPASS(?:ED|ES)?\b/.test(head);
  const pass = hasPass && !hasFail;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const reason = lines.slice(1).join(" ") || lines[0] || text;
  return { pass, raw: text, reason };
}

/**
 * Pull the llama_cpp VLM subgraph (loader + parameters + instruct_adv) out of a
 * ComfyUI API-prompt graph (e.g. the localized workflow after Step 03b). Returns
 * null if the graph has no local VLM. Pure.
 */
export function extractVlmConfigFromGraph(prompt: Record<string, any>): VlmNodeConfig | null {
  const byClass = (c: string) =>
    Object.values(prompt).find((n: any) => n && n.class_type === c) as VlmNode | undefined;
  const loader = byClass("llama_cpp_model_loader");
  const params = byClass("llama_cpp_parameters");
  const instruct = byClass("llama_cpp_instruct_adv");
  if (!loader || !params || !instruct) return null;
  return {
    loader: { class_type: loader.class_type, inputs: { ...loader.inputs } },
    params: { class_type: params.class_type, inputs: { ...params.inputs } },
    instruct: { class_type: instruct.class_type, inputs: { ...instruct.inputs } },
  };
}

/**
 * Build a ComfyUI API-prompt graph that loads `inputImage` (a filename already in
 * ComfyUI's input dir) and asks the local VLM to judge it. Reuses the supplied
 * VLM node inputs, overriding only the wiring (model/params/images) + the prompt.
 * Pure.
 */
export function buildJudgeGraph(
  vlm: VlmNodeConfig,
  inputImage: string,
  prompt: string = DEFAULT_JUDGE_PROMPT
): Record<string, any> {
  const LOADER = "10", PARAMS = "11", VLM = "12", LOAD = "13", OUT = "14";
  const instructInputs: Record<string, unknown> = { ...vlm.instruct.inputs };
  instructInputs.llama_model = [LOADER, 0];
  instructInputs.parameters = [PARAMS, 0];
  instructInputs.images = [LOAD, 0];
  instructInputs.custom_prompt = prompt;
  if ("system_prompt" in instructInputs)
    instructInputs.system_prompt = "Output only PASS or FAIL on the first line, then one short reason.";
  return {
    [LOADER]: { class_type: vlm.loader.class_type, inputs: { ...vlm.loader.inputs } },
    [PARAMS]: { class_type: vlm.params.class_type, inputs: { ...vlm.params.inputs } },
    [LOAD]: { class_type: "LoadImage", inputs: { image: inputImage } },
    [VLM]: { class_type: vlm.instruct.class_type, inputs: instructInputs },
    [OUT]: { class_type: "PreviewAny", inputs: { source: [VLM, 0] } },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Integration (needs a live ComfyUI with the llama_cpp VLM node + gguf models)
// ─────────────────────────────────────────────────────────────────────────────

async function comfyPost(comfyUrl: string, route: string, body: unknown): Promise<any> {
  const res = await fetch(`${comfyUrl.replace(/\/+$/, "")}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${route} -> ${res.status} ${await res.text().catch(() => "")}`);
  return res.json();
}

/** Fetch a render output and re-upload it into ComfyUI's input dir so LoadImage can read it. */
async function stageOutputAsInput(
  comfyUrl: string,
  out: { filename: string; type: string; subfolder?: string }
): Promise<string> {
  const base = comfyUrl.replace(/\/+$/, "");
  const params = new URLSearchParams({ filename: out.filename, subfolder: out.subfolder ?? "", type: out.type || "output" });
  const got = await fetch(`${base}/view?${params.toString()}`);
  if (!got.ok) throw new Error(`GET /view ${out.filename} -> ${got.status}`);
  const buf = Buffer.from(await got.arrayBuffer());
  const uploadName = `judge_${out.filename.replace(/[^\w.-]/g, "_")}`;
  const fd = new FormData();
  fd.append("image", new Blob([buf], { type: "image/png" }), uploadName);
  fd.append("overwrite", "true");
  const up = await fetch(`${base}/upload/image`, { method: "POST", body: fd });
  if (!up.ok) throw new Error(`POST /upload/image -> ${up.status}`);
  const j = await up.json().catch(() => ({}));
  return (j.name as string) || uploadName;
}

/**
 * Judge one render output with the local VLM. Returns the verdict, or null if the
 * VLM couldn't be run (no config / ComfyUI error) so callers can fall back to the
 * objective gate rather than hard-fail on judge infrastructure problems.
 */
export async function vlmJudgeOutput(
  comfyUrl: string,
  out: { filename: string; type: string; subfolder?: string },
  vlm: VlmNodeConfig,
  opts: { prompt?: string; timeoutMs?: number; pollMs?: number } = {}
): Promise<VlmVerdict | null> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const pollMs = opts.pollMs ?? 4_000;
  try {
    const inputName = await stageOutputAsInput(comfyUrl, out);
    const graph = buildJudgeGraph(vlm, inputName, opts.prompt);
    const q = await comfyPost(comfyUrl, "/prompt", { prompt: graph, client_id: "vlm-judge" });
    const promptId = q.prompt_id as string;
    if (q.node_errors && Object.keys(q.node_errors).length) return null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      const h = await fetch(`${comfyUrl.replace(/\/+$/, "")}/history/${promptId}`).then((r) => r.json()).catch(() => ({}));
      const rec = h?.[promptId];
      if (!rec?.status?.completed) continue;
      for (const o of Object.values(rec.outputs ?? {}) as any[]) {
        const t = o?.text ?? o?.string ?? o?.STRING;
        if (t) return parseVlmVerdict(Array.isArray(t) ? String(t[0]) : String(t));
      }
      return parseVlmVerdict(""); // completed but no text → fail-closed
    }
    return null; // timed out → let caller fall back
  } catch {
    return null;
  }
}
