/**
 * triage-workflows.mts — static pre-migration blocker scan for a batch of GUI
 * workflows. No GPU / migration run: classifies every node type against the core
 * registry + knownCustomNodes + the XPU catalog, and flags the blockers a batch
 * migration should resolve FIRST:
 *   - api    : cloud/API-calling nodes (Gemini/OpenAI/… ) → must be replaced with
 *              a local node before XPU migration
 *   - cuda   : catalog-known CUDA-only boundary (unsupported_cuda_kernel)
 *   - unknown: not core, not a known package, not in the catalog → source unknown
 *
 * Usage: npx tsx scripts/triage-workflows.mts <dir-or-file...>
 */
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import path from "node:path";
import { loadBuiltinNodeTypes } from "../src/server/builtinNodes";
import { knownCustomNodeForType } from "../src/server/knownCustomNodes";
import { resolveNodeType } from "../src/server/xpuCatalogClient";

const COMFY_ROOT = process.env.PW_COMFY_ROOT ?? "/nfs_share/comfyui-core";
const API_NAME = /gemini|openai|gpt4?o?|chatgpt|claude|anthropic|dalle|kling|runway|luma|pika|minimax|dashscope|qwen.?(api|vl.?api)|replicate|(^|_)fal(_|$)|stability.?api|ideogram|recraft|suno|elevenlabs|\bapi\b|cloud|webhook|httprequest|online/i;
// GUI-only / utility nodes that are not a migration blocker (no runtime compute).
const UTILITY = new Set([
  "Note", "MarkdownNote", "Reroute", "PrimitiveNode", "PrimitiveString", "PrimitiveInt",
  "PrimitiveFloat", "PrimitiveBoolean", "GetNode", "SetNode", "Bool", "Label (rgthree)",
]);
const UUID_TYPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WFNode { type: string; cnr?: string; }
function nodesOf(file: string): WFNode[] {
  const d: any = JSON.parse(readFileSync(file, "utf8"));
  const arr = Array.isArray(d?.nodes) ? d.nodes : Array.isArray(d) ? d : [];
  const m = new Map<string, WFNode>();
  for (const n of arr) {
    const t = String(n?.type ?? "");
    if (!t) continue;
    const props = n?.properties ?? {};
    const cnr = props.cnr_id ?? props.aux_id ?? undefined; // the real package hint, same as Step-00
    if (!m.has(t)) m.set(t, { type: t, cnr: cnr ? String(cnr) : undefined });
  }
  return [...m.values()];
}

async function main() {
  const args = process.argv.slice(2);
  const files: string[] = [];
  for (const a of args) {
    try {
      const st = readdirSync(a);
      for (const f of st) if (f.endsWith(".json")) files.push(path.join(a, f));
    } catch {
      files.push(a);
    }
  }
  if (!files.length) {
    console.error("usage: triage-workflows.mts <dir-or-file...>");
    process.exit(2);
  }
  const builtin = loadBuiltinNodeTypes(COMFY_ROOT);
  console.log(`# Workflow migration triage (core registry: ${builtin.size} types @ ${COMFY_ROOT})\n`);

  const summary: { file: string; api: string[]; cuda: string[]; unknown: string[]; custom: number; core: number }[] = [];
  for (const file of files.sort()) {
    const types = nodesOf(file);
    const api: string[] = [];
    const cuda: string[] = [];
    const unknown: string[] = [];
    let core = 0;
    let custom = 0;
    let subgraph = 0;
    let utility = 0;
    for (const { type, cnr } of types) {
      if (API_NAME.test(type)) { api.push(type); continue; }
      if (builtin.has(type)) { core++; continue; }
      if (UTILITY.has(type)) { utility++; continue; }
      if (UUID_TYPE.test(type)) { subgraph++; continue; } // subgraph/group instance — expanded at Step 03½
      const pkg = knownCustomNodeForType(type);
      const res = await resolveNodeType(type).catch(() => null);
      const route = res?.record?.migrationRoute;
      if (route === "unsupported_cuda_kernel") cuda.push(type);
      // Known if: knownCustomNodes map, catalog record, OR the workflow itself
      // carries a real package hint (cnr_id/aux_id) that isn't comfy-core.
      const hasPkgHint = cnr && cnr !== "comfy-core";
      if (pkg || res?.record || hasPkgHint) custom++;
      else unknown.push(type);
    }
    summary.push({ file: path.basename(file), api, cuda, unknown, custom, core });
    const name = path.basename(file);
    const blockers = api.length + cuda.length + unknown.length;
    console.log(`## ${name}  —  ${blockers === 0 ? "✅ no static blocker" : "⚠ " + blockers + " blocker(s)"}`);
    console.log(`   nodes: ${types.length} types (core ${core}, custom ${custom}, utility ${utility}, subgraph ${subgraph})`);
    if (api.length) console.log(`   🌩  API/cloud → REPLACE with local: ${[...new Set(api)].join(", ")}`);
    if (cuda.length) console.log(`   🚫 CUDA-only boundary: ${[...new Set(cuda)].join(", ")}`);
    if (unknown.length) console.log(`   ❓ unknown source (need package): ${[...new Set(unknown)].join(", ")}`);
    console.log("");
  }

  console.log("## Batch verdict");
  const clean = summary.filter((s) => !s.api.length && !s.cuda.length && !s.unknown.length);
  const needsWork = summary.filter((s) => s.api.length || s.cuda.length || s.unknown.length);
  console.log(`   ✅ ready to try (${clean.length}): ${clean.map((s) => s.file).join(", ") || "—"}`);
  console.log(`   ⚠ need pre-work (${needsWork.length}): ${needsWork.map((s) => s.file).join(", ") || "—"}`);
  const allApi = [...new Set(needsWork.flatMap((s) => s.api))];
  if (allApi.length) console.log(`   🌩  API nodes to build local replacements for: ${allApi.join(", ")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
