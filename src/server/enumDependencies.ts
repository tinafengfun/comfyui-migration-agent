/**
 * Implicit package-dependency detection via enum widget values.
 *
 * A ComfyUI workflow node can carry widget values that are ENUM choices (a
 * sampler_name, scheduler, upscale_method, aspect_ratio, ...). Custom packages
 * frequently EXTEND a core node's enum dropdown (e.g. RES4LYF adds `res_2s` to
 * KSampler.sampler_name and `bong_tangent` to KSampler.scheduler). If the target
 * environment lacks that package, the value silently disappears from the dropdown
 * and ComfyUI rejects the prompt (`'res_2s' not in (44 samplers)`).
 *
 * Scanning node *types* misses this entirely — KSampler is comfy-core and looks
 * "satisfied." So we scan enum widget VALUES: a value that exists in the SOURCE
 * environment's object_info for that node's enum slot, but not in the target's
 * built-in baseline, is an IMPLICIT PACKAGE DEPENDENCY. The apple-to-apple fix is
 * to install the providing package on the target, not substitute the value.
 */

/** object_info shape (partial): { NodeType: { input: { required/optional: { slot: [ [enum...], meta ] } } } } */
export type ObjectInfo = Record<
  string,
  { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } }
>;

export interface EnumDependency {
  nodeId: string;
  nodeType: string;
  slot: string;
  value: string;
  sourceHas: boolean; // source object_info lists this value for the slot
  targetCoreHas: boolean; // comfy-core baseline lists this value
  resolvingPackage: string; // from recipe/mapping, or "unknown — identify from source"
  state: "source known" | "source unknown" | "satisfied";
}

interface WorkflowNode {
  id?: number | string;
  type?: string;
  widgets_values?: unknown[];
}

/**
 * Built-in comfy-core enum baseline for the slots we care about. Used at intake
 * time (before the target is even up) as the "what core provides" reference.
 * Kept deliberately conservative — a value NOT here + present in source ⇒ likely
 * package-injected. The authoritative target check happens later at Step 05 via
 * the real target /object_info.
 */
export const COMFY_CORE_ENUM_BASELINE: Record<string, Set<string>> = {
  sampler_name: new Set([
    "euler", "euler_cfg_pp", "euler_ancestral", "euler_ancestral_cfg_pp", "heun", "heunpp2",
    "dpm_2", "dpm_2_ancestral", "lms", "dpm_fast", "dpm_adaptive", "dpmpp_2s_ancestral",
    "dpmpp_2s_ancestral_cfg_pp", "dpmpp_sde", "dpmpp_sde_gpu", "dpmpp_2m", "dpmpp_2m_cfg_pp",
    "dpmpp_2m_sde", "dpmpp_2m_sde_gpu", "dpmpp_3m_sde", "dpmpp_3m_sde_gpu", "ddpm", "lcm",
    "ipndm", "ipndm_v", "deis", "res_multistep", "res_multistep_cfg_pp", "res_multistep_ancestral",
    "res_multistep_ancestral_cfg_pp", "gradient_estimation", "gradient_estimation_cfg_pp",
    "er_sde", "seeds_2", "seeds_3", "uni_pc", "uni_pc_bh2", "ddim"
  ]),
  scheduler: new Set([
    "simple", "sgm_uniform", "karras", "exponential", "ddim_uniform", "beta", "normal",
    "linear_quadratic", "kl_optimal"
  ])
};

/** Enum slots we treat as dependency-bearing. Extend as needed. */
const DEPENDENCY_ENUM_SLOTS = new Set(["sampler_name", "scheduler"]);

const modelFilePattern = /\.(safetensors|ckpt|pt|pth|onnx|gguf|bin)$/i;
const mediaFilePattern = /\.(png|jpe?g|webp|gif|mp4|mov|webm|avi|mkv|wav|mp3|flac)$/i;

