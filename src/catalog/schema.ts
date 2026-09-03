/**
 * Custom-node XPU-support catalog — record types + helpers.
 *
 * This is the TS mirror of schemas/xpu-node.schema.json (the authoritative
 * shape, validated on every catalog-server write via schemaValidate's `xpuNode`
 * kind). One record per custom-node package describes its Intel-XPU support:
 * source/storage, required changes (patches / pip backend / SYCL wheel / env),
 * version support, xpu-vs-cpu execution, usable configs (reduction/launch
 * flags), append-only validation evidence, and a trust tier.
 *
 * It is a superset of:
 *  - recipes/nodes/*.json      (recipe.schema.json — runtime XPU knowledge)
 *  - src/server/knownCustomNodes.ts (deterministic provisioning map)
 * both of which are imported into records by src/catalog/seedImport.ts.
 */

export const XPU_NODE_SCHEMA_VERSION = 1 as const;

export type XpuSupport = "native" | "patched" | "cpu_offload" | "unsupported" | "unknown";
export type ExecutionTarget = "xpu" | "cpu" | "hybrid";
export type PatchClass =
  | "registration_only"
  | "functional_runtime_support"
  | "runtime_policy"
  | "none";
export type CatalogTier = "candidate" | "trusted" | "unsupported";
export type PipBackend = "xpu" | "cpu";

/**
 * How this node is migrated to XPU, and WHO acts. The shared triage vocabulary
 * used identically by Step 04 (route output), Step 02 (hard_stop reasoning), and
 * this catalog record. Actor is derivable from the prefix: `auto_*` = the agent may
 * attempt it autonomously (bounded, objective-gated); `human_*` / `unsupported_*` /
 * `not_applicable` = no autonomous attempts (fail fast / escalate). Orthogonal to
 * `xpuSupport` (which is the END STATE): e.g. both auto_device_redirect and auto_fp8
 * end at xpuSupport "patched".
 */
export type MigrationRoute =
  | "auto_deps"
  | "auto_device_redirect"
  | "auto_fp8"
  | "auto_attention_fallback"
  | "auto_enum"
  | "human_source_work"
  | "human_env_conflict"
  | "human_source_unknown"
  | "unsupported_cuda_kernel"
  // Node calls an external cloud API (no local compute) — cannot run on the
  // offline XPU target. `api_local_substitute`: a local model node does the
  // equivalent work (VLM/LLM/TTS) → the node-localization step (03b) proposes a
  // graph substitution (human-approved). `api_no_local_equivalent`: no local
  // equivalent exists → a "cannot localize" boundary (human). See
  // docs/prd/api-node-local-substitution.md.
  | "api_local_substitute"
  | "api_no_local_equivalent"
  | "not_applicable";

/**
 * V2 Node-Class — the single derived vocabulary that unifies the three prior
 * taxonomies (parse-xlsx import buckets, this catalog's migrationRoute, and
 * src/server/wheelhouse.ts's requirement classes) so they all speak one A/B/C:
 *   A = recompile   — needs a prebuilt XPU wheel from the Builder (no worker compile)
 *   B = pip deps    — plain pip (installable offline once cached)
 *   C = pure python — patch/config only, no build, no pip
 * Derived from migrationRoute so it never drifts from the triage decision.
 * human_* / not_applicable routes are not a mechanical class → undefined.
 */
export type NodeClass = "A" | "B" | "C";

export function nodeClassFromRoute(route: MigrationRoute | undefined): NodeClass | undefined {
  switch (route) {
    case "unsupported_cuda_kernel":
      return "A"; // compiled CUDA kernel → needs a recompiled XPU wheel (Builder), not a worker compile
    case "auto_deps":
      return "B"; // resolvable by pip
    case "auto_device_redirect":
    case "auto_fp8":
    case "auto_attention_fallback":
    case "auto_enum":
      return "C"; // pure-python patch / config / enum-package
    default:
      return undefined; // human_* / not_applicable / unset → not a mechanical class
  }
}

export interface CatalogPatch {
  file: string;
  target?: string;
  patchClass?: PatchClass;
  baseVersion?: string;
  validationCommand?: string;
}

export interface CatalogPip {
  backend: PipBackend;
  skipRequirementsTxt?: boolean;
  extraWheels?: string[];
  note?: string;
}

export interface CatalogSyclWheel {
  required: boolean;
  buildScript?: string;
  prebuiltWheelPath?: string;
  note?: string;
}

