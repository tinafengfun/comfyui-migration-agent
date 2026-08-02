import fs from "node:fs";
import path from "node:path";

export const demoModelRoot = "/home/intel/hf_models";

export interface AppConfig {
  port: number;
  projectRoot: string;
  workspaceRoot: string;
  stateRoot: string;
  draftDocRoot: string;
  comfyuiRoot: string;
  modelRoots: string[];
  /** Path to gpu-nodes.json — single source of truth for ComfyUI launch targets. */
  gpuNodesPath: string;
  /**
   * Source ComfyUI object_info — the "truth table" of node/enum capabilities in
   * the environment the workflow was authored in. Used to detect implicit package
   * dependencies (enum widget values injected by a source-side custom package).
   * A URL (GET {url}/object_info) or a path to a snapshot JSON. Optional.
   */
  sourceObjectInfoUrl?: string;
  sourceObjectInfoPath?: string;
  copilotCliPath?: string;
  autoApproveAgentPermissions: boolean;
  /** Shared NFS dir accepted (Step 12) migrated workflow delivery bundles are archived to. */
  workflowArchiveRoot: string;
  /**
   * Shared NFS dir every task's raw snapshot (task-state.json, artifacts/, logs/,
   * package/manifest.json) is archived to right before it would otherwise be
   * destroyed by prepareExclusiveNewTask or a manual task delete -- regardless of
   * final outcome (accepted, rejected, hard-stopped, or never finished). This is
   * a separate, broader net than workflowArchiveRoot's curated "final deliverable"
   * bundle, which only ever covers accepted tasks.
   */
  taskArchiveRoot: string;
  /**
   * Append-only JSONL ledger of asset-name -> resolved-file-path resolutions,
   * shared across tasks so Step 01 doesn't have to re-search for an asset it has
   * already resolved before. Never trusted blindly -- callers must confirm the
   * resolved path still exists before reusing an entry.
   */
  assetResolutionLedgerPath: string;
  /**
   * Absolute path to the CANONICAL comfyui-migration-agent git checkout used
   * for Step 13's draft/verify/fix/merge/push pipeline (agentImprovementPipeline.ts).
   * Deliberately never falls back to `projectRoot`: a live agent-demo deployment's
   * own `projectRoot` can be a stale subtree of an entirely different repo (confirmed
   * live -- agent-demo's own git identity was the ComfyUI repo's `v2-agent` branch,
   * badly behind comfyui-migration-agent's real history). Undefined means the
   * pipeline isn't configured for this deployment; callers must fail closed with a
   * clear error rather than silently using `projectRoot`.
   */
  agentSelfImprovementRepoRoot?: string;
}

const projectRoot = process.cwd();

function resolveFromProject(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

export function loadConfig(): AppConfig {
  const comfyuiRoot = resolveFromProject(process.env.COMFYUI_ROOT ?? defaultComfyUiRoot());
  const configuredModelRoots = (process.env.MODEL_ROOTS ?? process.env.MODEL_ROOT ?? demoModelRoot)
    .split(":")
    .filter(Boolean)
    .map(resolveFromProject);
  return {
    port: Number(process.env.PORT ?? "3001"),
    projectRoot,
    workspaceRoot: resolveFromProject(process.env.DEMO_WORKSPACE_ROOT ?? "workspaces"),
    stateRoot: resolveFromProject(process.env.DEMO_STATE_ROOT ?? ".demo-state"),
    // Default to bundled prompts/ dir; fall back to ComfyUI docs/draft for backwards compat
    draftDocRoot: resolveFromProject(
      process.env.DRAFT_DOC_ROOT ?? defaultDraftDocRoot(comfyuiRoot)
    ),
    comfyuiRoot,
    modelRoots: uniquePaths([demoModelRoot, ...configuredModelRoots]),
    // gpu-nodes.json at project root by default; override via GPU_NODES_PATH for tests.
    gpuNodesPath: resolveFromProject(process.env.GPU_NODES_PATH ?? "gpu-nodes.json"),
    sourceObjectInfoUrl: process.env.SOURCE_COMFYUI_URL || undefined,
    sourceObjectInfoPath: process.env.SOURCE_OBJECT_INFO_PATH
      ? resolveFromProject(process.env.SOURCE_OBJECT_INFO_PATH)
      : undefined,
    copilotCliPath: process.env.COPILOT_CLI_PATH,
    autoApproveAgentPermissions: process.env.MIGRATION_AGENT_AUTO_APPROVE !== "0",
    workflowArchiveRoot: resolveFromProject(process.env.WORKFLOW_ARCHIVE_ROOT ?? "/nfs_share/workflows"),
    taskArchiveRoot: resolveFromProject(process.env.TASK_ARCHIVE_ROOT ?? "/nfs_share/migration-tasks"),
    assetResolutionLedgerPath: resolveFromProject(
      process.env.ASSET_RESOLUTION_LEDGER_PATH ?? "/nfs_share/migration-knowledge/asset-resolutions.jsonl"
    ),
    agentSelfImprovementRepoRoot: process.env.AGENT_SELF_IMPROVEMENT_REPO_ROOT
      ? resolveFromProject(process.env.AGENT_SELF_IMPROVEMENT_REPO_ROOT)
      : undefined
  };
}

function uniquePaths(values: string[]): string[] {
  return [...new Set(values.filter(Boolean).map(resolveFromProject))];
}

function defaultComfyUiRoot(): string {
  const siblingCheckout = resolveFromProject("../ComfyUI");
  if (fs.existsSync(path.join(siblingCheckout, "docs/draft"))) return siblingCheckout;
  const parentCheckout = resolveFromProject("..");
  if (fs.existsSync(path.join(parentCheckout, "docs/draft"))) return parentCheckout;
  return siblingCheckout;
}

function defaultDraftDocRoot(comfyuiRoot: string): string {
  // Prefer bundled prompts/ dir (self-contained repo)
  const bundled = resolveFromProject("prompts");
  if (fs.existsSync(path.join(bundled, "migration-workflow-v2"))) return bundled;
  // Fall back to ComfyUI docs/draft for backwards compatibility
  return path.join(comfyuiRoot, "docs/draft");
}