/** Extract a node's enum slots (slot → allowed values) from an object_info entry. */
export function enumSlotsForNode(objectInfo: ObjectInfo | undefined, nodeType: string): Record<string, string[]> {
  const def = objectInfo?.[nodeType];
  if (!def?.input) return {};
  const out: Record<string, string[]> = {};
  for (const bucket of [def.input.required, def.input.optional]) {
    if (!bucket) continue;
    for (const [slot, spec] of Object.entries(bucket)) {
      // enum slot: spec = [ [v1, v2, ...], {meta} ]  (first element a string array)
      if (Array.isArray(spec) && Array.isArray(spec[0]) && spec[0].every((v) => typeof v === "string")) {
        out[slot] = spec[0] as string[];
      }
    }
  }
  return out;
}

/**
 * Detect implicit package dependencies in a workflow.
 *
 * @param nodes        workflow nodes
 * @param sourceInfo   source environment object_info (truth table); may be undefined
 * @param resolvePackage  maps an enum value → known providing package (from recipes), or undefined
 * @param targetInfo   optional target object_info (Step 05); if absent, uses COMFY_CORE_ENUM_BASELINE
 */
export function detectEnumDependencies(
  nodes: WorkflowNode[],
  sourceInfo: ObjectInfo | undefined,
  resolvePackage: (slot: string, value: string) => string | undefined = () => undefined,
  targetInfo?: ObjectInfo
): EnumDependency[] {
  const deps: EnumDependency[] = [];
  const seen = new Set<string>();

  for (const node of nodes) {
    const nodeType = String(node.type ?? "");
    if (!nodeType) continue;
    const sourceEnums = enumSlotsForNode(sourceInfo, nodeType);
    const targetEnums = targetInfo ? enumSlotsForNode(targetInfo, nodeType) : undefined;

    for (const raw of node.widgets_values ?? []) {
      if (typeof raw !== "string" || !raw) continue;
      if (modelFilePattern.test(raw) || mediaFilePattern.test(raw)) continue; // not an enum value

      // Which enum slot does this value belong to? Prefer the source object_info
      // (authoritative: it lists the slot's allowed values incl. package-injected
      // ones). Fall back to our known dependency slots + baseline membership.
      let slot: string | undefined;
      for (const [s, vals] of Object.entries(sourceEnums)) {
        if (vals.includes(raw)) { slot = s; break; }
      }
      if (!slot) {
        // No source info for this node — use the baseline slots: if the value is a
        // KNOWN core value for a dependency slot, it's fine; if it's not-core AND a
        // recipe maps it to a package, flag it. Otherwise we can't classify it.
        for (const s of DEPENDENCY_ENUM_SLOTS) {
          if (COMFY_CORE_ENUM_BASELINE[s]?.has(raw) || resolvePackage(s, raw)) { slot = s; break; }
        }
      }
      if (!slot || !DEPENDENCY_ENUM_SLOTS.has(slot)) continue;

      const key = `${nodeType}\0${slot}\0${raw}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const sourceHas = (sourceEnums[slot]?.includes(raw)) ?? false;
      const targetCoreHas = targetEnums
        ? (targetEnums[slot]?.includes(raw) ?? false)
        : (COMFY_CORE_ENUM_BASELINE[slot]?.has(raw) ?? false);

      if (targetCoreHas) continue; // target already provides it — no dependency

      const pkg = resolvePackage(slot, raw);
      deps.push({
        nodeId: String(node.id ?? "?"),
        nodeType,
        slot,
        value: raw,
        sourceHas,
        targetCoreHas,
        resolvingPackage: pkg ?? "unknown — identify from source environment",
        state: pkg ? "source known" : "source unknown"
      });
    }
  }
  return deps;
}

/** Render the enum-dependency ledger CSV (00-enum-dependencies.csv). */
export function renderEnumDependencyCsv(deps: EnumDependency[]): string {
  const header = "node_id,node_type,widget_slot,value,source_has,target_core_has,resolving_package,state";
  const rows = deps.map((d) =>
    [d.nodeId, d.nodeType, d.slot, d.value, d.sourceHas, d.targetCoreHas, csvCell(d.resolvingPackage), d.state]
      .map(String)
      .join(",")
  );
  return [header, ...rows].join("\n") + "\n";
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