export interface CatalogUsableConfigs {
  launchFlags?: string[];
  attnBackend?: string;
  /** Free-form; matches effective-run-config.recommended_reduced_setting. */
  reductionConfig?: Record<string, unknown>;
  /** Minimal known-good widget inputs used to seed the per-node validation harness. */
  knownGoodInputs?: Record<string, unknown>;
}

export interface CatalogValidationEvidence {
  commit?: string;
  taskId?: string;
  workflowName?: string;
  nodeType?: string;
  promptRef?: string;
  /** success | failed_runtime | timeout | capacity_suspected */
  historyResult?: string;
  passed: boolean;
  /** Peak XPU utilization during the run; low ⇒ CPU-fallback suspected. */
  xpuUtilizationPct?: number;
  peakVramRatio?: number;
  telemetryRef?: string;
  passedAt: string;
}

export interface CatalogWorkaround {
  action: string;
  rationale?: string;
  tradeoff?: string;
}

export interface CatalogEfficacy {
  appliedCount?: number;
  successCount?: number;
  lastAppliedAt?: string;
}

/** One catalog record. Mirrors schemas/xpu-node.schema.json exactly. */
export interface XpuNodeRecord {
  schemaVersion: typeof XPU_NODE_SCHEMA_VERSION;
  nodeKey: string;
  packageName: string;
  repository: string;
  nodeTypePrefixes: string[];

  onNfsShare?: boolean;
  nfsPath?: string;
  symlinkModel?: boolean;
  commit?: string;
  versionsSupported?: string[];
  /** Model dtypes this record's XPU support was proven for (e.g. ["fp8_e4m3fn","bf16"]). Empty = any. */
  supportedDtypes?: string[];
  modelSubdir?: string;

  execution: ExecutionTarget;
  xpuSupport: XpuSupport;
  patchClass?: PatchClass;
  patches?: CatalogPatch[];
  pip?: CatalogPip;
  syclWheel?: CatalogSyclWheel;
  envVars?: Record<string, string>;
  runtimePolicy?: Record<string, unknown>;

  providesEnumValues?: string[];
  enumSlots?: string[];
  usableConfigs?: CatalogUsableConfigs;

  validation?: CatalogValidationEvidence[];

  tier: CatalogTier;
  /** Triage class: how this node migrates to XPU + who acts. See MigrationRoute. */
  migrationRoute?: MigrationRoute;
  efficacy?: CatalogEfficacy;
  promotedBy?: string;
  promotedAt?: string;
  retireCondition?: string;
  knownIssues?: string[];
  workarounds?: CatalogWorkaround[];

  originTaskId?: string;
  createdAt: string;
  updatedAt: string;
  /** Optimistic-lock counter. Server bumps on every structural write; stale ⇒ 409. */
  version: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// nodeKey — the stable catalog key derived from the repo URL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a git repo URL (or `owner/repo`) into the catalog key
 * `<owner>__<repo>`, lowercased. Examples:
 *   https://github.com/lihaoyun6/ComfyUI-llama-cpp_vlm(.git)
 *     -> lihaoyun6__comfyui-llama-cpp_vlm
 *   git@github.com:ClownsharkBatwing/RES4LYF.git
 *     -> clownsharkbatwing__res4lyf
 *
 * When the owner cannot be determined (a bare package name), the repo segment is
 * used for both halves so the key still validates against the schema pattern.
 */
export function nodeKeyFromRepo(repoOrName: string): string {
  const cleaned = (repoOrName || "")
    .trim()
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  // Strip scheme + host: handle https://host/owner/repo and git@host:owner/repo.
  const withoutScheme = cleaned.replace(/^[a-z]+:\/\//i, "").replace(/^git@[^:]+:/i, "");
  const segments = withoutScheme.split("/").filter(Boolean);
  let owner: string;
  let repo: string;
  if (segments.length >= 2) {
    repo = segments[segments.length - 1];
    owner = segments[segments.length - 2];
  } else {
    repo = segments[0] ?? "custom-node";
    owner = repo;
  }
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${slug(owner)}__${slug(repo)}`;
}

/** custom_nodes/ dir name from a repo URL (basename, sans .git). */
export function packageNameFromRepo(repo: string): string {
  return (repo || "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .split("/")
    .pop() || "custom-node";
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation (delegates to the shared runtime gate)
// ─────────────────────────────────────────────────────────────────────────────

export { validateXpuNode } from "../server/schemaValidate";
