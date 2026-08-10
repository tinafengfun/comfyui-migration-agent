/**
 * Known custom-node provisioning registry.
 *
 * A small, deterministic node-type -> package/repo/model-dir/pip map that lets
 * the migration pipeline auto-resolve third-party custom nodes WITHOUT asking the
 * human for a GitHub URL. It exists because the only automatic source-identification
 * paths otherwise are (a) a local install already present, (b) an explicit
 * `repository` column the Step-01 agent happened to fill in, or (c) a >=80-score
 * GitHub provider search -- all of which miss for packages like
 * `ComfyUI-llama-cpp_vlm` whose node types (`llama_cpp_*`) carry no package hint.
 *
 * This is intentionally NOT a recipe under `recipes/` (those are schema-validated
 * by `loadAllRecipes` and describe XPU *runtime* behavior). This registry answers
 * a different question: "which repo provides this node type, where do its models
 * go, and how is its pip dependency installed." Recipes stay the advisory
 * runtime-knowledge layer; this is the deterministic provisioning layer.
 *
 * Consumed by:
 *  - intakePreflight.ts (inferPackageHint)  -> Step 00 marks the node "source known"
 *  - assetAcquisition.ts (resolveCustomNodeSource) -> deterministic auto-clone
 *  - assetAcquisition.ts (targetSubdir/assetKind) -> route the node's models to modelSubdir
 *  - Step 05 skill                          -> install the right pip backend, skip CUDA reqs
 */

export interface KnownCustomNodePip {
  /** Which llama.cpp / native backend the installed binary must be built for. */
  backend: "cpu";
  /**
   * When true, the node's own requirements.txt must NOT be `pip install -r`'d
   * (e.g. it pins CUDA/Metal wheels wrong for this XPU/CPU box); install the
   * backend-appropriate wheel instead. Step 05 honors this.
   */
  skipRequirementsTxt: true;
  /** Human-readable rationale surfaced in prompts/skills. */
  note: string;
}

export interface KnownCustomNode {
  /** Canonical package / custom_nodes dir name. */
  packageName: string;
  /** Git repo cloned into `<nfs>/custom_nodes/<name>` and symlinked into the run. */
  repository: string;
  /**
   * Node `class_type` prefixes provided by this package. A workflow node whose
   * type starts with any of these belongs to this package. Prefix (not exact)
   * match keeps a single entry covering a whole node family
   * (e.g. `llama_cpp_model_loader` / `llama_cpp_parameters` / `llama_cpp_instruct_adv`).
   */
  nodeTypePrefixes: string[];
  /**
   * ComfyUI `models/<modelSubdir>/` folder this node loads its weights from
   * (e.g. `LLM` for llama.cpp GGUF + mmproj). Used to route acquired assets so a
   * human never has to hand-place them.
   */
  modelSubdir?: string;
  /** Pip dependency handling for this package (backend-specific). */
  pip?: KnownCustomNodePip;
}

/**
 * The registry. Add an entry per known third-party package the agent should
 * auto-handle end-to-end.
 */
export const KNOWN_CUSTOM_NODES: KnownCustomNode[] = [
  {
    packageName: "ComfyUI-llama-cpp_vlm",
    repository: "https://github.com/lihaoyun6/ComfyUI-llama-cpp_vlm",
    nodeTypePrefixes: ["llama_cpp_"],
    modelSubdir: "LLM",
    pip: {
      backend: "cpu",
      skipRequirementsTxt: true,
      note:
        "requirements.txt pins CUDA (+cu128) / Metal llama-cpp-python wheels that are wrong " +
        "for this Intel XPU/CPU box. Install the CPU-built llama-cpp-python wheel instead " +
        "(the VLM runs on CPU via llama.cpp -- n_gpu_layers is a no-op without a SYCL build -- " +
        "which uses host RAM, not XPU VRAM, leaving the XPU free for fp8 diffusion).",
    },
  },
];

/** Case-sensitive prefix test against a node's class_type. */
function typeMatchesPrefixes(nodeType: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => nodeType.startsWith(prefix));
}

/**
 * Return the known package that provides `nodeType` (by class_type prefix), or
 * undefined. Used to mark a node "source known" and to supply the clone repo.
 */
export function knownCustomNodeForType(nodeType: string): KnownCustomNode | undefined {
  if (!nodeType) return undefined;
  return KNOWN_CUSTOM_NODES.find((node) => typeMatchesPrefixes(nodeType, node.nodeTypePrefixes));
}

/**
 * Return the known package referenced by a free-text asset evidence string (the
 * Step-01 `wrapper_source_evidence`, which names the loader node class). Used to
 * route the package's model files (e.g. GGUF + mmproj) to its `modelSubdir`.
 */
export function knownCustomNodeForEvidence(evidence: string): KnownCustomNode | undefined {
  if (!evidence) return undefined;
  const lower = evidence.toLowerCase();
  return KNOWN_CUSTOM_NODES.find((node) =>
    node.nodeTypePrefixes.some((prefix) => lower.includes(prefix.toLowerCase()))
  );
}
